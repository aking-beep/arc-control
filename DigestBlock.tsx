/** digestBlock(label, value) — select-all mono block, no clipboard API. */
export function DigestBlock({ label, value, note }: { label: string; value?: string; note?: string }) {
  return (
    <div className="grid grid-cols-[150px_1fr] gap-3 py-1.5 text-[13px]">
      <div>
        <div className="mono text-ink-soft">{label}</div>
        {note && <div className="text-[11.5px] text-ink-soft">{note}</div>}
      </div>
      <code className="mono digest rounded bg-sunk px-2 py-1 text-ink">{value ?? '—'}</code>
    </div>
  );
}
