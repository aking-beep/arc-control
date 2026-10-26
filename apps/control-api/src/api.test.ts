import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MemoryStore } from '@arc-control/store';
import { SimulationConnector } from '@arc-control/connector-simulation';
import { createControlApi, type ControlApi } from './server.js';

const TOKEN = 'test-operator-token';

interface Harness {
  readonly api: ControlApi;
  readonly agentKey: string;
  readonly toolId: string;
  readonly base: string;
  close(): Promise<void>;
}

async function harness(): Promise<Harness> {
  const store = new MemoryStore();
  const api = createControlApi({ store, operatorToken: TOKEN });
  api.gateway.addConnector(
    new SimulationConnector({ handlers: { 'stripe.refund': (parameters) => ({ refundId: 're_x', ...parameters }) } }),
  );

  const tool = await api.gateway.tools.register({
    name: 'stripe.refund',
    description: 'Refund a charge.',
    effect: 'irreversible',
    riskTier: 'critical',
    connector: 'simulation',
    parameters: [{ name: 'amount', type: 'number', required: true, minimum: 0 }],
  });

  await api.gateway.admin.publishPolicy(
    {
      id: 'FINANCE-001',
      version: 1,
      name: 'Refund authority',
      enabled: true,
      match: { tools: ['stripe.*'] },
      rules: [{ id: 'small', when: { lt: ['$.action.parameters.amount', 500] }, effect: 'ALLOW', reason: 'small' }],
      fallback: { effect: 'DENY', reason: 'no rule matched' },
    },
    { identifier: 'ops@example.com', via: 'api' },
  );

  const agent = await api.gateway.agents.register({ name: 'finance-agent', owner: 'ops@example.com', roles: ['finance'] });
  const { apiKey } = await api.gateway.agents.issueKey(agent.id);
  await api.assurance.seedBaseline();

  const address = await api.listen(0);
  return {
    api,
    agentKey: apiKey,
    toolId: tool.id,
    base: `http://${address.host}:${address.port}`,
    close: async () => {
      await api.close();
      await store.close();
    },
  };
}

