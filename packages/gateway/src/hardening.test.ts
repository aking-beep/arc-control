import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ArcError, classifyAction, type Policy } from '@arc-control/schemas';
import { MemoryStore } from '@arc-control/store';
import { Gateway, type GatewayOptions } from './gateway.js';
import { RecordingConnector } from './harness.test-support.js';

const OPEN: Policy = {
  id: 'OPEN-001',
  version: 1,
  name: 'Allow everything',
  enabled: true,
  match: {},
  rules: [{ id: 'all', when: { always: true }, effect: 'ALLOW', reason: 'permitted' }],
  fallback: { effect: 'DENY', reason: 'no rule matched' },
};

async function setup(options: Partial<GatewayOptions> = {}, policy: Policy = OPEN) {
  const connector = new RecordingConnector(() => ({ ok: true }));
  const store = new MemoryStore();
  const gateway = new Gateway({ store, ...options });
  gateway.addConnector(connector);

  const refund = await gateway.tools.register({
    name: 'stripe.refund',
    description: 'Refund a charge.',
    effect: 'irreversible',
    riskTier: 'critical',
    connector: 'recording',
    parameters: [{ name: 'amount', type: 'number', required: false, minimum: 0 }],
  });

  const read = await gateway.tools.register({
    name: 'stripe.charge.read',
    description: 'Read a charge.',
    effect: 'read',
    riskTier: 'low',
    connector: 'recording',
    parameters: [],
  });

  await gateway.admin.publishPolicy(policy, { identifier: 'ops@example.com', via: 'api' });

  const agent = await gateway.agents.register({ name: 'finance-agent', owner: 'ops@example.com', roles: ['finance'] });
  const { apiKey } = await gateway.agents.issueKey(agent.id);

  return { gateway, store, connector, apiKey, agent, refund, read };
}

describe('the agent lifecycle gate', () => {
  it('refuses a draft agent, which the old suspended-only check would have allowed', async () => {
    const { gateway } = await setup();
    const draft = await gateway.agents.register({ name: 'draft-agent', owner: 'ops@example.com', draft: true });
    const { apiKey } = await gateway.agents.issueKey(draft.id);

    await assert.rejects(
      () => gateway.handle(apiKey, { tool: 'stripe.charge.read', parameters: {} }),
      (error: ArcError) => error.code === 'agent_suspended' && /is draft and cannot act/.test(error.message),
    );
  });

  it('refuses a retired agent and revokes its keys', async () => {
    const { gateway, agent, apiKey } = await setup();
    await gateway.admin.retireAgent(agent.id, { identifier: 'ops@example.com', via: 'api' });

    await assert.rejects(
      () => gateway.handle(apiKey, { tool: 'stripe.charge.read', parameters: {} }),
      // The credential is revoked, so this fails at the credential rather than
      // the status: a retired agent's key is dead, not merely inert.
      (error: ArcError) => error.code === 'unauthenticated',
    );
  });

  it('refuses to revive a retired agent', async () => {
    const { gateway, agent } = await setup();
    await gateway.admin.retireAgent(agent.id, { identifier: 'ops@example.com' });
    await assert.rejects(() => gateway.agents.activate(agent.id), /register a new agent rather than reviving it/);
  });

  it('refuses to issue a credential to a retired agent', async () => {
    const { gateway, agent } = await setup();
    await gateway.admin.retireAgent(agent.id, { identifier: 'ops@example.com' });
    await assert.rejects(() => gateway.agents.issueKey(agent.id), /retired and cannot be issued a credential/);
  });

  it('clears a draft agent to act once activated', async () => {
    const { gateway } = await setup();
    const draft = await gateway.agents.register({ name: 'draft-agent', owner: 'ops@example.com', draft: true });
    const { apiKey } = await gateway.agents.issueKey(draft.id);

    await gateway.agents.activate(draft.id);
    const result = await gateway.handle(apiKey, { tool: 'stripe.charge.read', parameters: {} });
    assert.equal(result.outcome, 'executed');
  });
});

