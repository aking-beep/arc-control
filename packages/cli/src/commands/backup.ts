import { cp, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { verifyChain } from '@arc-control/audit';
import { FileStore } from '@arc-control/store';
import { ArcError } from '@arc-control/schemas';
import type { AuditRecord } from '@arc-control/schemas';
import { flagString, type ParsedArgs } from '../args.js';
import { detail, out, style } from '../output.js';

/**
 * `arc backup create` and `arc backup verify`.
 *
 * A control plane's data directory is the evidence an auditor will be shown,
 * so copying it is not enough: the copy has to be checkable. A backup nobody
 * has verified is a belief about a backup.
 *
 * Both commands work on a stopped deployment, which is the honest constraint.
 * Copying a directory while a process is appending to it can capture a torn
 * line — survivable, since the reader tolerates one — but it can also capture
 * a collection mid-compaction, when the live set is in a temporary file. So
 * the manifest records whether the source was quiescent and `verify` says so,
 * rather than the tool pretending a hot copy is as good.
 */

const MANIFEST = 'arc-backup.json';

interface BackupManifest {
  readonly tool: string;
  readonly createdAt: string;
  readonly sourceDirectory: string;
  /** sha256 of every file, so a silent corruption is detectable. */
  readonly files: Readonly<Record<string, { readonly bytes: number; readonly digest: string }>>;
  /** The audit chain's head at the moment of the copy. */
  readonly auditHead?: { readonly sequence: number; readonly digest: string };
  readonly records: Readonly<Record<string, number>>;
  readonly quiescent: boolean;
}

async function digestOf(path: string): Promise<{ bytes: number; digest: string }> {
  const body = await readFile(path);
  return { bytes: body.byteLength, digest: `sha256:${createHash('sha256').update(body).digest('hex')}` };
}

async function dataFiles(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name !== MANIFEST)
    // A `.tmp` file is a compaction in flight. Copying it would capture a
    // half-written snapshot, and leaving it out is correct: the live data is
    // still in the file it will replace.
    .filter((entry) => !entry.name.endsWith('.tmp'))
    .map((entry) => entry.name)
    .sort();
}

