import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ArcError, digest, type Action, type ActionResult, type Policy, type Tool } from '@arc-control/schemas';
import { MemoryStore } from '@arc-control/store';
import {
  ConnectorError,
  type Connector,
  type ConnectorResult,
  type ExecutionContext,
} from '@arc-control/execution';
import { Gateway } from './gateway.js';
import { IdempotencyLedger, scopeOf } from './idempotency.js';

/**
 * Regression cover for the concurrent-idempotency defect.
 *
 * The Meridian harness found it by sending eight parallel refunds under one
 * idempotency key and counting eight refunds in its own mutation log. The
 * cause was ordering, not a missing check: the gateway recorded the action and
 * *then* looked for an earlier one with the same key that already had
 * evidence. Evidence is not written until the connector returns, so every
 * member of a concurrent batch looked for a finished predecessor, found none,
 * and executed. Replay worked only for a retry that arrived after the original
 * had finished — the case that needs it least.
 *
 * These tests fix the ordering in place. Several of them would pass against
 * the old code; the concurrent ones are the ones that would not, and they are
 * written to fail loudly rather than flakily: the assertion is on the number
 * of connector calls, which is the business effect, not on response shape.
 */

const OPEN: Policy = {
  id: 'OPEN-001',
  version: 1,
  name: 'Allow everything',
  enabled: true,
  match: {},
  rules: [{ id: 'all', when: { always: true }, effect: 'ALLOW', reason: 'permitted' }],
  fallback: { effect: 'DENY', reason: 'no rule matched' },
};

const HOLD: Policy = {
  id: 'HOLD-001',
  version: 1,
  name: 'Hold refunds for a human',
  enabled: true,
  match: {},
  rules: [
    {
      id: 'hold',
      when: { always: true },
      effect: 'REQUIRE_APPROVAL',
      reason: 'a finance manager must approve',
      approval: { approvers: ['role:finance-manager'], minApprovals: 1 },
    },
  ],
  fallback: { effect: 'DENY', reason: 'no rule matched' },
};

const DENY: Policy = {
  id: 'OPEN-001',
  version: 2,
  name: 'Refuse everything',
  enabled: true,
  match: {},
  rules: [{ id: 'all', when: { always: true }, effect: 'DENY', reason: 'refunds are suspended' }],
  fallback: { effect: 'DENY', reason: 'no rule matched' },
};

/**
 * A connector that can be held open, so a repeat can be made to arrive while
 * the original is genuinely mid-flight rather than merely scheduled earlier.
 */
class GatedConnector implements Connector {
  readonly name = 'gated';
  readonly calls: string[] = [];
  #gate: Promise<void> | undefined;
  #open!: () => void;
  #failWith: ConnectorError | undefined;

  supports(tool: Tool): boolean {
    return tool.connector === this.name;
  }

