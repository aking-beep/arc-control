export function DelegationChain() {
  const nodes = ['Human principal', 'Delegating agent', 'Acting agent', 'Tool'];
  return (
    <div>
      <ol className="flex items-center gap-2">
        {nodes.map((n, i) => (
          <li key={n} className="flex items-center gap-2">
            <div className="w-48 rounded-md border border-dashed border-line-strong bg-sunk/60 px-3 py-3">
              <div className="text-[12px] font-semibold text-ink-soft">{n}</div>
              <div className="mt-2 h-3 w-28 rounded bg-line" aria-hidden />
            </div>
            {i < nodes.length - 1 && (
              <span aria-hidden className="text-ink-soft">
                →
              </span>
            )}
          </li>
        ))}
      </ol>
      <p className="mt-3 text-[13px] text-ink-soft">Would sit on Evidence detail above the timeline. No data source: delegatedFrom is never populated.</p>
    </div>
  );
}
