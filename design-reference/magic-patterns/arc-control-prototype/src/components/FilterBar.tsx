import { Link } from 'react-router-dom';

/** filterLinks(param, options, current) — query-string links, aria-current on the active one. */
export function FilterBar({
  label,
  options,
  current,
  hrefFor,
}: {
  label: string;
  options: { value: string; label: string; count?: number }[];
  current: string;
  hrefFor: (value: string) => string;
}) {
  return (
    <nav aria-label={label} className="flex flex-wrap items-center gap-1">
      <span className="mr-2 text-[12px] font-semibold text-ink-soft">{label}</span>
      {options.map((option) => {
        const active = option.value === current;
        return (
          <Link
            key={option.value || 'all'}
            to={hrefFor(option.value)}
            aria-current={active ? 'true' : undefined}
            className={`btn inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-md border px-2.5 text-[13px] ${
              active ? 'border-ink bg-ink text-bg' : 'border-line bg-surface text-ink hover:border-line-strong hover:bg-sunk'
            }`}
          >
            {option.label}
            {option.count !== undefined && <span className={`tnum text-[12px] ${active ? 'opacity-80' : 'text-ink-soft'}`}>{option.count}</span>}
          </Link>
        );
      })}
    </nav>
  );
}
