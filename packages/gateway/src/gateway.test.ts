import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { ArcError, type Policy } from '@arc-control/schemas';
import { MemoryStore } from '@arc-control/store';
import { ConnectorError } from '@arc-control/execution';
import { verifyEvidence } from '@arc-control/evidence';
import { Gateway } from './gateway.js';
import { RecordingConnector } from './harness.test-support.js';

/** The refund policy from the README. */
const FINANCE_004: Policy = {
  id: 'FINANCE-004',
  version: 1,
  name: 'Autonomous refund authority',
  enabled: true,
  match: { tools: ['stripe.refund'] },
  rules: [
    {
      id: 'under-500',
      when: { lt: ['$.action.parameters.amount', 500] },
      effect: 'ALLOW',
      reason: 'within autonomous refund authority',
    },
    {
      id: 'needs-approval',
      when: { lte: ['$.action.parameters.amount', 2500] },
      effect: 'REQUIRE_APPROVAL',
      reason: 'above autonomous refund authority, below the hard ceiling',
      approval: { approvers: ['role:finance-manager'], minApprovals: 1, expiresInSeconds: 3600 },
    },
    {
      id: 'over-ceiling',
      when: { always: true },
      effect: 'DENY',
      reason: 'exceeds autonomous refund authority',
    },
  ],
  fallback: { effect: 'DENY', reason: 'no refund rule matched' },
};

interface Harness {
  gateway: Gateway;
  connector: RecordingConnector;
  apiKey: string;
  agentId: string;
}

async function setup(): Promise<Harness> {
  const connector = new RecordingConnector((parameters) => ({
    refundId: 're_simulated',
    amount: parameters.amount,
  }));

  const gateway = new Gateway({ store: new MemoryStore() });
  gateway.addConnector(connector);

  await gateway.tools.register({
    name: 'stripe.refund',
    description: 'Refund a charge.',
    effect: 'irreversible',
    connector: 'recording',
    parameters: [
      { name: 'customer', type: 'string', required: true },
      { name: 'amount', type: 'number', required: true, minimum: 0 },
    ],
  });

  await gateway.policies.publish(FINANCE_004);

  const agent = await gateway.agents.register({
    name: 'finance-agent',
    owner: 'finance@example.com',
    roles: ['finance'],
  });
  const { apiKey } = await gateway.agents.issueKey(agent.id);

  return { gateway, connector, apiKey, agentId: agent.id };
}

