import type { ReactNode } from 'react';

/** Fixed banner on every concept frame (plan §12). */
export function ConceptFrame({ title, why, roadmap, children }: { title: string; why: string; roadmap: string; children: ReactNode }) {
  return (
    <section aria-labelledby={title} className="overflow-hidden rounded-lg border border-line bg-surface">
      <div className="flex items-center gap-3 border-b border-proto/30 bg-proto-bg px-5 py-2.5 text-[13px] text-proto">
        <span className="rounded border border-proto/50 px-1.5 font-mono text-[11px] font-semibold">PROPOSED</span>
        <span>Requires backend work not in the repository ({roadmap}). Shows no data.</span>
      </div>
      <div className="px-6 pb-6 pt-5">
        <h2 id={title} className="text-[18px] font-[650]">
          {title}
        </h2>
        <p className="mt-1 text-[13px] text-ink-soft">Why it is not buildable now: {why}</p>
        <div className="mt-5">{children}</div>
      </div>
    </section>
  );
}

/** Empty-state placeholder used inside every frame. */
export function NoSource({ children = 'No data source' }: { children?: ReactNode }) {
  return (
    <div className="flex h-full min-h-[96px] items-center justify-center rounded-md border border-dashed border-line-strong bg-sunk/60 px-4 text-center text-[13px] text-ink-soft">
      {children}
    </div>
  );
}

export function Slot({ label, wide }: { label: string; wide?: boolean }) {
  return (
    <div className={wide ? 'col-span-2' : ''}>
      <div className="mb-1 text-[12px] font-semibold text-ink-soft">{label}</div>
      <div className="h-8 rounded-md border border-line-strong bg-sunk/60" aria-hidden />
    </div>
  );
}
