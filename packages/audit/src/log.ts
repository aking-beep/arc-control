import {
  AUDIT_GENESIS_DIGEST,
  canonicalize,
  digestText,
  newId,
  type AuditEventType,
  type AuditRecord,
  type ChainVerification,
} from '@arc-control/schemas';
import { computeAuditDigest, verifyChain, type ControlStore, type LogReadOptions } from '@arc-control/store';

export interface AuditLogOptions {
  readonly now?: () => Date;
}

export interface AuditEvent {
  readonly type: AuditEventType;
  readonly organizationId: string;
  /** An agent id, a human identifier, or `system`. */
  readonly actor: string;
  /** The object acted upon. */
  readonly subject: string;
  readonly summary: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

/**
 * The audit log.
 *
 * Records are appended, never updated. Each one carries the digest of its
 * predecessor, so the log is a hash chain: editing a record changes its digest
 * and breaks the link every later record depends on, and removing one leaves a
 * sequence gap. `verify()` recomputes the whole chain and needs nothing but
 * the records, which is what makes an export independently checkable.
 *
 * This is tamper *evidence*, not tamper *proofing*: an attacker who controls
 * the storage can rewrite the entire chain. Anchoring the head digest
 * somewhere ARC Control does not control is what closes that gap, and is the
 * v0.5 work tracked in the roadmap.
 */
export class AuditLog {
  readonly #store: ControlStore;
  readonly #now: () => Date;

  constructor(store: ControlStore, options: AuditLogOptions = {}) {
    this.#store = store;
    this.#now = options.now ?? (() => new Date());
  }

  async append(event: AuditEvent): Promise<AuditRecord> {
    return this.#store.audit.append((previous, sequence) => {
      const content = {
        id: newId('audit'),
        sequence,
        type: event.type,
        organizationId: event.organizationId,
        occurredAt: this.#now().toISOString(),
        actor: event.actor,
        subject: event.subject,
        summary: event.summary,
        data: event.data ?? {},
        previousDigest: previous?.digest ?? AUDIT_GENESIS_DIGEST,
      };

      return { ...content, digest: digestText(canonicalize(content)) };
    });
  }

  async read(options: LogReadOptions = {}): Promise<readonly AuditRecord[]> {
    return this.#store.audit.read(options);
  }

  async head(): Promise<AuditRecord | undefined> {
    return this.#store.audit.last();
  }

  async count(): Promise<number> {
    return this.#store.audit.count();
  }

  /** Verifies the stored chain end to end. */
  async verify(): Promise<ChainVerification> {
    return this.#store.audit.verify();
  }

  /** Records concerning one subject, oldest first: the timeline for an action or agent. */
  async forSubject(subject: string): Promise<readonly AuditRecord[]> {
    const records = await this.#store.audit.read();
    return records.filter((record) => record.subject === subject);
  }
}

export { verifyChain, computeAuditDigest };
