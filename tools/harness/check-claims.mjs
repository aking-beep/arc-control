#!/usr/bin/env node
/**
 * Checks that what ARC Control says about itself is true of the code.
 *
 * ## Why this exists
 *
 * The product's whole proposition is that a record means what it says. The
 * recurring defect in this repository is not a broken control — it is a
 * document describing a control the code no longer implements, or stopped
 * implementing, or never did. Three real instances, all found by hand:
 *
 *   - `SECURITY.md` told buyers there was "no rate limiting" for two releases
 *     after `packages/gateway/src/rate-limit.ts` shipped and was wired into
 *     the decision path. The product was *understated* in the one file a
 *     security buyer reads first.
 *   - A release note recorded 795 tests and 93 eval properties after the
 *     change that took them to 812 and 95.
 *   - Five version numbers were live at once: the root manifest, the
 *     workspace packages, the API's own `/health` response, the console
 *     banner, and a "supported versions" table still naming `0.1.x`.
 *
 * None is caught by a test, because each is a statement *about* the code
 * rather than a behaviour of it. This script makes a class of them mechanical.
 *
 * ## What it checks
 *
 * 1. **One version.** The root manifest, every workspace package, every
 *    `@arc-control/*` pin, `API_VERSION`, the console banner and the
 *    `SECURITY.md` supported-versions table must agree, and must match the
 *    newest release note's major.minor.
 *
 * 2. **No contradicted claim.** An explicit table of phrases that must not
 *    appear in a named document while a named piece of code exists. Each entry
 *    carries its evidence path, so a reviewer can check the rule rather than
 *    trust it. If the evidence is deleted the claim may be true again, and the
 *    rule stops applying — which is the behaviour we want.
 *
 * It deliberately does **not** try to understand prose. A claim check is a
 * literal phrase and a file that must exist: cheap, and wrong only in obvious
 * ways. Anything subtler belongs to `arc-claims-auditor`, which reads; this
 * script only remembers.
 *
 * Usage: node tools/harness/check-claims.mjs [--out result.json]
 *        (exits non-zero on any problem)
 */
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, writeResult } from './lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKSPACE_DIRS = ['packages', 'connectors', 'apps'];

/**
 * Claims that must not appear while their evidence exists.
 *
 * `phrase` is matched literally, case-insensitively.
 */
export const CLAIMS = [
  {
    file: 'SECURITY.md',
    phrase: 'No rate limiting, quota or concurrency control',
    evidence: 'packages/gateway/src/rate-limit.ts',
    because: 'the gateway rate-limits actions per agent and fails closed when it cannot read its counter',
  },
  {
    file: 'docs/SECURITY_QUESTIONNAIRE.md',
    phrase: 'ARC Control 2.0,',
    evidence: 'docs/releases/2.3.md',
    because: 'the questionnaire is handed to buyers and must name the release it answers for',
  },
];

/**
 * The whole check, as a pure function over already-read inputs.
 *
 * @param {object} input
 * @param {Map<string,string[]>} input.versions   version -> the places reporting it
 * @param {string[]} input.releaseNotes           release-note basenames, e.g. ['2.0.md', '2.3.md']
 * @param {string} input.security                 the text of SECURITY.md
 * @param {Array<{file,phrase,evidence,because}>} input.claims
 * @param {Record<string,string|undefined>} input.docs   claim file -> its text (undefined if missing)
 * @param {(path: string) => boolean} input.evidenceExists
 * @returns {{problems: string[], version: string|undefined, newest: string|undefined}}
 */
