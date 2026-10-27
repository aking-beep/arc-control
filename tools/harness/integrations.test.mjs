import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { summarize } from './meridian-result.mjs';
import { pullRequest } from './github.mjs';

/** Meridian's summary and the GitHub client, each made to fail the way it must not pass. */

const phase2 = (overrides = {}) => ({
  phase2: { pass: 33, fail: 0, unsupported: 5 },
  stress: [{ pass: true }, { pass: true }, { pass: true }],
  preservedIntegration: { passed: 17, failed: 0 },
  ...overrides,
});
const validate = { passed: 17, failed: 0 };

describe('meridian-result fails closed', () => {
  it('passes a complete, clean run', () => {
    const result = summarize({ validate, phase2: phase2(), exits: { unit: 0, validate: 0, phase2: 0 } });
    assert.equal(result.ok, true);
    assert.equal(result.metrics.phase2_fail, 0);
  });

  it('fails when the Phase 2 report is missing, and leaves its metrics unmeasured', () => {
    const result = summarize({ validate, phase2: undefined, exits: { phase2: 1 } });
    assert.equal(result.ok, false);
    assert.equal(result.metrics.phase2_fail, undefined);
    assert.equal(result.metrics.stress_failed_presets, undefined);
  });

  it('fails when stress results are missing', () => {
    assert.equal(summarize({ validate, phase2: phase2({ stress: [] }) }).ok, false);
  });

  it('fails when a step exited non-zero even if the reports look clean', () => {
    assert.equal(summarize({ validate, phase2: phase2(), exits: { unit: 1 } }).ok, false);
  });

  it('fails on a reported Phase 2 failure', () => {
    assert.equal(summarize({ validate, phase2: phase2({ phase2: { pass: 32, fail: 1, unsupported: 5 } }) }).ok, false);
  });
});

describe('github client follows pagination', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('returns every file and review thread past the first page', async () => {
    const page = (count, prefix, hasNextPage) => ({
      nodes: Array.from({ length: count }, (_, index) => ({ path: `${prefix}${index}`, isResolved: index % 2 === 0 })),
      pageInfo: { hasNextPage, endCursor: hasNextPage ? 'cursor-1' : null },
    });
    const calls = [];
    globalThis.fetch = async (_url, init) => {
      const { variables } = JSON.parse(init.body);
      calls.push(variables.after ?? 'first');
      const pullRequest = variables.after
        ? { files: page(20, 'b', false), reviewThreads: page(7, 't2', false) }
        : {
            number: 7,
            files: page(100, 'a', true),
            reviewThreads: page(100, 't1', true),
            commits: { nodes: [] },
          };
      return new Response(JSON.stringify({ data: { repository: { pullRequest } } }), { status: 200 });
    };

    const pr = await pullRequest({ token: 't', owner: 'o', name: 'n' }, 7);
    assert.equal(pr.files.nodes.length, 120);
    assert.equal(pr.reviewThreads.nodes.length, 107);
    assert.ok(pr.files.nodes.some((file) => file.path === 'b19'));
    assert.deepEqual(calls, ['first', 'cursor-1', 'cursor-1']);
  });
});

describe('green at merge ignores checks that ran after the merge', async () => {
  const { greenAtMerge } = await import('./github.mjs');
  const merged = '2026-10-27T03:06:28Z';
  const run = (conclusion, suiteCreated, completedAt, status = 'COMPLETED') => ({
    __typename: 'CheckRun',
    name: 'ci',
    status,
    conclusion,
    completedAt,
    checkSuite: { createdAt: suiteCreated },
  });
  const pr = (...contexts) => ({ mergedAt: merged, commits: { nodes: [{ commit: { statusCheckRollup: { state: 'PENDING', contexts: { nodes: contexts } } } }] } });

  it('a fast-forwarded PR stays green while main re-runs checks on the same commit', () => {
    assert.equal(
      greenAtMerge(pr(run('SUCCESS', '2026-10-27T02:59:50Z', '2026-10-27T03:00:20Z'), run(null, '2026-10-27T03:06:29Z', null, 'IN_PROGRESS'))),
      true,
    );
  });

  it('neutral and skipped checks count as green', () => {
    assert.equal(greenAtMerge(pr(run('NEUTRAL', '2026-10-27T02:59:50Z', '2026-10-27T03:00:20Z'), run('SKIPPED', '2026-10-27T02:59:50Z', '2026-10-27T02:59:55Z'))), true);
  });

  it('a failing or unfinished check from before the merge is not green', () => {
    assert.equal(greenAtMerge(pr(run('FAILURE', '2026-10-27T02:59:50Z', '2026-10-27T03:00:20Z'))), false);
    assert.equal(greenAtMerge(pr(run(null, '2026-10-27T02:59:50Z', null, 'IN_PROGRESS'))), false);
    assert.equal(greenAtMerge(pr(run('SUCCESS', '2026-10-27T02:59:50Z', '2026-10-27T03:10:00Z'))), false, 'finished only after the merge');
  });

  it('a PR merged with no checks at all is not green', () => {
    assert.equal(greenAtMerge(pr()), false);
  });
});
