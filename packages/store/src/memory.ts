import { AUDIT_GENESIS_DIGEST, canonicalize, digestText } from '@arc-control/schemas';
import type {
  Action,
  Agent,
  AgentCredential,
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
  Tool,
  Budget,
  SpendRecord,
} from '@arc-control/schemas';
import { Mutex } from './mutex.js';
import type { AuditLogStore, Collection, ControlStore, LogReadOptions } from './types.js';

export class MemoryCollection<T> implements Collection<T> {
  readonly #items = new Map<string, T>();
  readonly #mutex = new Mutex();

  async get(id: string): Promise<T | undefined> {
    return this.#items.get(id);
  }

  async put(id: string, value: T): Promise<T> {
    this.#items.set(id, value);
    return value;
  }

  async delete(id: string): Promise<boolean> {
    return this.#items.delete(id);
  }

  async list(): Promise<readonly T[]> {
    return [...this.#items.values()];
  }

  async find(predicate: (value: T) => boolean): Promise<T | undefined> {
    for (const value of this.#items.values()) {
      if (predicate(value)) return value;
    }
    return undefined;
  }

  async filter(predicate: (value: T) => boolean): Promise<readonly T[]> {
    return [...this.#items.values()].filter(predicate);
  }

  async count(): Promise<number> {
    return this.#items.size;
  }

  transact<R>(critical: () => Promise<R> | R): Promise<R> {
    return this.#mutex.run(critical);
  }
}

export class MemoryAuditLog implements AuditLogStore {
  readonly #records: AuditRecord[] = [];
  readonly #mutex = new Mutex();
  /** Called after each append so a durable store can persist the record. */
  readonly #onAppend: ((record: AuditRecord) => Promise<void> | void) | undefined;

  constructor(options: { seed?: readonly AuditRecord[]; onAppend?: (record: AuditRecord) => Promise<void> | void } = {}) {
    if (options.seed) this.#records.push(...options.seed);
    this.#onAppend = options.onAppend;
  }

  append(build: (previous: AuditRecord | undefined, sequence: number) => AuditRecord): Promise<AuditRecord> {
    return this.#mutex.run(async () => {
      const previous = this.#records.at(-1);
      const record = build(previous, (previous?.sequence ?? 0) + 1);
      this.#records.push(record);
      await this.#onAppend?.(record);
      return record;
    });
  }

  async read(options: LogReadOptions = {}): Promise<readonly AuditRecord[]> {
    let records = this.#records.filter(
      (record) => options.afterSequence === undefined || record.sequence > options.afterSequence,
    );
    if (options.reverse) records = records.slice().reverse();
    if (options.limit !== undefined) records = records.slice(0, options.limit);
    return records;
  }

  async last(): Promise<AuditRecord | undefined> {
    return this.#records.at(-1);
  }

  async count(): Promise<number> {
    return this.#records.length;
  }

  async verify(expectation?: ChainExpectation): Promise<ChainVerification> {
    return verifyChain(this.#records, expectation);
  }
}

/**
 * Recomputes every digest and link in a chain.
 *
 * This is deliberately a pure function over the records: an auditor can run it
 * against an export without trusting the system that produced it.
 *
 * What it detects on its own: a record whose content no longer matches its
 * digest, a broken link, and a missing record in the middle of the chain.
 *
 * What it cannot detect on its own: **truncation**. Remove records from the
 * end and what remains is a shorter chain that is internally perfectly valid.
 * Catching that needs an expected head, which has to come from outside the log
 * — pass `expectation`, and see `ChainExpectation`.
 */
