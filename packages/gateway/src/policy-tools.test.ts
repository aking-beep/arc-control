import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Policy } from '@arc-control/schemas';
import { MemoryStore } from '@arc-control/store';
import { Gateway } from './gateway.js';
import { RecordingConnector } from './harness.test-support.js';
import { diffPolicies, simulateAgainstHistory, simulateHypothetical } from './policy-tools.js';

const BASE: Policy = {
  id: 'FINANCE-004',
  version: 1,
  name: 'Autonomous refund authority',
  enabled: true,
  match: { tools: ['stripe.refund'] },
  rules: [
    { id: 'under-500', when: { lt: ['$.action.parameters.amount', 500] }, effect: 'ALLOW', reason: 'within authority' },
    { id: 'over-500', when: { always: true }, effect: 'DENY', reason: 'above authority' },
  ],
  fallback: { effect: 'DENY', reason: 'no rule matched' },
};

async function setup() {
  const connector = new RecordingConnector(() => ({ refundId: 're_x' }));
  const gateway = new Gateway({ store: new MemoryStore() });
  gateway.addConnector(connector);

  await gateway.tools.register({
    name: 'stripe.refund',
    description: 'Refund a charge.',
    effect: 'irreversible',
    connector: 'recording',
    parameters: [{ name: 'amount', type: 'number', required: true, minimum: 0 }],
  });

  await gateway.admin.publishPolicy(BASE, { identifier: 'ops@example.com', via: 'api' });

  const agent = await gateway.agents.register({ name: 'finance-agent', owner: 'finance@example.com', roles: ['finance'] });
  const { apiKey } = await gateway.agents.issueKey(agent.id);
  return { gateway, connector, apiKey };
}

describe('policy diffing', () => {
  it('describes creation of a new policy', () => {
    const changes = diffPolicies(undefined, BASE);
    assert.equal(changes.length, 1);
    assert.match(changes[0]!.detail, /created at version 1 with 2 rule\(s\)/);
  });

  it('names the rule whose effect changed', () => {
    const next: Policy = {
      ...BASE,
      version: 2,
      rules: [{ ...BASE.rules[0]!, effect: 'REQUIRE_APPROVAL' }, BASE.rules[1]!],
    };

    const changes = diffPolicies(BASE, next);
    assert.deepEqual(
      changes.map((change) => ({ kind: change.kind, ruleId: change.ruleId })),
      [{ kind: 'rule_changed', ruleId: 'under-500' }],
    );
    assert.match(changes[0]!.detail, /effect ALLOW -> REQUIRE_APPROVAL/);
  });

  it('reports added and removed rules', () => {
    const next: Policy = {
      ...BASE,
      version: 2,
      rules: [BASE.rules[0]!, { id: 'new-rule', when: { always: true }, effect: 'DENY', reason: 'r' }],
    };

    const kinds = diffPolicies(BASE, next).map((change) => change.kind);
    assert.ok(kinds.includes('rule_added'));
    assert.ok(kinds.includes('rule_removed'));
  });

  it('reports a widened selector and a changed fallback', () => {
    const next: Policy = { ...BASE, version: 2, match: {}, fallback: { effect: 'ALLOW', reason: 'open' } };
    const kinds = diffPolicies(BASE, next).map((change) => change.kind);
    assert.ok(kinds.includes('match_changed'));
    assert.ok(kinds.includes('fallback_changed'));
  });

  it('notices a condition change even when the effect is unchanged', () => {
    const next: Policy = {
      ...BASE,
      version: 2,
      rules: [{ ...BASE.rules[0]!, when: { lt: ['$.action.parameters.amount', 1000] } }, BASE.rules[1]!],
    };
    assert.match(diffPolicies(BASE, next)[0]!.detail, /condition changed/);
  });
});

