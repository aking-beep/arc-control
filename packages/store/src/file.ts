import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SCHEMA_VERSION } from '@arc-control/schemas';
import type {
  Action,
  ChainExpectation,
  Agent,
  AgentCredential,
  ApprovalRequest,
  AssessmentRun,
  AuditRecord,
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
} from '@arc-control/schemas';
import { MemoryAuditLog, MemoryCollection } from './memory.js';
import type { AuditLogStore, Collection, ControlStore } from './types.js';

/**
 * A durable store backed by newline-delimited JSON files in one directory.
 *
 * Mutable collections are snapshot files rewritten on change; the audit log is
 * a true append-only file, so a record that has been written is never
 * rewritten — the file itself carries the same guarantee the hash chain does.
 * This is the single-node deployment target: enough for a pilot, an air-gapped
 * install or a developer laptop, and small enough to read with `cat`.
 */
export class FileStore implements ControlStore {
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

  readonly risks: Collection<Risk>;
  readonly controls: Collection<ControlDefinition>;
  readonly assessments: Collection<ControlAssessment>;
  readonly assessmentRuns: Collection<AssessmentRun>;
  readonly findings: Collection<Finding>;
  readonly attestations: Collection<HumanAttestation>;
  readonly policyVersions: Collection<PolicyVersionRecord>;
  readonly operatorSessions: Collection<OperatorSession>;
  readonly notificationChannels: Collection<NotificationChannel>;
  readonly notificationDeliveries: Collection<NotificationDelivery>;

  private constructor(
    private readonly directory: string,
    collections: {
      agents: Collection<Agent>;
      credentials: Collection<AgentCredential>;
      tools: Collection<Tool>;
      policies: Collection<Policy>;
      actions: Collection<Action>;
      decisions: Collection<Decision>;
      approvals: Collection<ApprovalRequest>;
      executions: Collection<ExecutionAttempt>;
      evidence: Collection<EvidenceRecord>;
      risks: Collection<Risk>;
      controls: Collection<ControlDefinition>;
      assessments: Collection<ControlAssessment>;
      assessmentRuns: Collection<AssessmentRun>;
      findings: Collection<Finding>;
      attestations: Collection<HumanAttestation>;
      policyVersions: Collection<PolicyVersionRecord>;
      operatorSessions: Collection<OperatorSession>;
      notificationChannels: Collection<NotificationChannel>;
      notificationDeliveries: Collection<NotificationDelivery>;
    },
    audit: AuditLogStore,
  ) {
    this.agents = collections.agents;
    this.credentials = collections.credentials;
    this.tools = collections.tools;
    this.policies = collections.policies;
    this.actions = collections.actions;
    this.decisions = collections.decisions;
    this.approvals = collections.approvals;
    this.executions = collections.executions;
    this.evidence = collections.evidence;
    this.risks = collections.risks;
    this.controls = collections.controls;
    this.assessments = collections.assessments;
    this.assessmentRuns = collections.assessmentRuns;
    this.findings = collections.findings;
    this.attestations = collections.attestations;
    this.policyVersions = collections.policyVersions;
    this.operatorSessions = collections.operatorSessions;
    this.notificationChannels = collections.notificationChannels;
    this.notificationDeliveries = collections.notificationDeliveries;
    this.audit = audit;
  }