describe('the tool kill switch', () => {
  it('refuses a disabled tool before any policy is consulted', async () => {
    const { gateway, refund, apiKey, connector } = await setup();
    await gateway.admin.setToolDisabled(refund.id, true, { identifier: 'ops@example.com' }, 'suspected runaway');

    await assert.rejects(
      () => gateway.handle(apiKey, { tool: 'stripe.refund', parameters: { amount: 10 } }),
      (error: ArcError) => error.code === 'tool_disabled',
    );
    assert.equal(connector.callCount(), 0);
  });

  /**
   * The property that makes the switch worth having: a policy that allows
   * everything cannot talk ARC into running a disabled tool, because the
   * refusal happens before evaluation.
   */
  it('cannot be overridden by an allow-everything policy', async () => {
    const { gateway, refund, apiKey } = await setup();
    await gateway.admin.setToolDisabled(refund.id, true, { identifier: 'ops@example.com' });

    const decisionsBefore = await gateway.store.decisions.count();
    await assert.rejects(() => gateway.handle(apiKey, { tool: 'stripe.refund', parameters: {} }));
    assert.equal(await gateway.store.decisions.count(), decisionsBefore, 'no decision should have been reached');
  });

  it('records who disabled it, when, and why', async () => {
    const { gateway, refund } = await setup();
    const tool = await gateway.admin.setToolDisabled(
      refund.id,
      true,
      { identifier: 'secops@example.com', via: 'console' },
      'duplicate refunds observed',
    );

    assert.equal(tool.disabled, true);
    assert.equal(tool.disabledBy, 'secops@example.com');
    assert.equal(tool.disabledReason, 'duplicate refunds observed');
    assert.ok(tool.disabledAt);

    const audit = await gateway.audit.read({ limit: 50 });
    const entry = audit.find((record) => record.type === 'tool.disabled');
    assert.ok(entry);
    assert.match(entry!.summary, /duplicate refunds observed/);
  });

  it('re-enables cleanly', async () => {
    const { gateway, refund, apiKey } = await setup();
    await gateway.admin.setToolDisabled(refund.id, true, { identifier: 'ops@example.com' });
    const reenabled = await gateway.admin.setToolDisabled(refund.id, false, { identifier: 'ops@example.com' });

    assert.equal(reenabled.disabled, false);
    assert.equal(reenabled.disabledBy, undefined);
    assert.equal((await gateway.handle(apiKey, { tool: 'stripe.refund', parameters: {} })).outcome, 'executed');
  });
});

describe('the connector kill switch', () => {
  it('disables every tool the connector runs', async () => {
    const { gateway, apiKey } = await setup();
    const affected = await gateway.admin.setConnectorDisabled(
      'recording',
      true,
      { identifier: 'ops@example.com' },
      'connector compromised',
    );

    assert.equal(affected.length, 2);
    for (const name of ['stripe.refund', 'stripe.charge.read']) {
      await assert.rejects(
        () => gateway.handle(apiKey, { tool: name, parameters: {} }),
        (error: ArcError) => error.code === 'tool_disabled',
      );
    }
  });

  it('survives a restart, because the state is on the tools', async () => {
    const { gateway, store } = await setup();
    await gateway.admin.setConnectorDisabled('recording', true, { identifier: 'ops@example.com' });

    // A second gateway over the same store is the restart.
    const revived = new Gateway({ store });
    revived.addConnector(new RecordingConnector());
    const tools = await revived.tools.list();
    assert.ok(tools.every((tool) => tool.disabled === true));
  });

  it('audits the gap it leaves, rather than implying there is none', async () => {
    const { gateway } = await setup();
    await gateway.admin.setConnectorDisabled('recording', true, { identifier: 'ops@example.com' });

    const audit = await gateway.audit.read({ limit: 50 });
    const entry = audit.find((record) => record.type === 'connector.disabled');
    assert.match(
      String(entry!.data.limitation),
      /a tool registered on this connector after this change is not covered by it/,
    );
  });
});

