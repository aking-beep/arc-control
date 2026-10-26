import {
  ArcError,
  assuranceOf,
  newId,
  type Action,
  type ApprovalRequest,
  type ApprovalRequirement,
  type ApprovalStatus,
  type ApprovalVote,
  type Decision,
  type IdentityAssurance,
} from '@arc-control/schemas';
import type { ControlStore } from '@arc-control/store';

export interface ApprovalEngineOptions {
  readonly now?: () => Date;
  /** Fallback window when a policy rule does not set one. */
  readonly defaultExpiresInSeconds?: number;
}

/** Identity of the human casting a vote, as established by the console session. */
export interface Approver {
  readonly identifier: string;
  readonly roles: readonly string[];
  /**
   * How this approver's identity was established.
   *
   * Carried onto the vote so the record states what it can support. Optional
   * so a caller that has not been updated still compiles — and such a caller
   * is recorded as `claimed`, which is the truth about a call site that cannot
   * say where its name came from.
   */
  readonly assurance?: IdentityAssurance;
  /** The issuer that vouched for them, when authenticated. */
  readonly issuer?: string;
  /** The provider's stable subject, which survives an email change. */
  readonly subject?: string;
}

/**
 * The approval engine owns the lifecycle of an action a policy will not
 * authorize on its own.
 *
 * Three properties make an approval trustworthy, and all three are enforced
 * here rather than left to the console:
 *
 *  - **Authority.** Only an approver the policy named may vote.
 *  - **Finality.** A resolved or expired request cannot be revisited, and one
 *    approver cannot vote twice to reach a threshold alone.
 *  - **Single use.** An approval is consumed when the action executes, so a
 *    granted approval can never authorize a second execution.
 */
export class ApprovalEngine {
  readonly #store: ControlStore;
  readonly #now: () => Date;
  readonly #defaultWindow: number;

  constructor(store: ControlStore, options: ApprovalEngineOptions = {}) {
    this.#store = store;
    this.#now = options.now ?? (() => new Date());
    this.#defaultWindow = options.defaultExpiresInSeconds ?? 3600;
  }

  /** Opens a request for a decision that came back REQUIRE_APPROVAL. */
  async request(args: {
    readonly action: Action;
    readonly decision: Decision;
    readonly requirement: ApprovalRequirement;
    /** Redacted parameters, safe to render to a human. */
    readonly parameters: Readonly<Record<string, unknown>>;
    /** The agent's registered owner, carried so `owner` and separation of duties can be resolved later. */
    readonly agentOwner: string;
  }): Promise<ApprovalRequest> {
    const { action, decision, requirement } = args;

    if (requirement.approvers.length === 0) {
      throw new ArcError('internal', 'a REQUIRE_APPROVAL decision reached the approval engine with no approvers', {
        details: { policyId: decision.policyId, ruleId: decision.ruleId },
      });
    }

    const createdAt = this.#now();
    const windowSeconds = requirement.expiresInSeconds ?? this.#defaultWindow;

    const request: ApprovalRequest = {
      id: newId('approval'),
      actionId: action.id,
      decisionId: decision.id,
      agentId: action.agentId,
      agentName: action.agentName,
      agentOwner: args.agentOwner,
      organizationId: action.organizationId,
      tool: action.tool,
      parameters: args.parameters,
      ...(decision.policyId ? { policyId: decision.policyId } : {}),
      ...(decision.ruleId ? { ruleId: decision.ruleId } : {}),
      reason: decision.reason,
      requirement: {
        ...requirement,
        approvers: requirement.approvers,
        minApprovals: requirement.minApprovals ?? 1,
      },
      status: 'pending',
      votes: [],
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + windowSeconds * 1000).toISOString(),
    };

