import type {
  Action,
  AgentCredential,
  Agent,
  ApprovalRequest,
  AssessmentRun,
  AuditRecord,
  ChainExpectation,
  ChainVerification,
  ControlAssessment,
  ControlDefinition,
  Decision,
  EvidenceRecord,
  ExecutionAttempt,
  Finding,
  HumanAttestation,
  NotificationChannel,
  NotificationDelivery,
  OperatorSession,
  Policy,
  PolicyVersionRecord,
  Risk,
  Budget,
  SpendRecord,
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

  // --- 2.0: governance and assurance ------------------------------------
  //
  // These are ordinary collections rather than a separate database, and that
  // is a deliberate constraint: an assessment result is only as trustworthy
  // as its link to the enforcement record it rests on, and keeping both in
  // one store means that link is a local read rather than a join across a
  // boundary that can be out of date or unavailable.

  readonly risks: Collection<Risk>;
  readonly controls: Collection<ControlDefinition>;
  readonly assessments: Collection<ControlAssessment>;
  readonly assessmentRuns: Collection<AssessmentRun>;
  readonly findings: Collection<Finding>;
  readonly attestations: Collection<HumanAttestation>;
  /** Append-only history of every policy document ever published. */
  readonly policyVersions: Collection<PolicyVersionRecord>;

  // --- 2.1: operator identity -------------------------------------------
  //
  // Sessions are durable so that signing out and revoking access are real
  // rather than advisory. A purely stateless token stays valid until it
  // expires, which is not an answer to "we removed someone this morning".

  readonly operatorSessions: Collection<OperatorSession>;

  // --- 2.1: notification delivery ---------------------------------------
  //
  // Durable because "was anyone actually told about this approval" has to be
  // answerable later, and because a broken webhook should be findable in the
  // console rather than in application logs.

  readonly notificationChannels: Collection<NotificationChannel>;
  readonly notificationDeliveries: Collection<NotificationDelivery>;

  // --- 2.3: spend control (ADR-0002) ------------------------------------
  //
  // In the same store as decisions because a budget is read on the decision
  // path: a refusal that cites spend has to be checkable against the very
  // records it counted.

  readonly spend: Collection<SpendRecord>;
  readonly budgets: Collection<Budget>;

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

  /**
   * Object-model version this store's data was written by, when the
   * implementation records it. Absent for an in-memory store and for a 1.x
   * data directory, and absence is itself the answer: it means version 1.
   */
  schemaVersion?(): Promise<number>;

  /** Flushes anything buffered and releases handles. */
  close(): Promise<void>;
}
