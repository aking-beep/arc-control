#!/usr/bin/env node
/**
 * Level 4: measures every skill's outcomes against its targets.
 *
 * Reads the definitions in `tools/harness/metrics.json`, collects each metric
 * from its source, compares it with its target, and writes:
 *
 *   <out-dir>/latest.json    this snapshot
 *   <out-dir>/history.jsonl  every snapshot, appended (kept on the harness-metrics branch)
 *   <out-dir>/SCORECARD.md   a human-readable table with the change since the last snapshot
 *
 * Sources:
 *   harness, client-profiles, findings, release-notes   run the repository's own scripts
 *   deploy                                              runs the deployment smoke test (needs a build)
 *   meridian                                            reads a result written by
 *                                                       .claude/skills/meridian-validate/run.sh (--meridian <result.json>)
 *   github-ci, github-prs                               the GitHub API (GITHUB_TOKEN, GITHUB_REPOSITORY)
 *
 * A metric whose source is unavailable is `unmeasured`. It is never counted as
 * met: a scorecard that turns green because it could not look is the failure
 * the assurance model exists to prevent, and the harness holds itself to it.
 *
 * Usage:
 *   node tools/harness/measure.mjs --out-dir .harness [--meridian path] [--skip deploy] [--check]
 *
 * --check exits 1 when any target is breached (unmeasured does not fail).
 */
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parseArgs } from './lib.mjs';
import { githubContext, mergedPullRequests, workflowRuns } from './github.mjs';
import { auditChange } from './pr-audit.mjs';

const run = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOUR = 3_600_000;

/** Every source the definitions may name. check-harness.mjs verifies against this list. */
export const SOURCES = ['harness', 'client-profiles', 'findings', 'release-notes', 'deploy', 'meridian', 'github-ci', 'github-prs'];

async function script(name, scratch) {
  const out = join(scratch, `${name}.json`);
  // These scripts exit 1 when their check fails; the result file is still the measurement.
  await run(process.execPath, [join(ROOT, 'tools', 'harness', `${name}.mjs`), '--out', out], { cwd: ROOT, maxBuffer: 16 * 1024 * 1024 }).catch(() => undefined);
  return JSON.parse(await readFile(out, 'utf8')).metrics;
}

const median = (values) => {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
};

async function collect(source, { scratch, options, measuredFrom }) {
  switch (source) {
    case 'harness':
      return script('check-harness', scratch);
    case 'client-profiles':
      return script('validate-client', scratch);
    case 'findings':
      return script('findings', scratch);
    case 'release-notes':
      return script('lint-release-notes', scratch);
    case 'deploy': {
      const metrics = await script('deploy-smoke', scratch);
      return { ...metrics, checks_passed_rate: metrics.checks_total ? metrics.checks_passed / metrics.checks_total : 0 };
    }
    case 'meridian': {
      if (!options.meridian) throw new Error('no Meridian result given (--meridian); run .claude/skills/meridian-validate/run.sh first');
      return JSON.parse(await readFile(resolve(options.meridian), 'utf8')).metrics;
    }
    case 'github-ci': {
      const context = githubContext();
      if (!context) throw new Error('GITHUB_TOKEN and GITHUB_REPOSITORY are not set');
      const runs = await workflowRuns(context, 'ci.yaml', 'main', 30);
      const decided = runs.filter((entry) => ['success', 'failure', 'timed_out'].includes(entry.conclusion));
      return {
        runs: decided.length,
        ...(decided.length ? { success_rate: decided.filter((entry) => entry.conclusion === 'success').length / decided.length } : {}),
      };
    }
    case 'github-prs': {
      const context = githubContext();
      if (!context) throw new Error('GITHUB_TOKEN and GITHUB_REPOSITORY are not set');
      const since = Date.parse(measuredFrom);
      const prs = (await mergedPullRequests(context, 50)).filter((pr) => Date.parse(pr.mergedAt) >= since);
      const metrics = { merged_prs: prs.length };
      if (prs.length === 0) return metrics;

      const audits = prs.map((pr) => auditChange(pr.files.nodes.map((file) => file.path), pr.body ?? ''));
      const decision = audits.filter((audit) => audit.decisionPathFiles.length > 0);
      metrics.delivery_gate_pass_rate = audits.filter((audit) => audit.passed).length / audits.length;
      metrics.waiver_rate = audits.filter((audit) => audit.waived.length > 0).length / audits.length;
      metrics.green_at_merge_rate = prs.filter((pr) => pr.commits.nodes[0]?.commit.statusCheckRollup?.state === 'SUCCESS').length / prs.length;
      metrics.unresolved_threads_at_merge = prs.reduce((sum, pr) => sum + pr.reviewThreads.nodes.filter((thread) => !thread.isResolved).length, 0);
      metrics.median_hours_to_merge = median(prs.map((pr) => (Date.parse(pr.mergedAt) - Date.parse(pr.createdAt)) / HOUR));
      if (decision.length > 0) {
        metrics.decision_path_prs_with_release_note_rate =
          decision.filter((audit) => !audit.violations.some((violation) => violation.id === 'D2') && !audit.waived.some((waiver) => waiver.id === 'D2')).length / decision.length;
      }
      return metrics;
    }
    default:
      throw new Error(`unknown source "${source}"`);
  }
}