export function inspect({ versions, releaseNotes, security, claims, docs, evidenceExists }) {
  const problems = [];
  const problem = (where, message) => problems.push(`${where}: ${message}`);

  if (versions.size === 0) problem('version', 'no versions found to compare');

  if (versions.size > 1) {
    const summary = [...versions.entries()]
      .map(([version, where]) => `${version} (${where.length}: ${where.slice(0, 3).join(', ')}${where.length > 3 ? ', …' : ''})`)
      .join(' · ');
    problem('version', `${versions.size} different versions are live at once — ${summary}`);
  }

  // With several versions live, the lowest-risk reading is the root manifest's.
  const version =
    [...versions.entries()].find(([, where]) => where.includes('package.json'))?.[0] ?? [...versions.keys()][0];

  const ordered = releaseNotes
    .filter((name) => /^[0-9]+\.[0-9]+\.md$/.test(name))
    .map((name) => name.replace('.md', ''))
    .sort((a, b) => {
      const [aMajor, aMinor] = a.split('.').map(Number);
      const [bMajor, bMinor] = b.split('.').map(Number);
      return aMajor - bMajor || aMinor - bMinor;
    });
  const newest = ordered.at(-1);

  if (!newest) problem('docs/releases', 'no release note found');
  else if (version && !version.startsWith(`${newest}.`)) {
    problem('version', `the product reports ${version} but the newest release note is ${newest}.x — write the note, or correct the version`);
  }

  // SECURITY.md tells a reporter which versions get fixes. It must name the
  // one that exists.
  if (version) {
    const [major, minor] = version.split('.');
    if (!security.includes(`| ${major}.${minor}.x |`)) {
      problem('SECURITY.md', `the supported-versions table does not list ${major}.${minor}.x, which is what the product reports`);
    }
  }

  for (const claim of claims) {
    if (!evidenceExists(claim.evidence)) continue;
    const text = docs[claim.file];
    if (text === undefined) {
      problem(claim.file, 'missing, but a claim rule names it');
      continue;
    }
    if (text.toLowerCase().includes(claim.phrase.toLowerCase())) {
      problem(claim.file, `says "${claim.phrase}", but ${claim.evidence} exists — ${claim.because}`);
    }
  }

  return { problems, version, newest };
}

/** Reads every place that reports a version. */
async function collectVersions(read) {
  const versions = new Map();
  const problems = [];
  const note = (version, where) => {
    if (!versions.has(version)) versions.set(version, []);
    versions.get(version).push(where);
  };

  const root = JSON.parse(await read('package.json'));
  if (root.version) note(root.version, 'package.json');

  for (const dir of WORKSPACE_DIRS) {
    for (const entry of await readdir(join(ROOT, dir))) {
      const relative = `${dir}/${entry}/package.json`;
      if (!existsSync(join(ROOT, relative))) continue;
      const manifest = JSON.parse(await read(relative));
      if (manifest.version) note(manifest.version, relative);
      for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
        for (const [name, range] of Object.entries(manifest[field] ?? {})) {
          if (name.startsWith('@arc-control/')) note(range, `${relative} (${name})`);
        }
      }
    }
  }

  const apiVersion = /export const API_VERSION = '([^']+)'/.exec(await read('apps/control-api/src/server.ts'));
  if (apiVersion) note(apiVersion[1], 'apps/control-api/src/server.ts (API_VERSION)');
  else problems.push('apps/control-api/src/server.ts: no API_VERSION found to check');

  const banner = /'ARC Control Console ([0-9]+\.[0-9]+\.[0-9]+)'/.exec(await read('apps/control-console/src/main.ts'));
  if (banner) note(banner[1], 'apps/control-console/src/main.ts (banner)');
  else problems.push('apps/control-console/src/main.ts: no console version banner found to check');

  return { versions, problems };
}

// --- CLI ------------------------------------------------------------------

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const read = (relative) => readFile(join(ROOT, relative), 'utf8');
  const { versions, problems: readProblems } = await collectVersions(read);

  const docs = {};
  for (const claim of CLAIMS) docs[claim.file] = await read(claim.file).catch(() => undefined);

  const { problems, version, newest } = inspect({
    versions,
    releaseNotes: await readdir(join(ROOT, 'docs', 'releases')),
    security: await read('SECURITY.md'),
    claims: CLAIMS,
    docs,
    evidenceExists: (path) => existsSync(join(ROOT, path)),
  });

  const all = [...readProblems, ...problems];
  const { options } = parseArgs();
  await writeResult(options.out, {
    skill: 'verify',
    tool: 'check-claims.mjs',
    ok: all.length === 0,
    metrics: { problems: all.length },
    details: { version: version ?? null, versionsSeen: versions.size, newestReleaseNote: newest ?? null, claimsChecked: CLAIMS.length, problems: all },
  });

  if (all.length > 0) {
    console.error(`${all.length} claim problem(s):\n`);
    for (const line of all) console.error(`  - ${line}`);
    process.exit(1);
  }

  const places = [...versions.values()].reduce((total, where) => total + where.length, 0);
  console.log(`Claims OK: one version (${version}) across ${places} place(s); newest release note ${newest}; ${CLAIMS.length} claim rule(s) checked`);
}
