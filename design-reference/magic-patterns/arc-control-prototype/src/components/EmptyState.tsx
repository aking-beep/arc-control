import type { ReactNode } from 'react';
/** emptyState() in render.ts. */
export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="rounded-lg border border-dashed border-line-strong px-4 py-6 text-center text-[14px] text-ink-soft">{children}</p>;
}
