import { expect } from '../harness.mjs';
import { buildHarness, financeManager, refund } from '../fixtures.mjs';

/**
 * Reliability guarantees.
 *
 * A control plane that loses a decision, double-executes a refund or reports a
 * failure as a success is worse than no control plane, because people will
 * trust its records. These are the properties that make the record worth
 * trusting.
 */
export default {
  id: 'reliability/guarantees',
  title: 'The record can be trusted',
  rationale: 'One authorization means one effect; failures are reported as failures; the chain verifies.',
  cases: [
    {
      name: 'every action leaves exactly one evidence record, whatever the outcome',
      async run() {
        const { gateway, apiKey } = await buildHarness();

        await gateway.handle(apiKey, refund(120));
        await gateway.handle(apiKey, refund(1800));
        await gateway.handle(apiKey, refund(4200));

        const evidence = await gateway.listEvidence();
        expect.equal(evidence.length, 3, 'allowed, held and denied actions each leave one record');

        const outcomes = evidence.map((record) => record.outcome).sort();
        expect.deepEqual(outcomes, ['denied', 'executed', 'pending_approval'], 'and each records its own outcome');
      },
    },
    {
      name: 'an approved action executes exactly once, however many times it is resumed',
      async run() {
        const { gateway, apiKey, connector } = await buildHarness();

        const held = await gateway.handle(apiKey, refund(1800));
        await gateway.approvals.vote({ approvalId: held.approvalId, approver: financeManager, vote: 'approve' });

        await gateway.resume(held.approvalId);
        await expect.rejects(
          () => gateway.resume(held.approvalId),
          'conflict',
          'a granted approval must not authorize a second execution',
        );

        expect.equal(connector.callCount('stripe.refund'), 1, 'the refund must have happened exactly once');
      },
    },
    {
      name: 'two callers racing to resume one approval produce one execution',
      async run() {
        const { gateway, apiKey, connector } = await buildHarness();

        const held = await gateway.handle(apiKey, refund(1800));
        await gateway.approvals.vote({ approvalId: held.approvalId, approver: financeManager, vote: 'approve' });

        const outcomes = await Promise.allSettled([
          gateway.resume(held.approvalId),
          gateway.resume(held.approvalId),
          gateway.resume(held.approvalId),
        ]);

        const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
        expect.equal(fulfilled.length, 1, 'exactly one concurrent resume may succeed');
        expect.equal(connector.callCount('stripe.refund'), 1, 'and the refund must have happened once');
      },
    },
    {
      name: 'one approver cannot reach a two-approver threshold alone',
      async run() {
        const { gateway, apiKey, connector } = await buildHarness({
          policies: [
            {
              id: 'FINANCE-DUAL',
              version: 1,
              name: 'Dual control refunds',
              enabled: true,
              match: { tools: ['stripe.refund'] },
              rules: [
                {
                  id: 'two-approvers',
                  when: { always: true },
                  effect: 'REQUIRE_APPROVAL',
                  reason: 'refunds require dual control',
                  approval: { approvers: ['role:finance-manager'], minApprovals: 2 },
                },
              ],
              fallback: { effect: 'DENY', reason: 'no rule matched' },
            },
          ],
        });

        const held = await gateway.handle(apiKey, refund(100));
        await gateway.approvals.vote({ approvalId: held.approvalId, approver: financeManager, vote: 'approve' });

        await expect.rejects(
          () =>
            gateway.approvals.vote({ approvalId: held.approvalId, approver: financeManager, vote: 'approve' }),
          'conflict',
          'the same approver must not be able to vote twice',
        );
        await expect.rejects(
          () => gateway.resume(held.approvalId),
          'approval_required',
          'the action must stay held until the threshold is genuinely met',
        );
        expect.equal(connector.callCount(), 0, 'nothing executes on a single vote');

        const second = { identifier: 'controller@example.com', roles: ['finance-manager'] };
        await gateway.approvals.vote({ approvalId: held.approvalId, approver: second, vote: 'approve' });
        const executed = await gateway.resume(held.approvalId);
        expect.equal(executed.outcome, 'executed', 'two distinct approvers satisfy dual control');
      },
    },
    {
      name: 'an agent owner cannot approve their own agent under separation of duties',
      async run() {
        const { gateway, apiKey } = await buildHarness({
          policies: [
            {
              id: 'FINANCE-SOD',
              version: 1,
              name: 'Separated refunds',
              enabled: true,
              match: { tools: ['stripe.refund'] },
              rules: [
                {
                  id: 'needs-someone-else',
                  when: { always: true },
                  effect: 'REQUIRE_APPROVAL',
                  reason: 'refunds need a second pair of eyes',
                  approval: {
                    approvers: ['role:finance-manager', 'owner'],
                    minApprovals: 1,
                    requireSeparationOfDuties: true,
                  },
                },
              ],
              fallback: { effect: 'DENY', reason: 'no rule matched' },
            },
          ],
        });

        const held = await gateway.handle(apiKey, refund(100));
        const request = await gateway.approvals.require(held.approvalId);

        // The owner is explicitly listed as an approver, and is still barred.
        expect.equal(
          gateway.approvals.canApprove(request, { identifier: 'finance-ops@example.com', roles: ['finance-manager'] }),
          false,
          'the agent owner must be barred however else they would match',
        );
        expect.equal(
          gateway.approvals.canApprove(request, financeManager),
          true,
          'somebody else holding the role may still approve',
        );
      },
    },
    {
      name: 'an expired approval cannot be executed',
      async run() {
        let now = new Date('2026-01-15T12:00:00.000Z');
        const { Gateway } = await import('@arc-control/gateway');
        const { MemoryStore } = await import('@arc-control/store');
        const { SimulationConnector } = await import('@arc-control/connector-simulation');

        const connector = new SimulationConnector().handle('stripe.refund', () => ({ ok: true }));
        const gateway = new Gateway({ store: new MemoryStore(), now: () => now });
        gateway.addConnector(connector);

        const actor = { identifier: 'evals', via: 'system' };
        await gateway.admin.registerTool(
          {
            name: 'stripe.refund',
            description: 'Refund a charge.',
            effect: 'irreversible',
            connector: connector.name,
            parameters: [
              { name: 'customer', type: 'string', required: true },
              { name: 'amount', type: 'number', required: true },
            ],
          },
          actor,
        );
        await gateway.admin.publishPolicy(
          {
            id: 'SHORT-WINDOW',
            version: 1,
            name: 'Short approval window',
            enabled: true,
            match: { tools: ['stripe.refund'] },
            rules: [
              {
                id: 'needs-approval',
                when: { always: true },
                effect: 'REQUIRE_APPROVAL',
                reason: 'needs a human',
                approval: { approvers: ['role:finance-manager'], minApprovals: 1, expiresInSeconds: 60 },
              },
            ],
            fallback: { effect: 'DENY', reason: 'no rule matched' },
          },
          actor,
        );
        const agent = await gateway.admin.registerAgent(
          { name: 'finance-agent', owner: 'finance-ops@example.com', roles: ['finance'] },
          actor,
        );
        const { apiKey } = await gateway.admin.issueKey(agent.id, actor);

        const held = await gateway.handle(apiKey, refund(100));

        now = new Date('2026-01-15T12:05:00.000Z');

        await expect.rejects(
          () => gateway.approvals.vote({ approvalId: held.approvalId, approver: financeManager, vote: 'approve' }),
          'conflict',
          'a vote after the window has closed must be refused',
        );
        await expect.rejects(
          () => gateway.resume(held.approvalId),
          'approval_expired',
          'an expired approval must not authorize anything',
        );
        expect.equal(connector.callCount(), 0, 'and nothing may have executed');
      },
    },
    {
      name: 'a retried action with the same key does not act twice',
      async run() {
        const { gateway, apiKey, connector } = await buildHarness();
        const request = { ...refund(100), idempotencyKey: 'retry-1' };

        const first = await gateway.handle(apiKey, request);
        const second = await gateway.handle(apiKey, request);

        expect.equal(second.actionId, first.actionId, 'the repeat must return the original action');
        expect.equal(second.evidenceId, first.evidenceId, 'and the original evidence');
        expect.equal(connector.callCount('stripe.refund'), 1, 'the refund must have happened once');
      },
    },
    {
      name: 'a reused key with different parameters is refused rather than conflated',
      async run() {
        const { gateway, apiKey, connector } = await buildHarness();

        await gateway.handle(apiKey, { ...refund(100), idempotencyKey: 'retry-1' });
        await expect.rejects(
          () => gateway.handle(apiKey, { ...refund(400), idempotencyKey: 'retry-1' }),
          'conflict',
          'a key reused for different parameters must be refused, not treated as a repeat',
        );
        expect.equal(connector.callCount('stripe.refund'), 1, 'and must not cause a second refund');
      },
    },
    {
      name: 'a failed execution is reported as failed, not as a success',
      async run() {
        const { Gateway } = await import('@arc-control/gateway');
        const { MemoryStore } = await import('@arc-control/store');
        const { ConnectorError } = await import('@arc-control/execution');
        const { SimulationConnector } = await import('@arc-control/connector-simulation');

        const connector = new SimulationConnector().handle('stripe.refund', () => {
          throw new ConnectorError('card_declined', 'the acquirer declined the refund');
        });

        const gateway = new Gateway({ store: new MemoryStore() });
        gateway.addConnector(connector);

        const actor = { identifier: 'evals', via: 'system' };
        await gateway.admin.registerTool(
          {
            name: 'stripe.refund',
            description: 'Refund a charge.',
            effect: 'irreversible',
            connector: connector.name,
            parameters: [
              { name: 'customer', type: 'string', required: true },
              { name: 'amount', type: 'number', required: true },
            ],
          },
          actor,
        );
        await gateway.admin.publishPolicy(
          {
            id: 'ALLOW-ALL',
            version: 1,
            name: 'Allow refunds',
            enabled: true,
            match: { tools: ['stripe.refund'] },
            rules: [{ id: 'allow', when: { always: true }, effect: 'ALLOW', reason: 'permitted' }],
            fallback: { effect: 'DENY', reason: 'no rule matched' },
          },
          actor,
        );
        const agent = await gateway.admin.registerAgent(
          { name: 'finance-agent', owner: 'finance-ops@example.com', roles: ['finance'] },
          actor,
        );
        const { apiKey } = await gateway.admin.issueKey(agent.id, actor);

        const result = await gateway.handle(apiKey, refund(100));

        expect.equal(result.outcome, 'failed', 'a connector failure must surface as a failure');
        expect.equal(result.decision.effect, 'ALLOW', 'while still recording that policy allowed it');
        expect.equal(result.error.code, 'card_declined', 'and keeping the connector’s own error code');

        const evidence = await gateway.evidence(result.evidenceId);
        expect.equal(evidence.execution.status, 'failed', 'evidence must record the failure');
        expect.equal(
          evidence.outcome,
          'failed',
          'the outcome must not read as executed; a false record is worse than none',
        );
      },
    },
    {
      name: 'an irreversible action is never retried automatically',
      async run() {
        const { Gateway } = await import('@arc-control/gateway');
        const { MemoryStore } = await import('@arc-control/store');
        const { ConnectorError } = await import('@arc-control/execution');
        const { SimulationConnector } = await import('@arc-control/connector-simulation');

        let attempts = 0;
        const connector = new SimulationConnector().handle('stripe.refund', () => {
          attempts += 1;
          // A timeout or a 503 may well have taken effect upstream.
          throw new ConnectorError('upstream_unavailable', 'temporarily unavailable', { retryable: true });
        });

        const gateway = new Gateway({ store: new MemoryStore() });
        gateway.addConnector(connector);

        const actor = { identifier: 'evals', via: 'system' };
        await gateway.admin.registerTool(
          {
            name: 'stripe.refund',
            description: 'Refund a charge.',
            effect: 'irreversible',
            connector: connector.name,
            parameters: [
              { name: 'customer', type: 'string', required: true },
              { name: 'amount', type: 'number', required: true },
            ],
          },
          actor,
        );
        await gateway.admin.publishPolicy(
          {
            id: 'ALLOW-ALL',
            version: 1,
            name: 'Allow refunds',
            enabled: true,
            match: { tools: ['stripe.refund'] },
            rules: [{ id: 'allow', when: { always: true }, effect: 'ALLOW', reason: 'permitted' }],
            fallback: { effect: 'DENY', reason: 'no rule matched' },
          },
          actor,
        );
        const agent = await gateway.admin.registerAgent(
          { name: 'finance-agent', owner: 'finance-ops@example.com', roles: ['finance'] },
          actor,
        );
        const { apiKey } = await gateway.admin.issueKey(agent.id, actor);

        await gateway.handle(apiKey, refund(100));
        expect.equal(attempts, 1, 'an irreversible action must be attempted once: one authorization, one effect');
      },
    },
    {
      name: 'the audit chain covers the whole lifecycle and verifies',
      async run() {
        const { gateway, apiKey } = await buildHarness();

        const held = await gateway.handle(apiKey, refund(1800));
        await gateway.approvals.vote({ approvalId: held.approvalId, approver: financeManager, vote: 'approve' });
        await gateway.resume(held.approvalId);
        await gateway.handle(apiKey, refund(4200));

        const verification = await gateway.audit.verify();
        expect.equal(verification.valid, true, 'the chain must verify');
        expect.deepEqual(verification.failures, [], 'with no failures');

        const records = await gateway.audit.read();
        const types = new Set(records.map((record) => record.type));
        for (const required of [
          'tool.registered',
          'policy.created',
          'agent.registered',
          'credential.issued',
          'action.requested',
          'approval.requested',
          'approval.approved',
          'action.executed',
          'action.denied',
          'evidence.recorded',
        ]) {
          expect.ok(types.has(required), `the chain must record ${required}`);
        }

        records.forEach((record, index) => {
          expect.equal(record.sequence, index + 1, 'sequence numbers must be contiguous');
          if (index > 0) {
            expect.equal(record.previousDigest, records[index - 1].digest, 'each record must link to its predecessor');
          }
        });
      },
    },
    {
      name: 'editing one audit record is detectable',
      async run() {
        const { verifyChain } = await import('@arc-control/audit');
        const { gateway, apiKey } = await buildHarness();

        await gateway.handle(apiKey, refund(4200));
        const records = await gateway.audit.read();

        const target = records.findIndex((record) => record.type === 'action.denied');
        expect.ok(target >= 0, 'there should be a denial to tamper with');

        const forged = records.map((record, index) =>
          index === target ? { ...record, summary: 'nothing to see here' } : record,
        );

        const verification = verifyChain(forged);
        expect.equal(verification.valid, false, 'an edited record must break verification');
        expect.equal(verification.failures[0].problem, 'digest_mismatch', 'and be reported as a digest mismatch');
        expect.equal(
          verification.failures[0].sequence,
          records[target].sequence,
          'and name the record that was altered',
        );
      },
    },
    {
      name: 'removing an audit record leaves a gap',
      async run() {
        const { verifyChain } = await import('@arc-control/audit');
        const { gateway, apiKey } = await buildHarness();

        await gateway.handle(apiKey, refund(4200));
        const records = await gateway.audit.read();

        const truncated = records.filter((_, index) => index !== records.length - 2);
        const verification = verifyChain(truncated);

        expect.equal(verification.valid, false, 'a removed record must break verification');
        expect.ok(
          verification.failures.some((failure) => failure.problem === 'sequence_gap' || failure.problem === 'broken_link'),
          'and be reported as a gap or a broken link',
        );
      },
    },
    {
      name: 'an evidence record verifies on its own, and fails if altered',
      async run() {
        const { verifyEvidence } = await import('@arc-control/evidence');
        const { gateway, apiKey } = await buildHarness();

        const result = await gateway.handle(apiKey, refund(4200));
        const evidence = await gateway.evidence(result.evidenceId);

        expect.equal(verifyEvidence(evidence), true, 'an untouched record must verify');
        expect.equal(
          verifyEvidence({ ...evidence, outcome: 'executed' }),
          false,
          'rewriting a denial into an execution must be detectable',
        );
        expect.equal(
          verifyEvidence({
            ...evidence,
            decision: { ...evidence.decision, reason: 'approved by management' },
          }),
          false,
          'rewriting the reason must be detectable',
        );
      },
    },
    {
      name: 'the durable store survives a restart with the chain intact',
      async run() {
        const { mkdtemp, rm } = await import('node:fs/promises');
        const { tmpdir } = await import('node:os');
        const { join } = await import('node:path');
        const { FileStore } = await import('@arc-control/store');
        const { Gateway } = await import('@arc-control/gateway');
        const { SimulationConnector } = await import('@arc-control/connector-simulation');

        const directory = await mkdtemp(join(tmpdir(), 'arc-eval-'));
        const actor = { identifier: 'evals', via: 'system' };

        try {
          const build = async () => {
            const store = await FileStore.open(directory);
            const connector = new SimulationConnector().handle('stripe.refund', () => ({ ok: true }));
            const gateway = new Gateway({ store });
            gateway.addConnector(connector);
            return { store, gateway };
          };

          // First process: configure and act.
          const first = await build();
          await first.gateway.admin.registerTool(
            {
              name: 'stripe.refund',
              description: 'Refund a charge.',
              effect: 'irreversible',
              connector: 'simulation',
              parameters: [
                { name: 'customer', type: 'string', required: true },
                { name: 'amount', type: 'number', required: true },
              ],
            },
            actor,
          );
          await first.gateway.admin.publishPolicy(
            {
              id: 'FINANCE-004',
              version: 1,
              name: 'Autonomous refund authority',
              enabled: true,
              match: { tools: ['stripe.refund'] },
              rules: [{ id: 'ceiling', when: { gt: ['$.action.parameters.amount', 2500] }, effect: 'DENY', reason: 'exceeds autonomous refund authority' }],
              fallback: { effect: 'ALLOW', reason: 'within autonomous refund authority' },
            },
            actor,
          );
          const agent = await first.gateway.admin.registerAgent(
            { name: 'finance-agent', owner: 'finance-ops@example.com', roles: ['finance'] },
            actor,
          );
          const { apiKey } = await first.gateway.admin.issueKey(agent.id, actor);
          await first.gateway.handle(apiKey, refund(4200));
          const before = await first.gateway.audit.count();
          await first.store.close();

          // Second process: the same directory, nothing in memory.
          const second = await build();
          const after = await second.gateway.audit.count();
          expect.equal(after, before, 'every audit record must survive the restart');

          const verification = await second.gateway.audit.verify();
          expect.equal(verification.valid, true, 'and the chain must still verify across the restart');

          const denied = (await second.gateway.listEvidence({ outcome: 'denied' }))[0];
          expect.ok(denied, 'the denial evidence must survive');
          expect.equal(denied.decision.policyId, 'FINANCE-004', 'with its policy citation intact');

          // And the credential issued before the restart still authenticates.
          const replayed = await second.gateway.handle(apiKey, refund(4200));
          expect.equal(replayed.outcome, 'denied', 'policy published before the restart must still govern');
          await second.store.close();
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      },
    },
  ],
};
