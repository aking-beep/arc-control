#!/usr/bin/env node
/**
 * Writes the shipped demo policies to a file so `arc policy lint` can check
 * them in CI — the same command an operator runs before trusting a policy.
 *
 * Usage:  node .github/scripts/export-demo-policies.mjs <output.json>
 */
import { writeFile } from 'node:fs/promises';
import { DEMO_POLICIES } from '../../apps/control-api/dist/seed.js';

const output = process.argv[2];

if (!output) {
  process.stderr.write('usage: export-demo-policies.mjs <output.json>\n');
  process.exit(2);
}

await writeFile(output, `${JSON.stringify(DEMO_POLICIES, null, 2)}\n`, 'utf8');
process.stdout.write(`wrote ${DEMO_POLICIES.length} policy document(s) to ${output}\n`);
