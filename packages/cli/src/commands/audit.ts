import { readFile } from 'node:fs/promises';
import { verifyEvidence } from '@arc-control/evidence';
import { verifyChain } from '@arc-control/audit';
import { FileStore } from '@arc-control/store';
import { ArcError } from '@arc-control/schemas';
import type { AuditRecord, ChainExpectation, EvidenceRecord } from '@arc-control/schemas';
import { flagString, type ParsedArgs } from '../args.js';
import { detail, out, style, table } from '../output.js';

/**
 * `arc audit verify` and `arc evidence verify`.
 *
 * Both work against an exported file as well as a live store, and neither
 * needs ARC Control running. That is the point: an auditor should be able to
 * check an export with a tool they control, against a party that may have an
 * interest in the answer.
 */

export async function verifyAudit(args: ParsedArgs): Promise<number> {
  const dataDir = flagString(args, 'data') ?? process.env.ARC_DATA_DIR;
  const file = flagString(args, 'file') ?? args.positional[0];

  if (!dataDir && !file) {
    out('usage: arc audit verify (--data <dir> | --file <audit.jsonl>)');
    out();
    out('  --expect-head <digest>     head digest recorded earlier, from an anchor');
    out('  --expect-records <count>   sequence the chain should reach');
    out();
    out('Without an expected head the chain is checked against itself, which');
    out('detects an edited record and a missing record in the middle — but not');
    out('truncation, because a truncated chain is internally valid.');
    return 2;
  }

  const records = file ? await readJsonLines<AuditRecord>(file) : await readFromStore(dataDir!);

  // What to check against, strongest first: a head the operator anchored
  // elsewhere, then the store's own head marker, then nothing.
  const expectation = await resolveExpectation(args, dataDir, file);
  const verification = verifyChain(records, expectation.value ?? {});

  out(style.bold('Audit chain verification'));
  detail([
    ['source', file ?? `${dataDir}/audit.jsonl`],
    ['records', String(verification.recordsChecked)],
    ['checked against', expectation.describe],
    ['result', verification.valid ? style.green('INTACT') : style.red('BROKEN')],
  ]);
  out();

  if (!verification.valid) {
    table(
      ['sequence', 'problem', 'detail'],
      verification.failures.map((failure) => [String(failure.sequence), failure.problem, failure.detail]),
    );
    out();
    out(
      style.red(
        'The audit log has been altered. Treat every record at or after the first failure as untrustworthy.',
      ),
    );
    return 1;
  }

  if (verification.headDigest) {
    out(style.dim('Head digest — record this outside ARC Control, then pass it back with --expect-head'));
    out(`  ${verification.headDigest}  ${style.dim(`(sequence ${verification.headSequence})`)}`);
    out();
  }

  out(style.green('Every record matches its digest and links to its predecessor.'));

  if (!verification.checkedAgainstExpectation) {
    out();
    out(
      style.yellow(
        'Note: nothing was available to check the head against, so truncation would not\n' +
          '      have been detected — removing records from the end leaves a shorter chain\n' +
          '      that verifies. Anchor the head digest above and pass it as --expect-head.',
      ),
    );
  }

  return 0;
}

interface ResolvedExpectation {
  readonly value: ChainExpectation | undefined;
  readonly describe: string;
}

async function resolveExpectation(
  args: ParsedArgs,
  dataDir: string | undefined,
  file: string | undefined,
): Promise<ResolvedExpectation> {
  const expectedHead = flagString(args, 'expect-head');
  const expectedRecords = flagString(args, 'expect-records');

  if (expectedHead || expectedRecords) {
    const parsedCount = expectedRecords === undefined ? undefined : Number(expectedRecords);
    if (parsedCount !== undefined && (!Number.isInteger(parsedCount) || parsedCount < 0)) {
      throw new ArcError('invalid_request', '--expect-records must be a non-negative integer');
    }

    return {
      value: {
        ...(expectedHead ? { headDigest: expectedHead } : {}),
        ...(parsedCount !== undefined ? { headSequence: parsedCount } : {}),
      },
      describe: style.green('the head you supplied'),
    };
  }

  // The store's own marker is weaker than an external anchor — an attacker who
  // can rewrite the log can usually rewrite the marker beside it — but it
  // reliably catches the accidental case: a crash mid-write, a partial
  // restore, a rotation that dropped the tail.
  if (dataDir && !file) {
    const store = await FileStore.open(dataDir);
    try {
      const recorded = await store.recordedAuditHead();
      if (recorded) {
        return { value: recorded, describe: `the store's head marker ${style.dim('(audit.head.json)')}` };
      }
    } finally {
      await store.close();
    }
  }

  return { value: undefined, describe: style.yellow('itself only — truncation undetectable') };
}

export async function verifyEvidenceFile(args: ParsedArgs): Promise<number> {
  const file = flagString(args, 'file') ?? args.positional[0];
  if (!file) {
    out('usage: arc evidence verify <evidence.json>');
    out();
    out('Accepts one record, an array of records, or a JSONL export.');
    return 2;
  }

  const records = await readEvidence(file);
  if (records.length === 0) {
    out(style.red('no evidence records found'));
    return 2;
  }

  let failures = 0;
  const rows: string[][] = [];

  for (const record of records) {
    const valid = verifyEvidence(record);
    if (!valid) failures += 1;
    rows.push([
      record.id ?? '(no id)',
      record.tool?.name ?? '?',
      record.outcome ?? '?',
      valid ? style.green('verified') : style.red('ALTERED'),
    ]);
  }

  out(style.bold('Evidence verification'));
  detail([
    ['source', file],
    ['records', String(records.length)],
    ['result', failures === 0 ? style.green('ALL VERIFIED') : style.red(`${failures} ALTERED`)],
  ]);
  out();
  table(['evidence', 'tool', 'outcome', 'integrity'], rows);
  out();

  if (failures === 0) {
    out(style.green('Every record matches the digest computed over its own contents.'));
    return 0;
  }
  out(style.red('At least one record no longer matches its digest and cannot be relied upon.'));
  return 1;
}

async function readFromStore(dataDir: string): Promise<readonly AuditRecord[]> {
  const store = await FileStore.open(dataDir);
  try {
    return await store.audit.read();
  } finally {
    await store.close();
  }
}

async function readEvidence(file: string): Promise<EvidenceRecord[]> {
  const text = await readFile(file, 'utf8');
  const trimmed = text.trim();

  if (trimmed.startsWith('[')) return JSON.parse(trimmed) as EvidenceRecord[];
  if (trimmed.startsWith('{') && !trimmed.includes('}\n{')) {
    const parsed = JSON.parse(trimmed) as EvidenceRecord | { evidence: EvidenceRecord[] };
    if ('evidence' in parsed && Array.isArray(parsed.evidence)) return parsed.evidence;
    return [parsed as EvidenceRecord];
  }

  return parseJsonLines<EvidenceRecord>(text);
}

async function readJsonLines<T>(path: string): Promise<T[]> {
  return parseJsonLines<T>(await readFile(path, 'utf8'));
}

function parseJsonLines<T>(text: string): T[] {
  const records: T[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    records.push(JSON.parse(trimmed) as T);
  }
  return records;
}