describe('policy version history', () => {
  it('records the first publish with its publisher', async () => {
    const { gateway } = await setup();
    const history = await gateway.policies.history('FINANCE-004');

    assert.equal(history.length, 1);
    assert.equal(history[0]!.version, 1);
    assert.equal(history[0]!.publishedBy, 'ops@example.com');
    assert.equal(history[0]!.via, 'api');
    assert.equal(history[0]!.previous, undefined);
    assert.match(history[0]!.documentDigest, /^sha256:[0-9a-f]{64}$/);
  });

  it('keeps the superseded document, so an old decision stays explainable', async () => {
    const { gateway } = await setup();
    await gateway.admin.publishPolicy(
      {
        ...BASE,
        version: 2,
        rules: [
          {
            ...BASE.rules[0]!,
            effect: 'REQUIRE_APPROVAL',
            approval: { approvers: ['role:finance-manager'], minApprovals: 1 },
          },
          BASE.rules[1]!,
        ],
      },
      { identifier: 'risk@example.com', via: 'console' },
    );

    const history = await gateway.policies.history('FINANCE-004');
    assert.equal(history.length, 2);
    assert.equal(history[0]!.version, 2, 'newest first');
    assert.equal(history[0]!.previous?.version, 1);
    assert.equal(history[0]!.previous?.rules[0]!.effect, 'ALLOW');
    assert.equal(history[0]!.changes[0]!.ruleId, 'under-500');
  });

  it('records a disable at the same version', async () => {
    const { gateway } = await setup();
    await gateway.admin.setPolicyEnabled('FINANCE-004', false, { identifier: 'ops@example.com', via: 'console' });

    const history = await gateway.policies.history('FINANCE-004');
    assert.equal(history.length, 2);
    assert.equal(history[0]!.version, 1);
    assert.equal(history[0]!.changes[0]!.kind, 'disabled');
  });

  /**
   * Regression. A disable keeps the policy's version, so two entries can share
   * a version and a millisecond; ordering on those alone was arbitrary and put
   * the disable before the creation roughly one run in eight.
   */
  it('orders same-version entries by when they were written, not arbitrarily', async () => {
    const store = new MemoryStore();
    const frozen = new Date('2026-10-20T12:00:00.000Z');
    // No tool and no connector: this test only exercises the policy history.
    const gateway = new Gateway({ store, now: () => frozen });

    await gateway.admin.publishPolicy(BASE, { identifier: 'ops@example.com', via: 'api' });
    await gateway.admin.setPolicyEnabled('FINANCE-004', false, { identifier: 'ops@example.com' });
    await gateway.admin.setPolicyEnabled('FINANCE-004', true, { identifier: 'ops@example.com' });

    const history = await gateway.policies.history('FINANCE-004');
    assert.deepEqual(
      history.map((record) => record.changes[0]!.kind),
      ['enabled', 'disabled', 'metadata_changed'],
      'every entry shares version 1 and one frozen timestamp, so only write order can separate them',
    );
  });

  it('records nothing when the enabled state is already what was asked for', async () => {
    const { gateway } = await setup();
    await gateway.admin.setPolicyEnabled('FINANCE-004', true, { identifier: 'ops@example.com' });
    assert.equal((await gateway.policies.history('FINANCE-004')).length, 1);
  });
});

