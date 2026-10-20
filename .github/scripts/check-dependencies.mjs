#!/usr/bin/env node
/**
 * Enforces the "zero runtime dependencies" claim.
 *
 * A control plane's supply chain is part of its threat model, and the README
 * makes a specific promise about this one. A promise that is only in the
 * README decays, so it is checked here instead.
 *
 * Workspace siblings (`@arc-control/*`) are not third-party and do not count.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const WORKSPACE_ROOTS = ['packages', 'connectors', 'apps'];
const SIBLING_PREFIX = '@arc-control/';

async function manifests() {
  const found = [];

  for (const root of WORKSPACE_ROOTS) {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      found.push(join(root, entry.name, 'package.json'));
    }
  }

  return found.sort();
}

const offenders = [];
let checked = 0;

for (const path of await manifests()) {
  const pkg = JSON.parse(await readFile(path, 'utf8'));
  checked += 1;

  for (const name of Object.keys(pkg.dependencies ?? {})) {
    if (!name.startsWith(SIBLING_PREFIX)) offenders.push({ path, name });
  }

  // A runtime dependency smuggled in as a peer or optional dependency is
  // still a runtime dependency.
  for (const field of ['peerDependencies', 'optionalDependencies']) {
    for (const name of Object.keys(pkg[field] ?? {})) {
      if (!name.startsWith(SIBLING_PREFIX)) offenders.push({ path, name: `${name} (${field})` });
    }
  }
}

if (offenders.length > 0) {
  process.stderr.write('Third-party runtime dependencies found:\n');
  for (const offender of offenders) {
    process.stderr.write(`  ${offender.path}: ${offender.name}\n`);
  }
  process.stderr.write('\nSee CONTRIBUTING.md — adding one needs an argument in review.\n');
  process.exit(1);
}

process.stdout.write(`${checked} workspace package(s) checked; every runtime dependency is a workspace sibling.\n`);