describe('rate limiting', () => {
  it('is off unless configured, so an upgrade does not start refusing traffic', async () => {
    const { gateway, apiKey } = await setup();
    assert.equal(gateway.rateLimiter.configured, false);

    for (let index = 0; index < 20; index += 1) {
      assert.equal((await gateway.handle(apiKey, { tool: 'stripe.charge.read', parameters: {} })).outcome, 'executed');
    }
  });

  it('refuses an agent over its overall limit', async () => {
    const { gateway, apiKey } = await setup({ rateLimit: { default: { windowSeconds: 60, maxActions: 3 } } });

    for (let index = 0; index < 3; index += 1) {
      await gateway.handle(apiKey, { tool: 'stripe.charge.read', parameters: {} });
    }

    await assert.rejects(
      () => gateway.handle(apiKey, { tool: 'stripe.charge.read', parameters: {} }),
      (error: ArcError) => error.code === 'rate_limited' && /3 actions in the last 60 seconds/.test(error.message),
    );
  });

  it('applies a tighter ceiling to irreversible tools', async () => {
    const { gateway, apiKey } = await setup({
      rateLimit: { default: { windowSeconds: 60, maxActions: 100, maxIrreversibleActions: 2 } },
    });

    await gateway.handle(apiKey, { tool: 'stripe.refund', parameters: { amount: 1 } });
    await gateway.handle(apiKey, { tool: 'stripe.refund', parameters: { amount: 2 } });

    // Reads are unaffected by the irreversible ceiling.
    assert.equal((await gateway.handle(apiKey, { tool: 'stripe.charge.read', parameters: {} })).outcome, 'executed');

    await assert.rejects(
      () => gateway.handle(apiKey, { tool: 'stripe.refund', parameters: { amount: 3 } }),
      (error: ArcError) => error.code === 'rate_limited' && /irreversible actions/.test(error.message),
    );
  });

  /**
   * A refused action must not count toward the limit, or one runaway agent
   * locks itself out for the whole window and the operator cannot tell a
   * rate-limited agent from a broken one.
   */
  it('does not record a refused action, so a refusal cannot compound', async () => {
    const { gateway, apiKey, store } = await setup({ rateLimit: { default: { windowSeconds: 60, maxActions: 2 } } });

    await gateway.handle(apiKey, { tool: 'stripe.charge.read', parameters: {} });
    await gateway.handle(apiKey, { tool: 'stripe.charge.read', parameters: {} });
    await assert.rejects(() => gateway.handle(apiKey, { tool: 'stripe.charge.read', parameters: {} }));
    await assert.rejects(() => gateway.handle(apiKey, { tool: 'stripe.charge.read', parameters: {} }));

    assert.equal(await store.actions.count(), 2);
  });

  it('audits the refusal and never reaches a connector', async () => {
    const { gateway, apiKey, connector } = await setup({ rateLimit: { default: { windowSeconds: 60, maxActions: 1 } } });

    await gateway.handle(apiKey, { tool: 'stripe.charge.read', parameters: {} });
    const callsAfterFirst = connector.callCount();
    await assert.rejects(() => gateway.handle(apiKey, { tool: 'stripe.charge.read', parameters: {} }));

    assert.equal(connector.callCount(), callsAfterFirst);
    const audit = await gateway.audit.read({ limit: 50 });
    assert.ok(audit.some((record) => String(record.data.code) === 'rate_limited'));
  });

  it('honours a per-agent override', async () => {
    const { gateway, apiKey } = await setup({
      rateLimit: { default: { windowSeconds: 60, maxActions: 1 }, byAgent: { 'finance-agent': { windowSeconds: 60, maxActions: 5 } } },
    });

    for (let index = 0; index < 5; index += 1) {
      await gateway.handle(apiKey, { tool: 'stripe.charge.read', parameters: {} });
    }
    await assert.rejects(() => gateway.handle(apiKey, { tool: 'stripe.charge.read', parameters: {} }));
  });
});

