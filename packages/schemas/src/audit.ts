/**
 * The audit log is append-only and hash-chained: every record carries the
 * digest of its predecessor, so editing a record, or removing one from the
 * middle, breaks the chain at that point and at every point after it.
 *
 * Walking the records detects those on its own. It cannot detect
 * **truncation** — remove records from the end and what remains is a shorter
 * chain in which every digest and link is still correct. Catching that needs
 * an expected head from outside the log; see `ChainExpectation`.
 */
export type AuditEventType =
  | 'agent.registered'
  | 'agent.updated'
  | 'agent.suspended'
  | 'agent.resumed'
  | 'credential.issued'
  | 'credential.revoked'
  | 'tool.registered'
  | 'tool.updated'
  | 'policy.created'
  | 'policy.updated'
  | 'policy.disabled'
  | 'action.requested'
  | 'action.allowed'
  | 'action.denied'
  | 'action.executed'
  | 'action.failed'
  | 'approval.requested'
  | 'approval.voted'
  | 'approval.approved'
  | 'approval.rejected'
  | 'approval.expired'
  | 'evidence.recorded'
  // 2.0 — kill switches and lifecycle.
  | 'agent.retired'
  | 'tool.disabled'
  | 'tool.enabled'
  | 'connector.disabled'
  | 'connector.enabled'
  | 'credential.rotated'
  | 'credential.expired'
  // 2.0 — governance administration. Every one of these is an operator
  // changing what the platform asserts about itself, which is exactly the
  // class of change an auditor asks to see a trail of.
  | 'risk.created'
  | 'risk.updated'
  | 'risk.accepted'
  | 'risk.closed'
  | 'control.created'
  | 'control.updated'
  | 'control.enabled'
  | 'control.disabled'
  | 'assessment.ran'
  | 'attestation.recorded'
  | 'finding.opened'
  | 'finding.updated'
  | 'finding.resolved'
  | 'bundle.exported';

export interface AuditRecord {
  readonly id: string;
  /** Monotonic position in the chain, starting at 1. */
  readonly sequence: number;
  readonly type: AuditEventType;
  readonly organizationId: string;
  readonly occurredAt: string;
  /** Who or what caused the event: an agent id, a human identifier, or `system`. */
  readonly actor: string;
  /** The object acted upon, e.g. an action, policy or agent id. */
  readonly subject: string;
  readonly summary: string;
  readonly data: Readonly<Record<string, unknown>>;
  /** Digest of the previous record, or the genesis constant for the first. */
  readonly previousDigest: string;
  /** Digest over this record's content and `previousDigest`. */
  readonly digest: string;
}

/** `previousDigest` of the first record in a chain. */
export const AUDIT_GENESIS_DIGEST = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';

/**
 * What a chain can be checked against.
 *
 * Walking the records alone detects an edited record and an *interior*
 * deletion, but it cannot detect truncation: lop records off the end and what
 * remains is a shorter, perfectly valid chain. Detecting that requires knowing
 * what the head should be, which has to come from outside the log — which is
 * exactly why `arc audit verify` prints the head digest for an operator to
 * record somewhere else.
 */
export interface ChainExpectation {
  /** Digest of the record that should be at the head. */
  readonly headDigest?: string;
  /** Sequence number the chain should reach. */
  readonly headSequence?: number;
}

export type ChainProblem =
  | 'digest_mismatch'
  | 'broken_link'
  | 'sequence_gap'
  | 'truncated'
  | 'head_mismatch'
  | 'empty';

export interface ChainVerification {
  readonly valid: boolean;
  readonly recordsChecked: number;
  readonly failures: readonly {
    readonly sequence: number;
    readonly id: string;
    readonly problem: ChainProblem;
    readonly detail: string;
  }[];
  /** The digest at the head of the chain as verified, for anchoring. */
  readonly headDigest?: string;
  readonly headSequence?: number;
  /** True when the chain was checked against an expected head rather than only internally. */
  readonly checkedAgainstExpectation: boolean;
}
