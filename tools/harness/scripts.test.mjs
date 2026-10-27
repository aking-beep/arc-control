import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { auditChange } from './pr-audit.mjs';
import { auditFindings } from './findings.mjs';
import { lintReleaseNote } from './lint-release-notes.mjs';

/**
 * The harness scripts are only worth running if they fail when they should.
 * Each case below is a shape of change or record the script exists to catch.
 */

describe('pr-audit (deliver gates)', () => {
  it('fails decision-path source with no test and no release note', () => {
    const result = auditChange(['packages/gateway/src/gateway.ts']);
    assert.equal(result.passed, false);
    assert.deepEqual(result.violations.map((violation) => violation.id), ['D1', 'D2']);
  });

  it('passes the same change with a test and a release note', () => {
    const result = auditChange(['packages/gateway/src/gateway.ts', 'packages/gateway/src/gateway.test.ts', 'docs/releases/2.2.md']);
    assert.equal(result.passed, true);
  });

  it('accepts an eval as the test', () => {
    assert.equal(auditChange(['packages/policy-engine/src/engine.ts', 'evals/policy/decisions.eval.mjs', 'docs/releases/2.2.md']).passed, true);
  });

  it('ignores changes off the decision path, and test-only changes', () => {
    assert.equal(auditChange(['docs/OPERATIONS.md', 'packages/cli/src/bin.ts']).passed, true);
    assert.equal(auditChange(['packages/gateway/src/gateway.test.ts']).decisionPathFiles.length, 0);
  });

  it('records a waiver instead of failing, so it is visible and counted', () => {
    const result = auditChange(['connectors/mcp/src/index.ts'], 'Harness-Exempt: D1 rename only\nharness-exempt: D2 no behaviour change');
    assert.equal(result.passed, true);
    assert.deepEqual(result.waived.map((waiver) => waiver.id), ['D1', 'D2']);
  });

  it('warns when schema types change without the published schema', () => {
    const result = auditChange(['packages/schemas/src/action.ts']);
    assert.equal(result.passed, true);
    assert.deepEqual(result.warnings.map((warning) => warning.id), ['D3']);
  });
});

describe('findings register', () => {
  const finding = (overrides = {}) => ({
    id: 'ARC-SEC-900',
    title: 't',
    severity: 'high',
    status: 'fixed',
    foundAt: '2026-10-01',
    foundBy: 'test',
    fixedAt: '2026-10-03',
    fixedIn: '#1',
    regressionTests: ['packages/gateway/src/idempotency.test.ts'],
    releaseNote: 'docs/releases/2.2.md',
    ...overrides,
  });

  it('accepts a fixed finding with an existing regression test and release note', async () => {
    const { problems, metrics } = await auditFindings({ findings: [finding()] }, new Date('2026-10-10'));
    assert.deepEqual(problems, []);
    assert.equal(metrics.fixed_with_regression_tests_rate, 1);
    assert.equal(metrics.median_days_to_fix, 2);
  });

  it('refuses a fixed finding with no regression test, or one that does not exist', async () => {
    const none = await auditFindings({ findings: [finding({ regressionTests: [] })] });
    assert.ok(none.problems.some((problem) => problem.includes('at least one regression test')));
    const missing = await auditFindings({ findings: [finding({ regressionTests: ['packages/nowhere.test.ts'] })] });
    assert.ok(missing.problems.some((problem) => problem.includes('does not exist')));
  });

  it('refuses an accepted risk with nobody accepting it, and duplicate ids', async () => {
    const { problems } = await auditFindings({ findings: [finding({ status: 'accepted' }), finding({ status: 'accepted', acceptedBy: 'ciso' })] });
    assert.ok(problems.some((problem) => problem.includes('acceptedBy')));
    assert.ok(problems.some((problem) => problem.includes('duplicate id')));
  });

  it('measures the age of the oldest open finding', async () => {
    const { metrics } = await auditFindings(
      { findings: [finding({ id: 'ARC-SEC-901', status: 'open', fixedAt: undefined, severity: 'critical', foundAt: '2026-10-01' })] },
      new Date('2026-10-21'),
    );
    assert.equal(metrics.oldest_open_days, 20);
    assert.equal(metrics.open_critical, 1);
  });
});

describe('release-note lint', () => {
  const good = '# 9.9\n\n## Verification\n\nNumbers.\n\n## What this release does not establish\n\nLimits.\n';

  it('accepts a note with verification and limits', () => {
    assert.deepEqual(lintReleaseNote(good), []);
  });

  it('refuses a note with no verification or no limits', () => {
    assert.ok(lintReleaseNote('# 9.9\n\n## What this release does not establish\n').some((problem) => problem.includes('Verification')));
    assert.ok(lintReleaseNote('# 9.9\n\n## Verification\n').some((problem) => problem.includes('does not establish')));
  });

  it('refuses a claim of enterprise readiness, but not a denial of one', () => {
    assert.ok(lintReleaseNote(`${good}\nARC is now enterprise-ready.\n`).some((problem) => problem.includes('enterprise readiness')));
    assert.deepEqual(lintReleaseNote(`${good}\nNothing here makes the platform enterprise-ready.\n`), []);
  });
});