function evaluate(value, target) {
  if (value === undefined || value === null || Number.isNaN(value)) return 'unmeasured';
  switch (target.op) {
    case '>=':
      return value >= target.value ? 'met' : 'breached';
    case '<=':
      return value <= target.value ? 'met' : 'breached';
    case '==':
      return value === target.value ? 'met' : 'breached';
    default:
      return 'unmeasured';
  }
}

const format = (value) => (value === undefined || value === null ? '—' : Number.isInteger(value) ? String(value) : value.toFixed(2));

async function main() {
  const { options } = parseArgs();
  const outDir = resolve(options['out-dir'] ?? '.harness');
  const scratch = join(outDir, 'results');
  await mkdir(scratch, { recursive: true });
  const skip = new Set(String(options.skip ?? '').split(',').filter(Boolean));

  const definitions = JSON.parse(await readFile(join(ROOT, 'tools', 'harness', 'metrics.json'), 'utf8'));
  const sources = {};
  for (const source of [...new Set(definitions.metrics.map((metric) => metric.source))]) {
    if (skip.has(source)) {
      sources[source] = { ok: false, error: 'skipped' };
      continue;
    }
    try {
      sources[source] = { ok: true, metrics: await collect(source, { scratch, options, measuredFrom: definitions.measuredFrom }) };
    } catch (cause) {
      sources[source] = { ok: false, error: cause.message };
    }
  }

  let previous;
  try {
    const lines = (await readFile(join(outDir, 'history.jsonl'), 'utf8')).trim().split('\n');
    previous = JSON.parse(lines.at(-1));
  } catch {
    previous = undefined;
  }
  const before = new Map((previous?.metrics ?? []).map((metric) => [metric.id, metric.value]));

  const metrics = definitions.metrics.map((metric) => {
    const value = sources[metric.source]?.metrics?.[metric.key];
    return { id: metric.id, skill: metric.skill, value: value ?? null, target: metric.target, status: evaluate(value, metric.target), previous: before.get(metric.id) ?? null };
  });

  const commit = (await run('git', ['rev-parse', 'HEAD'], { cwd: ROOT }).catch(() => ({ stdout: '' }))).stdout.trim();
  const snapshot = {
    at: new Date().toISOString(),
    commit,
    ref: process.env.GITHUB_REF ?? null,
    summary: {
      met: metrics.filter((metric) => metric.status === 'met').length,
      breached: metrics.filter((metric) => metric.status === 'breached').length,
      unmeasured: metrics.filter((metric) => metric.status === 'unmeasured').length,
    },
    metrics,
    sources: Object.fromEntries(Object.entries(sources).map(([name, source]) => [name, source.ok ? { ok: true } : { ok: false, error: source.error }])),
  };

  await writeFile(join(outDir, 'latest.json'), `${JSON.stringify(snapshot, null, 2)}\n`);
  await appendFile(join(outDir, 'history.jsonl'), `${JSON.stringify(snapshot)}\n`);

  const icon = { met: 'met', breached: '**BREACHED**', unmeasured: '_unmeasured_' };
  const rows = metrics.map((metric) => {
    const delta = metric.previous !== null && metric.value !== null && metric.previous !== metric.value ? ` (was ${format(metric.previous)})` : '';
    return `| ${metric.skill} | \`${metric.id}\` | ${format(metric.value)}${delta} | ${metric.target.op} ${metric.target.value} | ${icon[metric.status]} |`;
  });
  const unavailable = Object.entries(sources).filter(([, source]) => !source.ok);
  const scorecard = [
    '# Harness scorecard',
    '',
    `Measured ${snapshot.at} at \`${commit.slice(0, 12) || 'unknown'}\`. ${snapshot.summary.met} met, ${snapshot.summary.breached} breached, ${snapshot.summary.unmeasured} unmeasured.`,
    '',
    '| Skill | Metric | Value | Target | Status |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
    '',
    ...(unavailable.length
      ? ['Sources not measured this run (their metrics are unmeasured, not met):', '', ...unavailable.map(([name, source]) => `- \`${name}\`: ${source.error}`), '']
      : []),
    'Definitions and targets: `tools/harness/metrics.json`. Ladder: `docs/harness/SKILLS.md`.',
    '',
  ].join('\n');
  await writeFile(join(outDir, 'SCORECARD.md'), scorecard);
  process.stdout.write(scorecard);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, scorecard);

  if (options.check && snapshot.summary.breached > 0) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
