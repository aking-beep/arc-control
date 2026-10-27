#!/usr/bin/env node
/**
 * Checks a change against the `deliver` skill's mechanical exit gates.
 *
 * The gates a script can check from a list of changed files:
 *
 *   D1  a change to decision-path source changes or adds a test or an eval
 *   D2  a change to decision-path source updates a release note
 *   D3  a change to the schema types updates the published JSON Schemas (warning)
 *   D4  a change to a client profile prompts a check of its README (warning)
 *
 * The decision path is the code that decides whether an action reaches a
 * connector, or records what happened: gateway, approvals, identity, policy,
 * execution, evidence, audit, store, connectors.
 *
 * A gate can be waived for one change by a line in the PR description,
 * `Harness-Exempt: D1 <reason>`, which is reported and counted — a waiver is
 * visible, never silent.
 *
 * Usage:
 *   node tools/harness/pr-audit.mjs [--base origin/main] [--head HEAD] [--body-file pr.md] [--out result.json]
 */
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, writeResult } from './lib.mjs';

const DECISION_PATH = /^(?:packages\/(?:gateway|approvals|agent-identity|operator-identity|policy-engine|execution|evidence|audit|store)\/src\/|connectors\/[^/]+\/src\/)(?!.*\.test\.ts$).+\.ts$/;
const TEST = /(?:\.test\.(?:ts|mjs|js)$|^evals\/.+\.eval\.mjs$)/;
const RELEASE_NOTE = /^docs\/releases\/.+\.md$/;
const SCHEMA_TYPES = /^packages\/schemas\/src\/(?!.*\.test\.ts$).+\.ts$/;
const PUBLISHED_SCHEMA = /^schemas\/.+\.schema\.json$/;

/** Pure: the gates, from a list of changed paths and the PR description. */
export function auditChange(files, body = '') {
  const exempt = new Map(
    [...body.matchAll(/^Harness-Exempt:\s*(D\d)\s+(.+)$/gim)].map((match) => [match[1].toUpperCase(), match[2].trim()]),
  );
  const decision = files.filter((file) => DECISION_PATH.test(file));
  const violations = [];
  const warnings = [];
  const waived = [];

  const gate = (id, failed, message, severity = 'error') => {
    if (!failed) return;
    if (exempt.has(id)) waived.push({ id, message, reason: exempt.get(id) });
    else (severity === 'error' ? violations : warnings).push({ id, message });
  };

  gate('D1', decision.length > 0 && !files.some((file) => TEST.test(file)), `decision-path source changed (${decision.length} file(s)) with no test or eval added or changed`);
  gate('D2', decision.length > 0 && !files.some((file) => RELEASE_NOTE.test(file)), 'decision-path source changed with no release note updated in docs/releases/');
  gate('D3', files.some((file) => SCHEMA_TYPES.test(file)) && !files.some((file) => PUBLISHED_SCHEMA.test(file)), 'schema types changed with no published JSON Schema updated (fine if the change is not on the wire)', 'warning');
  // A new client arrives with its README; a later profile edit need not touch it.
  for (const profile of files.filter((file) => /^clients\/[^/]+\/profile\.json$/.test(file))) {
    const readme = profile.replace(/profile\.json$/, 'README.md');
    gate('D4', !files.includes(readme), `${profile} changed; check ${readme} still records accepted warnings and unmet requirements`, 'warning');
  }

  return { decisionPathFiles: decision, violations, warnings, waived, passed: violations.length === 0 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { options } = parseArgs();
  const base = options.base ?? 'origin/main';
  const head = options.head ?? 'HEAD';
  const files = execFileSync('git', ['diff', '--name-only', `${base}...${head}`], { encoding: 'utf8' }).split('\n').filter(Boolean);
  const body = options['body-file'] ? await readFile(options['body-file'], 'utf8').catch(() => '') : (process.env.PR_BODY ?? '');
  const result = auditChange(files, body);

  process.stdout.write(`${files.length} file(s) changed, ${result.decisionPathFiles.length} on the decision path\n`);
  for (const violation of result.violations) process.stdout.write(`FAIL ${violation.id} ${violation.message}\n`);
  for (const warning of result.warnings) process.stdout.write(`warn ${warning.id} ${warning.message}\n`);
  for (const waiver of result.waived) process.stdout.write(`waived ${waiver.id} ${waiver.message} — ${waiver.reason}\n`);
  process.stdout.write(result.passed ? 'Delivery gates pass\n' : 'Delivery gates fail\n');

  await writeResult(options.out, {
    skill: 'deliver',
    tool: 'pr-audit',
    ok: result.passed,
    metrics: {
      files_changed: files.length,
      decision_path_files: result.decisionPathFiles.length,
      violations: result.violations.length,
      waivers: result.waived.length,
    },
    details: result,
  });
  if (!result.passed) process.exitCode = 1;
}