describe('action risk classification', () => {
  it('is recorded on the evidence record', async () => {
    const { gateway, apiKey } = await setup();
    const result = await gateway.handle(apiKey, { tool: 'stripe.refund', parameters: { amount: 100 } });
    const record = await gateway.evidence(result.evidenceId);

    assert.ok(record!.risk);
    assert.equal(record!.risk!.reversibility, 'irreversible');
    assert.equal(record!.risk!.class, 'severe');
    assert.equal(record!.risk!.sensitive, true);
    assert.ok(record!.risk!.factors.length > 0);
  });

  it('is available to policy as $.action.risk', async () => {
    const guarded: Policy = {
      id: 'RISK-001',
      version: 1,
      name: 'Hold severe actions',
      enabled: true,
      match: {},
      rules: [
        {
          id: 'severe-needs-human',
          when: { eq: ['$.action.risk.class', 'severe'] },
          effect: 'REQUIRE_APPROVAL',
          reason: 'classified severe',
          approval: { approvers: ['role:finance-manager'], minApprovals: 1 },
        },
        { id: 'rest', when: { always: true }, effect: 'ALLOW', reason: 'routine' },
      ],
      fallback: { effect: 'DENY', reason: 'no rule matched' },
    };

    const { gateway, apiKey } = await setup({}, guarded);

    const refund = await gateway.handle(apiKey, { tool: 'stripe.refund', parameters: { amount: 100 } });
    assert.equal(refund.outcome, 'pending_approval');
    assert.equal(refund.decision.ruleId, 'severe-needs-human');

    const read = await gateway.handle(apiKey, { tool: 'stripe.charge.read', parameters: {} });
    assert.equal(read.outcome, 'executed');
    assert.equal(read.decision.ruleId, 'rest');
  });

  /**
   * The classification is advisory. It is read by policy and written to
   * evidence; it is never consulted to permit anything. A DENY policy stays a
   * DENY however routine the action classifies.
   */
  it('cannot authorize anything on its own', async () => {
    const closed: Policy = {
      id: 'CLOSED-001',
      version: 1,
      name: 'Deny everything',
      enabled: true,
      match: {},
      rules: [{ id: 'none', when: { always: true }, effect: 'DENY', reason: 'denied by policy' }],
      fallback: { effect: 'DENY', reason: 'no rule matched' },
    };

    const { gateway, apiKey, connector } = await setup({}, closed);

    // The most routine action available: a read on a low-risk tool.
    assert.equal(classifyAction({ effect: 'read', riskTier: 'low', parameters: {} }).class, 'routine');

    const result = await gateway.handle(apiKey, { tool: 'stripe.charge.read', parameters: {} });
    assert.equal(result.outcome, 'denied');
    assert.equal(connector.callCount(), 0);
  });

  /**
   * Asserted on the factor rather than the resulting class: `stripe.refund`
   * is already irreversible and critical, so it is severe either way. The
   * question here is whether the amount contributed, and why.
   */
  it('escalates on a configured monetary threshold and not otherwise', async () => {
    const withoutThreshold = await setup();
    const low = await withoutThreshold.gateway.handle(withoutThreshold.apiKey, {
      tool: 'stripe.refund',
      parameters: { amount: 1_000_000 },
    });
    const record = await withoutThreshold.gateway.evidence(low.evidenceId);
    const monetary = record!.risk!.factors.find((factor) => factor.code === 'monetary_amount');
    assert.equal(monetary!.escalation, 0);
    assert.match(monetary!.detail, /no escalation threshold is configured/);

    const withThreshold = await setup({ classification: { monetaryEscalationThreshold: 500 } });
    const high = await withThreshold.gateway.handle(withThreshold.apiKey, {
      tool: 'stripe.refund',
      parameters: { amount: 1000 },
    });
    const escalated = await withThreshold.gateway.evidence(high.evidenceId);
    assert.equal(
      escalated!.risk!.factors.find((factor) => factor.code === 'monetary_amount')!.escalation,
      1,
    );
  });
});
