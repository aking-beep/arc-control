import type { ApprovalRequirement } from './policy.js';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled';

export interface ApprovalVote {
  /** Identity of the human who voted, from the console session. */
  readonly approver: string;
  readonly vote: 'approve' | 'reject';
  readonly comment?: string;
  readonly votedAt: string;
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
