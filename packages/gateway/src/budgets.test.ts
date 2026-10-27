import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Policy } from '@arc-control/schemas';
import { MemoryStore } from '@arc-control/store';
import { Gateway } from './gateway.js';
import { RecordingConnector } from './harness.test-support.js';

/**
 * Budgets on the decision path (ADR-0002).
 *
 * Every refusal claimed here is checked at the connector, because a
 * response that says "denied" and a charge that did not happen are
 * different statements.
 */

const NOW = new Date('2026-10-27T15:00:00.000Z');

const ALLOW_DEPLOY: Policy = {
  id: 'DEPLOY-001',
  version: 1,
  name: 'Deploys allowed',
  enabled: true,
  match: { tools: ['ci.deploy', 'ci.status'] },
  rules: [{ id: 'always', when: { always: true }, effect: 'ALLOW', reason: 'deploys are allowed' }],
  fallback: { effect: 'DENY', reason: 'no rule matched' },
};

const operator = { identifier: 'ops@example.com', via: 'api' } as const;

async function setup() {
  const store = new MemoryStore();
  const connector = new RecordingConnector();
  const gateway = new Gateway({ store, now: () => NOW });
  gateway.addConnector(connector);

  for (const [name, effect] of [
    ['ci.deploy', 'write'],
    ['ci.status', 'read'],
    ['ci.unpoliced', 'write'],
  ] as const) {
    await gateway.tools.register({
      name,
      description: name,
      effect,
      riskTier: 'medium',
      connector: 'recording',
      parameters: [],
    });
  }
  await gateway.admin.publishPolicy(ALLOW_DEPLOY, operator);

  const agent = await gateway.agents.register({ name: 'coder', owner: 'owner@example.com', roles: ['engineer'] });
  const { apiKey } = await gateway.agents.issueKey(agent.id);
  const spend = (amountUsd: number) =>
    gateway.spend.record(
      { organizationId: 'default', agentId: agent.id, provider: 'anthropic', amountUsd, occurredAt: NOW.toISOString() },
      'provider',
      'system:anthropic',
    );
  const deploy = () => gateway.handle(apiKey, { tool: 'ci.deploy', parameters: {} });

  return { store, gateway, connector, agent, apiKey, spend, deploy };
}

