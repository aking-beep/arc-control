#!/usr/bin/env node
/**
 * Summarizes a Meridian run directory (written by
 * `.claude/skills/meridian-validate/run.sh`) into one result in the harness
 * format, for the CI gate and for `measure.mjs`.
 *
 * Fails closed. A run passes only when every report it needs exists and every
 * step exited cleanly: a Phase 2 run that crashed before writing its report is
 * a failure, not zero failures. Missing data leaves the metric absent, which
 * `measure.mjs` reports as unmeasured.
 *
 * Usage: node tools/harness/meridian-result.mjs <run-dir>   (writes <run-dir>/result.json)
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Pure: the reports and step exit codes in, the result out. */
export function summarize({ validate, phase2, exits = {} }) {
  const metrics = {};
  const problems = [];

  if (validate) {
    metrics.integration_passed = validate.passed;
    metrics.integration_failed = validate.failed;
  } else problems.push('no integration report (validate-latest.json)');

  if (phase2) {
    metrics.phase2_pass = phase2.phase2.pass;
    metrics.phase2_fail = phase2.phase2.fail;
    metrics.phase2_unsupported = phase2.phase2.unsupported;
    if (Array.isArray(phase2.stress) && phase2.stress.length > 0) {
      metrics.stress_failed_presets = phase2.stress.filter((preset) => !preset.pass).length;
    } else problems.push('the Phase 2 report has no stress results');
    if (phase2.preservedIntegration) {
      metrics.integration_passed = phase2.preservedIntegration.passed;
      metrics.integration_failed = phase2.preservedIntegration.failed;
    }
  } else problems.push('no Phase 2 report (phase2-latest.json)');

  for (const [step, code] of Object.entries(exits)) {
    if (code !== 0) problems.push(`${step} exited ${code}`);
  }

  const clean =
    metrics.integration_failed === 0 && metrics.phase2_fail === 0 && metrics.stress_failed_presets === 0;
  if (!clean && problems.length === 0) problems.push('Meridian reported failures');
  return { ok: clean && problems.length === 0, metrics, problems };
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = resolve(process.argv[2] ?? '.');
  const exits = {};
  const summary = await readFile(join(dir, 'summary.txt'), 'utf8').catch(() => '');
  for (const [, step, code] of summary.matchAll(/^(\w+) exit (\d+)$/gm)) exits[step] = Number(code);
  if (/phase2 not available/.test(summary)) exits.phase2 = -1;

  const result = summarize({
    validate: await readJson(join(dir, 'validate-latest.json')),
    phase2: await readJson(join(dir, 'phase2-latest.json')),
    exits,
  });
  const revisions = await readFile(join(dir, 'revisions.txt'), 'utf8').catch(() => '');
  await writeFile(
    join(dir, 'result.json'),
    `${JSON.stringify({ at: new Date().toISOString(), skill: 'meridian-validate', tool: 'run.sh', ...result, details: { revisions, exits } }, null, 2)}\n`,
  );
  process.stdout.write(`${result.ok ? 'Meridian passed' : `Meridian did not pass: ${result.problems.join('; ')}`}\n`);
}