function operator(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}`, 'x-arc-operator': 'ops@example.com', ...extra };
}

/**
 * Every governance route, with a body good enough to get past validation.
 *
 * Listed exhaustively on purpose: the point of the test below is that no
 * governance route is reachable with an agent credential, and a list that
 * drifts out of date would silently stop testing the route that was added last.
 */
const GOVERNANCE_ROUTES: readonly { method: 'GET' | 'POST'; path: string; body?: unknown }[] = [
  { method: 'GET', path: '/v1/assurance/summary' },
  { method: 'GET', path: '/v1/assurance/coverage' },
  { method: 'GET', path: '/v1/assurance/controls' },
  { method: 'GET', path: '/v1/assurance/controls/ARC-AI-001' },
  { method: 'POST', path: '/v1/assurance/controls/ARC-AI-001/enable' },
  { method: 'POST', path: '/v1/assurance/controls/ARC-AI-001/disable' },
  { method: 'POST', path: '/v1/assurance/controls/ARC-AI-009/attest', body: { statement: 'all fine' } },
  { method: 'POST', path: '/v1/assurance/runs', body: {} },
  { method: 'GET', path: '/v1/assurance/runs' },
  { method: 'GET', path: '/v1/assurance/runs/arc_run_x' },
  { method: 'GET', path: '/v1/assurance/assessments/arc_asm_x' },
  { method: 'GET', path: '/v1/assurance/frameworks' },
  { method: 'GET', path: '/v1/assurance/frameworks/nist-ai-rmf' },
  { method: 'GET', path: '/v1/risks' },
  {
    method: 'POST',
    path: '/v1/risks',
    body: {
      reference: 'R1',
      title: 't',
      description: 'd',
      category: 'c',
      impact: 3,
      likelihood: 3,
      treatment: 'mitigate',
      owner: 'o',
    },
  },
  { method: 'GET', path: '/v1/risks/arc_rsk_x' },
  { method: 'POST', path: '/v1/risks/arc_rsk_x/residual', body: { impact: 1, likelihood: 1, rationale: 'r' } },
  { method: 'POST', path: '/v1/risks/arc_rsk_x/accept', body: { rationale: 'r' } },
  { method: 'POST', path: '/v1/risks/arc_rsk_x/controls', body: { controlIds: [] } },
  { method: 'GET', path: '/v1/findings' },
  { method: 'GET', path: '/v1/findings/arc_fnd_x' },
  { method: 'POST', path: '/v1/findings/arc_fnd_x', body: { owner: 'o' } },
  { method: 'POST', path: '/v1/findings/arc_fnd_x/resolve', body: { status: 'resolved', note: 'n' } },
  { method: 'POST', path: '/v1/evidence/bundles', body: {} },
  { method: 'GET', path: '/v1/policies/FINANCE-001/history' },
  { method: 'POST', path: '/v1/policies/simulate', body: { candidate: {} } },
  { method: 'GET', path: '/v1/credentials' },
  { method: 'POST', path: '/v1/credentials/arc_cred_x/rotate', body: {} },
  { method: 'POST', path: '/v1/agents/arc_ag_x/governance', body: { purpose: 'p', criticality: 'low' } },
  { method: 'POST', path: '/v1/agents/arc_ag_x/activate' },
  { method: 'POST', path: '/v1/agents/arc_ag_x/retire' },
  { method: 'POST', path: '/v1/tools/arc_tl_x/disable', body: {} },
  { method: 'POST', path: '/v1/tools/arc_tl_x/enable' },
  { method: 'POST', path: '/v1/connectors/simulation/disable', body: {} },
  { method: 'POST', path: '/v1/connectors/simulation/enable' },
];

describe('the governance surface is operator-only', () => {
  /**
   * The security property the whole assurance module rests on. An agent that
   * could read its own control results would learn which of its actions go
   * unexamined; one that could write them would be marking its own homework.
   *
   * A valid agent API key is presented to every governance route. All of them
   * must answer 401 — not 403, not 404, and above all not 200.
   */
  it('refuses a valid agent API key on every governance route', async () => {
    const h = await harness();
    try {
      // Sanity: the key really is valid for the one endpoint an agent may use.
      const allowed = await fetch(`${h.base}/v1/actions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${h.agentKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ tool: 'stripe.refund', parameters: { amount: 10 } }),
      });
      assert.equal(allowed.status, 200, 'the agent key should work on /v1/actions');
      // The outcome, not just the status: a failed execution is also a 200, so
      // asserting the status alone would pass with a broken connector.
      assert.equal(((await allowed.json()) as { outcome: string }).outcome, 'executed');

      const leaked: string[] = [];
      for (const route of GOVERNANCE_ROUTES) {
        const response = await fetch(`${h.base}${route.path}`, {
          method: route.method,
          headers: { authorization: `Bearer ${h.agentKey}`, 'content-type': 'application/json' },
          ...(route.body === undefined ? {} : { body: JSON.stringify(route.body) }),
        });

        if (response.status !== 401) {
          leaked.push(`${route.method} ${route.path} answered ${response.status}`);
        }
      }

      assert.deepEqual(leaked, [], 'an agent credential reached a governance route');
    } finally {
      await h.close();
    }
  });

  it('answers every governance route for an operator', async () => {
    const h = await harness();
    try {
      const refused: string[] = [];
      for (const route of GOVERNANCE_ROUTES) {
        const response = await fetch(`${h.base}${route.path}`, {
          method: route.method,
          headers: { ...operator(), 'content-type': 'application/json' },
          ...(route.body === undefined ? {} : { body: JSON.stringify(route.body) }),
        });

        // 2xx, or a 4xx that is about the *content* of the request rather than
        // the credential. A 401 here would mean the route is unreachable even
        // for an operator, which is the failure this catches.
        if (response.status === 401) refused.push(`${route.method} ${route.path}`);
      }

      assert.deepEqual(refused, [], 'an operator was refused on a governance route');
    } finally {
      await h.close();
    }
  });

  it('refuses an unauthenticated request', async () => {
    const h = await harness();
    try {
      const response = await fetch(`${h.base}/v1/assurance/summary`);
      assert.equal(response.status, 401);
    } finally {
      await h.close();
    }
  });
});

