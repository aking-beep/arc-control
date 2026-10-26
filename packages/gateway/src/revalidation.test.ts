import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ArcError, type EvidenceRecord, type Policy } from '@arc-control/schemas';
import { MemoryStore } from '@arc-control/store';
import { Gateway } from './gateway.js';
import { RecordingConnector } from './harness.test-support.js';
import { heldApprovalSatisfies } from './revalidation.js';

/**
 * Regression cover for the stale-approval defect.
 *
 * The Meridian harness held an $1,850 refund for a manager, published an
 * always-deny policy for `finance.refund`, voted the approval through and
 * released it. ARC returned `executed` and the customer was refunded — while
 * an identical *new* request under the same policy was correctly denied. The
 * release path re-checked the tool's kill switch and the agent's lifecycle,
 * but it executed the decision stored at submission time and never asked what
 * policy said now.
 *
 * The tests below assert on the connector call count wherever a refusal is
 * claimed, because "ARC returned denied" and "the refund did not happen" are
 * different statements and only the second one matters.
 */

const FINANCE: Policy = {
  id: 'FINANCE-004',
  version: 1,
  name: 'Autonomous refund authority',
  enabled: true,
  match: { tools: ['stripe.refund'] },
  rules: [
    { id: 'under-500', when: { lt: ['$.action.parameters.amount', 500] }, effect: 'ALLOW', reason: 'within authority' },
    {
      id: 'needs-approval',
      when: { lte: ['$.action.parameters.amount', 2500] },
      effect: 'REQUIRE_APPROVAL',
      reason: 'a finance manager must approve',
      approval: { approvers: ['role:finance-manager'], minApprovals: 1, expiresInSeconds: 3600 },
    },
    { id: 'over-ceiling', when: { always: true }, effect: 'DENY', reason: 'exceeds the ceiling' },
  ],
  fallback: { effect: 'DENY', reason: 'no refund rule matched' },
};

/** The policy Meridian published while the approval sat in the queue. */
const SUSPENDED: Policy = {
  id: 'REFUNDS-FROZEN',
  version: 1,
  name: 'Refunds suspended',
  enabled: true,
  match: { tools: ['stripe.refund'] },
  rules: [{ id: 'freeze', when: { always: true }, effect: 'DENY', reason: 'refunds are suspended pending investigation' }],
  fallback: { effect: 'DENY', reason: 'refunds are suspended' },
};

async function setup() {
  const connector = new RecordingConnector(() => ({ refundId: 're_1' }));
  const store = new MemoryStore();
  const gateway = new Gateway({ store });
  gateway.addConnector(connector);

  const refund = await gateway.tools.register({
    name: 'stripe.refund',
    description: 'Refund a charge.',
    effect: 'irreversible',
    riskTier: 'critical',
    connector: 'recording',
    parameters: [{ name: 'amount', type: 'number', required: true, minimum: 0 }],
  });

  await gateway.admin.publishPolicy(FINANCE, { identifier: 'ops@example.com', via: 'api' });

  const agent = await gateway.agents.register({
    name: 'finance-agent',
    owner: 'agent-owner@example.com',
    roles: ['finance'],
  });
  const { apiKey } = await gateway.agents.issueKey(agent.id);

  /** Raises a held $1,850 refund and votes it through. Returns the approval id. */
  async function approved(): Promise<{ approvalId: string; actionId: string }> {
    const held = await gateway.handle(apiKey, { tool: 'stripe.refund', parameters: { amount: 1850 } });
    assert.equal(held.outcome, 'pending_approval');
    await gateway.approvals.vote({
      approvalId: held.approvalId!,
      approver: { identifier: 'cfo@example.com', roles: ['finance-manager'] },
      vote: 'approve',
    });
    return { approvalId: held.approvalId!, actionId: held.actionId };
  }

  const publish = (policy: Policy): Promise<Policy> =>
    gateway.admin.publishPolicy(policy, { identifier: 'ops@example.com', via: 'api' });

  return { gateway, store, connector, apiKey, agent, refund, approved, publish };
}

/** Evidence for an action, newest first — a released action has more than one. */
async function evidenceFor(gateway: Gateway, actionId: string): Promise<readonly EvidenceRecord[]> {
  const records = await gateway.store.evidence.filter((record) => record.actionId === actionId);
  return records.slice().reverse();
}

