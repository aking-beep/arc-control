import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MemoryStore } from '@arc-control/store';
import { ArcError, type Agent } from '@arc-control/schemas';
import { SpendLedger } from './ledger.js';

const NOW = new Date('2026-10-27T15:00:00.000Z');

async function setup() {
  const store = new MemoryStore();
  const agent: Agent = {
    id: 'arc_ag_1',
    name: 'coder',
    kind: 'autonomous',
    status: 'active',
    organizationId: 'default',
    environment: 'production',
    owner: 'owner@example.com',
    roles: [],
    declaredTools: [],
    labels: {},
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  };
  await store.agents.put(agent.id, agent);
  const ledger = new SpendLedger(store, { now: () => NOW });
  return { store, ledger, agent };
}

const spend = (amountUsd: number, extra: Record<string, unknown> = {}) => ({
  organizationId: 'default',
  agentId: 'arc_ag_1',
  provider: 'anthropic',
  amountUsd,
  occurredAt: '2026-10-27T10:00:00.000Z',
  ...extra,
});

describe('SpendLedger: recording', () => {
  it('marks provider spend verified and reported spend unverified', async () => {
    const { ledger } = await setup();
    assert.equal((await ledger.record(spend(1), 'provider', 'system:anthropic')).verified, true);
    assert.equal((await ledger.record(spend(1), 'reported', 'arc_ag_1')).verified, false);
  });

  it('refuses a negative, non-finite or non-numeric amount, any of which could lower spend', async () => {
    const { ledger, store } = await setup();
    for (const amount of [-0.01, Number.NaN, Number.POSITIVE_INFINITY, '5' as unknown as number]) {
      await assert.rejects(ledger.record(spend(amount), 'reported', 'arc_ag_1'), (error: unknown) => {
        return error instanceof ArcError && error.code === 'invalid_request';
      });
    }
    assert.equal(await store.spend.count(), 0);
  });

  it('refuses a record dated more than a day ahead, or not dated at all', async () => {
    const { ledger } = await setup();
    await assert.rejects(ledger.record(spend(1, { occurredAt: '2026-10-29T00:00:00Z' }), 'reported', 'x'));
    await assert.rejects(ledger.record(spend(1, { occurredAt: 'yesterday' }), 'reported', 'x'));
  });

  it('replaces a provider row on re-fetch, so reading a day twice does not double it', async () => {
    const { ledger, store } = await setup();
    await ledger.record(spend(5, { reference: 'cost_report:2026-10-27:w1' }), 'provider', 'system:anthropic');
    await ledger.record(spend(7, { reference: 'cost_report:2026-10-27:w1' }), 'provider', 'system:anthropic');
    const records = await store.spend.list();
    assert.equal(records.length, 1);
    assert.equal(records[0]!.amountUsd, 7);
  });

  it('never lets a reported record replace another, whatever reference it claims', async () => {
    const { ledger, store } = await setup();
    await ledger.record(spend(50, { reference: 'r1' }), 'provider', 'system:anthropic');
    await ledger.record(spend(0, { reference: 'r1' }), 'reported', 'arc_ag_1');
    await ledger.record(spend(0, { reference: 'r1' }), 'reported', 'arc_ag_1');
    const total = (await store.spend.list()).reduce((sum, record) => sum + record.amountUsd, 0);
    assert.equal(total, 50);
    assert.equal(await store.spend.count(), 3);
  });
});

