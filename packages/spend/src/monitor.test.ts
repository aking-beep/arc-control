import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MemoryStore } from '@arc-control/store';
import type { Agent, SpendRecord } from '@arc-control/schemas';
import { SpendLedger } from './ledger.js';
import { detectSpikes, SpendMonitor, type MonitorAuditEvent } from './monitor.js';
import { AnthropicCostProvider } from './providers/anthropic.js';
import type { SpendProvider } from './providers/provider.js';

const NOW = new Date('2026-10-27T15:00:00.000Z');
const RULE = { multiplier: 3, minimumUsd: 20, baselineDays: 7 };

function record(agentId: string | undefined, amountUsd: number, occurredAt: string): SpendRecord {
  return {
    id: `${agentId}-${occurredAt}`,
    organizationId: 'default',
    ...(agentId ? { agentId } : {}),
    provider: 'anthropic',
    amountUsd,
    occurredAt,
    recordedAt: occurredAt,
    source: 'provider',
    verified: true,
    recordedBy: 'system:anthropic',
  };
}

describe('detectSpikes', () => {
  it('flags a day well above the agent own baseline', () => {
    const records = [
      ...Array.from({ length: 7 }, (_, day) => record('a', 10, `2026-10-${String(20 + day).padStart(2, '0')}T12:00:00Z`)),
      record('a', 31, '2026-10-27T09:00:00Z'),
    ];
    const [incident] = detectSpikes(records, NOW, RULE);
    assert.equal(incident?.agentId, 'a');
    assert.equal(incident?.baselineUsd, 10);
  });

  it('does not flag a busy day within the multiplier, or a spike below the minimum', () => {
    const busy = [record('a', 10, '2026-10-26T12:00:00Z'), record('a', 25, '2026-10-27T09:00:00Z')];
    assert.equal(detectSpikes(busy, NOW, { ...RULE, baselineDays: 1 }).length, 0);
    assert.equal(detectSpikes([record('b', 19.99, '2026-10-27T09:00:00Z')], NOW, RULE).length, 0);
  });

  it('judges an agent with no history on the minimum alone', () => {
    assert.equal(detectSpikes([record('new', 20, '2026-10-27T09:00:00Z')], NOW, RULE).length, 1);
  });

  it('ignores unattributed spend, which belongs to no agent to suspend', () => {
    assert.equal(detectSpikes([record(undefined, 500, '2026-10-27T09:00:00Z')], NOW, RULE).length, 0);
  });
});

async function monitorSetup(provider: SpendProvider, onSpike: 'record' | 'suspend' = 'suspend') {
  const store = new MemoryStore();
  const agent: Agent = {
    id: 'arc_ag_1',
    name: 'coder',
    kind: 'autonomous',
    status: 'active',
    organizationId: 'default',
    environment: 'production',
    owner: 'o@example.com',
    roles: [],
    declaredTools: [],
    labels: {},
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  };
  await store.agents.put(agent.id, agent);
  const ledger = new SpendLedger(store, { now: () => NOW });
  const events: MonitorAuditEvent[] = [];
  const suspended: string[] = [];
  const monitor = new SpendMonitor({
    store,
    ledger,
    providers: [provider],
    organizationId: 'default',
    attribution: { 'workspace:w1': 'coder' },
    spike: RULE,
    onSpike,
    audit: async (event) => events.push(event),
    suspend: async (agentId) => {
      suspended.push(agentId);
      await store.agents.put(agentId, { ...agent, status: 'suspended' });
    },
    now: () => NOW,
  });
  return { store, monitor, events, suspended };
}

const rows = (amount: number) => ({
  name: 'anthropic',
  fetch: async () => [
    { reference: 'cost_report:2026-10-27:w1', occurredAt: '2026-10-27T00:00:00.000Z', amountUsd: amount, attribution: 'workspace:w1' },
    { reference: 'cost_report:2026-10-27:w9', occurredAt: '2026-10-27T00:00:00.000Z', amountUsd: 1, attribution: 'workspace:w9' },
  ],
});

describe('SpendMonitor', () => {
  it('records provider spend as verified, attributes what it can, and keeps the rest as organization spend', async () => {
    const { store, monitor } = await monitorSetup(rows(5));
    const result = await monitor.tick();
    assert.equal(result.ingested, 2);
    const records = await store.spend.list();
    assert.ok(records.every((r) => r.verified && r.source === 'provider'));
    assert.deepEqual(records.map((r) => r.agentId ?? null).sort(), ['arc_ag_1', null]);
  });

  it('is idempotent across ticks', async () => {
    const { store, monitor } = await monitorSetup(rows(5));
    await monitor.tick();
    await monitor.tick();
    assert.equal(await store.spend.count(), 2);
  });

  it('suspends an agent on a spike, once per day, and audits it', async () => {
    const { monitor, events, suspended } = await monitorSetup(rows(50));
    const first = await monitor.tick();
    const second = await monitor.tick();
    assert.deepEqual(first.suspended, ['arc_ag_1']);
    assert.deepEqual(second.incidents, []);
    assert.deepEqual(suspended, ['arc_ag_1']);
    assert.equal(events.filter((event) => event.type === 'spend.incident').length, 1);
  });

  it('only records a spike when told to, and never suspends', async () => {
    const { monitor, suspended } = await monitorSetup(rows(50), 'record');
    const result = await monitor.tick();
    assert.equal(result.incidents.length, 1);
    assert.deepEqual(suspended, []);
  });

  it('reports and audits a provider it cannot read, without recording zero spend', async () => {
    const failing: SpendProvider = { name: 'anthropic', fetch: async () => { throw new Error('HTTP 503'); } };
    const { store, monitor, events } = await monitorSetup(failing);
    const result = await monitor.tick();
    assert.deepEqual(result.failures, [{ provider: 'anthropic', error: 'HTTP 503' }]);
    assert.equal(await store.spend.count(), 0);
    assert.equal(events[0]?.data.ok, false);
  });
});