describe('a policy published while an approval is open', () => {
  it('stops the release, and the refund does not happen', async () => {
    const { gateway, connector, approved, publish } = await setup();
    const { approvalId } = await approved();

    await publish(SUSPENDED);
    const released = await gateway.resume(approvalId);

    assert.equal(released.outcome, 'denied');
    assert.equal(released.decision.effect, 'DENY');
    assert.equal(released.decision.policyId, 'REFUNDS-FROZEN');
    assert.equal(released.error?.code, 'policy_denied');
    assert.equal(connector.callCount('stripe.refund'), 0, 'the refund must not have reached the connector');
  });

  it('records the second look as evidence, citing the policy that stopped it', async () => {
    const { gateway, approved, publish } = await setup();
    const { approvalId, actionId } = await approved();

    await publish(SUSPENDED);
    const released = await gateway.resume(approvalId);

    const evidence = await gateway.evidence(released.evidenceId);
    assert.ok(evidence);
    assert.equal(evidence.outcome, 'denied');

    const revalidation = evidence.revalidation;
    assert.ok(revalidation, 'the release must record that current policy was consulted');
    assert.equal(revalidation.effect, 'DENY');
    assert.equal(revalidation.verdict, 'denied');
    assert.equal(revalidation.policyId, 'REFUNDS-FROZEN');
    assert.equal(revalidation.ruleId, 'freeze');
    assert.equal(revalidation.agentStatus, 'active');
    assert.equal(revalidation.toolDisabled, false);
    assert.equal(revalidation.approvalBound, true);
    assert.equal(revalidation.approvalId, approvalId);
    assert.match(revalidation.reason, /suspended/);

    // The fresh decision is stored in full, so the rule-by-rule path behind
    // the refusal can be read rather than taken on trust.
    const fresh = await gateway.decision(revalidation.decisionId!);
    assert.ok(fresh);
    assert.equal(fresh.effect, 'DENY');
    assert.equal(fresh.actionId, actionId);
  });

  it('leaves the original decision and the approval history intact', async () => {
    const { gateway, approved, publish } = await setup();
    const { approvalId, actionId } = await approved();

    await publish(SUSPENDED);
    const released = await gateway.resume(approvalId);

    const evidence = await gateway.evidence(released.evidenceId);
    // The decision of record is still the one the human was asked about.
    assert.equal(evidence?.decision.effect, 'REQUIRE_APPROVAL');
    assert.equal(evidence?.decision.policyId, 'FINANCE-004');
    assert.equal(evidence?.decision.ruleId, 'needs-approval');
    // And the vote is still on the record.
    assert.equal(evidence?.approval?.status, 'approved');
    assert.deepEqual(
      evidence?.approval?.votes.map((vote) => vote.approver),
      ['cfo@example.com'],
    );

    // The hold is still evidenced too: the refusal added a record, it did not
    // rewrite one.
    const all = await evidenceFor(gateway, actionId);
    assert.equal(all.length, 2);
    assert.deepEqual(
      all.map((record) => record.outcome).sort(),
      ['denied', 'pending_approval'],
    );
  });

  it('appends the revalidation to the chain, which still verifies', async () => {
    const { gateway, approved, publish } = await setup();
    const { approvalId } = await approved();

    await publish(SUSPENDED);
    await gateway.resume(approvalId);

    const audit = await gateway.audit.read({ limit: 100 });
    const revalidated = audit.filter((record) => record.type === 'action.revalidated');
    assert.equal(revalidated.length, 1);
    assert.match(revalidated[0]!.summary, /revalidated against current policy before release: denied/);
    assert.ok(
      audit.some((record) => record.type === 'action.denied' && /refused at release by current policy/.test(record.summary)),
    );

    assert.equal((await gateway.audit.verify()).valid, true);
  });

  it('does not spend the grant, so a policy published in error can be withdrawn', async () => {
    const { gateway, connector, approved, publish } = await setup();
    const { approvalId } = await approved();

    await publish(SUSPENDED);
    assert.equal((await gateway.resume(approvalId)).outcome, 'denied');

    // The human decision survives the mistake. Burning the grant on a policy
    // refusal would make an operator re-collect an approval they already have.
    await gateway.admin.setPolicyEnabled('REFUNDS-FROZEN', false, { identifier: 'ops@example.com', via: 'api' });
    const released = await gateway.resume(approvalId);

    assert.equal(released.outcome, 'executed');
    assert.equal(connector.callCount('stripe.refund'), 1, 'and it executes exactly once afterwards');
  });

  it('refuses every attempt while the deny stands, never once', async () => {
    const { gateway, connector, approved, publish } = await setup();
    const { approvalId } = await approved();
    await publish(SUSPENDED);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      assert.equal((await gateway.resume(approvalId)).outcome, 'denied');
    }
    assert.equal(connector.callCount('stripe.refund'), 0);
  });

  it('decides one way or the other when the publish races the release, never both', async () => {
    const { gateway, connector, approved, publish } = await setup();
    const { approvalId } = await approved();

    const [released] = await Promise.all([gateway.resume(approvalId), publish(SUSPENDED)]);

    // Either the release saw the old policy and executed, or it saw the new
    // one and refused. What must not happen is a refusal reported alongside a
    // refund, or two refunds.
    if (released.outcome === 'executed') {
      assert.equal(connector.callCount('stripe.refund'), 1);
    } else {
      assert.equal(released.outcome, 'denied');
      assert.equal(connector.callCount('stripe.refund'), 0);
    }
  });
});