describe('SpendLedger: budgets', () => {
  it('refuses a budget that would hold actions for nobody', async () => {
    const { ledger } = await setup();
    await assert.rejects(
      ledger.saveBudget({ name: 'b', period: 'day', limitUsd: 10, onExceeded: 'REQUIRE_APPROVAL' }, { organizationId: 'default' }),
      /must name at least one approver/,
    );
  });

  it('refuses an unknown field rather than ignoring it', async () => {
    const { ledger } = await setup();
    await assert.rejects(
      ledger.saveBudget({ name: 'b', period: 'day', limitUsd: 10, onExceeded: 'DENY', efects: ['write'] }, { organizationId: 'default' }),
      /unknown field "efects"/,
    );
  });

  it('refuses a budget naming an agent that does not exist', async () => {
    const { ledger } = await setup();
    await assert.rejects(
      ledger.saveBudget({ name: 'b', agentId: 'arc_ag_x', period: 'day', limitUsd: 10, onExceeded: 'DENY' }, { organizationId: 'default' }),
      /does not exist/,
    );
  });

  it('versions a budget on every replace', async () => {
    const { ledger } = await setup();
    const first = await ledger.saveBudget({ name: 'b', period: 'day', limitUsd: 10, onExceeded: 'DENY' }, { organizationId: 'default' });
    const second = await ledger.saveBudget({ name: 'b', period: 'day', limitUsd: 20, onExceeded: 'DENY' }, { organizationId: 'default', id: first.id });
    assert.equal(first.version, 1);
    assert.equal(second.version, 2);
    assert.equal(second.id, first.id);
    assert.equal(second.createdAt, first.createdAt);
  });

  it('evaluates an exhausted budget as its effect, and one with room as not applied', async () => {
    const { ledger, agent } = await setup();
    const budget = await ledger.saveBudget(
      { name: 'daily', agentId: agent.id, period: 'day', limitUsd: 10, onExceeded: 'DENY' },
      { organizationId: 'default' },
    );
    const args = { agentId: agent.id, organizationId: 'default', toolEffect: 'write' };

    await ledger.record(spend(9.99), 'provider', 'system:anthropic');
    let { evaluations } = await ledger.evaluate(args);
    assert.equal(evaluations.length, 1);
    assert.equal(evaluations[0]!.applied, false);
    assert.equal(evaluations[0]!.policyId, `budget:${budget.id}`);

    await ledger.record(spend(0.01), 'reported', agent.id);
    ({ evaluations } = await ledger.evaluate(args));
    assert.equal(evaluations[0]!.applied, true, 'unverified spend counts: over-reporting can only tighten');
    assert.equal(evaluations[0]!.effect, 'DENY');
  });

  it('counts only the current period: yesterday does not exhaust a daily budget, but does a monthly one', async () => {
    const { ledger, agent } = await setup();
    await ledger.saveBudget({ name: 'day', agentId: agent.id, period: 'day', limitUsd: 10, onExceeded: 'DENY' }, { organizationId: 'default' });
    await ledger.saveBudget({ name: 'month', agentId: agent.id, period: 'month', limitUsd: 10, onExceeded: 'DENY' }, { organizationId: 'default' });
    await ledger.record(spend(10, { occurredAt: '2026-10-26T23:59:59Z' }), 'provider', 'system:anthropic');

    const { evaluations } = await ledger.evaluate({ agentId: agent.id, organizationId: 'default', toolEffect: 'write' });
    const byName = Object.fromEntries((await ledger.standings()).map((s) => [s.name, s.state]));
    assert.deepEqual(byName, { day: 'ok', month: 'exceeded' });
    assert.equal(evaluations.filter((evaluation) => evaluation.applied).length, 1);
  });

  it('applies an organization budget to every agent, and counts unattributed spend toward it', async () => {
    const { ledger, agent } = await setup();
    await ledger.saveBudget({ name: 'org', period: 'month', limitUsd: 100, onExceeded: 'DENY' }, { organizationId: 'default' });
    await ledger.record(spend(100, { agentId: undefined }), 'provider', 'system:anthropic');
    const { evaluations } = await ledger.evaluate({ agentId: agent.id, organizationId: 'default', toolEffect: 'read' });
    assert.equal(evaluations[0]!.effect, 'DENY');
  });

  it('gates only the effects a budget names', async () => {
    const { ledger, agent } = await setup();
    await ledger.saveBudget(
      { name: 'writes', agentId: agent.id, period: 'day', limitUsd: 1, onExceeded: 'DENY', effects: ['write', 'irreversible'] },
      { organizationId: 'default' },
    );
    await ledger.record(spend(5), 'provider', 'system:anthropic');
    const read = await ledger.evaluate({ agentId: agent.id, organizationId: 'default', toolEffect: 'read' });
    const write = await ledger.evaluate({ agentId: agent.id, organizationId: 'default', toolEffect: 'write' });
    assert.equal(read.evaluations.length, 0);
    assert.equal(write.evaluations[0]!.effect, 'DENY');
  });

  it('ignores disabled budgets and budgets of another organization', async () => {
    const { ledger, agent } = await setup();
    await ledger.saveBudget({ name: 'off', period: 'day', limitUsd: 1, onExceeded: 'DENY', enabled: false }, { organizationId: 'default' });
    await ledger.saveBudget({ name: 'other', period: 'day', limitUsd: 1, onExceeded: 'DENY' }, { organizationId: 'acme' });
    await ledger.record(spend(5), 'provider', 'system:anthropic');
    const { evaluations } = await ledger.evaluate({ agentId: agent.id, organizationId: 'default', toolEffect: 'write' });
    assert.equal(evaluations.length, 0);
  });

  it('holds rather than denies when the budget says so, naming its approvers', async () => {
    const { ledger, agent } = await setup();
    await ledger.saveBudget(
      { name: 'hold', agentId: agent.id, period: 'day', limitUsd: 1, onExceeded: 'REQUIRE_APPROVAL', approvers: ['role:finance-manager'] },
      { organizationId: 'default' },
    );
    await ledger.record(spend(1), 'provider', 'system:anthropic');
    const { evaluations } = await ledger.evaluate({ agentId: agent.id, organizationId: 'default', toolEffect: 'write' });
    assert.equal(evaluations[0]!.effect, 'REQUIRE_APPROVAL');
    assert.deepEqual(evaluations[0]!.approval?.approvers, ['role:finance-manager']);
  });

  it('denies a REQUIRE_APPROVAL budget that names nobody, if one reaches the store unvalidated', async () => {
    const { ledger, store, agent } = await setup();
    await store.budgets.put('arc_bdg_raw', {
      id: 'arc_bdg_raw',
      name: 'raw',
      organizationId: 'default',
      agentId: agent.id,
      period: 'day',
      limitUsd: 1,
      onExceeded: 'REQUIRE_APPROVAL',
      enabled: true,
      version: 1,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
    await ledger.record(spend(1), 'provider', 'system:anthropic');
    const { evaluations } = await ledger.evaluate({ agentId: agent.id, organizationId: 'default', toolEffect: 'write' });
    assert.equal(evaluations[0]!.effect, 'DENY');
  });

  it('reports spend to policy: day, month, highest budget percent, and whether any is unverified', async () => {
    const { ledger, agent } = await setup();
    await ledger.saveBudget({ name: 'm', agentId: agent.id, period: 'month', limitUsd: 20, onExceeded: 'DENY' }, { organizationId: 'default' });
    await ledger.record(spend(4, { occurredAt: '2026-10-02T00:00:00Z' }), 'provider', 'system:anthropic');
    await ledger.record(spend(6), 'reported', agent.id);
    const input = await ledger.agentInput(agent.id, 'default');
    assert.deepEqual(input, { dayUsd: 6, monthUsd: 10, maxBudgetPercent: 50, verified: false });
  });
});