describe('budgets: enforcement', () => {
  it('decides exactly as before when no budget exists', async () => {
    const { deploy, connector, spend, store } = await setup();
    await spend(10_000);
    const result = await deploy();
    assert.equal(result.outcome, 'executed');
    assert.equal(connector.callCount('ci.deploy'), 1);
    const [decision] = await store.decisions.filter((d) => d.actionId === result.actionId);
    assert.equal(decision?.evaluations.length, 1, 'no budget evaluations to fold');
  });

  it('denies once spend reaches the limit, and the connector is not called', async () => {
    const { gateway, deploy, connector, agent, spend } = await setup();
    const budget = await gateway.spend.saveBudget(
      { name: 'coder daily', agentId: agent.id, period: 'day', limitUsd: 25, onExceeded: 'DENY' },
      { organizationId: 'default' },
    );

    await spend(24.99);
    assert.equal((await deploy()).outcome, 'executed');

    await spend(0.01);
    const refused = await deploy();
    assert.equal(refused.outcome, 'denied');
    assert.equal(refused.decision.policyId, `budget:${budget.id}`);
    const [decision] = await gateway.store.decisions.filter((d) => d.actionId === refused.actionId);
    assert.equal(decision?.policyVersion, budget.version);
    assert.ok(decision?.trace.some((entry) => entry.policyId === `budget:${budget.id}` && entry.matched));
    assert.match(refused.decision.reason, /coder daily.*exhausted/);
    assert.equal(connector.callCount('ci.deploy'), 1, 'only the deploy before the limit reached the connector');
  });

  it('leaves evidence for the refusal, citing the budget', async () => {
    const { gateway, deploy, agent, spend } = await setup();
    const budget = await gateway.spend.saveBudget(
      { name: 'b', agentId: agent.id, period: 'day', limitUsd: 1, onExceeded: 'DENY' },
      { organizationId: 'default' },
    );
    await spend(1);
    const refused = await deploy();
    const evidence = await gateway.evidence(refused.evidenceId);
    assert.equal(evidence?.outcome, 'denied');
    assert.equal(evidence?.decision.policyId, `budget:${budget.id}`);
  });

  it('holds for approval when the budget says so, and executes only once a human approves', async () => {
    const { gateway, deploy, connector, agent, spend } = await setup();
    await gateway.spend.saveBudget(
      { name: 'hold', agentId: agent.id, period: 'day', limitUsd: 1, onExceeded: 'REQUIRE_APPROVAL', approvers: ['role:eng-manager'] },
      { organizationId: 'default' },
    );
    await spend(2);
    const held = await deploy();
    assert.equal(held.outcome, 'pending_approval');
    assert.equal(connector.callCount('ci.deploy'), 0);

    await gateway.approvals.vote({
      approvalId: held.approvalId!,
      approver: { identifier: 'lead@example.com', roles: ['eng-manager'] },
      vote: 'approve',
    });
    const released = await gateway.resume(held.approvalId!);
    assert.equal(released.outcome, 'executed');
    assert.equal(connector.callCount('ci.deploy'), 1);
  });

  it('cannot make an action possible that policy refuses: no policy covers ci.unpoliced', async () => {
    const { gateway, apiKey, connector, agent } = await setup();
    await gateway.spend.saveBudget(
      { name: 'roomy', agentId: agent.id, period: 'month', limitUsd: 1_000, onExceeded: 'REQUIRE_APPROVAL', approvers: ['owner'] },
      { organizationId: 'default' },
    );
    const result = await gateway.handle(apiKey, { tool: 'ci.unpoliced', parameters: {} });
    assert.equal(result.outcome, 'denied');
    assert.equal(connector.callCount('ci.unpoliced'), 0);
  });

  it('lets an agent over a write-only budget still read', async () => {
    const { gateway, apiKey, deploy, connector, agent, spend } = await setup();
    await gateway.spend.saveBudget(
      { name: 'writes', agentId: agent.id, period: 'day', limitUsd: 1, onExceeded: 'DENY', effects: ['write', 'irreversible'] },
      { organizationId: 'default' },
    );
    await spend(5);
    assert.equal((await gateway.handle(apiKey, { tool: 'ci.status', parameters: {} })).outcome, 'executed');
    assert.equal((await deploy()).outcome, 'denied');
    assert.equal(connector.callCount('ci.status'), 1);
    assert.equal(connector.callCount('ci.deploy'), 0);
  });

  it('re-decides a held action at release against the budget as it is now', async () => {
    const { gateway, deploy, connector, agent, spend, store } = await setup();
    // Policy holds deploys for a human; the budget is not yet exhausted.
    await gateway.admin.publishPolicy(
      {
        ...ALLOW_DEPLOY,
        version: 2,
        rules: [
          {
            id: 'hold',
            when: { always: true },
            effect: 'REQUIRE_APPROVAL',
            reason: 'a lead approves deploys',
            approval: { approvers: ['role:eng-manager'] },
          },
        ],
      },
      operator,
    );
    await gateway.spend.saveBudget(
      { name: 'b', agentId: agent.id, period: 'day', limitUsd: 10, onExceeded: 'DENY' },
      { organizationId: 'default' },
    );
    const held = await deploy();
    assert.equal(held.outcome, 'pending_approval');
    await gateway.approvals.vote({
      approvalId: held.approvalId!,
      approver: { identifier: 'lead@example.com', roles: ['eng-manager'] },
      vote: 'approve',
    });

    await spend(10); // the budget runs out while the action waits
    const released = await gateway.resume(held.approvalId!);
    assert.equal(released.outcome, 'denied');
    assert.equal(connector.callCount('ci.deploy'), 0);
    const approval = await store.approvals.get(held.approvalId!);
    assert.notEqual(approval?.status, 'consumed', 'a refused release does not spend the approval');
  });

  it('fails closed when budget state cannot be read', async () => {
    const { gateway, deploy, connector, store } = await setup();
    const broken = store.budgets.list.bind(store.budgets);
    store.budgets.list = async () => {
      void broken;
      throw new Error('disk on fire');
    };
    const result = await deploy();
    assert.equal(result.outcome, 'denied');
    assert.equal(result.decision.policyId, 'budget:unavailable');
    assert.equal(connector.callCount('ci.deploy'), 0);
    assert.ok(gateway);
  });

  it('explain folds budgets the same way submit does', async () => {
    const { gateway, agent, apiKey, spend } = await setup();
    await gateway.spend.saveBudget(
      { name: 'b', agentId: agent.id, period: 'day', limitUsd: 1, onExceeded: 'DENY' },
      { organizationId: 'default' },
    );
    await spend(1);
    const principal = await gateway.agents.authenticate(apiKey);
    const explained = await gateway.explain(principal, { tool: 'ci.deploy', parameters: {} });
    assert.equal(explained.effect, 'DENY');
  });
});

