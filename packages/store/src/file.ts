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
    this.audit = audit;
  }

  /** Opens a store, creating the directory and replaying any existing data. */
  static async open(directory: string): Promise<FileStore> {
    await mkdir(directory, { recursive: true });

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
    };

    // Stamp the directory with the model version. A 1.x directory has no
    // marker, which is how an upgrade is recognised: the new collections open
    // empty, every 1.x record still parses because the added fields are all
    // optional, and nothing is rewritten. That is the entire migration, and it
    // is reversible — a 1.x build reading this directory ignores the files it
    // does not know about.
    await stampSchemaVersion(directory);

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

  async close(): Promise<void> {
    /* every write is already flushed */
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

/** A collection that persists a full snapshot after each mutation. */
class PersistedCollection<T extends { id: string }> implements Collection<T> {
  readonly #inner = new MemoryCollection<T>();

  constructor(
    private readonly path: string,
    seed: readonly T[],
  ) {
    for (const item of seed) void this.#inner.put(item.id, item);
  }

  get(id: string): Promise<T | undefined> {
    return this.#inner.get(id);
  }

  async put(id: string, value: T): Promise<T> {
    await this.#inner.put(id, value);
    await this.#flush();
    return value;
  }

  async delete(id: string): Promise<boolean> {
    const deleted = await this.#inner.delete(id);
    if (deleted) await this.#flush();
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

  async #flush(): Promise<void> {
    const items = await this.#inner.list();
    const body = items.map((item) => JSON.stringify(item)).join('\n');
    const temporary = `${this.path}.tmp`;
    await writeFile(temporary, body ? `${body}\n` : '', 'utf8');
    await rename(temporary, this.path);
  }
}

async function openCollection<T extends { id: string }>(directory: string, name: string): Promise<Collection<T>> {
  const path = join(directory, `${name}.jsonl`);
  const seed = await readJsonLines<T>(path);
  return new PersistedCollection<T>(path, seed);
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
