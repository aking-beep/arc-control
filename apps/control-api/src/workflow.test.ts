/**
 * One customer workflow, end to end, through the real HTTP connector.
 *
 * Every other test in this repository either drives the gateway in-process or
 * executes through `SimulationConnector`, which returns a canned payload
 * without leaving the process. That proves the control logic and proves
 * nothing about the integration: the connector's URL templating, its body
 * construction, its loopback and allowlist rules, and the way a real vendor's
 * response becomes evidence are all untested by a simulated run.
 *
 * So this exercises the chain a customer actually deploys — agent credential →
 * HTTP API → policy decision → human approval → an HTTP request to a real
 * listening service → evidence → assurance assessment → a verifiable export —
 * against a stub vendor on loopback. The vendor records what it received, so
 * the assertions are about what crossed the wire, not about what ARC intended
 * to send.
 */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { GenericHttpConnector } from '@arc-control/connector-generic-http';
import { verifyBundle } from '@arc-control/evidence';
import { MemoryStore } from '@arc-control/store';
import { createControlApi, type ControlApi } from './server.js';

const TOKEN = 'workflow-operator-token';

interface VendorCall {
  readonly method: string;
  readonly path: string;
  readonly auth: string | undefined;
  readonly body: unknown;
}

/** A stub of the vendor's refunds API, recording everything it is sent. */
function vendorStub(): { server: Server; calls: VendorCall[]; listen: () => Promise<number> } {
  const calls: VendorCall[] = [];

  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      calls.push({
        method: request.method ?? '',
        path: request.url ?? '',
        auth: request.headers.authorization,
        body: raw ? (JSON.parse(raw) as unknown) : undefined,
      });

      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: `re_${String(calls.length)}`, status: 'succeeded' }));
    });
  });

  return {
    server,
    calls,
    listen: () =>
      new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          const address = server.address();
          resolve(typeof address === 'object' && address ? address.port : 0);
        });
      }),
  };
}