describe('budgets: spend as policy input', () => {
  it('lets a policy hold actions as a budget fills up, via $.agent.spend.maxBudgetPercent', async () => {
    const { gateway, deploy, connector, agent, spend } = await setup();
    await gateway.admin.publishPolicy(
      {
        ...ALLOW_DEPLOY,
        version: 2,
        rules: [
          {
            id: 'nearly-spent',
            when: { gte: ['$.agent.spend.maxBudgetPercent', 80] },
            effect: 'REQUIRE_APPROVAL',
            reason: 'over 80% of budget: a lead approves further deploys',
            approval: { approvers: ['role:eng-manager'] },
          },
          { id: 'otherwise', when: { always: true }, effect: 'ALLOW', reason: 'within budget' },
        ],
      },
      operator,
    );
    await gateway.spend.saveBudget(
      { name: 'b', agentId: agent.id, period: 'month', limitUsd: 100, onExceeded: 'DENY' },
      { organizationId: 'default' },
    );
    await spend(79);
    assert.equal((await deploy()).outcome, 'executed');
    await spend(1);
    const held = await deploy();
    assert.equal(held.outcome, 'pending_approval');
    assert.equal(held.decision.ruleId, 'nearly-spent');
    assert.equal(connector.callCount('ci.deploy'), 1);
  });
});

describe('ARC-SEC-013: a policy hold and a budget hold both need their approvers', () => {
  async function held() {
    const ctx = await setup();
    await ctx.gateway.admin.publishPolicy(
      {
        ...ALLOW_DEPLOY,
        version: 2,
        rules: [
          { id: 'hold', when: { always: true }, effect: 'REQUIRE_APPROVAL', reason: 'a lead approves deploys', approval: { approvers: ['role:eng-manager'] } },
        ],
      },
      operator,
    );
    await ctx.gateway.spend.saveBudget(
      { name: 'b', agentId: ctx.agent.id, period: 'day', limitUsd: 1, onExceeded: 'REQUIRE_APPROVAL', approvers: ['role:finance-manager'] },
      { organizationId: 'default' },
    );
    return ctx;
  }
  const lead = { identifier: 'lead@example.com', roles: ['eng-manager'] };
  const cfo = { identifier: 'cfo@example.com', roles: ['finance-manager'] };

  it('does not release on the policy approver alone; releases once finance also approves', async () => {
    const { gateway, deploy, connector, spend } = await held();
    await spend(5);
    const pending = await deploy();
    assert.equal(pending.outcome, 'pending_approval');

    const afterLead = await gateway.approvals.vote({ approvalId: pending.approvalId!, approver: lead, vote: 'approve' });
    assert.equal(afterLead.status, 'pending');
    await assert.rejects(gateway.resume(pending.approvalId!));
    assert.equal(connector.callCount('ci.deploy'), 0);

    await gateway.approvals.vote({ approvalId: pending.approvalId!, approver: cfo, vote: 'approve' });
    assert.equal((await gateway.resume(pending.approvalId!)).outcome, 'executed');
    assert.equal(connector.callCount('ci.deploy'), 1);
  });

  it('a grant approved before the budget ran out does not release once the budget holds too', async () => {
    const { gateway, deploy, connector, spend } = await held();
    const pending = await deploy();
    await gateway.approvals.vote({ approvalId: pending.approvalId!, approver: lead, vote: 'approve' });
    await spend(5);
    const released = await gateway.resume(pending.approvalId!);
    assert.notEqual(released.outcome, 'executed');
    assert.equal(connector.callCount('ci.deploy'), 0);
    const evidence = await gateway.evidence(released.evidenceId);
    const reason = evidence?.revalidation?.reason ?? '';
    assert.match(reason, /role:finance-manager/, 'the reason names the approvers still needed');
    assert.doesNotMatch(reason, /separation of duties/);
  });
});
