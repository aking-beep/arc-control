import type {
  Action,
  AgentCredential,
  Agent,
  ApprovalRequest,
  AuditRecord,
  ChainExpectation,
  ChainVerification,
  Decision,
  EvidenceRecord,
  ExecutionAttempt,
  Policy,
  Tool,
} from '@arc-control/schemas';

/** A keyed collection of durable objects. */
export interface Collection<T> {
  get(id: string): Promise<T | undefined>;
  put(id: string, value: T): Promise<T>;
  delete(id: string): Promise<boolean>;
  /** All values, in insertion order. */
  list(): Promise<readonly T[]>;
  /** First value satisfying the predicate, in insertion order. */
  find(predicate: (value: T) => boolean): Promise<T | undefined>;
  filter(predicate: (value: T) => boolean): Promise<readonly T[]>;
  count(): Promise<number>;
  /** Serializes a read-modify-write sequence against this collection. */
  transact<R>(critical: () => Promise<R> | R): Promise<R>;
}

export interface LogReadOptions {
  /** Return records with a sequence greater than this value. */
  readonly afterSequence?: number;
  readonly limit?: number;
  /** Newest first. Defaults to oldest first, which is the order the chain verifies in. */
  readonly reverse?: boolean;
}

/** An append-only, hash-chained log. Records are never updated or removed. */
export interface AuditLogStore {
  append(build: (previous: AuditRecord | undefined, sequence: number) => AuditRecord): Promise<AuditRecord>;
  read(options?: LogReadOptions): Promise<readonly AuditRecord[]>;
  last(): Promise<AuditRecord | undefined>;
  count(): Promise<number>;
  /**
   * Verifies the chain. Without an expectation this detects edits, broken
   * links and interior deletions; truncation needs an expected head.
   */
  verify(expectation?: ChainExpectation): Promise<ChainVerification>;
}

/** Everything ARC Control persists. */
export interface ControlStore {
  readonly agents: Collection<Agent>;
  readonly credentials: Collection<AgentCredential>;
  readonly tools: Collection<Tool>;
  readonly policies: Collection<Policy>;
  readonly actions: Collection<Action>;
  readonly decisions: Collection<Decision>;
  readonly approvals: Collection<ApprovalRequest>;
  readonly executions: Collection<ExecutionAttempt>;
  readonly evidence: Collection<EvidenceRecord>;
  readonly audit: AuditLogStore;

  /**
   * The head of the audit chain as this store recorded it, when the
   * implementation keeps that separately from the log.
   *
   * Optional because it is a property of the storage layer, not of the model:
   * an in-memory store has nowhere to keep it. Where it exists, verification
   * can use it to detect truncation of the log — which walking the records
   * alone cannot do, since a truncated chain is internally valid.
   */
  recordedAuditHead?(): Promise<ChainExpectation | undefined>;

  /** Flushes anything buffered and releases handles. */
  close(): Promise<void>;
}
