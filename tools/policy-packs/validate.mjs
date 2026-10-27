#!/usr/bin/env node
/**
 * Validates the policy packs in `policy-packs/` (ADR-0002).
 *
 * A pack is starting policy built from an AI Workflow Template, written in the
 * client-profile format so the same validator that checks a client's
 * configuration checks it: each pack is loaded into a real gateway, every
 * scenario must produce its expected outcome **and** its expected number of
 * effects at the connector, and the evidence must verify.
 *
 * On top of that, a pack must be safe to publish into a deployment it was not
 * written for, which is checked here:
 *
 *   - every policy id starts with `PACK-`, so a pack cannot overwrite a
 *     client's own policy by publishing under its id;
 *   - every policy is scoped to agents by **role** (`role:<name>`) and to
 *     nothing broader — a pack policy with a DENY fallback that matched every
 *     action would deny everything in the deployment it was published to;
 *   - no fallback is ALLOW, so a pack never authorizes what it did not name;
 *   - the `pack` block says where it came from and what to adapt.
 *
 * Usage: node tools/policy-packs/validate.mjs [pack.json ...] [--out result.json]
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateProfile } from '../harness/validate-client.mjs';
import { parseArgs, writeResult } from '../harness/lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The checks particular to packs. Returns error messages; empty means acceptable. */
export function packProblems(pack) {
  const problems = [];
  if (typeof pack.id !== 'string' || !pack.id.startsWith('pack-')) problems.push('id must start with "pack-"');
  const meta = pack.pack;
  if (typeof meta !== 'object' || meta === null) problems.push('missing the "pack" block');
  else {
    if (!Number.isInteger(meta.version) || meta.version < 1) problems.push('pack.version must be a positive integer');
    for (const field of ['source', 'summary']) {
      if (typeof meta[field] !== 'string' || meta[field].trim() === '') problems.push(`pack.${field} is required`);
    }
    if (!Array.isArray(meta.adapt) || meta.adapt.length === 0) problems.push('pack.adapt must list what an operator changes before publishing');
  }
  for (const policy of pack.policies ?? []) {
    const where = `policy "${policy.id}"`;
    if (typeof policy.id !== 'string' || !policy.id.startsWith('PACK-')) problems.push(`${where}: id must start with "PACK-"`);
    const agents = policy.match?.agents;
    if (!Array.isArray(agents) || agents.length === 0 || !agents.every((entry) => typeof entry === 'string' && entry.startsWith('role:'))) {
      problems.push(`${where}: must be scoped with match.agents listing only role:<name> selectors`);
    }
    if (policy.fallback?.effect === 'ALLOW') problems.push(`${where}: a pack fallback must not be ALLOW`);
  }
  return problems;
}

export async function discover() {
  const directory = join(ROOT, 'policy-packs');
  const entries = await readdir(directory, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => join(directory, entry.name, 'pack.json')).sort();
}

async function main() {
  const { options, positional } = parseArgs();
  const files = positional.length > 0 ? positional.map((path) => resolve(path)) : await discover();
  const reports = [];

  for (const file of files) {
    const source = relative(ROOT, file);
    let pack;
    try {
      pack = JSON.parse(await readFile(file, 'utf8'));
    } catch (cause) {
      reports.push({ source, errors: [`cannot read pack: ${cause.message}`], warnings: [], results: [] });
      continue;
    }
    const profile = await validateProfile(pack, source);
    reports.push({ ...profile, errors: [...packProblems(pack), ...profile.errors] });
  }

  for (const report of reports) {
    const passed = report.results.filter((result) => result.pass).length;
    process.stdout.write(`${report.errors.length === 0 ? 'PASS' : 'FAIL'} ${report.source} — ${passed}/${report.results.length} scenarios\n`);
    for (const message of report.errors) process.stdout.write(`  error   ${message}\n`);
  }
  const invalid = reports.filter((report) => report.errors.length > 0).length;
  process.stdout.write(`\n${reports.length - invalid}/${reports.length} policy pack(s) valid\n`);

  const scenarios = reports.flatMap((report) => report.results);
  await writeResult(options.out, {
    skill: 'client-onboarding',
    tool: 'validate-packs',
    ok: invalid === 0,
    metrics: {
      packs_total: reports.length,
      packs_invalid: invalid,
      scenarios_total: scenarios.length,
      scenarios_passed: scenarios.filter((result) => result.pass).length,
    },
    details: reports.map((report) => ({ source: report.source, errors: report.errors, warnings: report.warnings })),
  });
  if (invalid > 0 || reports.length === 0) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
