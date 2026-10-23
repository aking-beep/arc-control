import type { ReactNode } from 'react';

/** Page title + one-line lede + page-level actions (plan §3 shell). */
export function PageHeader({ title, lede, actions, display }: { title: ReactNode; lede?: ReactNode; actions?: ReactNode; display?: boolean }) {
  return (
    <div className="mb-6 flex items-start justify-between gap-8 border-b border-line pb-5">
      <div className="min-w-0">
        <h1 className={display ? 'text-[28px] font-[650] leading-[1.2] tracking-tight' : 'text-[22px] font-[650] leading-[1.3] tracking-tight'}>{title}</h1>
        {lede && <p className="mt-1.5 max-w-[78ch] text-[15px] leading-[1.55] text-ink-soft">{lede}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export function SectionTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mb-3 mt-8 flex items-baseline justify-between gap-4">
      <h2 className="text-[16px] font-[650]">{children}</h2>
      {aside && <div className="text-[13px]">{aside}</div>}
    </div>
  );
}
