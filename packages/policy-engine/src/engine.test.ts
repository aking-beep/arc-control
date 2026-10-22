import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Policy, PolicyInput } from '@arc-control/schemas';
import { PolicyEngine } from './engine.js';

/** The refund policy from the README, used as the canonical worked example. */
const FINANCE_004: Policy = {
  id: 'FINANCE-004',
  version: 1,
  name: 'Autonomous refund authority',
  enabled: true,
  match: { tools: ['stripe.refund'] },
  rules: [
    {
      id: 'under-500',
      when: { lt: ['$.action.parameters.amount', 500] },
      effect: 'ALLOW',
      reason: 'within autonomous refund authority',
    },
    {
      id: 'needs-approval',
      when: { lte: ['$.action.parameters.amount', 2500] },
      effect: 'REQUIRE_APPROVAL',
      reason: 'above autonomous refund authority, below the hard ceiling',
      approval: { approvers: ['role:finance-manager'], minApprovals: 1, expiresInSeconds: 3600 },
    },
    {
      id: 'over-ceiling',
      when: { always: true },
      effect: 'DENY',
      reason: 'exceeds autonomous refund authority',
    },
  ],
  fallback: { effect: 'DENY', reason: 'no refund rule matched' },
};

function input(overrides: {
  amount?: unknown;
  tool?: string;
  roles?: string[];
  environment?: string;
  parameters?: Record<string, unknown>;
}): PolicyInput {
  return {
    agent: {
      id: 'arc_ag_1',
      name: 'finance-agent',
      kind: 'autonomous',
      environment: overrides.environment ?? 'production',
      owner: 'finance@example.com',
      roles: overrides.roles ?? ['finance'],
      labels: {},
    },
    tool: {
      name: overrides.tool ?? 'stripe.refund',
      system: 'stripe',
      effect: 'irreversible',
      riskTier: 'high',
      labels: {},
    },
    action: {
      id: 'arc_act_1',
      parameters: overrides.parameters ?? { amount: overrides.amount, customer: 'customer_123' },
    },
    context: {
      environment: overrides.environment ?? 'production',
      requestedAt: '2026-01-15T14:00:00.000Z',
      hourUtc: 14,
      dayOfWeekUtc: 4,
    },
  };
}

describe('PolicyEngine: the refund worked example', () => {
  const engine = new PolicyEngine();

  it('allows a refund below the autonomous limit', () => {
    const decision = engine.evaluate([FINANCE_004], input({ amount: 120 }));
    assert.equal(decision.effect, 'ALLOW');
    assert.equal(decision.policyId, 'FINANCE-004');
    assert.equal(decision.ruleId, 'under-500');
  });

  it('requires approval inside the approval band', () => {
    const decision = engine.evaluate([FINANCE_004], input({ amount: 1800 }));
    assert.equal(decision.effect, 'REQUIRE_APPROVAL');
    assert.equal(decision.ruleId, 'needs-approval');
    assert.deepEqual(decision.approval?.approvers, ['role:finance-manager']);
    assert.equal(decision.approval?.minApprovals, 1);
  });

  it('denies the $4,200 refund and cites the policy and reason', () => {
    const decision = engine.evaluate([FINANCE_004], input({ amount: 4200 }));
    assert.equal(decision.effect, 'DENY');
    assert.equal(decision.policyId, 'FINANCE-004');
    assert.equal(decision.ruleId, 'over-ceiling');
    assert.equal(decision.reason, 'exceeds autonomous refund authority');
  });

  it('treats the band boundaries as the policy text reads', () => {
    assert.equal(engine.evaluate([FINANCE_004], input({ amount: 499.99 })).effect, 'ALLOW');
    assert.equal(engine.evaluate([FINANCE_004], input({ amount: 500 })).effect, 'REQUIRE_APPROVAL');
    assert.equal(engine.evaluate([FINANCE_004], input({ amount: 2500 })).effect, 'REQUIRE_APPROVAL');
    assert.equal(engine.evaluate([FINANCE_004], input({ amount: 2500.01 })).effect, 'DENY');
  });

  it('records every rule it examined in the trace', () => {
    const decision = engine.evaluate([FINANCE_004], input({ amount: 4200 }));
    assert.deepEqual(
      decision.trace.map((entry) => [entry.ruleId, entry.matched]),
      [
        ['under-500', false],
        ['needs-approval', false],
        ['over-ceiling', true],
      ],
    );
  });
});