describe('an unchanged policy', () => {
  it('still releases the action, and records that it was re-checked', async () => {
    const { gateway, connector, approved } = await setup();
    const { approvalId } = await approved();

    const released = await gateway.resume(approvalId);

    assert.equal(released.outcome, 'executed');
    assert.equal(connector.callCount('stripe.refund'), 1);

    const evidence = await gateway.evidence(released.evidenceId);
    assert.equal(evidence?.revalidation?.verdict, 'proceeded');
    assert.equal(evidence?.revalidation?.effect, 'REQUIRE_APPROVAL');
    assert.match(evidence!.revalidation!.reason, /the approval on file satisfies it/);
  });

  it('still consumes the grant exactly once under eight concurrent releases', async () => {
    const { gateway, connector, approved } = await setup();
    const { approvalId } = await approved();

    const settled = await Promise.allSettled(Array.from({ length: 8 }, () => gateway.resume(approvalId)));
    const executed = settled.filter(
      (outcome) => outcome.status === 'fulfilled' && outcome.value.outcome === 'executed',
    );

    assert.equal(executed.length, 1);
    assert.equal(connector.callCount('stripe.refund'), 1);
  });
});

describe('a policy that now demands different authority', () => {
  /** The same hold, but only the CFO may grant it. */
  const NARROWED: Policy = {
    ...FINANCE,
    version: 2,
    rules: [
      {
        id: 'needs-cfo',
        when: { always: true },
        effect: 'REQUIRE_APPROVAL',
        reason: 'only the CFO may approve a refund of this size',
        approval: { approvers: ['user:cfo-only@example.com'], minApprovals: 1 },
      },
    ],
  };

  it('sends the action back for a fresh approval instead of executing it', async () => {
    const { gateway, connector, approved, publish } = await setup();
    const { approvalId } = await approved();

    await publish(NARROWED);
    const released = await gateway.resume(approvalId);

    assert.equal(released.outcome, 'pending_approval');
    assert.notEqual(released.approvalId, approvalId, 'a new question, put to whoever policy now names');
    assert.equal(released.error?.code, 'approval_required');
    assert.match(released.error!.message, /cfo-only@example\.com/);
    assert.equal(connector.callCount('stripe.refund'), 0);

    const fresh = await gateway.approvals.require(released.approvalId!);
    assert.deepEqual(fresh.requirement.approvers, ['user:cfo-only@example.com']);
    assert.equal(fresh.status, 'pending');
  });

  it('spends the superseded grant, so a retry does not mint approvals without end', async () => {
    const { gateway, approved, publish } = await setup();
    const { approvalId } = await approved();
    await publish(NARROWED);

    await gateway.resume(approvalId);
    await assert.rejects(
      () => gateway.resume(approvalId),
      (error: ArcError) => error.code === 'conflict',
    );
    assert.equal(await gateway.store.approvals.count(), 2, 'one superseded grant and one new request');
  });

  it('records the supersession on both sides of the evidence', async () => {
    const { gateway, approved, publish } = await setup();
    const { approvalId } = await approved();
    await publish(NARROWED);

    const released = await gateway.resume(approvalId);
    const evidence = await gateway.evidence(released.evidenceId);

    assert.equal(evidence?.outcome, 'pending_approval');
    assert.equal(evidence?.revalidation?.verdict, 'reapproval_required');
    assert.equal(evidence?.revalidation?.approvalId, approvalId, 'the grant that was not enough');
    assert.equal(evidence?.revalidation?.supersedingApprovalId, released.approvalId, 'and the one now asked for');
    // The original decision is untouched, as always.
    assert.equal(evidence?.decision.ruleId, 'needs-approval');
  });

  it('asks again when the threshold rises above the votes on file', async () => {
    const { gateway, connector, approved, publish } = await setup();
    const { approvalId } = await approved();

    await publish({
      ...FINANCE,
      version: 3,
      rules: [
        {
          id: 'two-managers',
          when: { always: true },
          effect: 'REQUIRE_APPROVAL',
          reason: 'two finance managers must approve',
          approval: { approvers: ['role:finance-manager'], minApprovals: 2 },
        },
      ],
    });

    const released = await gateway.resume(approvalId);
    assert.equal(released.outcome, 'pending_approval');
    assert.match(released.error!.message, /requires 2 approvals/);
    assert.equal(connector.callCount('stripe.refund'), 0);
  });

  it('asks again when separation of duties is newly required', async () => {
    const { gateway, connector, approved, publish } = await setup();
    const { approvalId } = await approved();

    await publish({
      ...FINANCE,
      version: 4,
      rules: [
        {
          id: 'not-the-owner',
          when: { always: true },
          effect: 'REQUIRE_APPROVAL',
          reason: 'nobody approves their own agent',
          approval: { approvers: ['role:finance-manager'], minApprovals: 1, requireSeparationOfDuties: true },
        },
      ],
    });

    const released = await gateway.resume(approvalId);
    assert.equal(released.outcome, 'pending_approval');
    assert.match(released.error!.message, /separation of duties/);
    assert.equal(connector.callCount('stripe.refund'), 0);
  });

  it('releases when the requirement has been relaxed rather than narrowed', async () => {
    const { gateway, connector, approved, publish } = await setup();
    const { approvalId } = await approved();

    // Whoever qualified under `role:finance-manager` still qualifies under a
    // requirement that admits them and more, so the grant on file carries.
    await publish({
      ...FINANCE,
      version: 5,
      rules: [
        {
          id: 'any-manager',
          when: { always: true },
          effect: 'REQUIRE_APPROVAL',
          reason: 'any manager may approve',
          approval: { approvers: ['role:finance-manager', 'role:ops-manager'], minApprovals: 1 },
        },
      ],
    });

    const released = await gateway.resume(approvalId);
    assert.equal(released.outcome, 'executed');
    assert.equal(connector.callCount('stripe.refund'), 1);
  });

  it('releases when policy now allows the action outright', async () => {
    const { gateway, connector, approved, publish } = await setup();
    const { approvalId } = await approved();

    await publish({
      ...FINANCE,
      version: 6,
      rules: [{ id: 'open', when: { always: true }, effect: 'ALLOW', reason: 'ceiling raised' }],
    });

    const released = await gateway.resume(approvalId);
    assert.equal(released.outcome, 'executed');
    assert.equal(connector.callCount('stripe.refund'), 1);

    const evidence = await gateway.evidence(released.evidenceId);
    assert.equal(evidence?.revalidation?.effect, 'ALLOW');
    assert.equal(evidence?.revalidation?.verdict, 'proceeded');
  });

  it('refuses outright when policy requires approval but names nobody', async () => {
    const { gateway, connector, approved, store } = await setup();
    const { approvalId } = await approved();

    // Not reachable through `publishPolicy`, which validates the document.
    // Written straight to the store, because a control that only holds for
    // well-formed input is not a control: fail closed on the malformed case.
    await store.policies.put('FINANCE-004', {
      ...FINANCE,
      version: 7,
      rules: [
        { id: 'nobody', when: { always: true }, effect: 'REQUIRE_APPROVAL', reason: 'held', approval: { approvers: [] } },
      ],
    });

    const released = await gateway.resume(approvalId);
    assert.equal(released.outcome, 'denied');
    assert.match(released.error!.message, /names no approvers/);
    assert.equal(connector.callCount('stripe.refund'), 0);
  });
});

