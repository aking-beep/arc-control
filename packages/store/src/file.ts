import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  Action,
  Agent,
  AgentCredential,
  ApprovalRequest,
  AuditRecord,
  Decision,
  EvidenceRecord,
  ExecutionAttempt,
  Policy,
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
    this.audit = audit;
  }

  /** Opens a store, creating the directory and replaying any existing data. */
  static async open(directory: string): Promise<FileStore> {
    await mkdir(directory, { recursive: true });

    const auditPath = join(directory, 'audit.jsonl');
    const seed = await readJsonLines<AuditRecord>(auditPath);
    const audit = new MemoryAuditLog({
      seed,
      onAppend: async (record) => {
        await appendFile(auditPath, `${JSON.stringify(record)}\n`, 'utf8');
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
    };

    return new FileStore(directory, collections, audit);
  }

  get path(): string {
    return this.directory;
  }

  async close(): Promise<void> {
    /* every write is already flushed */
  }
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
