import { createHash } from 'node:crypto';

/**
 * Canonical JSON serialization. Two structurally equal values always produce
 * the same string, so hashes over policy documents, action parameters and
 * audit records are stable across processes, languages and key insertion
 * order. Object keys are sorted; `undefined` members are dropped.
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(toCanonical(value));
}

function toCanonical(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new TypeError('cannot canonicalize a non-finite number');
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(toCanonical);
  if (value instanceof Date) return value.toISOString();

  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    if (source[key] === undefined) continue;
    out[key] = toCanonical(source[key]);
  }
  return out;
}

/** `sha256:<hex>` digest over the canonical form of a value. */
export function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalize(value), 'utf8').digest('hex')}`;
}

/** `sha256:<hex>` digest over raw text — used for the audit hash chain. */
export function digestText(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}
