function EmptyChart({ title, yLabel }: { title: string; yLabel: string }) {
  return (
    <figure className="rounded-md border border-line p-4">
      <figcaption className="mb-3 text-[13px] font-semibold">{title}</figcaption>
      <svg role="img" aria-label={`${title}: no data source`} viewBox="0 0 400 160" className="h-40 w-full">
        <line x1="40" y1="10" x2="40" y2="130" stroke="var(--border-strong)" />
        <line x1="40" y1="130" x2="390" y2="130" stroke="var(--border-strong)" />
        {[40, 70, 100].map((y) => (
          <line key={y} x1="40" y1={y} x2="390" y2={y} stroke="var(--border)" strokeDasharray="3 4" />
        ))}
        <text x="10" y="74" fontSize="10" fill="var(--ink-soft)" transform="rotate(-90 10 74)" textAnchor="middle">
          {yLabel}
        </text>
        <text x="215" y="150" fontSize="10" fill="var(--ink-soft)" textAnchor="middle">
          time
        </text>
        <text x="215" y="76" fontSize="13" fill="var(--ink-soft)" textAnchor="middle">
          No data source
        </text>
      </svg>
    </figure>
  );
}

export function Trends() {
  return (
    <div className="grid grid-cols-3 gap-4">
      <EmptyChart title="Decisions over time" yLabel="actions" />
      <EmptyChart title="Approval wait time" yLabel="minutes" />
      <EmptyChart title="Execution latency" yLabel="ms" />
    </div>
  );
}
