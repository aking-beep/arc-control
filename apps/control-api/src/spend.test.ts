import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MemoryStore } from '@arc-control/store';
import { SimulationConnector } from '@arc-control/connector-simulation';
import { createControlApi } from './server.js';

const TOKEN = 'test-operator-token';
const operator = { authorization: `Bearer ${TOKEN}`, 'x-arc-operator': 'ops@example.com', 'content-type': 'application/json' };

async function harness() {
  const store = new MemoryStore();
  const api = createControlApi({ store, operatorToken: TOKEN, schedule: false });
  let deploys = 0;
  api.gateway.addConnector(new SimulationConnector({ handlers: { 'ci.deploy': () => ({ deployed: ++deploys }) } }));
  await api.gateway.tools.register({
    name: 'ci.deploy',
    description: 'Deploy.',
    effect: 'write',
    riskTier: 'medium',
    connector: 'simulation',
    parameters: [],
  });
  await api.gateway.admin.publishPolicy(
    {
      id: 'DEPLOY-001',
      version: 1,
      name: 'Deploys',
      enabled: true,
      match: { tools: ['ci.*'] },
      rules: [{ id: 'always', when: { always: true }, effect: 'ALLOW', reason: 'allowed' }],
      fallback: { effect: 'DENY', reason: 'no rule' },
    },
    { identifier: 'ops@example.com', via: 'api' },
  );
  const agent = await api.gateway.agents.register({ name: 'coder', owner: 'ops@example.com' });
  const other = await api.gateway.agents.register({ name: 'other', owner: 'ops@example.com' });
  const { apiKey } = await api.gateway.agents.issueKey(agent.id);
  const address = await api.listen(0);
  const base = `http://${address.host}:${address.port}`;
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = operator) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };
  const asAgent = { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' };
  return {
    api,
    agent,
    other,
    call,
    asAgent,
    deploys: () => deploys,
    close: async () => {
      await api.close();
      await store.close();
    },
  };
}

describe('spend API', () => {
  it('an agent reporting its own spend can exhaust its own budget, and deploys stop', async () => {
    const h = await harness();
    try {
      const created = await h.call('POST', '/v1/budgets', {
        name: 'coder daily',
        agentId: h.agent.id,
        period: 'day',
        limitUsd: 10,
        onExceeded: 'DENY',
      });
      assert.equal(created.status, 201);

      assert.equal((await h.call('POST', '/v1/actions', { tool: 'ci.deploy' }, h.asAgent)).body.outcome, 'executed');
      const reported = await h.call('POST', '/v1/spend/report', { provider: 'anthropic', amountUsd: 10 }, h.asAgent);
      assert.equal(reported.status, 201);
      assert.equal(reported.body.verified, false);
      assert.equal(reported.body.agentId, h.agent.id);

      const refused = await h.call('POST', '/v1/actions', { tool: 'ci.deploy' }, h.asAgent);
      assert.equal(refused.body.outcome, 'denied');
      assert.equal(h.deploys(), 1, 'the second deploy never reached the connector');

      const standing = await h.call('GET', `/v1/spend?agentId=${h.agent.id}`);
      assert.equal(standing.body.standings[0].state, 'exceeded');
      assert.equal(standing.body.standings[0].unverifiedUsd, 10);
    } finally {
      await h.close();
    }
  });

  it('refuses an agent reporting spend for another agent, or a negative or string amount', async () => {
    const h = await harness();
    try {
      for (const body of [
        { provider: 'anthropic', amountUsd: 5, agentId: h.other.id },
        { provider: 'anthropic', amountUsd: -5 },
        { provider: 'anthropic', amountUsd: '5' },
      ]) {
        const response = await h.call('POST', '/v1/spend/report', body, h.asAgent);
        assert.equal(response.status, 400, JSON.stringify(body));
      }
      assert.equal(await h.api.gateway.store.spend.count(), 0);
    } finally {
      await h.close();
    }
  });

  it('refuses an agent key on the spend report route when it is not a valid key', async () => {
    const h = await harness();
    try {
      const response = await h.call('POST', '/v1/spend/report', { provider: 'anthropic', amountUsd: 1 }, {
        authorization: 'Bearer arc_nope',
        'content-type': 'application/json',
      });
      assert.equal(response.status, 401);
    } finally {
      await h.close();
    }
  });

  it('audits budget changes with what they changed from', async () => {
    const h = await harness();
    try {
      const created = await h.call('POST', '/v1/budgets', { name: 'b', period: 'month', limitUsd: 100, onExceeded: 'DENY' });
      const replaced = await h.call('PUT', `/v1/budgets/${created.body.id}`, {
        name: 'b',
        period: 'month',
        limitUsd: 500,
        onExceeded: 'DENY',
      });
      assert.equal(replaced.status, 200);
      assert.equal(replaced.body.version, 2);
      const audit = await h.api.gateway.audit.read();
      const updated = audit.find((record) => record.type === 'budget.updated');
      assert.match(updated?.summary ?? '', /from \$100 to \$500/);
      assert.ok(audit.some((record) => record.type === 'budget.created'));
    } finally {
      await h.close();
    }
  });

  it('records spend from a provider on a scheduler tick, and the monitor suspends a runaway', async () => {
    const store = new MemoryStore();
    const api = createControlApi({
      store,
      operatorToken: TOKEN,
      schedule: false,
      spend: {
        attribution: { 'workspace:w1': 'coder' },
        spike: { multiplier: 3, minimumUsd: 20, baselineDays: 7 },
        onSpike: 'suspend',
        providers: [
          {
            name: 'anthropic',
            fetch: async () => [
              { reference: 'r1', occurredAt: new Date().toISOString(), amountUsd: 500, attribution: 'workspace:w1' },
            ],
          },
        ],
      },
    });
    try {
      const agent = await api.gateway.agents.register({ name: 'coder', owner: 'ops@example.com' });
      const tick = await api.scheduler.tick();
      assert.equal(tick.spendIngested, 1);
      assert.equal(tick.spendIncidents, 1);
      assert.equal((await api.gateway.agents.require(agent.id)).status, 'suspended');
      const audit = await api.gateway.audit.read();
      assert.ok(audit.some((record) => record.type === 'spend.incident'));
      assert.ok(audit.some((record) => record.type === 'agent.suspended' && record.actor === 'system:spend-monitor'));
    } finally {
      api.scheduler.stop();
      await store.close();
    }
  });
});
