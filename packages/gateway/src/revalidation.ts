import type { ApprovalRequest, ApprovalRequirement, Decision, EvidenceRevalidation } from '@arc-control/schemas';

/** The outcome of the second look, and the fresh decision behind it. */
export interface Revalidation {
  readonly record: EvidenceRevalidation;
  /**
   * The decision produced by re-evaluating current policy, when evaluation was
   * reached. Absent when an earlier gate — agent lifecycle, the tool's kill
   * switch, the approval's binding — refused first, because in those cases no
   * policy was consulted and recording one would overstate what happened.
   */
  readonly decision?: Decision;
}

/**
 * Whether an approval already in hand satisfies what current policy now asks
 * for.
 *
 * The sound test is not "are these requirements identical" but "would the
 * humans who voted still qualify". ARC records *who* voted, not which
 * selector they matched or which roles they held at the time, so it cannot
 * re-run `role:finance-manager` against a vote cast last Tuesday. What it can
 * establish is containment: if every selector the held requirement admitted is
 * also admitted now, then whoever qualified then qualifies now, whatever they
 * matched. A requirement that has been *narrowed* fails that test and sends
 * the action back for a fresh approval — which is the point of the control.
 *
 * Separation of duties is checked the same way round: if current policy
 * demands it and the held requirement did not, the votes on file may include
 * the agent's own owner, and the grant cannot be trusted to carry the new
 * requirement.
 */
export function heldApprovalSatisfies(required: ApprovalRequirement, held: ApprovalRequest): boolean {
  const heldGroups = [held.requirement, ...(held.requirement.alsoRequired ?? [])];
  const counted = (index: number): number =>
    held.votes.filter((vote) => vote.vote === 'approve' && (vote.groups ?? [0]).includes(index)).length;

  // Every group current policy requires — the requirement itself and each
  // `alsoRequired` (ARC-SEC-013) — must be met by some group on file whose
  // approvers it still admits, carrying enough approvals of its own.
  return [required, ...(required.alsoRequired ?? [])].every((group) =>
    heldGroups.some((candidate, index) => {
      if (counted(index) < (group.minApprovals ?? 1)) return false;
      if (group.requireSeparationOfDuties === true && candidate.requireSeparationOfDuties !== true) return false;
      const admittedNow = new Set(group.approvers);
      return admittedNow.has('*') || candidate.approvers.every((selector) => admittedNow.has(selector));
    }),
  );
}

/** Explains a re-approval in the terms an operator reading the queue needs. */
export function reapprovalReason(required: ApprovalRequirement, held: ApprovalRequest): string {
  const was = held.requirement.approvers.join(', ');
  const now = required.approvers.join(', ');
  const heldMinimum = held.requirement.minApprovals;
  const minimum = required.minApprovals ?? 1;

  if (was !== now) {
    return `current policy requires approval from ${now}; the approval on file was granted under ${was}`;
  }
  if (minimum > heldMinimum) {
    return `current policy requires ${minimum} approvals; the approval on file carries ${held.votes.filter((vote) => vote.vote === 'approve').length}`;
  }
  return 'current policy requires separation of duties, which the approval on file was not granted under';
}
