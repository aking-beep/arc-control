import { readFile } from 'node:fs/promises';
import { verifyEvidence } from '@arc-control/evidence';
import { verifyChain } from '@arc-control/audit';
import { FileStore } from '@arc-control/store';
import type { AuditRecord, EvidenceRecord } from '@arc-control/schemas';
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
    return 2;
  }

  const records = file ? await readJsonLines<AuditRecord>(file) : await readFromStore(dataDir!);
  const verification = verifyChain(records);

  out(style.bold('Audit chain verification'));
  detail([
    ['source', file ?? `${dataDir}/audit.jsonl`],
    ['records', String(verification.recordsChecked)],
    ['result', verification.valid ? style.green('INTACT') : style.red('BROKEN')],
  ]);
  out();

  if (verification.valid) {
    const head = records.at(-1);
    if (head) {
      out(style.dim('Head digest — anchor this outside ARC Control to make the chain tamper-proof'));
      out(`  ${head.digest}`);
      out();
    }
    out(style.green('Every record matches its digest and links to its predecessor.'));
    return 0;
  }

  table(
    ['sequence', 'problem', 'detail'],
    verification.failures.map((failure) => [String(failure.sequence), failure.problem, failure.detail]),
  );
  out();
  out(style.red('The audit log has been altered. Treat every record at or after the first failure as untrustworthy.'));
  return 1;
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
