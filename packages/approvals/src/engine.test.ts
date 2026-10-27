import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ApprovalRequest } from '@arc-control/schemas';
import { MemoryStore } from '@arc-control/store';
import { ApprovalEngine, type Approver } from './engine.js';

/**
 * Who may approve what.
 *
 * The identity an operator arrives with is normalised — a verified email is
 * lowercased on the way in, and so is a trusted proxy's header — while the
 * identity written into a policy selector or an agent's owner field is
 * whatever somebody typed. Comparing those two exactly produced a bypass in
 * one direction and a lockout in the other, from the same line.
 */

function engine(): ApprovalEngine {
  return new ApprovalEngine(new MemoryStore());
}

function request(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: 'arc_apr_1',
    actionId: 'arc_act_1',
    decisionId: 'arc_dec_1',
    agentId: 'arc_ag_1',
    agentName: 'finance-agent',
    agentOwner: 'Ops@Example.com',
    organizationId: 'default',
    tool: 'stripe.refund',
    parameters: {},
    reason: 'needs a human',
    requirement: { approvers: ['role:finance-manager'], minApprovals: 1 },
    status: 'pending',
    votes: [],
    createdAt: '2026-10-20T06:00:00.000Z',
    expiresAt: '2026-10-20T07:00:00.000Z',
    ...overrides,
  } as ApprovalRequest;
}

const approver = (identifier: string, roles: readonly string[] = []): Approver => ({
  identifier,
  roles: [...roles],
});

describe('separation of duties', () => {
  /**
   * The bypass. The owner is registered as `Ops@Example.com`; single sign-on
   * hands the same person over as `ops@example.com`. Compared exactly, they
   * are different people, so the control that exists to stop somebody
   * approving their own agent's work let them straight through — via a role
   * they legitimately hold, which is exactly the route the rule is written to
   * close.
   */
  it('bars the agent owner however their address is cased', () => {
    const held = request({
      requirement: { approvers: ['role:finance-manager'], minApprovals: 1, requireSeparationOfDuties: true },
    });

    for (const spelling of ['ops@example.com', 'OPS@EXAMPLE.COM', 'Ops@Example.com', 'oPs@eXaMpLe.CoM']) {
      assert.equal(
        engine().canApprove(held, approver(spelling, ['finance-manager'])),
        false,
        `"${spelling}" is the owner and must not be able to approve`,
      );
    }
  });

  it('still admits a colleague who holds the role', () => {
    const held = request({
      requirement: { approvers: ['role:finance-manager'], minApprovals: 1, requireSeparationOfDuties: true },
    });

    assert.equal(engine().canApprove(held, approver('cfo@example.com', ['finance-manager'])), true);
  });
});

describe('approver selectors', () => {
  /**
   * The lockout, which is the same bug pointing the other way: the person the
   * policy named could not approve, and the refusal would read as a
   * configuration error rather than a comparison bug.
   */
  it('matches an `owner` selector however the address is cased', () => {
    const held = request({ requirement: { approvers: ['owner'], minApprovals: 1 } });

    assert.equal(engine().canApprove(held, approver('ops@example.com')), true);
    assert.equal(engine().canApprove(held, approver('OPS@EXAMPLE.COM')), true);
  });

  it('matches a `user:` selector however either side is cased', () => {
    const held = request({ requirement: { approvers: ['user:CFO@Example.com'], minApprovals: 1 } });

    assert.equal(engine().canApprove(held, approver('cfo@example.com')), true);
    assert.equal(engine().canApprove(held, approver('CFO@EXAMPLE.COM')), true);
  });

  it('matches a bare identifier selector however it is cased', () => {
    const held = request({ requirement: { approvers: ['CFO@Example.com'], minApprovals: 1 } });
    assert.equal(engine().canApprove(held, approver('cfo@example.com')), true);
  });

  it('still refuses somebody the policy did not name', () => {
    const held = request({ requirement: { approvers: ['user:cfo@example.com'], minApprovals: 1 } });

    assert.equal(engine().canApprove(held, approver('intern@example.com')), false);
    assert.equal(engine().canApprove(held, approver('cfo@other-company.com')), false);
  });

  /** Roles stay exact. A role name is an identifier the deployment chose. */
  it('compares roles exactly, since a role is not an address', () => {
    const held = request({ requirement: { approvers: ['role:finance-manager'], minApprovals: 1 } });

    assert.equal(engine().canApprove(held, approver('cfo@example.com', ['finance-manager'])), true);
    assert.equal(engine().canApprove(held, approver('cfo@example.com', ['Finance-Manager'])), false);
  });

  it('admits anybody for the wildcard selector', () => {
    const held = request({ requirement: { approvers: ['*'], minApprovals: 1 } });
    assert.equal(engine().canApprove(held, approver('anyone@example.com')), true);
  });
});