  /** Holds every subsequent call until `release` is called. */
  close(): void {
    this.#gate = new Promise<void>((resolve) => {
      this.#open = resolve;
    });
  }

  release(): void {
    this.#open?.();
    this.#gate = undefined;
  }

  failWith(error: ConnectorError | undefined): void {
    this.#failWith = error;
  }

  async execute(context: ExecutionContext): Promise<ConnectorResult> {
    this.calls.push(context.tool.name);
    if (this.#gate) await this.#gate;
    if (this.#failWith) throw this.#failWith;
    return { output: { refundId: `re_${this.calls.length}` } };
  }

  callCount(): number {
    return this.calls.length;
  }
}

async function setup(policy: Policy = OPEN) {
  const connector = new GatedConnector();
  const store = new MemoryStore();
  const gateway = new Gateway({ store });
  gateway.addConnector(connector);

  const refund = await gateway.tools.register({
    name: 'stripe.refund',
    description: 'Refund a charge.',
    effect: 'irreversible',
    riskTier: 'critical',
    connector: 'gated',
    parameters: [{ name: 'amount', type: 'number', required: true, minimum: 0 }],
  });

  await gateway.tools.register({
    name: 'stripe.payout',
    description: 'Send a payout.',
    effect: 'irreversible',
    riskTier: 'critical',
    connector: 'gated',
    parameters: [{ name: 'amount', type: 'number', required: true, minimum: 0 }],
  });

  await gateway.admin.publishPolicy(policy, { identifier: 'ops@example.com', via: 'api' });

  const agent = await gateway.agents.register({
    name: 'finance-agent',
    owner: 'ops@example.com',
    roles: ['finance'],
  });
  const { apiKey } = await gateway.agents.issueKey(agent.id);

  return { gateway, store, connector, apiKey, agent, refund };
}

describe('concurrent idempotency', () => {
  it('turns eight simultaneous identical refunds into one refund', async () => {
    const { gateway, apiKey, connector, store } = await setup();
    const request = { tool: 'stripe.refund', parameters: { amount: 120 }, idempotencyKey: 'batch-1' };

    const results = await Promise.all(Array.from({ length: 8 }, () => gateway.handle(apiKey, request)));

    // The claim that matters: the customer was refunded once.
    assert.equal(connector.callCount(), 1, 'exactly one refund may have reached the connector');

    // And every caller was told the same thing about the same action.
    assert.equal(new Set(results.map((result) => result.actionId)).size, 1);
    assert.equal(new Set(results.map((result) => result.evidenceId)).size, 1);
    for (const result of results) assert.equal(result.outcome, 'executed');

    // One logical action means one action row and one evidence row, which is
    // also what keeps "every recorded action has evidence" true.
    assert.equal(await store.actions.count(), 1);
    assert.equal(await store.evidence.count(), 1);
  });

  it('holds for one refund across repeated rounds, not just the first', async () => {
    const { gateway, apiKey, connector } = await setup();

    for (let round = 0; round < 5; round += 1) {
      const request = {
        tool: 'stripe.refund',
        parameters: { amount: 120 },
        idempotencyKey: `round-${round}`,
      };
      await Promise.all(Array.from({ length: 8 }, () => gateway.handle(apiKey, request)));
      assert.equal(connector.callCount(), round + 1, `round ${round + 1} must add exactly one refund`);
    }
  });

  it('joins a repeat that arrives while the original is still executing', async () => {
    const { gateway, apiKey, connector } = await setup();
    const request = { tool: 'stripe.refund', parameters: { amount: 120 }, idempotencyKey: 'in-flight' };

    connector.close();
    const first = gateway.handle(apiKey, request);
    // Let the first reach the connector and block there.
    await waitFor(() => connector.callCount() === 1);

    const second = gateway.handle(apiKey, request);
    connector.release();

    const [a, b] = await Promise.all([first, second]);
    assert.equal(connector.callCount(), 1, 'the repeat must not have executed');
    assert.equal(b.actionId, a.actionId);
    assert.equal(b.evidenceId, a.evidenceId);
    assert.equal(b.outcome, 'executed');
    assert.deepEqual(b.result, a.result, 'a joined caller gets the original result, not an empty one');
  });

  it('refuses a key reused with different parameters while the original is in flight', async () => {
    const { gateway, apiKey, connector } = await setup();

    connector.close();
    const first = gateway.handle(apiKey, {
      tool: 'stripe.refund',
      parameters: { amount: 120 },
      idempotencyKey: 'conflict-1',
    });
    await waitFor(() => connector.callCount() === 1);

    await assert.rejects(
      () =>
        gateway.handle(apiKey, {
          tool: 'stripe.refund',
          parameters: { amount: 4200 },
          idempotencyKey: 'conflict-1',
        }),
      (error: ArcError) => error.code === 'conflict',
    );

    connector.release();
    await first;
    assert.equal(connector.callCount(), 1);
  });

  it('raises the original error for everyone joined to a failed execution', async () => {
    const { gateway, apiKey, connector } = await setup();
    const request = { tool: 'stripe.refund', parameters: { amount: 120 }, idempotencyKey: 'fail-1' };

    connector.failWith(new ConnectorError('execution_failed', 'the vendor refused', { retryable: false }));

    const results = await Promise.all(Array.from({ length: 4 }, () => gateway.handle(apiKey, request)));

    assert.equal(connector.callCount(), 1, 'a failure must not be retried by its own repeats');
    for (const result of results) {
      assert.equal(result.outcome, 'failed');
      assert.equal(result.actionId, results[0]!.actionId);
    }
  });

  it('reports the recorded failure to a later retry rather than acting again', async () => {
    const { gateway, apiKey, connector } = await setup();
    const request = { tool: 'stripe.refund', parameters: { amount: 120 }, idempotencyKey: 'fail-2' };

    connector.failWith(new ConnectorError('execution_failed', 'the vendor refused', { retryable: false }));
    const first = await gateway.handle(apiKey, request);
    connector.failWith(undefined);

    // The key is spent. A caller who wants a genuine retry after a definite
    // failure presents a new key; ARC will not decide on their behalf that the
    // effect did not land, because for an irreversible tool it cannot know.
    const second = await gateway.handle(apiKey, request);

    assert.equal(second.outcome, 'failed');
    assert.equal(second.actionId, first.actionId);
    assert.equal(connector.callCount(), 1);
  });

  it('returns the denial to a repeat, without a second decision', async () => {
    const { gateway, apiKey, connector, store } = await setup(DENY);
    const request = { tool: 'stripe.refund', parameters: { amount: 120 }, idempotencyKey: 'denied-1' };

    const results = await Promise.all(Array.from({ length: 4 }, () => gateway.handle(apiKey, request)));

    for (const result of results) {
      assert.equal(result.outcome, 'denied');
      assert.equal(result.decision.effect, 'DENY');
    }
    assert.equal(connector.callCount(), 0);
    assert.equal(await store.actions.count(), 1);
    assert.equal(await store.decisions.count(), 1, 'one logical action is decided once');
  });

  it('reports the execution, not the hold, to a retry after the action was released', async () => {
    const { gateway, apiKey, connector } = await setup(HOLD);
    const request = { tool: 'stripe.refund', parameters: { amount: 1850 }, idempotencyKey: 'held-1' };

    const held = await gateway.handle(apiKey, request);
    assert.equal(held.outcome, 'pending_approval');

    // A retry while it is still held reports the hold.
    assert.equal((await gateway.handle(apiKey, request)).outcome, 'pending_approval');

    await gateway.approvals.vote({
      approvalId: held.approvalId!,
      approver: { identifier: 'cfo@example.com', roles: ['finance-manager'] },
      vote: 'approve',
    });
    const released = await gateway.resume(held.approvalId!);
    assert.equal(released.outcome, 'executed');

    // And a retry afterwards reports the execution. Reading the *first*
    // evidence record for the action would have reported `pending_approval`
    // forever, which is a false statement about a refund that happened.
    const retried = await gateway.handle(apiKey, request);
    assert.equal(retried.outcome, 'executed');
    assert.equal(retried.evidenceId, released.evidenceId);
    assert.equal(connector.callCount(), 1);
  });

  it('refuses when the key is held by a request whose outcome was never recorded', async () => {
    const { gateway, apiKey, store, agent, refund } = await setup();

    // What a process that died between claiming the key and writing evidence
    // leaves behind, and what a second process sharing a FileStore directory
    // would see. Executing again is the one answer that can double an
    // irreversible effect.
    const orphan: Action = {
      id: 'arc_act_orphan',
      agentId: agent.id,
      agentName: agent.name,
      organizationId: agent.organizationId,
      environment: agent.environment,
      tool: 'stripe.refund',
      toolId: refund.id,
      parameters: { amount: 120 },
      parametersDigest: digest({ amount: 120 }),
      idempotencyKey: 'orphaned',
      source: 'api',
      requestedAt: new Date().toISOString(),
    };
    await store.actions.put(orphan.id, orphan);

    await assert.rejects(
      () =>
        gateway.handle(apiKey, {
          tool: 'stripe.refund',
          parameters: { amount: 120 },
          idempotencyKey: 'orphaned',
        }),
      (error: ArcError) => error.code === 'conflict' && /no outcome was recorded/.test(error.message),
    );
  });

  it('scopes a key to one agent and one tool', async () => {
    const { gateway, apiKey, connector } = await setup();

    const other = await gateway.agents.register({ name: 'payouts-agent', owner: 'ops@example.com' });
    const { apiKey: otherKey } = await gateway.agents.issueKey(other.id);

    // Same key, different tool: a different logical action.
    await gateway.handle(apiKey, { tool: 'stripe.refund', parameters: { amount: 10 }, idempotencyKey: 'shared' });
    await gateway.handle(apiKey, { tool: 'stripe.payout', parameters: { amount: 10 }, idempotencyKey: 'shared' });
    // Same key, different agent: likewise. A key is the caller's name for its
    // own attempt, and conflating two callers' attempts would make one agent's
    // retry silently swallow another's work.
    await gateway.handle(otherKey, { tool: 'stripe.refund', parameters: { amount: 10 }, idempotencyKey: 'shared' });

    assert.equal(connector.callCount(), 3);
  });

  it('leaves twenty distinct concurrent refunds as twenty refunds', async () => {
    const { gateway, apiKey, connector } = await setup();

    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        gateway.handle(apiKey, {
          tool: 'stripe.refund',
          parameters: { amount: 120 },
          idempotencyKey: `distinct-${index}`,
        }),
      ),
    );

    assert.equal(connector.callCount(), 20, 'idempotency must not collapse genuinely distinct work');
  });

  it('records the repeat in the chain rather than hiding it', async () => {
    const { gateway, apiKey } = await setup();
    const request = { tool: 'stripe.refund', parameters: { amount: 120 }, idempotencyKey: 'audited' };

    await gateway.handle(apiKey, request);
    await gateway.handle(apiKey, request);

    const audit = await gateway.audit.read({ limit: 50 });
    const replays = audit.filter((record) => record.type === 'action.replayed');
    assert.equal(replays.length, 1);
    assert.match(replays[0]!.summary, /returned the recorded outcome/);

    const verification = await gateway.audit.verify();
    assert.equal(verification.valid, true);
  });
});