  /** Opens a store, creating the directory and replaying any existing data. */
  /**
   * Opens a data directory.
   *
   * `readOnly` skips the version stamp and the directory creation, so reading
   * a directory does not modify it. That matters for exactly one reason and it
   * is the product's central claim: verifying evidence must not alter it. An
   * auditor checking a backup, or `arc backup verify` checking its own
   * digests, would otherwise invalidate the thing it was asked to check —
   * which is how the first version of that command failed.
   */
  static async open(directory: string, options: { readonly readOnly?: boolean } = {}): Promise<FileStore> {
    if (options.readOnly !== true) await mkdir(directory, { recursive: true });

    const auditPath = join(directory, 'audit.jsonl');
    const headPath = join(directory, 'audit.head.json');
    const seed = await readJsonLines<AuditRecord>(auditPath);

    const audit = new MemoryAuditLog({
      seed,
      onAppend: async (record) => {
        await appendFile(auditPath, `${JSON.stringify(record)}\n`, 'utf8');
        // The head marker is written after the record it describes, so a crash
        // between the two leaves the marker behind the log rather than ahead
        // of it — which reads as "a record was appended and not yet marked",
        // not as "records are missing".
        await writeHead(headPath, record);
      },
    });

    const collections = {
      agents: await openCollection<Agent>(directory, 'agents'),
      credentials: await openCollection<AgentCredential>(directory, 'credentials'),
      tools: await openCollection<Tool>(directory, 'tools'),
      policies: await openCollection<Policy>(directory, 'policies'),
      actions: await openCollection<Action>(directory, 'actions'),
      decisions: await openCollection<Decision>(directory, 'decisions'),
      approvals: await openCollection<ApprovalRequest>(directory, 'approvals'),
      executions: await openCollection<ExecutionAttempt>(directory, 'executions'),
      evidence: await openCollection<EvidenceRecord>(directory, 'evidence'),
      risks: await openCollection<Risk>(directory, 'risks'),
      controls: await openCollection<ControlDefinition>(directory, 'controls'),
      assessments: await openCollection<ControlAssessment>(directory, 'assessments'),
      assessmentRuns: await openCollection<AssessmentRun>(directory, 'assessment-runs'),
      findings: await openCollection<Finding>(directory, 'findings'),
      attestations: await openCollection<HumanAttestation>(directory, 'attestations'),
      policyVersions: await openCollection<PolicyVersionRecord>(directory, 'policy-versions'),
      operatorSessions: await openCollection<OperatorSession>(directory, 'operator-sessions'),
      notificationChannels: await openCollection<NotificationChannel>(directory, 'notification-channels'),
      notificationDeliveries: await openCollection<NotificationDelivery>(directory, 'notification-deliveries'),
    };

    // Stamp the directory with the model version. A 1.x directory has no
    // marker, which is how an upgrade is recognised: the new collections open
    // empty, every 1.x record still parses because the added fields are all
    // optional, and nothing is rewritten. That is the entire migration, and it
    // is reversible — a 1.x build reading this directory ignores the files it
    // does not know about.
    if (options.readOnly !== true) await stampSchemaVersion(directory);

    return new FileStore(directory, collections, audit);
  }

  get path(): string {
    return this.directory;
  }

  /**
   * The recorded head of the audit chain, if the marker file is present.
   *
   * This exists because walking the records alone cannot detect truncation:
   * lop entries off the end of `audit.jsonl` and what remains is a shorter,
   * internally valid chain. Keeping the head in a separate file means
   * truncating the log alone is caught.
   *
   * It is defence in depth, not a guarantee. An attacker who can rewrite
   * `audit.jsonl` can usually rewrite this file too. What it reliably catches
   * is the accidental case — a crash mid-write, a partial restore, a log
   * rotation that dropped the tail — which is the common one. The real
   * guarantee needs the head digest anchored outside ARC Control entirely.
   */
  async recordedAuditHead(): Promise<ChainExpectation | undefined> {
    try {
      const raw = JSON.parse(await readFile(join(this.directory, 'audit.head.json'), 'utf8')) as {
        sequence?: number;
        digest?: string;
      };
      if (typeof raw.digest !== 'string' || typeof raw.sequence !== 'number') return undefined;
      return { headDigest: raw.digest, headSequence: raw.sequence };
    } catch {
      return undefined;
    }
  }

  /**
   * The model version recorded in the directory, defaulting to 1.
   *
   * A 1.x directory carries no marker file, so its absence is not an error —
   * it is the version. Reported rather than acted upon: this build reads both,
   * and a store that silently upgraded data on open would make a downgrade
   * impossible to perform safely.
   */
  async schemaVersion(): Promise<number> {
    try {
      const raw = JSON.parse(await readFile(join(this.directory, 'schema.json'), 'utf8')) as { version?: unknown };
      return typeof raw.version === 'number' ? raw.version : 1;
    } catch {
      return 1;
    }
  }