export async function createBackup(args: ParsedArgs): Promise<number> {
  const source = flagString(args, 'data') ?? process.env.ARC_DATA_DIR;
  const target = flagString(args, 'to') ?? args.positional[0];

  if (!source || !target) {
    out('usage: arc backup create --data <dir> --to <dir>');
    out();
    out('Copies a data directory and writes a manifest of digests beside it,');
    out('so `arc backup verify` can later establish the copy is intact.');
    out();
    out('Stop the deployment first. A copy taken while it is writing may');
    out('capture a collection mid-compaction, and the manifest will record');
    out('that the source was not quiescent.');
    return 2;
  }

  const stats = await stat(source).catch(() => undefined);
  if (!stats?.isDirectory()) throw new ArcError('not_found', `${source} is not a directory`);

  const names = await dataFiles(source);
  if (names.length === 0) throw new ArcError('not_found', `${source} holds no data files`);

  // A compaction in flight is the one thing that makes a hot copy unsafe
  // rather than merely untidy, so it is detected and reported.
  const quiescent = !(await readdir(source)).some((name) => name.endsWith('.tmp'));

  await mkdir(target, { recursive: true });

  const files: Record<string, { bytes: number; digest: string }> = {};
  for (const name of names) {
    await cp(join(source, name), join(target, name));
    files[name] = await digestOf(join(target, name));
  }

  const store = await FileStore.open(target, { readOnly: true });
  let auditHead: BackupManifest['auditHead'];
  const records: Record<string, number> = {};

  try {
    const head = await store.audit.last();
    if (head) auditHead = { sequence: head.sequence, digest: head.digest };

    for (const [name, collection] of [
      ['agents', store.agents],
      ['tools', store.tools],
      ['policies', store.policies],
      ['actions', store.actions],
      ['evidence', store.evidence],
      ['approvals', store.approvals],
      ['findings', store.findings],
      ['risks', store.risks],
    ] as const) {
      records[name] = await collection.count();
    }
    records.auditRecords = await store.audit.count();
  } finally {
    await store.close();
  }

  const manifest: BackupManifest = {
    tool: 'arc-control',
    createdAt: new Date().toISOString(),
    sourceDirectory: source,
    files,
    ...(auditHead ? { auditHead } : {}),
    records,
    quiescent,
  };

  await writeFile(join(target, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  out(style.bold(`Backed up ${source} to ${target}`));
  out();
  detail([
    ['files', String(names.length)],
    ['audit records', String(records.auditRecords ?? 0)],
    ['chain head', auditHead ? `${String(auditHead.sequence)} ${auditHead.digest.slice(0, 23)}…` : undefined],
    ['source quiescent', quiescent ? 'yes' : 'NO — a compaction was in flight'],
  ]);
  out();

  if (!quiescent) {
    out(
      style.yellow(
        'The source was being written to while it was copied. Stop the deployment and take the backup again.',
      ),
    );
    return 1;
  }

  out('Verify it now, and after every restore, with:');
  out(`  arc backup verify --data ${target}`);
  return 0;
}

export async function verifyBackup(args: ParsedArgs): Promise<number> {
  const directory = flagString(args, 'data') ?? args.positional[0];

  if (!directory) {
    out('usage: arc backup verify --data <dir>');
    out();
    out('Checks every file against the digests recorded when the backup was');
    out('taken, then verifies the audit chain inside it. A backup nobody has');
    out('verified is a belief about a backup.');
    return 2;
  }

  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(await readFile(join(directory, MANIFEST), 'utf8')) as BackupManifest;
  } catch {
    throw new ArcError(
      'not_found',
      `${directory} has no ${MANIFEST}, so there is nothing to check it against. ` +
        'It may be a data directory rather than a backup.',
    );
  }

  const problems: string[] = [];

  for (const [name, expected] of Object.entries(manifest.files)) {
    const actual = await digestOf(join(directory, name)).catch(() => undefined);
    if (actual === undefined) {
      problems.push(`${name} is missing`);
      continue;
    }
    if (actual.digest !== expected.digest) {
      problems.push(`${name} does not match its recorded digest (${String(actual.bytes)} bytes now)`);
    }
  }

  const unexpected = (await dataFiles(directory)).filter((name) => !(name in manifest.files));
  for (const name of unexpected) problems.push(`${name} is present but not in the manifest`);

  // The digests prove the bytes are unchanged since the copy. Verifying the
  // chain proves the data was sound when it was taken, which is a different
  // question and the one an auditor asks.
  let chainLine = 'not checked';
  try {
    const store = await FileStore.open(directory, { readOnly: true });
    try {
      const records = await store.audit.read();
      const verification = verifyChain(records as readonly AuditRecord[], {
        ...(manifest.auditHead
          ? { headDigest: manifest.auditHead.digest, headSequence: manifest.auditHead.sequence }
          : {}),
      });

      chainLine = verification.valid
        ? `${String(verification.recordsChecked)} record(s) verified${
            verification.checkedAgainstExpectation ? ' against the recorded head' : ' against itself only'
          }`
        : `INVALID: ${verification.failures.map((failure) => failure.detail).join('; ')}`;

      if (!verification.valid) problems.push('the audit chain inside this backup does not verify');
    } finally {
      await store.close();
    }
  } catch (cause) {
    problems.push(`the backup could not be opened: ${cause instanceof Error ? cause.message : String(cause)}`);
  }

  out(style.bold(`Backup at ${directory}`));
  out();
  detail([
    ['taken', manifest.createdAt],
    ['files', `${String(Object.keys(manifest.files).length)} checked`],
    ['audit chain', chainLine],
    ['source quiescent', manifest.quiescent ? 'yes' : 'no — taken from a running deployment'],
  ]);
  out();

  if (problems.length > 0) {
    out(style.red(`This backup is not usable: ${String(problems.length)} problem(s)`));
    for (const problem of problems) out(`  - ${problem}`);
    return 1;
  }

  out(style.green('Every file matches its recorded digest and the audit chain verifies.'));
  if (!manifest.quiescent) {
    out();
    out(style.yellow('It was taken from a running deployment, so it may be missing the last few writes.'));
  }
  return 0;
}
