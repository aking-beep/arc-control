#!/usr/bin/env node
/**
 * Validates the security findings register (`docs/security/findings.json`) —
 * the `security-remediation` skill's procedure, as a check.
 *
 * A finding is closed only when the evidence for closing it exists: a fixed
 * finding must name where it was fixed, when, the regression tests that cover
 * it (which must exist in this tree), and the release note that documents it.
 * A register that says "fixed" without a test is the failure mode this exists
 * to prevent.
 *
 * Usage: node tools/harness/findings.mjs [--out result.json] [--now 2026-10-27]
 */
import { access, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, writeResult } from './lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const STATUSES = new Set(['open', 'in_progress', 'fixed', 'accepted']);
const SEVERITIES = new Set(['critical', 'high', 'medium', 'low']);
const DAY = 86_400_000;

const exists = (path) => access(join(ROOT, path)).then(() => true, () => false);

export async function auditFindings(register, now = new Date()) {
  const problems = [];
  const seen = new Set();
  const findings = register.findings ?? [];

  for (const finding of findings) {
    const where = finding.id ?? '(no id)';
    if (!/^ARC-SEC-\d{3}$/.test(finding.id ?? '')) problems.push(`${where}: id must look like ARC-SEC-001`);
    if (seen.has(finding.id)) problems.push(`${where}: duplicate id`);
    seen.add(finding.id);
    if (!finding.title) problems.push(`${where}: missing title`);
    if (!SEVERITIES.has(finding.severity)) problems.push(`${where}: severity must be one of ${[...SEVERITIES].join(', ')}`);
    if (!STATUSES.has(finding.status)) problems.push(`${where}: status must be one of ${[...STATUSES].join(', ')}`);
    if (Number.isNaN(Date.parse(finding.foundAt))) problems.push(`${where}: foundAt is not a date`);
    if (!finding.foundBy) problems.push(`${where}: foundBy is required — who or what found it`);

    if (finding.status === 'fixed') {
      if (Number.isNaN(Date.parse(finding.fixedAt))) problems.push(`${where}: a fixed finding needs fixedAt`);
      if (!finding.fixedIn) problems.push(`${where}: a fixed finding needs fixedIn (PR or commit)`);
      if (!Array.isArray(finding.regressionTests) || finding.regressionTests.length === 0) {
        problems.push(`${where}: a fixed finding needs at least one regression test`);
      }
      if (!finding.releaseNote) problems.push(`${where}: a fixed finding needs a releaseNote`);
    }
    if (finding.status === 'accepted' && !finding.acceptedBy) problems.push(`${where}: an accepted finding names who accepted the risk (acceptedBy)`);
    for (const test of finding.regressionTests ?? []) {
      if (!(await exists(test))) problems.push(`${where}: regression test ${test} does not exist`);
    }
    if (finding.releaseNote && !(await exists(finding.releaseNote))) problems.push(`${where}: release note ${finding.releaseNote} does not exist`);
  }

  const open = findings.filter((finding) => finding.status === 'open' || finding.status === 'in_progress');
  const fixed = findings.filter((finding) => finding.status === 'fixed');
  const ages = open.map((finding) => (now.getTime() - Date.parse(finding.foundAt)) / DAY);
  const fixDays = fixed.map((finding) => (Date.parse(finding.fixedAt) - Date.parse(finding.foundAt)) / DAY).sort((a, b) => a - b);
  const withTests = fixed.filter((finding) => (finding.regressionTests ?? []).length > 0).length;

  return {
    problems,
    metrics: {
      findings_total: findings.length,
      open_findings: open.length,
      open_critical: open.filter((finding) => finding.severity === 'critical').length,
      oldest_open_days: ages.length ? Math.max(...ages) : 0,
      ...(fixed.length ? { fixed_with_regression_tests_rate: withTests / fixed.length } : {}),
      ...(fixDays.length ? { median_days_to_fix: fixDays[Math.floor((fixDays.length - 1) / 2)] } : {}),
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { options } = parseArgs();
  const register = JSON.parse(await readFile(join(ROOT, 'docs', 'security', 'findings.json'), 'utf8'));
  const now = options.now ? new Date(options.now) : new Date();
  const { problems, metrics } = await auditFindings(register, now);
  for (const line of problems) process.stdout.write(`FAIL ${line}\n`);
  process.stdout.write(`${problems.length === 0 ? 'Findings register OK' : `${problems.length} problem(s)`}: ${JSON.stringify(metrics)}\n`);
  await writeResult(options.out, { skill: 'security-remediation', tool: 'findings', ok: problems.length === 0, metrics, details: { problems } });
  if (problems.length > 0) process.exitCode = 1;
}
