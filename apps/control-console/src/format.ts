/**
 * Pure formatting for the console. Nothing here reaches the network or the
 * DOM, so every one of these is directly testable.
 *
 * Ported from the Magic Patterns prototype's `src/lib/` (`format.ts`,
 * `conditionText.ts`, `actionHeadline.ts`). The prototype's `digest.ts` is
 * deliberately not ported: it fabricates digests for the canvas, and every
 * digest the console shows comes from the API.
 */

import type { Condition, Operand } from '@arc-control/schemas';

/** ISO timestamp in UTC, `2026-10-20 05:39:26Z`. Unambiguous in an audit export. */
export function timestamp(iso: unknown): string {
  if (typeof iso !== 'string' || iso.length < 19) return '—';
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}Z`;
}

/** Time of day with milliseconds, for timelines where ordering is the point. */
export function timeMs(iso: unknown): string {
  if (typeof iso !== 'string' || iso.length < 19) return '—';
  return `${iso.slice(11, 23)}Z`;
}

/** Truncated identifier. Callers keep the full value in a `title`. */
export function shortId(id: unknown, keep = 14): string {
  const text = String(id ?? '');
  return text.length > keep ? `${text.slice(0, keep)}…` : text;
}

/** `sha256:ab12cd34ef56…` — enough to compare two digests by eye. */
export function shortDigest(digest: unknown): string {
  const text = String(digest ?? '');
  if (!text) return '—';
  return text.startsWith('sha256:') ? `${text.slice(7, 19)}…` : shortId(text, 12);
}

export function outcomeLabel(outcome: unknown): string {
  return String(outcome ?? '').replace(/_/g, ' ') || '—';
}

export function money(value: unknown): string {
  const amount = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(amount)) return String(value);
  return amount.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

export function count(value: unknown): string {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed.toLocaleString('en-US') : '0';
}

/** A parameter value as recorded. Objects and arrays stay JSON. */
export function formatValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '—';
  return JSON.stringify(value) ?? 'null';
}

/**
 * How long an approval request has left, relative to now.
 *
 * Returns `expired` once the window has closed. The approvals engine is what
 * actually expires a request; this is only the reading of the clock.
 */
export function expiresIn(iso: unknown, now: number = Date.now()): string {
  if (typeof iso !== 'string') return '—';
  const ms = new Date(iso).getTime() - now;
  if (Number.isNaN(ms)) return '—';
  if (ms <= 0) return 'expired';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `expires in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `expires in ${hours} h ${minutes % 60} min`;
  return `expires in ${Math.floor(hours / 24)} days`;
}

/** `agent.suspended` → `agent`. Groups audit events into families. */
export function eventFamily(type: unknown): string {
  return String(type ?? '').split('.')[0] ?? '';
}

// --- the action headline --------------------------------------------------

export interface ActionHeadline {
  readonly verb: string;
  readonly strong?: string;
  readonly rest?: string;
}

/**
 * A one-line description of what an agent asked to do.
 *
 * Built only from the tool name and the already-redacted recorded parameters,
 * with no inference: an approver reading "Refund $1,840.00 to cus_Nx8..." is
 * reading the parameters back, not a summary someone wrote. A tool with no
 * template falls back to its own name rather than guessing.
 */
export function actionHeadline(tool: unknown, parameters: unknown): ActionHeadline {
  const name = String(tool ?? '');
  const params = (parameters ?? {}) as Record<string, unknown>;

  if (name === 'stripe.refund' && params.amount !== undefined && params.customer !== undefined) {
    return { verb: 'Refund', strong: money(params.amount), rest: `to ${String(params.customer)}` };
  }
  if (name === 'stripe.get_charge' && params.chargeId !== undefined) {
    return { verb: 'Read charge', strong: String(params.chargeId) };
  }
  if (name === 'github.create_issue' && params.repository !== undefined) {
    return { verb: 'Open an issue on', strong: String(params.repository) };
  }
  return { verb: name || 'Action' };
}

// --- conditions as sentences ----------------------------------------------

/**
 * Renders a policy `Condition` as a sentence without changing its meaning.
 *
 * Covers all 17 operators in `@arc-control/schemas`. Reference paths are
 * shortened for reading (`$.action.parameters.amount` → `amount`), which loses
 * nothing an operator needs because every caller keeps the raw JSON one click
 * or one `title` away. An unrecognised shape falls back to its JSON rather
 * than being described approximately.
 */
export function conditionToText(condition: unknown): string {
  if (typeof condition !== 'object' || condition === null) return JSON.stringify(condition) ?? '—';
  const node = condition as Record<string, unknown>;

  if ('always' in node) return 'always';
  if ('and' in node && Array.isArray(node.and)) return node.and.map(wrap).join(' and ');
  if ('or' in node && Array.isArray(node.or)) return node.or.map(wrap).join(' or ');
  if ('not' in node) return `not (${conditionToText(node.not)})`;
  if ('exists' in node) return `${operand(node.exists as Operand)} is present`;

  const entry = Object.entries(node)[0];
  if (!entry) return '—';
  const [op, value] = entry;
  if (!Array.isArray(value) || value.length < 2) return JSON.stringify(condition) ?? '—';

  const left = operand(value[0] as Operand);
  const right = operand(value[1] as Operand);

  switch (op) {
    case 'eq':
      return `${left} = ${right}`;
    case 'ne':
      return `${left} ≠ ${right}`;
    case 'gt':
      return `${left} > ${right}`;
    case 'gte':
      return `${left} ≥ ${right}`;
    case 'lt':
      return `${left} < ${right}`;
    case 'lte':
      return `${left} ≤ ${right}`;
    case 'in':
      return `${left} is one of ${right}`;
    case 'nin':
      return `${left} is none of ${right}`;
    case 'contains':
      return `${left} contains ${right}`;
    case 'startsWith':
      return `${left} starts with ${right}`;
    case 'endsWith':
      return `${left} ends with ${right}`;
    case 'matches':
      return `${left} matches /${String(value[1])}/`;
    default:
      return JSON.stringify(condition) ?? '—';
  }
}

function wrap(condition: unknown): string {
  const text = conditionToText(condition);
  const node = (condition ?? {}) as Record<string, unknown>;
  return 'and' in node || 'or' in node ? `(${text})` : text;
}

function operand(value: Operand | unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => operand(item)).join(', ')}]`;
  if (typeof value === 'string') {
    if (value.startsWith('$.')) return shortPath(value);
    return `"${value}"`;
  }
  return String(value);
}

function shortPath(path: string): string {
  return path.replace(/^\$\.action\.parameters\./, '').replace(/^\$\./, '');
}

/** Approver selector in words: `role:finance-manager` → `role finance-manager`. */
export function describeApprover(selector: unknown): string {
  const text = String(selector ?? '');
  if (text.startsWith('role:')) return `role ${text.slice(5)}`;
  if (text.startsWith('user:')) return text.slice(5);
  if (text === 'owner') return 'the agent owner';
  return text;
}

export type { Condition };