describe('Gateway: the v0.1 end-to-end workflow', () => {
  let harness: Harness;
  beforeEach(async () => {
    harness = await setup();
  });

  it('allows, executes and evidences a refund below the limit', async () => {
    const result = await harness.gateway.handle(harness.apiKey, {
      tool: 'stripe.refund',
      parameters: { customer: 'customer_123', amount: 120 },
    });

    assert.equal(result.outcome, 'executed');
    assert.equal(result.decision.effect, 'ALLOW');
    assert.equal(result.decision.policyId, 'FINANCE-004');
    assert.deepEqual(result.result, { refundId: 're_simulated', amount: 120 });
    assert.equal(harness.connector.callCount('stripe.refund'), 1);
    assert.match(result.evidenceId, /^arc_ev_[0-9a-f]{32}$/);
  });

  it('denies the $4,200 refund and never reaches the system', async () => {
    const result = await harness.gateway.handle(harness.apiKey, {
      tool: 'stripe.refund',
      parameters: { customer: 'customer_123', amount: 4200 },
    });

    assert.equal(result.outcome, 'denied');
    assert.equal(result.decision.effect, 'DENY');
    assert.equal(result.decision.policyId, 'FINANCE-004');
    assert.equal(result.decision.ruleId, 'over-ceiling');
    assert.equal(result.decision.reason, 'exceeds autonomous refund authority');
    // The claim that matters: the refund did not happen.
    assert.equal(harness.connector.callCount(), 0);
  });

  it('writes evidence for a denial, not just for a success', async () => {
    const result = await harness.gateway.handle(harness.apiKey, {
      tool: 'stripe.refund',
      parameters: { customer: 'customer_123', amount: 4200 },
    });

    const evidence = await harness.gateway.evidence(result.evidenceId);
    assert.ok(evidence, 'a denied action must still leave evidence');
    assert.equal(evidence.outcome, 'denied');
    assert.equal(evidence.decision.policyId, 'FINANCE-004');
    assert.equal(evidence.decision.reason, 'exceeds autonomous refund authority');
    assert.equal(evidence.execution, undefined);
    assert.ok(verifyEvidence(evidence), 'evidence must verify against its own digest');
  });

  it('holds a refund in the approval band without executing it', async () => {
    const result = await harness.gateway.handle(harness.apiKey, {
      tool: 'stripe.refund',
      parameters: { customer: 'customer_123', amount: 1800 },
    });

    assert.equal(result.outcome, 'pending_approval');
    assert.ok(result.approvalId);
    assert.equal(harness.connector.callCount(), 0);

    const pending = await harness.gateway.approvals.listPending();
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.tool, 'stripe.refund');
  });

  it('executes a held refund only after a named approver approves it', async () => {
    const held = await harness.gateway.handle(harness.apiKey, {
      tool: 'stripe.refund',
      parameters: { customer: 'customer_123', amount: 1800 },
    });

    await harness.gateway.approvals.vote({
      approvalId: held.approvalId!,
      approver: { identifier: 'cfo@example.com', roles: ['finance-manager'] },
      vote: 'approve',
    });

    assert.equal(harness.connector.callCount(), 0, 'approving must not itself execute the action');

    const executed = await harness.gateway.resume(held.approvalId!);
    assert.equal(executed.outcome, 'executed');
    assert.equal(harness.connector.callCount('stripe.refund'), 1);

    const evidence = await harness.gateway.evidence(executed.evidenceId);
    assert.equal(evidence?.approval?.status, 'approved');
    assert.deepEqual(
      evidence?.approval?.votes.map((vote) => vote.approver),
      ['cfo@example.com'],
    );
  });

  it('refuses to execute a held refund that was rejected', async () => {
    const held = await harness.gateway.handle(harness.apiKey, {
      tool: 'stripe.refund',
      parameters: { customer: 'customer_123', amount: 1800 },
    });

    await harness.gateway.approvals.vote({
      approvalId: held.approvalId!,
      approver: { identifier: 'cfo@example.com', roles: ['finance-manager'] },
      vote: 'reject',
    });

    await assert.rejects(
      () => harness.gateway.resume(held.approvalId!),
      (error: unknown) => error instanceof ArcError && error.code === 'approval_rejected',
    );
    assert.equal(harness.connector.callCount(), 0);
  });

  it('will not let one approval authorize two executions', async () => {
    const held = await harness.gateway.handle(harness.apiKey, {
      tool: 'stripe.refund',
      parameters: { customer: 'customer_123', amount: 1800 },
    });
    await harness.gateway.approvals.vote({
      approvalId: held.approvalId!,
      approver: { identifier: 'cfo@example.com', roles: ['finance-manager'] },
      vote: 'approve',
    });

    await harness.gateway.resume(held.approvalId!);
    await assert.rejects(
      () => harness.gateway.resume(held.approvalId!),
      (error: unknown) => error instanceof ArcError && error.code === 'conflict',
    );
    assert.equal(harness.connector.callCount('stripe.refund'), 1);
  });

  it('refuses a vote from someone the policy did not name', async () => {
    const held = await harness.gateway.handle(harness.apiKey, {
      tool: 'stripe.refund',
      parameters: { customer: 'customer_123', amount: 1800 },
    });

    await assert.rejects(
      () =>
        harness.gateway.approvals.vote({
          approvalId: held.approvalId!,
          approver: { identifier: 'intern@example.com', roles: ['support'] },
          vote: 'approve',
        }),
      (error: unknown) => error instanceof ArcError && error.code === 'policy_denied',
    );
  });
});

