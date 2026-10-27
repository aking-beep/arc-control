import type { ApprovalRequirement } from './policy.js';

import type { IdentityAssurance } from './operator.js';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled';

export interface ApprovalVote {
  /** Identity of the human who voted, from the console session. */
  readonly approver: string;
  readonly vote: 'approve' | 'reject';
  readonly comment?: string;
  readonly votedAt: string;
  /**
   * How that identity was established, recorded at the moment of the vote.
   *
   * Without this a reader cannot tell a verified approval from an asserted
   * one, and the whole set is only worth its weakest member. Absent on records
   * written before 2.1, which `assuranceOf` reads as `claimed` — the strongest
   * claim those deployments could actually support.
   */
  readonly assurance?: IdentityAssurance;
  /** The issuer that vouched for the approver. Present when authenticated. */
  readonly issuer?: string;
  /** The provider's stable subject for the approver, which survives an email change. */
  readonly subject?: string;
  /**
   * The approver groups this vote counts toward, decided when it was cast:
   * 0 is the requirement itself, `n` is `alsoRequired[n - 1]`. Absent on votes
   * cast before 2.3, which count toward the requirement itself only.
   */
  readonly groups?: readonly number[];
}

/**
 * A request for a human to authorize one specific action. The snapshot of the
 * action and decision is stored on the request so the approver sees exactly
 * what they are authorizing, even if policy changes in the meantime.
 */
export interface ApprovalRequest {
  readonly id: string;
  readonly actionId: string;
  readonly decisionId: string;
  readonly agentId: string;
  readonly agentName: string;
  /** The human or team accountable for the agent, used by the `owner` approver selector. */
  readonly agentOwner: string;
  readonly organizationId: string;
  readonly tool: string;
  /** Redacted parameters, safe to render in the console. */
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly policyId?: string;
  readonly ruleId?: string;
  readonly reason: string;
  readonly requirement: Required<Pick<ApprovalRequirement, 'approvers' | 'minApprovals'>> & ApprovalRequirement;
  readonly status: ApprovalStatus;
  readonly votes: readonly ApprovalVote[];
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly resolvedAt?: string;
  /** Set once the approved action has been executed, so an approval cannot be replayed. */
  readonly consumedAt?: string;
}
