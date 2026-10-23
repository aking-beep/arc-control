/** render.ts `timestamp()`: ISO in UTC, `2026-10-20 05:39:26Z`. */
export function timestamp(iso?: string): string {
  if (!iso) return '—';
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}Z`;
}

/** Time only, with milliseconds, for timelines. */
export function timeMs(iso?: string): string {
  if (!iso) return '—';
  return `${iso.slice(11, 23)}Z`;
}

/** Truncated id, full value kept for `title` (plan §11). */
export function shortId(id: string, keep = 14): string {
  return id.length > keep ? `${id.slice(0, keep)}…` : id;
}

export function shortDigest(digest?: string): string {
  if (!digest) return '—';
  return `${digest.slice(7, 19)}…`;
}

export function money(value: unknown): string {
  const amount = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(amount)) return String(value);
  return amount.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

export function formatValue(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

/** Prototype clock: the seed's demo moment, so expiry reads sensibly. */
export const PROTO_NOW = new Date('2026-10-20T05:59:40Z').getTime();

export function expiresIn(iso: string): string {
  const ms = new Date(iso).getTime() - PROTO_NOW;
  if (ms <= 0) return 'expired';
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `expires in ${minutes} min`;
  return `expires in ${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

export function outcomeLabel(outcome: string): string {
  return outcome.replace(/_/g, ' ');
}