describe('Gateway: identity is the first gate', () => {
  let harness: Harness;
  beforeEach(async () => {
    harness = await setup();
  });

  it('refuses an action with no credential', async () => {
    await assert.rejects(
      () => harness.gateway.handle(undefined, { tool: 'stripe.refund', parameters: { customer: 'c', amount: 1 } }),
      (error: unknown) => error instanceof ArcError && error.code === 'unauthenticated',
    );
    assert.equal(harness.connector.callCount(), 0);
  });

  it('refuses a forged credential', async () => {
    // Change the last character to something it is not: overwriting it with a
    // fixed '0' left the key intact whenever the random key already ended in '0'.
    const last = harness.apiKey.at(-1);
    const forged = `${harness.apiKey.slice(0, -1)}${last === '0' ? '1' : '0'}`;
    await assert.rejects(
      () =>
        harness.gateway.handle(forged, {
          tool: 'stripe.refund',
          parameters: { customer: 'c', amount: 1 },
        }),
      (error: unknown) => error instanceof ArcError && error.code === 'unauthenticated',
    );
  });

  it('refuses a suspended agent before policy is ever consulted', async () => {
    await harness.gateway.agents.suspend(harness.agentId);
    await assert.rejects(
      () =>
        harness.gateway.handle(harness.apiKey, {
          tool: 'stripe.refund',
          parameters: { customer: 'c', amount: 1 },
        }),
      (error: unknown) => error instanceof ArcError && error.code === 'agent_suspended',
    );
    assert.equal(harness.connector.callCount(), 0);
  });

  it('refuses a revoked credential', async () => {
    const keys = await harness.gateway.agents.listKeys(harness.agentId);
    await harness.gateway.agents.revokeKey(keys[0]!.id);
    await assert.rejects(
      () =>
        harness.gateway.handle(harness.apiKey, {
          tool: 'stripe.refund',
          parameters: { customer: 'c', amount: 1 },
        }),
      (error: unknown) => error instanceof ArcError && error.code === 'unauthenticated',
    );
  });
});

describe('Gateway: the tool contract', () => {
  let harness: Harness;
  beforeEach(async () => {
    harness = await setup();
  });

  it('refuses an unregistered tool', async () => {
    await assert.rejects(
      () => harness.gateway.handle(harness.apiKey, { tool: 'stripe.payout', parameters: {} }),
      (error: unknown) => error instanceof ArcError && error.code === 'unknown_tool',
    );
  });

  it('refuses parameters the tool never declared', async () => {
    await assert.rejects(
      () =>
        harness.gateway.handle(harness.apiKey, {
          tool: 'stripe.refund',
          parameters: { customer: 'c', amount: 10, destination: 'attacker@example.com' },
        }),
      (error: unknown) => error instanceof ArcError && error.code === 'invalid_parameters',
    );
    assert.equal(harness.connector.callCount(), 0);
  });

  it('refuses a missing required parameter', async () => {
    await assert.rejects(
      () => harness.gateway.handle(harness.apiKey, { tool: 'stripe.refund', parameters: { amount: 10 } }),
      (error: unknown) => error instanceof ArcError && error.code === 'invalid_parameters',
    );
  });
});

describe('Gateway: execution failures are reported honestly', () => {
  it('records a failed execution as failed, with evidence', async () => {
    const harness = await setup();
    harness.connector.failWith(new ConnectorError('card_declined', 'the acquirer declined the refund'));

    const result = await harness.gateway.handle(harness.apiKey, {
      tool: 'stripe.refund',
      parameters: { customer: 'customer_123', amount: 100 },
    });

    assert.equal(result.outcome, 'failed');
    assert.equal(result.decision.effect, 'ALLOW');
    assert.equal(result.error?.code, 'card_declined');

    const evidence = await harness.gateway.evidence(result.evidenceId);
    assert.equal(evidence?.execution?.status, 'failed');
    assert.equal(evidence?.execution?.error?.code, 'card_declined');
    assert.equal(evidence?.outcome, 'failed');
  });

  it('does not retry an irreversible action', async () => {
    const harness = await setup();
    harness.connector.failWith(new ConnectorError('upstream_unavailable', 'temporary', { retryable: true }));

    await harness.gateway.handle(harness.apiKey, {
      tool: 'stripe.refund',
      parameters: { customer: 'customer_123', amount: 100 },
    });

    assert.equal(harness.connector.callCount('stripe.refund'), 1);
  });
});

