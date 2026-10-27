import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Decision, PolicyEffect, PolicyEvaluation } from '@arc-control/schemas';
import { tighten } from './tighten.js';

function decision(effect: PolicyEffect, extra: Partial<Decision> = {}): Decision {
  return {
    id: 'decision_1',
    actionId: 'action_1',
    effect,
    policyId: 'FINANCE-004',
    policyVersion: 3,
    ruleId: 'under-500',
    reason: 'policy reason',
    obligations: ['log'],
    evaluations: [{ policyId: 'FINANCE-004', policyVersion: 3, applied: true, effect, ruleId: 'under-500' }],
    trace: [{ policyId: 'FINANCE-004', policyVersion: 3, ruleId: 'under-500', matched: true, effect }],
    decidedAt: '2026-10-27T00:00:00.000Z',
    evaluationMs: 0.1,
    ...extra,
  };
}

function budget(effect: PolicyEffect | undefined, id = 'budget:b1'): PolicyEvaluation {
  return {
    policyId: id,
    policyVersion: 1,
    applied: effect !== undefined,
    ...(effect ? { effect, reason: `${id} exhausted`, ruleId: 'exceeded' } : {}),
    ...(effect === 'REQUIRE_APPROVAL'
      ? { approval: { approvers: ['role:finance-manager'], minApprovals: 1, expiresInSeconds: 3600 } }
      : {}),
  };
}

const EFFECTS: readonly PolicyEffect[] = ['ALLOW', 'REQUIRE_APPROVAL', 'DENY'];
const SEVERITY: Record<PolicyEffect, number> = { ALLOW: 0, REQUIRE_APPROVAL: 1, DENY: 2 };

describe('tighten', () => {
  it('never produces an effect less strict than the decision it was given', () => {
    for (const base of EFFECTS) {
      for (const extra of [...EFFECTS, undefined]) {
        const result = tighten(decision(base), [budget(extra)]);
        assert.ok(
          SEVERITY[result.effect] >= SEVERITY[base],
          `${base} folded with ${String(extra)} became ${result.effect}`,
        );
      }
    }
  });

  it('takes the stricter effect, and cites the budget that imposed it', () => {
    const result = tighten(decision('ALLOW'), [budget('DENY')]);
    assert.equal(result.effect, 'DENY');
    assert.equal(result.policyId, 'budget:b1');
    assert.equal(result.ruleId, 'exceeded');
    assert.equal(result.reason, 'budget:b1 exhausted');
    assert.deepEqual(result.obligations, [], 'a refusal carries none of the allowing policy obligations');
    assert.equal(result.approval, undefined);
  });

  it('carries the approval requirement of a budget that holds an allowed action', () => {
    const result = tighten(decision('ALLOW'), [budget('REQUIRE_APPROVAL')]);
    assert.equal(result.effect, 'REQUIRE_APPROVAL');
    assert.deepEqual(result.approval?.approvers, ['role:finance-manager']);
  });

  it('leaves a decision that is already as strict untouched, citation included', () => {
    const held = decision('REQUIRE_APPROVAL', {
      approval: { approvers: ['role:cfo'], minApprovals: 2, expiresInSeconds: 600 },
    });
    const result = tighten(held, [budget('REQUIRE_APPROVAL')]);
    assert.equal(result.policyId, 'FINANCE-004');
    assert.deepEqual(result.approval?.approvers, ['role:cfo']);
  });

  it('cannot turn a default DENY into anything else', () => {
    const uncovered = decision('DENY', { evaluations: [], trace: [] });
    const { policyId: _p, policyVersion: _v, ruleId: _r, ...bare } = uncovered;
    for (const extra of EFFECTS) {
      assert.equal(tighten(bare, [budget(extra)]).effect, 'DENY');
    }
  });

  it('records every extra evaluation and a trace entry for each, whichever way it fell', () => {
    const result = tighten(decision('ALLOW'), [budget(undefined, 'budget:a'), budget('DENY', 'budget:b')]);
    assert.deepEqual(
      result.evaluations.map((evaluation) => evaluation.policyId),
      ['FINANCE-004', 'budget:a', 'budget:b'],
    );
    assert.deepEqual(
      result.trace.slice(1).map((entry) => [entry.policyId, entry.matched]),
      [
        ['budget:a', false],
        ['budget:b', true],
      ],
    );
  });

  it('picks the strictest of several, ties broken by id so the citation is stable', () => {
    const forward = tighten(decision('ALLOW'), [budget('DENY', 'budget:z'), budget('DENY', 'budget:a')]);
    const reverse = tighten(decision('ALLOW'), [budget('DENY', 'budget:a'), budget('DENY', 'budget:z')]);
    assert.equal(forward.policyId, 'budget:a');
    assert.equal(reverse.policyId, 'budget:a');
  });

  it('treats an evaluation with an unknown effect as a refusal rather than ignoring it', () => {
    const odd = { policyId: 'budget:x', policyVersion: 1, applied: true, effect: 'MAYBE' } as unknown as PolicyEvaluation;
    assert.equal(tighten(decision('ALLOW'), [odd]).effect, 'DENY');
  });

  it('returns the decision unchanged when there is nothing to fold', () => {
    const base = decision('ALLOW');
    assert.equal(tighten(base, []), base);
  });
});
