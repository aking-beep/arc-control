import type { Status } from '../data/mapping';

/** Canvas-only label for the plan's status vocabulary. */
export function StatusTag({ status }: { status: Status }) {
  const tone =
    status === 'IMPLEMENTED' ? 'border-line-strong text-ink-soft' : status === 'API-ONLY' ? 'border-info/40 text-info' : 'border-proto/40 text-proto';
  return <span className={`inline-flex h-[18px] items-center rounded border px-1.5 font-mono text-[10.5px] font-semibold ${tone}`}>{status}</span>;
}