describe('Gateway: idempotency', () => {
  it('returns the original outcome rather than acting twice', async () => {
    const harness = await setup();
    const request = {
      tool: 'stripe.refund',
      parameters: { customer: 'customer_123', amount: 100 },
      idempotencyKey: 'refund-attempt-1',
    };

    const first = await harness.gateway.handle(harness.apiKey, request);
    const second = await harness.gateway.handle(harness.apiKey, request);

    assert.equal(first.outcome, 'executed');
    assert.equal(second.outcome, 'executed');
    assert.equal(second.actionId, first.actionId);
    assert.equal(second.evidenceId, first.evidenceId);
    assert.equal(harness.connector.callCount('stripe.refund'), 1);
  });

  it('refuses a reused key carrying different parameters', async () => {
    const harness = await setup();
    await harness.gateway.handle(harness.apiKey, {
      tool: 'stripe.refund',
      parameters: { customer: 'customer_123', amount: 100 },
      idempotencyKey: 'refund-attempt-1',
    });

    await assert.rejects(
      () =>
        harness.gateway.handle(harness.apiKey, {
          tool: 'stripe.refund',
          parameters: { customer: 'customer_123', amount: 400 },
          idempotencyKey: 'refund-attempt-1',
        }),
      (error: unknown) => error instanceof ArcError && error.code === 'conflict',
    );
    assert.equal(harness.connector.callCount('stripe.refund'), 1);
  });
});

describe('Gateway: the audit chain', () => {
  it('records the whole lifecycle and verifies', async () => {
    const harness = await setup();

    await harness.gateway.handle(harness.apiKey, {
      tool: 'stripe.refund',
      parameters: { customer: 'customer_123', amount: 120 },
    });
    await harness.gateway.handle(harness.apiKey, {
      tool: 'stripe.refund',
      parameters: { customer: 'customer_123', amount: 4200 },
    });

    const verification = await harness.gateway.audit.verify();
    assert.equal(verification.valid, true);
    assert.deepEqual(verification.failures, []);

    const records = await harness.gateway.audit.read();
    const types = records.map((record) => record.type);
    assert.ok(types.includes('action.requested'));
    assert.ok(types.includes('action.allowed'));
    assert.ok(types.includes('action.executed'));
    assert.ok(types.includes('action.denied'));
    assert.ok(types.includes('evidence.recorded'));

    // Sequence numbers are contiguous and links hold.
    records.forEach((record, index) => {
      assert.equal(record.sequence, index + 1);
      if (index > 0) assert.equal(record.previousDigest, records[index - 1]!.digest);
    });
  });

  it('detects a tampered record', async () => {
    const harness = await setup();
    await harness.gateway.handle(harness.apiKey, {
      tool: 'stripe.refund',
      parameters: { customer: 'customer_123', amount: 4200 },
    });

    const records = await harness.gateway.audit.read();
    const forged = records.map((record, index) =>
      index === 1 ? { ...record, summary: 'nothing to see here' } : record,
    );

    const { verifyChain } = await import('@arc-control/audit');
    const verification = verifyChain(forged);
    assert.equal(verification.valid, false);
    assert.equal(verification.failures[0]?.problem, 'digest_mismatch');
  });
});

describe('Gateway: secrets never reach evidence', () => {
  it('redacts a sensitive parameter in evidence and audit', async () => {
    const connector = new RecordingConnector(() => ({ ok: true }));
    const gateway = new Gateway({ store: new MemoryStore() });
    gateway.addConnector(connector);

    await gateway.tools.register({
      name: 'vault.write',
      description: 'Write a secret.',
      effect: 'write',
      connector: 'recording',
      parameters: [
        { name: 'path', type: 'string', required: true },
        { name: 'api_key', type: 'string', required: true, sensitive: true },
      ],
    });
    await gateway.policies.publish({
      id: 'VAULT-001',
      version: 1,
      name: 'Vault writes',
      enabled: true,
      match: { tools: ['vault.write'] },
      rules: [{ id: 'allow', when: { always: true }, effect: 'ALLOW', reason: 'permitted for platform agents' }],
      fallback: { effect: 'DENY', reason: 'not permitted' },
    });

    const agent = await gateway.agents.register({ name: 'platform-agent', owner: 'platform@example.com' });
    const { apiKey } = await gateway.agents.issueKey(agent.id);

    const result = await gateway.handle(apiKey, {
      tool: 'vault.write',
      parameters: { path: 'secret/app', api_key: 'sk_live_do_not_log_me' },
    });

    const evidence = await gateway.evidence(result.evidenceId);
    assert.equal(evidence?.request.parameters.api_key, '[redacted]');
    assert.equal(evidence?.request.parameters.path, 'secret/app');

    const serialized = JSON.stringify(await gateway.audit.read());
    assert.ok(!serialized.includes('sk_live_do_not_log_me'), 'a secret must never appear in the audit log');

    // The connector still received the real value: redaction is for the record, not the call.
    assert.equal(connector.calls[0]?.parameters.api_key, 'sk_live_do_not_log_me');
  });
});
