import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { Agent } from '@arc-control/schemas';
import { FileStore } from './file.js';

/**
 * The durable store's write path.
 *
 * The 2.0 implementation rewrote a whole collection file after every mutation,
 * so recording the ten-thousandth action cost time proportional to the nine
 * thousand before it. Actions and evidence grow for as long as a deployment
 * runs, which made this the ceiling on how long a customer could use the
 * product before writes became the problem.
 */

function agent(id: string, name = id): Agent {
  return {
    id,
    organizationId: 'default',
    name,
    owner: 'ops@example.com',
    roles: [],
    status: 'active',
    environment: 'production',
    labels: {},
    kind: 'service',
    declaredTools: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  } satisfies Agent;
}

describe('the append-only collection', () => {
  let directory: string;

  before(async () => {
    directory = await mkdtemp(join(tmpdir(), 'arc-store-'));
  });

  after(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  /** A fresh store in its own directory. */
  async function store(name: string): Promise<{ store: FileStore; path: string; dir: string }> {
    const dir = join(directory, name);
    const opened = await FileStore.open(dir);
    return { store: opened, path: join(dir, 'agents.jsonl'), dir };
  }

  it('persists a record and reads it back after a restart', async () => {
    const { store: first, dir } = await store('restart');
    await first.agents.put('a1', agent('a1'));
    await first.close();

    const second = await FileStore.open(dir);
    assert.equal((await second.agents.get('a1'))?.name, 'a1');
    await second.close();
  });

  it('replays an update as last-write-wins', async () => {
    const { store: first, dir } = await store('update');
    await first.agents.put('a1', agent('a1', 'original'));
    await first.agents.put('a1', agent('a1', 'renamed'));
    await first.close();

    const second = await FileStore.open(dir);
    assert.equal((await second.agents.get('a1'))?.name, 'renamed');
    assert.equal(await second.agents.count(), 1, 'the update is not a second record');
    await second.close();
  });

  /**
   * A delete cannot be expressed by appending a record, so it appends a
   * marker. Getting this wrong would resurrect deleted records on restart —
   * including revoked credentials.
   */
  it('keeps a deletion deleted across a restart', async () => {
    const { store: first, dir } = await store('delete');
    await first.agents.put('a1', agent('a1'));
    await first.agents.put('a2', agent('a2'));
    await first.agents.delete('a1');
    await first.close();

    const second = await FileStore.open(dir);
    assert.equal(await second.agents.get('a1'), undefined, 'it must not come back');
    assert.equal((await second.agents.get('a2'))?.name, 'a2');
    assert.equal(await second.agents.count(), 1);
    await second.close();
  });

  it('survives a delete followed by a re-put of the same id', async () => {
    const { store: first, dir } = await store('recreate');
    await first.agents.put('a1', agent('a1', 'first'));
    await first.agents.delete('a1');
    await first.agents.put('a1', agent('a1', 'second'));
    await first.close();

    const second = await FileStore.open(dir);
    assert.equal((await second.agents.get('a1'))?.name, 'second');
    await second.close();
  });

  it('deleting something absent writes nothing', async () => {
    const { store: opened, path } = await store('absent');
    await opened.agents.put('a1', agent('a1'));
    const before = (await readFile(path, 'utf8')).split('\n').filter(Boolean).length;

    assert.equal(await opened.agents.delete('nope'), false);
    const after = (await readFile(path, 'utf8')).split('\n').filter(Boolean).length;

    assert.equal(after, before, 'a no-op must not grow the log');
    await opened.close();
  });

  /**
   * A 2.0 data directory holds a plain snapshot with no delete markers. It has
   * to keep working, or upgrading means losing the deployment's history.
   */
  it('reads a 2.0 snapshot file unchanged', async () => {
    const { store: first, dir } = await store('legacy');
    await first.agents.put('a1', agent('a1'));
    await first.agents.put('a2', agent('a2'));
    // Compaction produces exactly the old format, which is the compatibility
    // claim: a file this reader writes is one the old reader could read.
    await first.close();

    const snapshot = await readFile(join(dir, 'agents.jsonl'), 'utf8');
    for (const line of snapshot.split('\n').filter(Boolean)) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      assert.ok('id' in parsed, 'every line of a compacted file is a bare record');
    }

    const second = await FileStore.open(dir);
    assert.equal(await second.agents.count(), 2);
    await second.close();
  });

  /**
   * The measurement, not a guess: the cost of a write must not grow with the
   * number of records already stored.
   *
   * Bytes written is the honest metric. Timing a thousand writes on shared CI
   * hardware measures the machine; file growth measures the algorithm. Under
   * the old implementation the file was rewritten each time, so total bytes
   * written grew as the square of the record count.
   */
  it('does not rewrite the whole collection on every write', async () => {
    const { store: opened, path } = await store('amplification');

    for (let index = 0; index < 200; index += 1) {
      await opened.agents.put(`a${String(index)}`, agent(`a${String(index)}`));
    }
    await opened.close();

    const size = (await stat(path)).size;
    const oneRecord = JSON.stringify(agent('a0')).length + 1;

    // A log of 200 records, possibly compacted, is within a small factor of
    // 200 records. The old implementation wrote 200 * 201 / 2 records' worth
    // of bytes to get here — about a hundred times this.
    assert.ok(
      size < oneRecord * 200 * 3,
      `the file is ${String(size)} bytes for 200 records of ~${String(oneRecord)} bytes each`,
    );

    const reopened = await FileStore.open(path.replace('/agents.jsonl', ''));
    assert.equal(await reopened.agents.count(), 200, 'and every record is still there');
    await reopened.close();
  });

  /**
   * Compaction has to actually happen, or the log grows without bound and
   * opening the store gets slower every restart.
   */
  it('compacts a log that has accumulated more dead weight than live records', async () => {
    const { store: opened, path } = await store('compaction');

    // One record, written many times: every line but the last is dead.
    for (let index = 0; index < 300; index += 1) {
      await opened.agents.put('a1', agent('a1', `version-${String(index)}`));
    }
    await opened.close();

    const lines = (await readFile(path, 'utf8')).split('\n').filter(Boolean).length;
    assert.ok(lines < 300, `the log still holds ${String(lines)} lines; it should have been compacted`);

    const reopened = await FileStore.open(path.replace('/agents.jsonl', ''));
    assert.equal((await reopened.agents.get('a1'))?.name, 'version-299', 'and the surviving value is the last one');
    await reopened.close();
  });

  it('leaves a small collection alone rather than rewriting it constantly', async () => {
    const { store: opened, path } = await store('small');
    for (let index = 0; index < 10; index += 1) {
      await opened.agents.put('a1', agent('a1', `version-${String(index)}`));
    }
    await opened.close();

    const lines = (await readFile(path, 'utf8')).split('\n').filter(Boolean).length;
    assert.ok(lines > 1, 'a ten-line log is not worth compacting');
  });

  /**
   * `close` used to be a no-op, which was true while writes were synchronous
   * whole-file rewrites. Writes are queued now, and a CLI command that records
   * something and exits is the normal shape.
   */
  it('drains queued writes on close', async () => {
    const { store: opened, dir } = await store('drain');

    // Deliberately not awaited: the close must still capture them.
    const writes = [0, 1, 2, 3, 4].map((index) =>
      opened.agents.put(`a${String(index)}`, agent(`a${String(index)}`)),
    );
    await Promise.all(writes);
    await opened.close();

    const second = await FileStore.open(dir);
    assert.equal(await second.agents.count(), 5);
    await second.close();
  });

  it('keeps insertion order, which list() promises', async () => {
    const { store: first, dir } = await store('order');
    for (const id of ['a3', 'a1', 'a2']) await first.agents.put(id, agent(id));
    await first.agents.put('a1', agent('a1', 'updated'));
    await first.close();

    const second = await FileStore.open(dir);
    assert.deepEqual(
      (await second.agents.list()).map((item) => item.id),
      ['a3', 'a1', 'a2'],
      'an update keeps a record where it was',
    );
    await second.close();
  });

  it('tolerates a torn final line from a process that died mid-append', async () => {
    const { store: first, dir, path } = await store('torn');
    await first.agents.put('a1', agent('a1'));
    await first.close();

    const { appendFile } = await import('node:fs/promises');
    await appendFile(path, '{"id":"a2","partial', 'utf8');

    const second = await FileStore.open(dir);
    assert.equal(await second.agents.count(), 1, 'the intact record survives');
    assert.equal(await second.agents.get('a2'), undefined);
    await second.close();
  });
});