describe('PolicyEngine: failing closed', () => {
  const engine = new PolicyEngine();

  it('denies when no policy matches the action', () => {
    const decision = engine.evaluate([FINANCE_004], input({ tool: 'github.create_issue' }));
    assert.equal(decision.effect, 'DENY');
    assert.equal(decision.policyId, undefined);
    assert.equal(decision.reason, 'no policy authorizes this action');
  });

  it('denies when the policy list is empty', () => {
    assert.equal(engine.evaluate([], input({ amount: 1 })).effect, 'DENY');
  });

  it('does not allow a refund whose amount arrived as a string', () => {
    // A numeric comparison against text is a policy bug, not an allow: the
    // rule is recorded with its error and the policy falls through to DENY.
    const decision = engine.evaluate([FINANCE_004], input({ amount: '10' }));
    assert.equal(decision.effect, 'DENY');
    const failed = decision.trace.find((entry) => entry.ruleId === 'under-500');
    assert.equal(failed?.matched, false);
    assert.match(failed?.error ?? '', /requires two numbers or two strings/);
  });

  it('does not let a later rule decide for a rule that could not be evaluated', () => {
    const ceiling: Policy = {
      id: 'FINANCE-009',
      version: 1,
      name: 'Hard ceiling, otherwise allow',
      enabled: true,
      match: { tools: ['stripe.refund'] },
      rules: [
        {
          id: 'over-1000',
          when: { gt: ['$.action.parameters.amount', 1000] },
          effect: 'DENY',
          reason: 'over the hard ceiling',
        },
        { id: 'otherwise', when: { always: true }, effect: 'ALLOW', reason: 'under the ceiling' },
      ],
      fallback: { effect: 'REQUIRE_APPROVAL', reason: 'refund could not be checked' },
    };
    const decision = engine.evaluate([ceiling], input({ amount: '50000' }));
    assert.equal(decision.effect, 'REQUIRE_APPROVAL');
    assert.equal(decision.trace.some((entry) => entry.ruleId === 'otherwise'), false);
    assert.match(decision.trace.find((entry) => entry.ruleId === 'over-1000')?.error ?? '', /two numbers/);
  });

  it('denies a rule error even when the fallback would allow', () => {
    const permissive: Policy = {
      id: 'MONITOR-001',
      version: 1,
      name: 'Permissive fallback',
      enabled: true,
      match: { tools: ['stripe.refund'] },
      rules: [
        { id: 'over-1000', when: { gt: ['$.action.parameters.amount', 1000] }, effect: 'DENY', reason: 'too large' },
      ],
      fallback: { effect: 'ALLOW', reason: 'nothing objected' },
    };
    const decision = engine.evaluate([permissive], input({ amount: '50000' }));
    assert.equal(decision.effect, 'DENY');
    assert.equal(decision.reason, 'rule over-1000 could not be evaluated');
    assert.equal(engine.evaluate([permissive], input({ amount: 10 })).effect, 'ALLOW');
  });

  it('does not allow when the governed parameter is missing entirely', () => {
    const decision = engine.evaluate([FINANCE_004], input({ parameters: { customer: 'customer_123' } }));
    assert.equal(decision.effect, 'DENY');
  });

  it('ignores a disabled policy', () => {
    const disabled: Policy = { ...FINANCE_004, enabled: false };
    assert.equal(engine.evaluate([disabled], input({ amount: 10 })).effect, 'DENY');
  });

  it('never resolves a reference through the prototype chain', () => {
    const probe: Policy = {
      ...FINANCE_004,
      id: 'PROBE-001',
      rules: [
        {
          id: 'prototype-probe',
          when: { exists: '$.action.parameters.constructor' },
          effect: 'ALLOW',
          reason: 'should never match',
        },
      ],
    };
    const decision = engine.evaluate([probe], input({ amount: 10 }));
    assert.equal(decision.effect, 'DENY');
  });
});

describe('PolicyEngine: combining policies', () => {
  const engine = new PolicyEngine();

  const allowAllRefunds: Policy = {
    id: 'AAA-PERMISSIVE',
    version: 1,
    name: 'Permissive refunds',
    enabled: true,
    match: { tools: ['stripe.*'] },
    rules: [{ id: 'allow-all', when: { always: true }, effect: 'ALLOW', reason: 'permitted by the finance team' }],
    fallback: { effect: 'ALLOW', reason: 'permitted' },
  };

  it('lets the strictest policy win, whatever order it is listed in', () => {
    const forward = engine.evaluate([allowAllRefunds, FINANCE_004], input({ amount: 4200 }));
    const reverse = engine.evaluate([FINANCE_004, allowAllRefunds], input({ amount: 4200 }));
    assert.equal(forward.effect, 'DENY');
    assert.equal(reverse.effect, 'DENY');
    assert.equal(forward.policyId, 'FINANCE-004');
    assert.equal(reverse.policyId, 'FINANCE-004');
  });

  it('cannot be loosened by adding a permissive policy', () => {
    const decision = engine.evaluate([FINANCE_004, allowAllRefunds], input({ amount: 1800 }));
    assert.equal(decision.effect, 'REQUIRE_APPROVAL');
  });

  it('records an evaluation for every policy that applied', () => {
    const decision = engine.evaluate([FINANCE_004, allowAllRefunds], input({ amount: 100 }));
    assert.equal(decision.evaluations.length, 2);
    assert.ok(decision.evaluations.every((evaluation) => evaluation.applied));
  });

  it('is deterministic when two policies produce the same effect', () => {
    const twin: Policy = { ...allowAllRefunds, id: 'ZZZ-PERMISSIVE' };
    const first = engine.evaluate([allowAllRefunds, twin], input({ amount: 100 }));
    const second = engine.evaluate([twin, allowAllRefunds], input({ amount: 100 }));
    assert.equal(first.policyId, second.policyId);
    assert.equal(first.policyId, 'AAA-PERMISSIVE');
  });
});

describe('PolicyEngine: monitor-only mode', () => {
  it('can be configured to allow unmatched actions during a rollout', () => {
    const engine = new PolicyEngine({ defaultEffect: 'ALLOW', defaultReason: 'monitor-only rollout' });
    const decision = engine.evaluate([], input({ amount: 1 }));
    assert.equal(decision.effect, 'ALLOW');
    assert.equal(decision.reason, 'monitor-only rollout');
  });
});