describe('voting twice', () => {
  /**
   * A threshold of two is not met by one person signing in twice. Case was a
   * way to do exactly that: vote as `cfo@example.com`, then again as
   * `CFO@example.com`, and a two-approval requirement was satisfied alone.
   */
  it('counts one person once, however they spell their address', async () => {
    const store = new MemoryStore();
    // Inside the fixture's window, so the request is live and the dedup check
    // is what the test actually reaches.
    const approvals = new ApprovalEngine(store, { now: () => new Date('2026-10-20T06:30:00.000Z') });

    const held = request({
      requirement: { approvers: ['*'], minApprovals: 2 },
      votes: [{ approver: 'cfo@example.com', vote: 'approve', votedAt: '2026-10-20T06:10:00.000Z' }],
    });
    await store.approvals.put(held.id, held);

    await assert.rejects(
      () => approvals.vote({ approvalId: held.id, approver: approver('CFO@EXAMPLE.COM'), vote: 'approve' }),
      /has already voted/,
    );
  });

  it('still accepts a genuinely different approver', async () => {
    const store = new MemoryStore();
    // Inside the fixture's window, so the request is live and the dedup check
    // is what the test actually reaches.
    const approvals = new ApprovalEngine(store, { now: () => new Date('2026-10-20T06:30:00.000Z') });

    const held = request({
      requirement: { approvers: ['*'], minApprovals: 2 },
      votes: [{ approver: 'cfo@example.com', vote: 'approve', votedAt: '2026-10-20T06:10:00.000Z' }],
    });
    await store.approvals.put(held.id, held);

    const updated = await approvals.vote({
      approvalId: held.id,
      approver: approver('cto@example.com'),
      vote: 'approve',
    });

    assert.equal(updated.status, 'approved');
    assert.equal(updated.votes.length, 2);
  });
});

describe('ARC-SEC-013: every approver group must approve', () => {
  async function held(store: MemoryStore) {
    const engine = new ApprovalEngine(store, { now: () => new Date('2026-10-20T06:30:00.000Z') });
    await store.approvals.put(
      'arc_apr_2',
      request({
        id: 'arc_apr_2',
        requirement: {
          approvers: ['role:eng-manager'],
          minApprovals: 1,
          alsoRequired: [{ approvers: ['role:finance-manager'], minApprovals: 1 }],
        },
      }),
    );
    return engine;
  }

  it('stays pending until a member of each group has approved', async () => {
    const store = new MemoryStore();
    const engine = await held(store);
    const first = await engine.vote({ approvalId: 'arc_apr_2', approver: approver('lead@example.com', ['eng-manager']), vote: 'approve' });
    assert.equal(first.status, 'pending', 'the policy approver alone is not enough');
    const second = await engine.vote({ approvalId: 'arc_apr_2', approver: approver('cfo@example.com', ['finance-manager']), vote: 'approve' });
    assert.equal(second.status, 'approved');
    assert.deepEqual(second.votes.map((vote) => vote.groups), [[0], [1]]);
  });

  it('lets anyone in any group vote, and refuses anyone in none', async () => {
    const store = new MemoryStore();
    const engine = await held(store);
    assert.equal(engine.canApprove(await engine.require('arc_apr_2'), approver('cfo@example.com', ['finance-manager'])), true);
    await assert.rejects(
      engine.vote({ approvalId: 'arc_apr_2', approver: approver('intern@example.com', ['intern']), vote: 'approve' }),
      /not an approver/,
    );
  });

  it('applies a group separation of duties to that group', async () => {
    const store = new MemoryStore();
    const engine = new ApprovalEngine(store, { now: () => new Date('2026-10-20T06:30:00.000Z') });
    await store.approvals.put(
      'arc_apr_3',
      request({
        id: 'arc_apr_3',
        requirement: {
          approvers: ['role:eng-manager'],
          minApprovals: 1,
          alsoRequired: [{ approvers: ['role:finance-manager'], minApprovals: 1, requireSeparationOfDuties: true }],
        },
      }),
    );
    // The owner holds both roles: they may count for the policy group, never the finance one.
    const owner = await engine.vote({ approvalId: 'arc_apr_3', approver: approver('ops@example.com', ['eng-manager', 'finance-manager']), vote: 'approve' });
    assert.deepEqual(owner.votes[0]!.groups, [0]);
    assert.equal(owner.status, 'pending');
  });
});
