import { randomBytes } from 'node:crypto';

/**
 * Every durable ARC Control object carries a prefixed, opaque identifier. The
 * prefix makes identifiers self-describing in logs, audit records and support
 * tickets: `arc_ev_82f3...` is unambiguously an evidence record.
 */
export const ID_PREFIXES = {
  agent: 'arc_ag',
  tool: 'arc_tl',
  policy: 'arc_pl',
  action: 'arc_act',
  decision: 'arc_dec',
  approval: 'arc_apr',
  execution: 'arc_exe',
  evidence: 'arc_ev',
  audit: 'arc_aud',
  credential: 'arc_cred',
  request: 'arc_req',
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

/** Number of random bytes behind each identifier. 16 bytes = 128 bits. */
const ID_BYTES = 16;

export function newId(kind: IdKind): string {
  return `${ID_PREFIXES[kind]}_${randomBytes(ID_BYTES).toString('hex')}`;
}

export function isId(kind: IdKind, value: unknown): value is string {
  return typeof value === 'string' && new RegExp(`^${ID_PREFIXES[kind]}_[0-9a-f]{${ID_BYTES * 2}}$`).test(value);
}

/** Shortens an identifier for display: `arc_ev_82f3a1...`. */
export function shortId(id: string): string {
  const underscore = id.lastIndexOf('_');
  if (underscore === -1 || id.length - underscore <= 7) return id;
  return `${id.slice(0, underscore + 7)}...`;
}
