/**
 * Concurrency, over HTTP, against a real listening vendor.
 *
 * The two authorization defects the Meridian harness found were both ordering
 * bugs that only appear under load, and neither is visible to a test that
 * drives the gateway one call at a time in-process. So this drives the shipped
 * HTTP API with the shipped HTTP connector and counts what crossed the wire to
 * the vendor, because "ARC said one refund" and "the vendor was asked once"
 * are different statements and only the second one is the customer's money.
 *
 * The concurrency here is higher than the Phase 2 harness uses, deliberately:
 * a lock that holds for eight callers and not for fifty is not a lock.
 */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { GenericHttpConnector } from '@arc-control/connector-generic-http';
import { MemoryStore } from '@arc-control/store';
import type { Policy } from '@arc-control/schemas';
import { createControlApi, type ControlApi } from './server.js';

const TOKEN = 'concurrency-operator-token';

/** A stub vendor that counts calls and can be made slow. */
function vendorStub(): { server: Server; calls: string[]; listen: () => Promise<number>; delayMs: number } {
  const calls: string[] = [];
  const state = { delayMs: 0 };

  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      calls.push(request.url ?? '');
      const reply = (): void => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ id: `re_${String(calls.length)}`, status: 'succeeded' }));
      };
      if (state.delayMs > 0) setTimeout(reply, state.delayMs);
      else reply();
    });
  });

  return {
    server,
    calls,
    get delayMs() {
      return state.delayMs;
    },
    set delayMs(value: number) {
      state.delayMs = value;
    },
    listen: () =>
      new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          const address = server.address();
          resolve(typeof address === 'object' && address ? address.port : 0);
        });
      }),
  };
}

const AUTHORITY: Policy = {
  id: 'REFUND-AUTHORITY',
  version: 1,
  name: 'Refund authority',
  enabled: true,
  match: { tools: ['vendor.refund'] },
  rules: [
    { id: 'routine', when: { lt: ['$.action.parameters.amount', 5000] }, effect: 'ALLOW', reason: 'within authority' },
    {
      id: 'large',
      when: { lt: ['$.action.parameters.amount', 50_000] },
      effect: 'REQUIRE_APPROVAL',
      reason: 'above the agent’s own authority',
      approval: { approvers: ['role:finance-manager'], minApprovals: 1 },
    },
  ],
  fallback: { effect: 'DENY', reason: 'beyond any delegated authority' },
};