describe('a customer workflow, end to end through the HTTP connector', () => {
  let api: ControlApi;
  let store: MemoryStore;
  let base: string;
  let agentKey: string;
  let vendor: ReturnType<typeof vendorStub>;
  let vendorPort: number;

  const operator = (identifier = 'ops@example.com'): Record<string, string> => ({
    authorization: `Bearer ${TOKEN}`,
    'x-arc-operator': identifier,
    'content-type': 'application/json',
  });

  const asAgent = (): Record<string, string> => ({
    authorization: `Bearer ${agentKey}`,
    'content-type': 'application/json',
  });

  /** Submits a refund as the agent and returns the parsed decision. */
  async function refund(amount: number, idempotencyKey?: string): Promise<Record<string, unknown>> {
    const response = await fetch(`${base}/v1/actions`, {
      method: 'POST',
      headers: asAgent(),
      body: JSON.stringify({
        tool: 'vendor.refund',
        parameters: { chargeId: 'ch_123', amount },
        ...(idempotencyKey ? { idempotencyKey } : {}),
      }),
    });
    return (await response.json()) as Record<string, unknown>;
  }

  /** Reads a response once, so an assertion message cannot consume the body. */
  async function read<T>(response: Response): Promise<{ status: number; body: T; raw: string }> {
    const raw = await response.text();
    return { status: response.status, body: JSON.parse(raw) as T, raw };
  }

  before(async () => {
    vendor = vendorStub();
    vendorPort = await vendor.listen();

    store = new MemoryStore();
    api = createControlApi({ store, operatorToken: TOKEN });

    // The allowlist names the stub explicitly. An empty allowlist refuses
    // everything, which is the behaviour a misconfigured deployment gets.
    api.gateway.addConnector(
      new GenericHttpConnector({
        allowedHosts: ['127.0.0.1'],
        headers: { authorization: 'Bearer vendor-secret-key' },
      }),
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
          bodyTemplate: { amount: '$amount', reason: 'requested_by_customer' },
        },
        parameters: [
          { name: 'chargeId', type: 'string', required: true },
          { name: 'amount', type: 'number', required: true, minimum: 0 },
        ],
      },
      { identifier: 'ops@example.com', via: 'api' },
    );

    await api.gateway.admin.publishPolicy(
      {
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
      },
      { identifier: 'ops@example.com', via: 'api' },
    );

    const agent = await api.gateway.agents.register({
      name: 'support-agent',
      owner: 'support-lead@example.com',
      roles: ['support'],
    });
    ({ apiKey: agentKey } = await api.gateway.agents.issueKey(agent.id));
    await api.assurance.seedBaseline();

    const address = await api.listen(0);
    base = `http://${address.host}:${address.port}`;
  });

  /**
   * Each resource is closed independently and failures are swallowed. If setup
   * throws part way, a half-built fixture must still release its handles:
   * otherwise the listening stub keeps the event loop alive and the run hangs
   * instead of failing, which in CI is a timeout with no useful output.
   */
  after(async () => {
    const close = async (what: string, fn: () => Promise<unknown> | unknown): Promise<void> => {
      try {
        await fn();
      } catch (cause) {
        console.error(`workflow test: closing ${what} failed`, cause);
      }
    };

    await close('the API', () => api?.close());
    await close('the store', () => store?.close());
    await close('the vendor stub', async () => {
      if (!vendor?.server.listening) return;
      await new Promise<void>((resolve) => vendor.server.close(() => resolve()));
    });
  });

  it('executes a routine refund against the real vendor', async () => {
    const decision = await refund(2500);
    assert.equal(decision.outcome, 'executed', JSON.stringify(decision));

    const call = vendor.calls.at(-1);
    assert.ok(call, 'the vendor was actually called');
    assert.equal(call.method, 'POST');
    assert.equal(call.path, '/v1/charges/ch_123/refunds', 'the URL template was filled from the parameters');
    assert.deepEqual(call.body, { amount: 2500, reason: 'requested_by_customer' }, 'and the body was built from the template');
  });

  /**
   * The connector holds the vendor credential; the agent never sees it. This
   * is the point of routing through ARC rather than giving the agent the key.
   */
  it('presents the connector’s credential, not the agent’s', async () => {
    const call = vendor.calls.at(-1);
    assert.equal(call?.auth, 'Bearer vendor-secret-key');
    assert.ok(!JSON.stringify(call?.body).includes(agentKey), 'the agent key never reaches the vendor');
  });

  /**
   * Evidence commits to the vendor's response by digest rather than copying
   * it. That is deliberate — a connector's output may carry customer data or
   * credentials, and this record is exported to auditors — so the assertion is
   * that the record binds the real execution, not that it quotes it.
   */
  it('binds the real execution in evidence without copying the vendor’s payload', async () => {
    const { body } = await read<{ evidence: readonly Record<string, Record<string, unknown>>[] }>(
      await fetch(`${base}/v1/evidence?limit=5`, { headers: operator() }),
    );

    const latest = body.evidence[0];
    assert.ok(latest, 'evidence exists');
    assert.equal(latest.outcome, 'executed');
    assert.equal(latest.execution?.connector, 'generic-http', 'the real connector ran, not a simulation');
    assert.equal(latest.execution?.status, 'succeeded');
    assert.match(String(latest.execution?.resultDigest), /^sha256:[0-9a-f]{64}$/, 'the result is committed to by digest');
    assert.ok(Number(latest.execution?.durationMs) >= 0, 'and a real round trip was timed');
    assert.ok(!JSON.stringify(latest).includes('vendor-secret-key'), 'the vendor credential is not in evidence');
  });

  it('holds a large refund for a human, and the vendor is not called meanwhile', async () => {
    const before = vendor.calls.length;
    const decision = await refund(25_000);

    assert.equal(decision.outcome, 'pending_approval', JSON.stringify(decision));
    assert.ok(decision.approvalId, 'an approval request was raised');
    assert.equal(vendor.calls.length, before, 'nothing reached the vendor while the decision was pending');
  });

  it('executes it only after a qualified human approves, and exactly once', async () => {
    const pending = await refund(30_000);
    const approvalId = String(pending.approvalId);
    const before = vendor.calls.length;

    // An approver without the required role cannot clear it.
    const wrongRole = await fetch(`${base}/v1/approvals/${approvalId}/vote`, {
      method: 'POST',
      headers: { ...operator('intern@example.com'), 'x-arc-operator-roles': 'support' },
      body: JSON.stringify({ vote: 'approve' }),
    });
    assert.ok(wrongRole.status >= 400, 'the wrong role must not be able to approve');
    assert.equal(vendor.calls.length, before, 'and nothing executed');

    const vote = await fetch(`${base}/v1/approvals/${approvalId}/vote`, {
      method: 'POST',
      headers: { ...operator('cfo@example.com'), 'x-arc-operator-roles': 'finance-manager' },
      body: JSON.stringify({ vote: 'approve' }),
    });
    assert.equal(vote.status, 200, `voting failed: ${await vote.text()}`);
    assert.equal(vendor.calls.length, before, 'approving is not itself an act');

    const executed = await fetch(`${base}/v1/approvals/${approvalId}/execute`, {
      method: 'POST',
      headers: operator(),
    });
    const result = (await executed.json()) as Record<string, unknown>;
    assert.equal(result.outcome, 'executed', JSON.stringify(result));
    assert.equal(vendor.calls.length, before + 1, 'the vendor was called once');
    assert.deepEqual(vendor.calls.at(-1)?.body, { amount: 30_000, reason: 'requested_by_customer' });

    // The grant is single-use: a replay must not produce a second refund.
    const replay = await fetch(`${base}/v1/approvals/${approvalId}/execute`, {
      method: 'POST',
      headers: operator(),
    });
    assert.ok(replay.status >= 400, 'a consumed approval cannot be executed again');
    assert.equal(vendor.calls.length, before + 1, 'and the vendor was not called twice');
  });

  it('denies a refund beyond any delegated authority without calling the vendor', async () => {
    const before = vendor.calls.length;
    const decision = await refund(500_000);

    assert.equal(decision.outcome, 'denied', JSON.stringify(decision));
    assert.equal(vendor.calls.length, before, 'a denial never reaches the vendor');
  });

  it('refuses a duplicate submission rather than refunding twice', async () => {
    const key = 'customer-ticket-4471';
    const first = await refund(1000, key);
    const before = vendor.calls.length;
    const second = await refund(1000, key);

    assert.equal(first.outcome, 'executed');
    assert.equal(second.outcome, 'executed', 'the replay returns the original decision');
    assert.equal(second.actionId, first.actionId, 'and the same action, not a new one');
    assert.equal(vendor.calls.length, before, 'the vendor was not called a second time');
  });

  /**
   * The assurance layer must read this real traffic, not a fixture. If the
   * controls were only ever exercised against simulated evidence, a mismatch
   * between what a connector records and what an evaluator expects would not
   * show up until a customer ran it.
   */
  it('assesses the controls from this traffic and reports a readable window', async () => {
    const { status, body, raw } = await read<{
      run: { window: { from: string; to: string; actionsConsidered: number; evidenceConsidered: number } };
    }>(await fetch(`${base}/v1/assurance/runs`, { method: 'POST', headers: operator(), body: '{}' }));
    assert.equal(status, 201, raw);

    assert.ok(!Number.isNaN(Date.parse(body.run.window.from)), 'the window has a readable start');
    assert.ok(body.run.window.actionsConsidered > 0, 'and it saw the actions this test submitted');
    assert.ok(body.run.window.evidenceConsidered > 0, 'and the evidence they produced');
  });

  it('shows the authorization control passing on evidence from real executions', async () => {
    const { body, raw } = await read<{
      history?: readonly { status?: string; window?: Record<string, number> }[];
    }>(await fetch(`${base}/v1/assurance/controls/ARC-AI-003`, { headers: operator() }));

    const latest = body.history?.[0];
    assert.ok(latest, `the control has been assessed: ${raw}`);
    assert.equal(latest.status, 'pass', 'nothing executed without an authorization decision');
    assert.ok((latest.window?.actionsConsidered ?? 0) > 0, 'and it was assessed over actions, not nothing');
  });

  it('exports a bundle that verifies independently of the server', async () => {
    const { status, body: bundle, raw } = await read<Parameters<typeof verifyBundle>[0]>(
      await fetch(`${base}/v1/evidence/bundles`, { method: 'POST', headers: operator(), body: '{}' }),
    );
    assert.equal(status, 201, raw);
    const verification = verifyBundle(bundle);

    assert.equal(verification.valid, true, JSON.stringify(verification.failures));
    assert.deepEqual(verification.failures, [], 'a bundle that cannot be verified is not evidence');
    assert.ok(verification.entriesChecked > 0, 'and it checked the entries rather than trusting the manifest');

    // Nothing external anchors this chain, so the bundle cannot rule out
    // truncation. It must say so as a limitation rather than quietly passing.
    assert.ok(
      verification.limitations.some((limitation) => limitation.problem === 'chain_unanchored'),
      'an unanchored export must state what it cannot prove',
    );
  });

  it('leaves an audit chain that still verifies after all of this', async () => {
    const { body, raw } = await read<{ valid?: boolean; recordsChecked?: number; notice?: string }>(
      await fetch(`${base}/v1/audit/verify`, { headers: operator() }),
    );

    assert.equal(body.valid, true, raw);
    assert.ok((body.recordsChecked ?? 0) > 0, 'and it checked something');
    assert.match(
      String(body.notice),
      /not truncation/,
      'a self-check must say what it cannot detect, since nothing anchors this chain',
    );
  });
});