describe('the idempotency scope', () => {
  it('cannot be confused by a key that looks like a scope separator', async () => {
    const base = {
      id: 'arc_act_1',
      agentId: 'arc_ag_1',
      agentName: 'a',
      organizationId: 'org',
      environment: 'production',
      toolId: 'arc_tl_1',
      parameters: {},
      parametersDigest: 'sha256:0',
      requestedAt: '2026-01-01T00:00:00.000Z',
    };

    const left = scopeOf({ ...base, tool: 'a.b', idempotencyKey: 'c' } as Action);
    const right = scopeOf({ ...base, tool: 'a', idempotencyKey: 'b.c' } as Action);
    assert.notEqual(left, right);
  });
});

describe('the idempotency ledger', () => {
  /** The smallest action that satisfies the predicate the ledger searches on. */
  function actionOf(key: string, id = 'arc_act_1'): Action {
    return {
      id,
      agentId: 'arc_ag_1',
      agentName: 'finance-agent',
      organizationId: 'org',
      environment: 'production',
      tool: 'stripe.refund',
      toolId: 'arc_tl_1',
      parameters: { amount: 1 },
      parametersDigest: digest({ amount: 1 }),
      idempotencyKey: key,
      source: 'api',
      requestedAt: '2026-01-01T00:00:00.000Z',
    };
  }

  const result = (actionId: string): ActionResult => ({
    actionId,
    outcome: 'executed',
    decision: { effect: 'ALLOW', reason: 'permitted' },
    evidenceId: 'arc_ev_1',
    completedAt: '2026-01-01T00:00:00.000Z',
  });

  it('releases the key once the claim settles, so the map does not grow without bound', async () => {
    const ledger = new IdempotencyLedger(new MemoryStore());

    for (let index = 0; index < 100; index += 1) {
      const action = actionOf(`key-${index}`, `arc_act_${index}`);
      const claim = await ledger.claim(action);
      assert.equal(claim.kind, 'claimed');
      ledger.settle(claim.kind === 'claimed' ? claim.scope : '', result(action.id));
    }

    assert.equal(ledger.inFlight, 0);
  });

  it('releases the key when the claim is abandoned, and raises the cause for anyone joined', async () => {
    const ledger = new IdempotencyLedger(new MemoryStore());
    const action = actionOf('abandoned');

    const claim = await ledger.claim(action);
    assert.equal(claim.kind, 'claimed');

    const repeat = await ledger.claim(actionOf('abandoned', 'arc_act_2'));
    assert.equal(repeat.kind, 'in_progress');

    const failure = new ArcError('execution_failed', 'the vendor refused');
    if (claim.kind === 'claimed') ledger.abandon(claim.scope, failure);

    if (repeat.kind === 'in_progress') {
      await assert.rejects(() => repeat.outcome, (error: unknown) => error === failure);
    }
    assert.equal(ledger.inFlight, 0);
  });

  it('reports a settled key as settled once the claim that held it is gone', async () => {
    const ledger = new IdempotencyLedger(new MemoryStore());
    const action = actionOf('settled');

    const claim = await ledger.claim(action);
    if (claim.kind === 'claimed') ledger.settle(claim.scope, result(action.id));

    const repeat = await ledger.claim(actionOf('settled', 'arc_act_2'));
    assert.equal(repeat.kind, 'settled');
    if (repeat.kind === 'settled') assert.equal(repeat.original.id, action.id);
  });
});

/** Polls until a condition holds, so a test does not depend on tick counts. */
async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('condition did not hold in time');
}