describe('policy simulation', () => {
  const candidate: Policy = {
    ...BASE,
    version: 2,
    rules: [
      { id: 'under-500', when: { lt: ['$.action.parameters.amount', 100] }, effect: 'ALLOW', reason: 'tightened' },
      { id: 'over-500', when: { always: true }, effect: 'DENY', reason: 'above authority' },
    ],
  };

  it('reports what the current and candidate policies would each decide', async () => {
    const { gateway } = await setup();

    const result = await simulateHypothetical({
      store: gateway.store,
      candidate,
      subject: { agentName: 'finance-agent', tool: 'stripe.refund', parameters: { amount: 250 } },
    });

    assert.equal(result.current.effect, 'ALLOW');
    assert.equal(result.candidate.effect, 'DENY');
    assert.equal(result.changed, true);
    assert.ok(result.candidateTrace.length > 0);
  });

  it('reports no change where the candidate decides the same way', async () => {
    const { gateway } = await setup();
    const result = await simulateHypothetical({
      store: gateway.store,
      candidate,
      subject: { agentName: 'finance-agent', tool: 'stripe.refund', parameters: { amount: 50 } },
    });
    assert.equal(result.changed, false);
  });

  /**
   * The property the whole feature rests on. An operator asked "what would
   * this do?" — not "do it". A simulation that recorded an action or published
   * the candidate would be a policy change disguised as a question.
   */
  it('writes nothing: no action, no decision, no evidence, no policy, no audit', async () => {
    const { gateway } = await setup();
    const store = gateway.store;

    const before = {
      actions: await store.actions.count(),
      decisions: await store.decisions.count(),
      evidence: await store.evidence.count(),
      policies: await store.policies.count(),
      versions: await store.policyVersions.count(),
      audit: await store.audit.count(),
    };

    await simulateHypothetical({
      store,
      candidate,
      subject: { agentName: 'finance-agent', tool: 'stripe.refund', parameters: { amount: 250 } },
    });
    await simulateAgainstHistory({ store, candidate });

    assert.deepEqual(
      {
        actions: await store.actions.count(),
        decisions: await store.decisions.count(),
        evidence: await store.evidence.count(),
        policies: await store.policies.count(),
        versions: await store.policyVersions.count(),
        audit: await store.audit.count(),
      },
      before,
    );

    // And the stored policy is still the one that was published.
    assert.equal((await store.policies.get('FINANCE-004'))?.version, 1);
  });

  it('never executes a connector', async () => {
    const { gateway, connector } = await setup();
    await simulateHypothetical({
      store: gateway.store,
      candidate,
      subject: { agentName: 'finance-agent', tool: 'stripe.refund', parameters: { amount: 250 } },
    });
    assert.equal(connector.callCount(), 0);
  });

  it('refuses a subject naming an agent or tool that does not exist', async () => {
    const { gateway } = await setup();
    await assert.rejects(
      () =>
        simulateHypothetical({
          store: gateway.store,
          candidate,
          subject: { agentName: 'nope', tool: 'stripe.refund', parameters: {} },
        }),
      /no agent named "nope"/,
    );
  });
});

describe('replaying a candidate policy against recorded traffic', () => {
  const tightened: Policy = {
    ...BASE,
    version: 2,
    rules: [
      { id: 'under-500', when: { lt: ['$.action.parameters.amount', 100] }, effect: 'ALLOW', reason: 'tightened' },
      { id: 'over-500', when: { always: true }, effect: 'DENY', reason: 'above authority' },
    ],
  };

  it('names the past actions the change would have decided differently', async () => {
    const { gateway, apiKey } = await setup();
    await gateway.handle(apiKey, { tool: 'stripe.refund', parameters: { amount: 50 } });
    await gateway.handle(apiKey, { tool: 'stripe.refund', parameters: { amount: 250 } });
    await gateway.handle(apiKey, { tool: 'stripe.refund', parameters: { amount: 300 } });

    const result = await simulateAgainstHistory({ store: gateway.store, candidate: tightened });

    assert.equal(result.considered, 3);
    assert.equal(result.changes.length, 2);
    for (const change of result.changes) {
      assert.equal(change.currentEffect, 'ALLOW');
      assert.equal(change.candidateEffect, 'DENY');
    }
  });

  it('skips an action whose tool is no longer registered rather than guessing', async () => {
    const { gateway, apiKey } = await setup();
    await gateway.handle(apiKey, { tool: 'stripe.refund', parameters: { amount: 50 } });

    const tool = await gateway.store.tools.find((candidate) => candidate.name === 'stripe.refund');
    await gateway.store.tools.delete(tool!.id);

    const result = await simulateAgainstHistory({ store: gateway.store, candidate: tightened });
    assert.equal(result.considered, 0);
    assert.equal(result.skipped.length, 1);
    assert.match(result.skipped[0]!.reason, /no longer registered/);
  });

  it('states its own limitations on the result', async () => {
    const { gateway } = await setup();
    const result = await simulateAgainstHistory({ store: gateway.store, candidate: tightened });

    assert.ok(result.limitations.some((limitation) => /cannot predict traffic the change itself would cause/.test(limitation)));
    assert.ok(result.limitations.some((limitation) => /says nothing about bypass/.test(limitation)));
  });

  it('reports the window it covered', async () => {
    const { gateway } = await setup();
    const result = await simulateAgainstHistory({ store: gateway.store, candidate: tightened });
    assert.ok(Date.parse(result.from) < Date.parse(result.to));
  });
});