describe('AnthropicCostProvider', () => {
  function fake(pages: readonly unknown[], seen: string[] = []) {
    let index = 0;
    return (async (url: string | URL, init?: RequestInit) => {
      seen.push(String(url));
      assert.equal((init?.headers as Record<string, string>)['x-api-key'], 'sk-ant-admin-test');
      const body = pages[index++];
      return new Response(JSON.stringify(body), { status: body === undefined ? 500 : 200 });
    }) as typeof globalThis.fetch;
  }
  const window = { start: new Date('2026-10-01T00:00:00Z'), end: NOW };

  it('reads cents as dollars, one record per day per workspace, across pages', async () => {
    const seen: string[] = [];
    const provider = new AnthropicCostProvider({
      adminKey: 'sk-ant-admin-test',
      fetch: fake(
        [
          {
            data: [{ starting_at: '2026-10-26T00:00:00Z', results: [{ amount: '1234.5', currency: 'USD', workspace_id: 'w1' }, { amount: '100', currency: 'USD', workspace_id: 'w1' }] }],
            has_more: true,
            next_page: 'page_2',
          },
          { data: [{ starting_at: '2026-10-27T00:00:00Z', results: [{ amount: '50', currency: 'USD', workspace_id: null }] }], has_more: false, next_page: null },
        ],
        seen,
      ),
    });
    const result = await provider.fetch(window);
    assert.deepEqual(
      result.map((row) => [row.reference, row.amountUsd, row.attribution]),
      [
        ['cost_report:2026-10-26:w1', 13.345, 'workspace:w1'],
        ['cost_report:2026-10-27:default', 0.5, 'workspace:default'],
      ],
    );
    assert.match(seen[0]!, /\/v1\/organizations\/cost_report\?/);
    assert.match(seen[1]!, /page=page_2/);
  });

  // A negative row is a credit and is skipped (ARC-SEC-011, below), so it no
  // longer appears here; every case that would under-count still fails.
  it('fails the whole fetch on an HTTP error, a non-USD row or a bad amount, rather than under-counting', async () => {
    const bucket = (result: unknown) => ({ data: [{ starting_at: '2026-10-26T00:00:00Z', results: [result] }], has_more: false });
    for (const pages of [[undefined], [bucket({ amount: '1', currency: 'EUR' })], [bucket({ amount: 'abc', currency: 'USD' })], [bucket({ currency: 'USD' })]]) {
      const provider = new AnthropicCostProvider({ adminKey: 'sk-ant-admin-test', fetch: fake(pages) });
      await assert.rejects(provider.fetch(window));
    }
  });

  it('refuses a cursor that never ends', async () => {
    const endless = { data: [], has_more: true, next_page: 'again' };
    const provider = new AnthropicCostProvider({ adminKey: 'sk-ant-admin-test', maxPages: 3, fetch: fake([endless, endless, endless, endless]) });
    await assert.rejects(provider.fetch(window), /did not finish within 3 pages/);
  });
});

describe('review findings', () => {
  it('ARC-SEC-005: unverified spend does not count toward a spike baseline', () => {
    const planted = { ...record('a', 5000, '2026-10-26T00:00:00Z'), source: 'reported' as const, verified: false };
    const runaway = record('a', 900, '2026-10-27T09:00:00Z');
    assert.equal(detectSpikes([planted, runaway], NOW, RULE).length, 1);
  });

  it('ARC-SEC-011: the cost report fails closed on a missing amount and on a cursor-less has_more, and skips credits', async () => {
    const window = { start: new Date('2026-10-01T00:00:00Z'), end: NOW };
    const page = (body: unknown) => (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof globalThis.fetch;
    const bucket = (results: unknown[]) => ({ data: [{ starting_at: '2026-10-26T00:00:00Z', results }], has_more: false });
    await assert.rejects(new AnthropicCostProvider({ adminKey: 'k', fetch: page(bucket([{ currency: 'USD' }])) }).fetch(window));
    await assert.rejects(new AnthropicCostProvider({ adminKey: 'k', fetch: page(bucket([{ amount: ' ', currency: 'USD' }])) }).fetch(window));
    await assert.rejects(new AnthropicCostProvider({ adminKey: 'k', fetch: page({ data: [], has_more: true, next_page: null }) }).fetch(window));
    const credited = await new AnthropicCostProvider({
      adminKey: 'k',
      fetch: page(bucket([{ amount: '1000', currency: 'USD', workspace_id: 'w' }, { amount: '-400', currency: 'USD', workspace_id: 'w' }])),
    }).fetch(window);
    assert.equal(credited[0]?.amountUsd, 10, 'a credit is ignored, which can only over-count');
  });
});
