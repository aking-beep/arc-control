import type { PolicyMatch } from '../data/types';

/** scopeChips(match) — an omitted selector matches everything. */
export function ScopeChips({ match }: { match: PolicyMatch }) {
  const entries = Object.entries(match).filter(([, v]) => v && v.length > 0) as [string, string[]][];
  if (entries.length === 0) return <span className="text-[13px] text-ink-soft">Applies to every action</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {entries.flatMap(([key, values]) =>
        values.map((value) => (
          <span key={`${key}-${value}`} className="inline-flex h-[22px] items-center rounded border border-line-strong bg-sunk px-1.5 text-[12px]">
            <span className="text-ink-soft">{key}:</span>
            <span className="mono ml-1 text-ink">{value}</span>
          </span>
        )),
      )}
    </span>
  );
}

/** labelTags(labels) — `control: SOX-302` reads as a control tag. */
export function ControlTags({ labels }: { labels?: Record<string, string> }) {
  if (!labels || Object.keys(labels).length === 0) return null;
  return (
    <span className="inline-flex flex-wrap gap-1.5">
      {Object.entries(labels).map(([key, value]) => (
        <span
          key={key}
          className={`inline-flex h-[22px] items-center rounded px-1.5 text-[12px] ${key === 'control' ? 'bg-ink font-semibold text-bg' : 'border border-line text-ink-soft'}`}
        >
          {key === 'control' ? value : `${key}=${value}`}
        </span>
      ))}
    </span>
  );
}