describe('health', () => {
  it('reports enforcement and assurance separately', async () => {
    const h = await harness();
    try {
      const response = await fetch(`${h.base}/health`);
      const body = (await response.json()) as Record<string, Record<string, unknown>>;

      assert.equal(response.status, 200);
      assert.equal(body.enforcement!.status, 'ok');
      assert.equal(body.enforcement!.failureMode, 'closed');
      assert.equal(body.enforcement!.policyFallbackEffect, 'DENY');
      assert.equal(body.assurance!.status, 'ok');
      assert.equal(body.assurance!.controls, 9);
    } finally {
      await h.close();
    }
  });

  /**
   * Authorization must not depend on assurance. The enforcement probe exists
   * so a load balancer has something that cannot be turned red by a stale
   * control assessment, and it reads nothing from the assurance layer.
   */
  it('serves an enforcement-only probe', async () => {
    const h = await harness();
    try {
      const response = await fetch(`${h.base}/health/enforcement`);
      const body = (await response.json()) as Record<string, unknown>;

      assert.equal(response.status, 200);
      assert.equal(body.status, 'ok');
      assert.equal(body.failureMode, 'closed');
      assert.ok(!('assurance' in body), 'the enforcement probe must not read assurance');
    } finally {
      await h.close();
    }
  });

  it('states that enforcement does not depend on assurance', async () => {
    const h = await harness();
    try {
      const body = (await (await fetch(`${h.base}/health`)).json()) as Record<string, Record<string, unknown>>;
      assert.equal(body.assurance!.enforcementDependsOnAssurance, false);
      assert.equal(body.assurance!.dependsOnEnforcement, true);
    } finally {
      await h.close();
    }
  });
});

describe('an assurance failure cannot open the gateway', () => {
  /**
   * The fail-closed invariant, tested by breaking assurance for real: every
   * assurance collection is replaced with one that throws on any read. The
   * gateway must still decide and enforce exactly as before.
   */
  it('still denies and allows correctly when every assurance read throws', async () => {
    const store = new MemoryStore();
    const api = createControlApi({ store, operatorToken: TOKEN });
    api.gateway.addConnector(
      new SimulationConnector({ handlers: { 'stripe.refund': () => ({ refundId: 're_x' }) } }),
    );

    await api.gateway.tools.register({
      name: 'stripe.refund',
      description: 'Refund a charge.',
      effect: 'irreversible',
      riskTier: 'critical',
      connector: 'simulation',
      parameters: [{ name: 'amount', type: 'number', required: true, minimum: 0 }],
    });

    await api.gateway.admin.publishPolicy(
      {
        id: 'FINANCE-001',
        version: 1,
        name: 'Refund authority',
        enabled: true,
        match: { tools: ['stripe.*'] },
        rules: [{ id: 'small', when: { lt: ['$.action.parameters.amount', 500] }, effect: 'ALLOW', reason: 'small' }],
        fallback: { effect: 'DENY', reason: 'above authority' },
      },
      { identifier: 'ops@example.com', via: 'api' },
    );

    const agent = await api.gateway.agents.register({ name: 'finance-agent', owner: 'ops@example.com' });
    const { apiKey } = await api.gateway.agents.issueKey(agent.id);

    const explode = () => {
      throw new Error('assurance storage is unavailable');
    };
    for (const name of ['controls', 'assessments', 'assessmentRuns', 'findings', 'risks', 'attestations'] as const) {
      Object.defineProperty(store, name, {
        value: new Proxy({} as never, { get: () => explode }),
        configurable: true,
      });
    }

    const address = await api.listen(0);
    const base = `http://${address.host}:${address.port}`;

    try {
      const allowed = await api.gateway.handle(apiKey, { tool: 'stripe.refund', parameters: { amount: 10 } });
      assert.equal(allowed.outcome, 'executed', 'an allowed action must still execute');

      const denied = await api.gateway.handle(apiKey, { tool: 'stripe.refund', parameters: { amount: 10_000 } });
      assert.equal(denied.outcome, 'denied', 'a denied action must still be denied');

      // Health says assurance is unavailable, and says enforcement is fine.
      const body = (await (await fetch(`${base}/health`)).json()) as Record<string, Record<string, unknown>>;
      assert.equal(body.assurance!.status, 'unavailable');
      assert.equal(body.enforcement!.status, 'ok');
      assert.equal(body.status, 'ok', 'overall status reports enforcement, which is healthy');

      // And the enforcement probe is unaffected.
      assert.equal((await fetch(`${base}/health/enforcement`)).status, 200);
    } finally {
      await api.close();
    }
  });
});