describe('concurrency through the HTTP API', () => {
  let api: ControlApi;
  let store: MemoryStore;
  let base: string;
  let agentKey: string;
  let vendor: ReturnType<typeof vendorStub>;

  const operator = (identifier = 'ops@example.com'): Record<string, string> => ({
    authorization: `Bearer ${TOKEN}`,
    'x-arc-operator': identifier,
    'x-arc-operator-roles': 'finance-manager',
    'content-type': 'application/json',
  });

  const asAgent = (): Record<string, string> => ({
    authorization: `Bearer ${agentKey}`,
    'content-type': 'application/json',
  });

  interface Submitted {
    readonly status: number;
    readonly outcome?: string;
    readonly actionId?: string;
    readonly evidenceId?: string;
    readonly approvalId?: string;
    readonly error?: { readonly code: string };
  }

  async function refund(amount: number, idempotencyKey?: string): Promise<Submitted> {
    const response = await fetch(`${base}/v1/actions`, {
      method: 'POST',
      headers: asAgent(),
      body: JSON.stringify({
        tool: 'vendor.refund',
        parameters: { chargeId: 'ch_123', amount },
        ...(idempotencyKey ? { idempotencyKey } : {}),
      }),
    });
    const body = (await response.json()) as Record<string, unknown>;
    return { status: response.status, ...body } as Submitted;
  }

  before(async () => {
    vendor = vendorStub();
    const vendorPort = await vendor.listen();

    store = new MemoryStore();
    api = createControlApi({ store, operatorToken: TOKEN, schedule: false });
    api.gateway.addConnector(
      new GenericHttpConnector({ allowedHosts: ['127.0.0.1'], headers: { authorization: 'Bearer vendor-secret' } }),
    );

    await api.gateway.admin.registerTool(
      {
        name: 'vendor.refund',
        description: 'Refund a charge through the vendor API.',
        system: 'vendor',
        effect: 'irreversible',
        riskTier: 'critical',
        connector: 'generic-http',
        connectorConfig: {
          url: `http://127.0.0.1:${String(vendorPort)}/v1/charges/{chargeId}/refunds`,
          method: 'POST',
          bodyTemplate: { amount: '$amount' },
        },
        parameters: [
          { name: 'chargeId', type: 'string', required: true },
          { name: 'amount', type: 'number', required: true, minimum: 0 },
        ],
      },
      { identifier: 'ops@example.com', via: 'api' },
    );

    await api.gateway.admin.publishPolicy(AUTHORITY, { identifier: 'ops@example.com', via: 'api' });

    const agent = await api.gateway.agents.register({
      name: 'support-agent',
      owner: 'support-lead@example.com',
      roles: ['support'],
    });
    ({ apiKey: agentKey } = await api.gateway.agents.issueKey(agent.id));

    const address = await api.listen(0);
    base = `http://${address.host}:${address.port}`;
  });

  after(async () => {
    const close = async (what: string, fn: () => Promise<unknown> | unknown): Promise<void> => {
      try {
        await fn();
      } catch (cause) {
        console.error(`concurrency test: closing ${what} failed`, cause);
      }
    };
    await close('the API', () => api?.close());
    await close('the store', () => store?.close());
    await close('the vendor stub', async () => {
      if (!vendor?.server.listening) return;
      await new Promise<void>((resolve) => vendor.server.close(() => resolve()));
    });
  });

  it('turns fifty simultaneous requests under one key into one vendor call', async () => {
    const before = vendor.calls.length;
    const results = await Promise.all(Array.from({ length: 50 }, () => refund(1200, 'burst-1')));

    assert.equal(vendor.calls.length - before, 1, 'the vendor must have been asked exactly once');
    for (const result of results) {
      assert.equal(result.status, 200);
      assert.equal(result.outcome, 'executed');
    }
    assert.equal(new Set(results.map((result) => result.actionId)).size, 1);
    assert.equal(new Set(results.map((result) => result.evidenceId)).size, 1);
  });

  it('holds while the vendor is slow, which is when the window is widest', async () => {
    const before = vendor.calls.length;
    vendor.delayMs = 50;
    try {
      const results = await Promise.all(Array.from({ length: 25 }, () => refund(1300, 'slow-1')));
      assert.equal(vendor.calls.length - before, 1);
      for (const result of results) assert.equal(result.outcome, 'executed');
    } finally {
      vendor.delayMs = 0;
    }
  });

  it('keeps one hundred distinct keys as one hundred vendor calls', async () => {
    const before = vendor.calls.length;
    await Promise.all(Array.from({ length: 100 }, (_, index) => refund(1400, `distinct-${index}`)));
    assert.equal(vendor.calls.length - before, 100, 'a lock on the wrong thing would collapse these');
  });

  it('refuses the odd one out when a key is reused with different parameters', async () => {
    const before = vendor.calls.length;
    const results = await Promise.all([
      ...Array.from({ length: 8 }, () => refund(1500, 'mixed-1')),
      ...Array.from({ length: 8 }, () => refund(1600, 'mixed-1')),
    ]);

    assert.equal(vendor.calls.length - before, 1, 'one key, one effect, whichever amount won the claim');
    const conflicts = results.filter((result) => result.status === 409);
    assert.equal(conflicts.length, 8, 'and the eight asking for the other amount are refused');
    for (const conflict of conflicts) assert.equal(conflict.error?.code, 'conflict');
  });

  it('never both refuses a release and calls the vendor when policy changes mid-release', async () => {
    const held = await refund(12_000, undefined);
    assert.equal(held.status, 202);
    assert.equal(held.outcome, 'pending_approval');

    await fetch(`${base}/v1/approvals/${held.approvalId!}/vote`, {
      method: 'POST',
      headers: operator('cfo@example.com'),
      body: JSON.stringify({ vote: 'approve' }),
    });

    const before = vendor.calls.length;
    const [release] = await Promise.all([
      fetch(`${base}/v1/approvals/${held.approvalId!}/execute`, { method: 'POST', headers: operator() }).then(
        async (response) => (await response.json()) as Submitted,
      ),
      fetch(`${base}/v1/policies`, {
        method: 'POST',
        headers: operator(),
        body: JSON.stringify({
          id: 'REFUNDS-FROZEN',
          version: 1,
          name: 'Refunds suspended',
          enabled: true,
          match: { tools: ['vendor.refund'] },
          rules: [{ id: 'freeze', when: { always: true }, effect: 'DENY', reason: 'refunds are suspended' }],
          fallback: { effect: 'DENY', reason: 'refunds are suspended' },
        }),
      }),
    ]);

    const called = vendor.calls.length - before;
    if (release.outcome === 'executed') {
      assert.equal(called, 1, 'an execution must mean exactly one vendor call');
    } else {
      assert.equal(release.outcome, 'denied');
      assert.equal(called, 0, 'a refusal must mean none');
    }
  });

  it('refuses the release when the deny is switched back on while the approval is open', async () => {
    // The previous case left `REFUNDS-FROZEN` published, so a *new* request is
    // already denied at submission — which is the behaviour that worked all
    // along. Switching it off to raise the hold, then on again, reproduces the
    // case that did not: a grant collected under one policy, released under
    // another.
    const policy = (action: 'disable' | 'enable'): Promise<Response> =>
      fetch(`${base}/v1/policies/REFUNDS-FROZEN/${action}`, { method: 'POST', headers: operator() });

    assert.equal((await policy('disable')).status, 200);

    const held = await refund(13_000, undefined);
    assert.equal(held.outcome, 'pending_approval');
    await fetch(`${base}/v1/approvals/${held.approvalId!}/vote`, {
      method: 'POST',
      headers: operator('cfo@example.com'),
      body: JSON.stringify({ vote: 'approve' }),
    });

    assert.equal((await policy('enable')).status, 200);

    const before = vendor.calls.length;
    const released = await fetch(`${base}/v1/approvals/${held.approvalId!}/execute`, {
      method: 'POST',
      headers: operator(),
    }).then(async (response) => (await response.json()) as Submitted);

    assert.equal(released.outcome, 'denied');
    assert.equal(vendor.calls.length - before, 0);

    // And the chain still verifies after all of the above.
    const verify = await fetch(`${base}/v1/audit/verify`, { headers: operator() }).then(
      async (response) => (await response.json()) as { valid: boolean },
    );
    assert.equal(verify.valid, true);
  });
});
