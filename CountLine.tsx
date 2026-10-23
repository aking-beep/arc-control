import { Link } from 'react-router-dom';

/** countLine(counts) — replaces the .stats tiles with one quiet line. */
export function CountLine({ items }: { items: { value: number; label: string; to?: string }[] }) {
  return (
    <p className="flex flex-wrap items-center gap-x-1 text-[14px] text-ink-soft">
      {items.map((item, index) => (
        <span key={item.label} className="inline-flex items-center gap-1">
          {index > 0 && <span aria-hidden className="mx-1.5">·</span>}
          {item.to ? (
            <Link to={item.to} className="link">
              <span className="tnum font-semibold">{item.value.toLocaleString('en-US')}</span> {item.label}
            </Link>
          ) : (
            <span>
              <span className="tnum font-semibold text-ink">{item.value.toLocaleString('en-US')}</span> {item.label}
            </span>
          )}
        </span>
      ))}
    </p>
  );
}
