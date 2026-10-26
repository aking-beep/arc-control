#!/usr/bin/env node
/**
 * The deployment artefacts, checked against the code they configure.
 *
 * Terraform, Compose files and Kubernetes manifests are the one part of this
 * repository the test suite cannot run: there is no cluster in CI, and the
 * errors they hold are not type errors. They are a variable referenced but
 * never declared, or an environment variable spelled slightly wrong — which
 * fails as "the feature does nothing", silently, in somebody else's cluster.
 *
 * Both of those happened while adding single sign-on to these files, and one
 * was caught only because a grep happened to run. So they are checked here:
 *
 *   1. every `var.x` in the Terraform module is declared, and every declared
 *      variable is used;
 *   2. every ARC_* environment variable the deployment artefacts set is one
 *      the code actually reads.
 *
 * No dependencies, because a check on the supply chain cannot add to it.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('../../', import.meta.url).pathname;
const problems = [];

/** Every file under `dir` whose name matches, recursively. */
function walk(dir, matches) {
  const found = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) found.push(...walk(path, matches));
    else if (matches(entry)) found.push(path);
  }
  return found;
}

const read = (path) => readFileSync(path, 'utf8');
const all = (text, pattern) => [...text.matchAll(pattern)].map((match) => match[1]);

// --- 1. Terraform variables -------------------------------------------------

const terraform = walk(join(root, 'infrastructure/terraform'), (name) => name.endsWith('.tf'));
const declared = new Set();
const used = new Map();

for (const path of terraform) {
  const text = read(path);
  for (const name of all(text, /^variable "([a-z0-9_]+)"/gm)) declared.add(name);
  for (const name of all(text, /\bvar\.([a-z0-9_]+)/g)) {
    if (!used.has(name)) used.set(name, relative(root, path));
  }
}

for (const [name, where] of used) {
  // A variable's own description may reference others; declarations are what
  // matter, and `variables.tf` declares them all.
  if (!declared.has(name)) problems.push(`${where}: var.${name} is used but never declared`);
}
for (const name of declared) {
  if (!used.has(name)) problems.push(`infrastructure/terraform: variable "${name}" is declared but never used`);
}

// --- 2. Environment variables -----------------------------------------------

/**
 * What the code reads. Both entry points plus the config module, which is
 * where the API's settings are parsed.
 */
const sources = [
  'apps/control-api/src/config.ts',
  'apps/control-api/src/main.ts',
  'apps/control-console/src/main.ts',
].map((path) => read(join(root, path)));

const known = new Set(sources.flatMap((text) => all(text, /\benv(?:ironment)?[.[]'?(ARC_[A-Z0-9_]+)/g)));
for (const text of sources) {
  for (const name of all(text, /process\.env\.(ARC_[A-Z0-9_]+)/g)) known.add(name);
  for (const name of all(text, /\benv\.(ARC_[A-Z0-9_]+)/g)) known.add(name);
}

const artefacts = [
  ...walk(join(root, 'infrastructure'), (name) => /\.(tf|ya?ml)$/.test(name) || name === '.env.example'),
];

/**
 * Only assignment positions, so a variable mentioned in a comment as an
 * alternative is not a failure. Each shape these files actually use:
 *
 *   ARC_X: value          compose, and a Kubernetes mapping key
 *   ARC_X=value           a .env file
 *   - name: ARC_X         a Kubernetes container env entry
 *   name = "ARC_X"        Terraform
 *
 * The first version of this check had only the first two and matched nothing
 * in the Kubernetes manifests at all — it passed while a deliberately
 * misspelled variable sat in `api.yaml`. Hence the count printed at the end:
 * a check that silently matches nothing is worse than no check.
 */
const shapes = [
  /^\s*"?(ARC_[A-Z0-9_]+)"?\s*[:=]/gm,
  /^\s*-\s*name:\s*"?(ARC_[A-Z0-9_]+)"?\s*$/gm,
  /\bname\s*=\s*"(ARC_[A-Z0-9_]+)"/g,
];

let assignments = 0;

for (const path of artefacts) {
  const text = read(path);
  const names = new Set(shapes.flatMap((shape) => all(text, shape)));
  assignments += names.size;
  for (const name of names) {
    if (!known.has(name)) {
      problems.push(`${relative(root, path)}: sets ${name}, which no entry point reads`);
    }
  }
}

if (assignments === 0) {
  problems.push(
    'no ARC_* assignments were found in any deployment artefact, so this check proved nothing. ' +
      'The file layout or a variable naming convention has changed.',
  );
}

// ---------------------------------------------------------------------------

if (problems.length > 0) {
  process.stderr.write(`${problems.map((problem) => `  ✗ ${problem}`).join('\n')}\n`);
  process.stderr.write(
    `\n${String(problems.length)} problem(s) in the deployment artefacts. These do not fail a test run; ` +
      'they fail in a cluster.\n',
  );
  process.exit(1);
}

process.stdout.write(
  `${String(declared.size)} Terraform variable(s) and ${String(assignments)} environment assignment(s) ` +
    `checked against ${String(known.size)} setting(s) the entry points read; the deployment artefacts match ` +
    'the code they configure.\n',
);