    await this.#store.approvals.put(request.id, request);
    return request;
  }

  async get(approvalId: string): Promise<ApprovalRequest | undefined> {
    return this.#store.approvals.get(approvalId);
  }

  async require(approvalId: string): Promise<ApprovalRequest> {
    const request = await this.get(approvalId);
    if (!request) throw new ArcError('not_found', `no approval request with id ${approvalId}`);
    return request;
  }

  /** Requests still actionable, newest first. The console's work queue. */
  async listPending(filter: { organizationId?: string; approver?: Approver } = {}): Promise<readonly ApprovalRequest[]> {
    const all = await this.#store.approvals.list();
    const now = this.#now().getTime();

    return all
      .filter((request) => request.status === 'pending' && Date.parse(request.expiresAt) > now)
      .filter((request) => !filter.organizationId || request.organizationId === filter.organizationId)
      .filter((request) => !filter.approver || this.canApprove(request, filter.approver))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  /**
   * Casts a vote. A single rejection resolves the request: when a named
   * approver says no, waiting for the others cannot make the action safe.
   */
  async vote(args: {
    readonly approvalId: string;
    readonly approver: Approver;
    readonly vote: 'approve' | 'reject';
    readonly comment?: string;
  }): Promise<ApprovalRequest> {
    return this.#store.approvals.transact(async () => {
      const request = await this.#expireIfDue(await this.require(args.approvalId));

      if (request.status !== 'pending') {
        throw new ArcError('conflict', `this approval request is already ${request.status}`, {
          details: { approvalId: request.id, status: request.status },
        });
      }

      if (!this.canApprove(request, args.approver)) {
        throw new ArcError('policy_denied', `${args.approver.identifier} is not an approver for this request`, {
          details: { approvalId: request.id, approvers: request.requirement.approvers },
        });
      }

      if (request.votes.some((cast) => cast.approver === args.approver.identifier)) {
        throw new ArcError('conflict', `${args.approver.identifier} has already voted on this request`, {
          details: { approvalId: request.id },
        });
      }

      const vote: ApprovalVote = {
        approver: args.approver.identifier,
        vote: args.vote,
        ...(args.comment ? { comment: args.comment } : {}),
        votedAt: this.#now().toISOString(),
        // Recorded at the moment of the vote, because it is a fact about this
        // request and cannot be reconstructed later: the deployment's auth
        // configuration may have changed by the time anyone reads the record.
        assurance: assuranceOf(args.approver),
        ...(args.approver.issuer ? { issuer: args.approver.issuer } : {}),
        ...(args.approver.subject ? { subject: args.approver.subject } : {}),
      };

      const votes = [...request.votes, vote];
      const approvals = votes.filter((cast) => cast.vote === 'approve').length;
      const rejected = votes.some((cast) => cast.vote === 'reject');

      let status: ApprovalStatus = 'pending';
      if (rejected) status = 'rejected';
      else if (approvals >= request.requirement.minApprovals) status = 'approved';

      const updated: ApprovalRequest = {
        ...request,
        votes,
        status,
        ...(status === 'pending' ? {} : { resolvedAt: this.#now().toISOString() }),
      };

      await this.#store.approvals.put(updated.id, updated);
      return updated;
    });
  }

  /**
   * Claims an approved request for execution, marking it consumed. Returns the
   * consumed request, or throws if it is not executable. Claiming and
   * executing are separate steps so a crash between them leaves a consumed
   * approval rather than a replayable one.
   */
  async consume(approvalId: string): Promise<ApprovalRequest> {
    return this.#store.approvals.transact(async () => {
      const request = await this.#expireIfDue(await this.require(approvalId));
      assertReleasable(request, this.#now().getTime());

      const consumed: ApprovalRequest = { ...request, consumedAt: this.#now().toISOString() };
      await this.#store.approvals.put(consumed.id, consumed);
      return consumed;
    });
  }

  /**
   * Reads a request and throws unless it is a grant that may still be
   * released, without consuming it.
   *
   * A caller that must do work before spending the grant — re-checking the
   * kill switch and the agent's status at release time — needs to know the
   * grant is real *first*, or it reports its own refusal for an approval
   * nobody ever approved and writes that into the audit chain. It shares
   * `assertReleasable` with `consume` rather than restating the rules, and
   * `consume` still re-checks inside the transaction, so this is an early
   * answer rather than a second authority.
   *
   * Reads only, and deliberately. `#expireIfDue` persists a pending-to-expired
   * transition, and it is safe only inside the `transact` lock that `vote`,
   * `cancel` and `consume` hold: `put` does not take that mutex, so writing
   * from here could overwrite a grant a concurrent `vote` had just approved —
   * destroying a human decision and leaving the action unreleasable. So the
   * expiry is *judged* here from `expiresAt` and *recorded* only on the
   * serialized path.
   */
  async requireReleasable(approvalId: string): Promise<ApprovalRequest> {
    const request = await this.require(approvalId);
    assertReleasable(request, this.#now().getTime());
    return request;
  }

  /**
   * Expires every pending request whose window has closed.
   *
   * Until 2.1 a lapsed request only became `expired` when something happened
   * to touch it, so an abandoned approval sat in the store reading `pending`
   * indefinitely — and the console's queue showed it as live work. The
   * scheduler calls this so the state of the queue is a fact rather than an
   * artefact of who last looked at it.
   *
   * Each transition goes through the approvals lock via `transact`, and the
   * request is re-read inside it. The previous implementation wrote through
   * `#expireIfDue` without the lock, which is the same defect a review caught
   * in the release path: a stale `pending` snapshot could overwrite a grant a
   * concurrent `vote` had just approved, destroying a human decision. Reading
   * outside a lock is fine; writing what you read is not.
   */
  async expireDue(): Promise<readonly ApprovalRequest[]> {
    const now = this.#now().getTime();
    const candidates = await this.#store.approvals.filter(
      (request) => request.status === 'pending' && Date.parse(request.expiresAt) <= now,
    );

    const expired: ApprovalRequest[] = [];
    for (const candidate of candidates) {
      const result = await this.#store.approvals.transact(async () => {
        // Re-read inside the lock: a vote may have resolved it since the scan.
        const current = await this.#store.approvals.get(candidate.id);
        if (!current || current.status !== 'pending') return undefined;
        if (Date.parse(current.expiresAt) > this.#now().getTime()) return undefined;
        return this.#expireIfDue(current);
      });

      if (result !== undefined && result.status === 'expired') expired.push(result);
    }

    return expired;
  }

  /**
   * Pending requests whose window closes within `withinMs`.
   *
   * For warning somebody before the decision is lost rather than after.
   */
  async expiringSoon(withinMs: number): Promise<readonly ApprovalRequest[]> {
    const now = this.#now().getTime();
    return this.#store.approvals.filter((request) => {
      if (request.status !== 'pending') return false;
      const expiresAt = Date.parse(request.expiresAt);
      return expiresAt > now && expiresAt <= now + withinMs;
    });
  }

  async cancel(approvalId: string, reason: string): Promise<ApprovalRequest> {
    return this.#store.approvals.transact(async () => {
      const request = await this.require(approvalId);
      if (request.status !== 'pending') {
        throw new ArcError('conflict', `cannot cancel a request that is already ${request.status}`);
      }
      const cancelled: ApprovalRequest = {
        ...request,
        status: 'cancelled',
        reason: `${request.reason} (cancelled: ${reason})`,
        resolvedAt: this.#now().toISOString(),
      };
      await this.#store.approvals.put(cancelled.id, cancelled);
      return cancelled;
    });
  }

  /**
   * Whether this human may vote on this request.
   *
   * `owner` resolves against the agent's registered owner. Separation of
   * duties, when the policy asks for it, bars that owner however they would
   * otherwise match — including through a role they happen to hold — because
   * the point of the control is that nobody approves their own agent's work.
   */
  canApprove(request: ApprovalRequest, approver: Approver): boolean {
    if (request.requirement.requireSeparationOfDuties && approver.identifier === request.agentOwner) {
      return false;
    }

    return request.requirement.approvers.some((selector) => {
      if (selector === '*') return true;
      if (selector === 'owner') return approver.identifier === request.agentOwner;
      if (selector.startsWith('role:')) return approver.roles.includes(selector.slice('role:'.length));
      if (selector.startsWith('user:')) return approver.identifier === selector.slice('user:'.length);
      return approver.identifier === selector;
    });
  }

  async #expireIfDue(request: ApprovalRequest): Promise<ApprovalRequest> {
    if (request.status !== 'pending') return request;
    if (Date.parse(request.expiresAt) > this.#now().getTime()) return request;

    const expired: ApprovalRequest = {
      ...request,
      status: 'expired',
      resolvedAt: this.#now().toISOString(),
    };
    await this.#store.approvals.put(expired.id, expired);
    return expired;
  }
}