  /**
   * Waits for every queued append to reach disk.
   *
   * This used to be a no-op, which was true while each write rewrote the whole
   * file synchronously. Writes are now queued, so closing without draining the
   * queue would drop whatever had not been written yet — and a process that
   * closes immediately after recording an action is the normal shape of a CLI
   * command.
   */
  async close(): Promise<void> {
    await Promise.all(
      Object.values(this as unknown as Record<string, unknown>)
        .filter((value): value is { flushed: () => Promise<void> } => isPersisted(value))
        .map((collection) => collection.flushed()),
    );
  }
}

/**
 * Writes the model-version marker, preserving the version a directory was
 * first created at so an upgrade is visible rather than overwritten.
 */
async function stampSchemaVersion(directory: string): Promise<void> {
  const path = join(directory, 'schema.json');

  let createdWith = SCHEMA_VERSION as number;
  let createdAt = new Date().toISOString();
  try {
    const existing = JSON.parse(await readFile(path, 'utf8')) as { createdWith?: unknown; createdAt?: unknown };
    if (typeof existing.createdWith === 'number') createdWith = existing.createdWith;
    if (typeof existing.createdAt === 'string') createdAt = existing.createdAt;
  } catch {
    /* no marker yet: a fresh directory, or one written by 1.x */
  }

  const body = JSON.stringify({ version: SCHEMA_VERSION, createdWith, createdAt, openedAt: new Date().toISOString() }, null, 2);
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${body}\n`, 'utf8');
  await rename(temporary, path);
}

/**
 * A collection persisted as an append-only log, compacted when it earns it.
 *
 * The 2.0 implementation rewrote the whole file after every mutation. That is
 * fine for agents and policies, which number in the tens, and wrong for
 * actions and evidence, which grow for as long as the deployment runs: the
 * cost of recording the ten-thousandth action was proportional to the nine
 * thousand, nine hundred and ninety-nine before it. A customer doing a few
 * hundred actions a day would have watched writes get slower every week and
 * had no way to tell why.
 *
 * So a write appends one line. A put appends the record exactly as the old
 * format stored it, which is why existing data directories load unchanged and
 * a compacted file is still readable by the 2.0 reader. Only a delete needs an
 * envelope, since "this record is gone" cannot be expressed by a record.
 *
 * Replaying the log on open is last-write-wins in file order. Compaction
 * rewrites the live set as a plain snapshot once the log has accumulated more
 * dead weight than live records, which bounds both the file size and the time
 * to open it.
 */

/** Whether a value is one of this store's append-queue-backed collections. */
function isPersisted(value: unknown): value is { flushed: () => Promise<void> } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { flushed?: unknown }).flushed === 'function'
  );
}

/** Marks a deletion in the log. ARC records never carry this key. */
const DELETE_MARKER = '$arcDeleted';

interface DeleteEntry {
  readonly [DELETE_MARKER]: true;
  readonly id: string;
}

function isDeleteEntry(value: unknown): value is DeleteEntry {
  return typeof value === 'object' && value !== null && DELETE_MARKER in value;
}

/** Smallest log worth compacting, so a tiny collection is never rewritten. */
const MIN_COMPACT_ENTRIES = 64;

class PersistedCollection<T extends { id: string }> implements Collection<T> {
  readonly #inner = new MemoryCollection<T>();
  /** Lines in the file, live and dead, since the last compaction. */
  #entries: number;
  /** Serializes appends so two writes cannot interleave a partial line. */
  #writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly path: string,
    seed: readonly T[],
    entries: number,
  ) {
    for (const item of seed) void this.#inner.put(item.id, item);
    this.#entries = entries;
  }

  get(id: string): Promise<T | undefined> {
    return this.#inner.get(id);
  }

  async put(id: string, value: T): Promise<T> {
    await this.#inner.put(id, value);
    await this.#append(JSON.stringify(value));
    return value;
  }

  async delete(id: string): Promise<boolean> {
    const deleted = await this.#inner.delete(id);
    if (deleted) await this.#append(JSON.stringify({ [DELETE_MARKER]: true, id } satisfies DeleteEntry));
    return deleted;
  }

  list(): Promise<readonly T[]> {
    return this.#inner.list();
  }

  find(predicate: (value: T) => boolean): Promise<T | undefined> {
    return this.#inner.find(predicate);
  }

  filter(predicate: (value: T) => boolean): Promise<readonly T[]> {
    return this.#inner.filter(predicate);
  }

  count(): Promise<number> {
    return this.#inner.count();
  }

  transact<R>(critical: () => Promise<R> | R): Promise<R> {
    return this.#inner.transact(critical);
  }

  /**
   * Appends one line, then compacts if the log has grown past twice the live
   * set.
   *
   * Appends are chained rather than issued concurrently: `O_APPEND` is atomic
   * per write on POSIX, but compaction renames the file underneath, and a
   * write racing that rename is a lost record.
   */
  async #append(line: string): Promise<void> {
    const write = async (): Promise<void> => {
      await appendFile(this.path, `${line}\n`, 'utf8');
      this.#entries += 1;

      const live = await this.#inner.count();
      if (this.#entries > MIN_COMPACT_ENTRIES && this.#entries > live * 2) {
        await this.#compact();
      }
    };

    // Runs after the previous write whether that one succeeded or failed, and
    // the queue tail never holds a rejection. Chaining with a plain `.then`
    // would leave the tail rejected after one failed write, so every later
    // write would be skipped without being attempted — a full disk for one
    // moment would silently stop persisting anything until a restart.
    const queued = this.#writing.then(write, write);
    this.#writing = queued.then(
      () => undefined,
      () => undefined,
    );

    return queued;
  }

  /** Rewrites the live set as a snapshot, atomically. */
  async #compact(): Promise<void> {
    const items = await this.#inner.list();
    const body = items.map((item) => JSON.stringify(item)).join('\n');
    const temporary = `${this.path}.tmp`;
    await writeFile(temporary, body ? `${body}\n` : '', 'utf8');
    await rename(temporary, this.path);
    this.#entries = items.length;
  }

  /** Compacts now, whatever the log looks like. Used on close and by tests. */
  async compact(): Promise<void> {
    const queued = this.#writing.then(
      () => this.#compact(),
      () => this.#compact(),
    );
    this.#writing = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  /** Waits for every queued append to reach the file. */
  async flushed(): Promise<void> {
    return this.#writing;
  }
}

async function openCollection<T extends { id: string }>(directory: string, name: string): Promise<Collection<T>> {
  const path = join(directory, `${name}.jsonl`);
  const entries = await readJsonLines<T | DeleteEntry>(path);

  // Last write wins, in file order. A record written twice keeps the position
  // of its first appearance, which is the order the live map would have had.
  const live = new Map<string, T>();
  for (const entry of entries) {
    if (isDeleteEntry(entry)) {
      live.delete(entry.id);
      continue;
    }
    live.set(entry.id, entry as T);
  }

  return new PersistedCollection<T>(path, [...live.values()], entries.length);
}

/** Reads a JSONL file, tolerating absence and skipping an incomplete trailing line. */
async function readJsonLines<T>(path: string): Promise<T[]> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw cause;
  }

  const records: T[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as T);
    } catch {
      // A torn final line means the process died mid-append. Earlier records
      // are intact, and the audit chain will report the gap on verification.
    }
  }
  return records;
}

/** Writes the head marker atomically, so a crash never leaves it half-written. */
async function writeHead(path: string, record: AuditRecord): Promise<void> {
  const body = JSON.stringify(
    { sequence: record.sequence, digest: record.digest, updatedAt: new Date().toISOString() },
    null,
    2,
  );
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${body}\n`, 'utf8');
  await rename(temporary, path);
}