/**
 * An assessment window is the thing that makes a control status meaningful,
 * so a run must refuse to record one it cannot describe. `new Date(junk)`
 * yields an Invalid Date whose `toISOString()` throws or, worse, persists as
 * `null` — leaving a completed run whose window reads as unbounded.
 */
describe('an assessment run refuses a window it cannot interpret', () => {
  const BAD = ['not-a-date', '2026-13-45', 'yesterday'];

  for (const value of BAD) {
    it(`rejects from="${value}"`, async () => {
      const h = await harness();
      try {
        const response = await fetch(`${h.base}/v1/assurance/runs`, {
          method: 'POST',
          headers: operator({ 'content-type': 'application/json' }),
          body: JSON.stringify({ from: value }),
        });

        assert.equal(response.status, 400, `"${value}" must not be accepted as a date`);
        const body = (await response.json()) as { error?: { message?: string } };
        assert.match(String(body.error?.message), /from/);
      } finally {
        await h.close();
      }
    });
  }

  /**
   * An empty string means the field was not supplied, which is different from
   * supplying nonsense: the run falls back to its default window rather than
   * refusing. Pinned so the distinction stays deliberate.
   */
  it('treats an empty string as an omitted bound, not as a bad date', async () => {
    const h = await harness();
    try {
      const response = await fetch(`${h.base}/v1/assurance/runs`, {
        method: 'POST',
        headers: operator({ 'content-type': 'application/json' }),
        body: JSON.stringify({ from: '' }),
      });

      assert.equal(response.status, 201);
      const body = (await response.json()) as { run?: { window?: { from?: string; to?: string } } };
      assert.ok(body.run?.window?.from, 'the default window still has a lower bound');
      assert.ok(!Number.isNaN(Date.parse(String(body.run?.window?.from))), 'and it is a real date');
    } finally {
      await h.close();
    }
  });

  it('still accepts a valid window and records exactly it', async () => {
    const h = await harness();
    try {
      const from = '2026-01-01T00:00:00.000Z';
      const to = '2026-02-01T00:00:00.000Z';
      const response = await fetch(`${h.base}/v1/assurance/runs`, {
        method: 'POST',
        headers: operator({ 'content-type': 'application/json' }),
        body: JSON.stringify({ from, to }),
      });

      assert.equal(response.status, 201);
      const body = (await response.json()) as { run?: { window?: { from?: string; to?: string } } };
      assert.equal(body.run?.window?.from, from);
      assert.equal(body.run?.window?.to, to);
    } finally {
      await h.close();
    }
  });
});

/**
 * Simulation answers "what would the policy have done?", so it has to build
 * the same policy input the live path builds. It used to omit the risk
 * classification entirely and hardcode `source: 'internal'`, which made a
 * rule reading `$.action.risk.*` evaluate differently in the simulator than
 * in production — the one thing a simulator must never do.
 */
describe('simulation sees the same action risk the live path sees', () => {
  it('classifies the simulated action rather than omitting its risk', async () => {
    const h = await harness();
    try {
      await h.api.gateway.admin.publishPolicy(
        {
          id: 'RISK-001',
          version: 1,
          name: 'Deny critical irreversible actions',
          enabled: true,
          match: { tools: ['stripe.*'] },
          rules: [
            {
              id: 'risk-visible',
              when: { eq: ['$.action.risk.severity', 'critical'] },
              effect: 'DENY',
              reason: 'the classifier rated this critical',
            },
          ],
          fallback: { effect: 'ALLOW', reason: 'not critical' },
        },
        { identifier: 'ops@example.com', via: 'api' },
      );

      const response = await fetch(`${h.base}/v1/policies/simulate`, {
        method: 'POST',
        headers: operator({ 'content-type': 'application/json' }),
        body: JSON.stringify({ candidate: { policyId: 'RISK-001' }, limit: 10 }),
      });

      assert.equal(response.status, 200);
      const body = (await response.json()) as { limitations?: readonly string[] };
      assert.ok(
        (body.limitations ?? []).some((line) => /risk/i.test(line)),
        'the replay must state how it reconstructed the risk classification',
      );
    } finally {
      await h.close();
    }
  });
});
