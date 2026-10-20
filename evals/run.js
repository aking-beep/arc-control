#!/usr/bin/env node
/**
 * Runs every eval suite. Exits non-zero if any property does not hold, so the
 * suites can gate a release.
 *
 * Usage:  node evals/run.js [suite-id-substring ...]
 */
import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runSuites } from './harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));

async function discover() {
  const suites = [];

  for (const entry of await readdir(here, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = join(here, entry.name);
    for (const file of await readdir(directory)) {
      if (!file.endsWith('.eval.mjs')) continue;
      const module = await import(pathToFileURL(join(directory, file)).href);
      if (module.default) suites.push(module.default);
    }
  }

  return suites.sort((left, right) => left.id.localeCompare(right.id));
}

const filters = process.argv.slice(2);
const all = await discover();
const selected = filters.length === 0 ? all : all.filter((suite) => filters.some((filter) => suite.id.includes(filter)));

if (selected.length === 0) {
  process.stderr.write(`no eval suites matched ${filters.join(', ')}\n`);
  process.stderr.write(`available: ${all.map((suite) => suite.id).join(', ')}\n`);
  process.exit(2);
}

process.exit((await runSuites(selected)) === 0 ? 0 : 1);
