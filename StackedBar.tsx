/** stackedBar(series) — inline SVG, role="img", with a visible data table beneath. */
export interface Segment {
  key: string;
  label: string;
  value: number;
  color: string;
}

export function StackedBar({ segments, summary }: { segments: Segment[]; summary: string }) {
  const total = segments.reduce((s, x) => s + x.value, 0) || 1;
  let x = 0;
  return (
    <svg role="img" aria-label={summary} viewBox="0 0 1000 36" preserveAspectRatio="none" className="h-9 w-full overflow-hidden rounded-md">
      <rect width="1000" height="36" fill="var(--surface-sunk)" />
      {segments
        .filter((s) => s.value > 0)
        .map((s) => {
          const w = (s.value / total) * 1000;
          const el = (
            <g key={s.key}>
              <rect x={x} width={w} height="36" fill={s.color} />
              {x > 0 && <rect x={x} width="2" height="36" fill="var(--surface)" />}
            </g>
          );
          x += w;
          return el;
        })}
    </svg>
  );
}