describe('the approval binding', () => {
  it('refuses a grant that points at an action it was never about', async () => {
    const { gateway, connector, approved, store } = await setup();
    const { approvalId } = await approved();

    const approval = await gateway.approvals.require(approvalId);
    await store.approvals.put(approvalId, { ...approval, actionId: 'arc_act_somewhere_else' });

    await assert.rejects(
      () => gateway.resume(approvalId),
      (error: ArcError) => error.code === 'not_found',
    );
    assert.equal(connector.callCount('stripe.refund'), 0);
  });

  it('refuses a grant whose decision was reached about a different action', async () => {
    const { gateway, connector, approved, store, apiKey } = await setup();
    const { approvalId } = await approved();

    // A second hold produces a second decision. Pointing the grant at it
    // would borrow one human's agreement for a decision they never saw.
    const other = await gateway.handle(apiKey, { tool: 'stripe.refund', parameters: { amount: 1900 } });
    const otherApproval = await gateway.approvals.require(other.approvalId!);

    const approval = await gateway.approvals.require(approvalId);
    await store.approvals.put(approvalId, { ...approval, decisionId: otherApproval.decisionId });

    await assert.rejects(
      () => gateway.resume(approvalId),
      (error: ArcError) => error.code === 'conflict' && /not a decision about this action/.test(error.message),
    );
    assert.equal(connector.callCount('stripe.refund'), 0);
  });

  it('refuses a grant that names a different agent than the action', async () => {
    const { gateway, connector, approved, store } = await setup();
    const { approvalId } = await approved();

    const approval = await gateway.approvals.require(approvalId);
    await store.approvals.put(approvalId, { ...approval, agentId: 'arc_ag_someone_else' });

    await assert.rejects(
      () => gateway.resume(approvalId),
      (error: ArcError) => error.code === 'conflict' && /different agent/.test(error.message),
    );
    assert.equal(connector.callCount('stripe.refund'), 0);
  });

  it('refuses when the recorded parameters no longer match their digest', async () => {
    const { gateway, connector, approved, store } = await setup();
    const { approvalId, actionId } = await approved();

    const action = await store.actions.get(actionId);
    await store.actions.put(actionId, { ...action!, parameters: { amount: 25000 } });

    await assert.rejects(
      () => gateway.resume(approvalId),
      (error: ArcError) => error.code === 'conflict' && /no longer match the digest/.test(error.message),
    );
    assert.equal(connector.callCount('stripe.refund'), 0);
  });
});