export function verifyChain(
  records: readonly AuditRecord[],
  expectation: ChainExpectation = {},
): ChainVerification {
  const failures: ChainVerification['failures'][number][] = [];
  let expectedPrevious = AUDIT_GENESIS_DIGEST;
  let expectedSequence = 1;

  for (const record of records) {
    if (record.sequence !== expectedSequence) {
      failures.push({
        sequence: record.sequence,
        id: record.id,
        problem: 'sequence_gap',
        detail: `expected sequence ${expectedSequence}, found ${record.sequence}`,
      });
    }

    if (record.previousDigest !== expectedPrevious) {
      failures.push({
        sequence: record.sequence,
        id: record.id,
        problem: 'broken_link',
        detail: `previousDigest does not match the digest of record ${expectedSequence - 1}`,
      });
    }

    const recomputed = computeAuditDigest(record);
    if (recomputed !== record.digest) {
      failures.push({
        sequence: record.sequence,
        id: record.id,
        problem: 'digest_mismatch',
        detail: 'record content does not match its stored digest',
      });
    }

    expectedPrevious = record.digest;
    expectedSequence = record.sequence + 1;
  }

  const head = records.at(-1);
  const checkedAgainstExpectation =
    expectation.headDigest !== undefined || expectation.headSequence !== undefined;

  if (expectation.headSequence !== undefined) {
    if (!head) {
      failures.push({
        sequence: 0,
        id: '(none)',
        problem: 'empty',
        detail: `the chain is empty but was expected to reach sequence ${expectation.headSequence}`,
      });
    } else if (head.sequence < expectation.headSequence) {
      failures.push({
        sequence: head.sequence,
        id: head.id,
        problem: 'truncated',
        detail: `the chain ends at sequence ${head.sequence} but was expected to reach ${expectation.headSequence}: ${expectation.headSequence - head.sequence} record(s) are missing from the end`,
      });
    } else if (head.sequence > expectation.headSequence) {
      failures.push({
        sequence: head.sequence,
        id: head.id,
        problem: 'head_mismatch',
        detail: `the chain reaches sequence ${head.sequence} but was expected to end at ${expectation.headSequence}`,
      });
    }
  }

  if (expectation.headDigest !== undefined) {
    if (!head) {
      failures.push({
        sequence: 0,
        id: '(none)',
        problem: 'empty',
        detail: 'the chain is empty but an expected head digest was given',
      });
    } else if (head.digest !== expectation.headDigest) {
      failures.push({
        sequence: head.sequence,
        id: head.id,
        problem: 'head_mismatch',
        detail: `the head digest is ${head.digest} but ${expectation.headDigest} was expected; the chain has been rewritten or truncated`,
      });
    }
  }

  return {
    valid: failures.length === 0,
    recordsChecked: records.length,
    failures,
    ...(head ? { headDigest: head.digest, headSequence: head.sequence } : {}),
    checkedAgainstExpectation,
  };
}

/** The digest of an audit record: everything but the digest field itself. */
export function computeAuditDigest(record: AuditRecord): string {
  const { digest: _ignored, ...content } = record;
  return digestText(canonicalize(content));
}

export class MemoryStore implements ControlStore {
  readonly agents = new MemoryCollection<Agent>();
  readonly credentials = new MemoryCollection<AgentCredential>();
  readonly tools = new MemoryCollection<Tool>();
  readonly policies = new MemoryCollection<Policy>();
  readonly actions = new MemoryCollection<Action>();
  readonly decisions = new MemoryCollection<Decision>();
  readonly approvals = new MemoryCollection<ApprovalRequest>();
  readonly executions = new MemoryCollection<ExecutionAttempt>();
  readonly evidence = new MemoryCollection<EvidenceRecord>();
  readonly audit: AuditLogStore = new MemoryAuditLog();

  readonly risks = new MemoryCollection<Risk>();
  readonly controls = new MemoryCollection<ControlDefinition>();
  readonly assessments = new MemoryCollection<ControlAssessment>();
  readonly assessmentRuns = new MemoryCollection<AssessmentRun>();
  readonly findings = new MemoryCollection<Finding>();
  readonly attestations = new MemoryCollection<HumanAttestation>();
  readonly policyVersions = new MemoryCollection<PolicyVersionRecord>();

  readonly operatorSessions = new MemoryCollection<OperatorSession>();

  readonly notificationChannels = new MemoryCollection<NotificationChannel>();
  readonly notificationDeliveries = new MemoryCollection<NotificationDelivery>();

  readonly spend = new MemoryCollection<SpendRecord>();
  readonly budgets = new MemoryCollection<Budget>();

  async close(): Promise<void> {
    /* nothing to release */
  }
}
