/**
 * The audit log is append-only and hash-chained: every record carries the
 * digest of its predecessor, so removing or editing a record breaks the chain
 * at that point and every point after it. Verification needs nothing but the
 * records themselves.
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
  | 'evidence.recorded';

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

export interface ChainVerification {
  readonly valid: boolean;
  readonly recordsChecked: number;
  readonly failures: readonly {
    readonly sequence: number;
    readonly id: string;
    readonly problem: 'digest_mismatch' | 'broken_link' | 'sequence_gap';
    readonly detail: string;
  }[];
}
