import { expect } from '../harness.mjs';
import { buildHarness, refund, SEED_ACTOR } from '../fixtures.mjs';

/**
 * Budgets join the decision without loosening it (ADR-0002).
 *
 * A budget is a control over cumulative cost. The properties below are the
 * ones that make it safe to add one to a running deployment: it can refuse,
 * it can hold, it can never authorize — and nothing an agent reports about
 * itself can lift it.
 */
const spend = (gateway, agentId, amountUsd, source = 'provider') =>
  gateway.spend.record(
    { organizationId: 'default', agentId, provider: 'anthropic', amountUsd, occurredAt: new Date().toISOString() },
    source,
    source === 'provider' ? 'system:anthropic' : agentId,
  );

const budget = (gateway, body) => gateway.admin.saveBudget(body, SEED_ACTOR, { organizationId: 'default' });

export default {
  id: 'spend/budgets',
  title: 'Budgets only ever tighten',
  rationale: 'A budget can refuse or hold an action; it can never authorize one, and self-reported spend cannot lift it.',
  cases: [
    {
      name: 'an exhausted budget stops an action policy would allow, before the connector',
      async run() {
        const { gateway, connector, agent, apiKey } = await buildHarness();
        await budget(gateway, { name: 'b', agentId: agent.id, period: 'day', limitUsd: 5, onExceeded: 'DENY' });
        await spend(gateway, agent.id, 5);
        const result = await gateway.handle(apiKey, refund(10));
        expect.equal(result.outcome, 'denied', 'a $10 refund is within policy, but the budget is spent');
        expect.equal(connector.callCount(), 0, 'the refused refund must not reach the connector');
      },
    },
    {
      name: 'a budget with room to spare cannot allow what policy denies or holds',
      async run() {
        const { gateway, connector, agent, apiKey } = await buildHarness();
        await budget(gateway, { name: 'roomy', agentId: agent.id, period: 'month', limitUsd: 1_000_000, onExceeded: 'DENY' });
        const denied = await gateway.handle(apiKey, refund(5_000));
        const held = await gateway.handle(apiKey, refund(1_000));
        expect.equal(denied.outcome, 'denied', 'over the policy ceiling stays denied');
        expect.equal(held.outcome, 'pending_approval', 'within the approval band stays held');
        expect.equal(connector.callCount(), 0, 'neither may reach the connector');
      },
    },
    {
      name: 'an exhausted REQUIRE_APPROVAL budget cannot soften a policy DENY into a hold',
      async run() {
        const { gateway, connector, agent, apiKey } = await buildHarness();
        await budget(gateway, {
          name: 'hold',
          agentId: agent.id,
          period: 'day',
          limitUsd: 1,
          onExceeded: 'REQUIRE_APPROVAL',
          approvers: ['role:finance-manager'],
        });
        await spend(gateway, agent.id, 2);
        const result = await gateway.handle(apiKey, refund(5_000));
        expect.equal(result.outcome, 'denied', 'DENY is stricter than a budget hold and must stand');
        expect.equal(connector.callCount(), 0, 'nothing reaches the connector');
      },
    },
    {
      name: 'self-reported spend counts, and cannot be negative',
      async run() {
        const { gateway, connector, agent, apiKey } = await buildHarness();
        await budget(gateway, { name: 'b', agentId: agent.id, period: 'day', limitUsd: 5, onExceeded: 'DENY' });
        await expect.rejects(
          () => gateway.admin.reportSpend(
            { organizationId: 'default', agentId: agent.id, provider: 'anthropic', amountUsd: -100, occurredAt: new Date().toISOString() },
            { identifier: agent.id, via: 'api' },
          ),
          'invalid_request',
          'a negative report would lower spend',
        );
        const record = await spend(gateway, agent.id, 5, 'reported');
        expect.equal(record.verified, false, 'reported spend is marked unverified');
        expect.equal((await gateway.handle(apiKey, refund(10))).outcome, 'denied', 'unverified spend still exhausts the budget');
        expect.equal(connector.callCount(), 0, 'nothing reaches the connector');
      },
    },
    {
      name: 'a budget that cannot be read refuses rather than lifting',
      async run() {
        const { gateway, connector, apiKey } = await buildHarness();
        gateway.store.budgets.list = async () => {
          throw new Error('store unavailable');
        };
        const result = await gateway.handle(apiKey, refund(10));
        expect.equal(result.outcome, 'denied', 'an unreadable budget fails closed');
        expect.equal(connector.callCount(), 0, 'nothing reaches the connector');
      },
    },
    {
      name: 'a held action whose budget ran out while it waited is not released',
      async run() {
        const { gateway, connector, agent, apiKey } = await buildHarness();
        await budget(gateway, { name: 'b', agentId: agent.id, period: 'day', limitUsd: 5, onExceeded: 'DENY' });
        const held = await gateway.handle(apiKey, refund(1_000));
        await gateway.approvals.vote({
          approvalId: held.approvalId,
          approver: { identifier: 'cfo@example.com', roles: ['finance-manager'] },
          vote: 'approve',
        });
        await spend(gateway, agent.id, 5);
        const released = await gateway.resume(held.approvalId);
        expect.equal(released.outcome, 'denied', 'the release is re-decided against the budget as it is now');
        expect.equal(connector.callCount(), 0, 'the approved refund must not reach the connector');
      },
    },
  ],
};