describe('whether a held approval satisfies a requirement', () => {
  const grant = (approvers: readonly string[], options: { minApprovals?: number; sod?: boolean; votes?: number } = {}) =>
    ({
      requirement: {
        approvers,
        minApprovals: options.minApprovals ?? 1,
        ...(options.sod === undefined ? {} : { requireSeparationOfDuties: options.sod }),
      },
      votes: Array.from({ length: options.votes ?? 1 }, (_, index) => ({
        approver: `approver-${index}@example.com`,
        vote: 'approve' as const,
        votedAt: '2026-01-01T00:00:00.000Z',
      })),
      // Only the two fields the predicate reads. Cast through `unknown`
      // because building a whole ApprovalRequest here would say nothing more
      // and hide what the test is actually about.
    }) as unknown as Parameters<typeof heldApprovalSatisfies>[1];

  it('accepts an identical requirement', () => {
    assert.equal(heldApprovalSatisfies({ approvers: ['role:finance-manager'] }, grant(['role:finance-manager'])), true);
  });

  it('accepts a requirement that admits everyone the grant did, and more', () => {
    assert.equal(
      heldApprovalSatisfies({ approvers: ['role:finance-manager', 'role:ops'] }, grant(['role:finance-manager'])),
      true,
    );
  });

  it('rejects a requirement that admits fewer', () => {
    assert.equal(heldApprovalSatisfies({ approvers: ['user:cfo@example.com'] }, grant(['role:finance-manager'])), false);
  });

  it('accepts a wildcard requirement', () => {
    assert.equal(heldApprovalSatisfies({ approvers: ['*'] }, grant(['role:finance-manager'])), true);
  });

  it('rejects a threshold the votes on file do not meet', () => {
    assert.equal(
      heldApprovalSatisfies({ approvers: ['role:finance-manager'], minApprovals: 2 }, grant(['role:finance-manager'])),
      false,
    );
  });

  it('accepts a threshold the votes on file do meet', () => {
    assert.equal(
      heldApprovalSatisfies(
        { approvers: ['role:finance-manager'], minApprovals: 2 },
        grant(['role:finance-manager'], { minApprovals: 2, votes: 2 }),
      ),
      true,
    );
  });

  it('rejects separation of duties the grant was not collected under', () => {
    assert.equal(
      heldApprovalSatisfies(
        { approvers: ['role:finance-manager'], requireSeparationOfDuties: true },
        grant(['role:finance-manager']),
      ),
      false,
    );
  });

  it('accepts separation of duties the grant was collected under', () => {
    assert.equal(
      heldApprovalSatisfies(
        { approvers: ['role:finance-manager'], requireSeparationOfDuties: true },
        grant(['role:finance-manager'], { sod: true }),
      ),
      true,
    );
  });
});