/**
 * The one definition of "this grant may still authorize an execution".
 *
 * Used by `consume`, inside its transaction, and by `requireReleasable`
 * ahead of it. Kept in one place because two copies of these five cases
 * would eventually disagree, and the disagreement would be a grant released
 * on a status that should have refused it.
 */
function assertReleasable(request: ApprovalRequest, now: number): void {
  if (request.consumedAt) {
    throw new ArcError('conflict', 'this approval has already authorized an execution', {
      details: { approvalId: request.id, consumedAt: request.consumedAt },
    });
  }

  // A grant whose window has closed is expired whether or not anything has
  // written that down yet, so the judgement comes from `expiresAt` rather than
  // from the stored status. That lets a caller refuse one without persisting
  // the transition, which only the serialized path may do.
  const effective: ApprovalStatus =
    request.status === 'pending' && Date.parse(request.expiresAt) <= now ? 'expired' : request.status;

  switch (effective) {
    case 'approved':
      return;
    case 'pending':
      throw new ArcError('approval_required', 'this action is still waiting for approval', {
        details: { approvalId: request.id, approvals: request.votes.length },
      });
    case 'rejected':
      throw new ArcError('approval_rejected', 'a named approver rejected this action', {
        details: { approvalId: request.id },
      });
    case 'expired':
      throw new ArcError('approval_expired', 'the approval window for this action has closed', {
        details: { approvalId: request.id, expiresAt: request.expiresAt },
      });
    case 'cancelled':
      throw new ArcError('conflict', 'this approval request was cancelled', {
        details: { approvalId: request.id },
      });
  }
}
