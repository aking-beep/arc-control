import type { ReactNode } from 'react';
import type { Effect, FindingSeverity } from '../data/types';
import { outcomeLabel } from '../lib/format';

/**
 * Badge helpers from render.ts. Every badge carries text, so meaning never
 * depends on colour alone, and keeps a 1px border for greyscale print.
 */

type Tone = 'allow' | 'deny' | 'approval' | 'failed' | 'info' | 'muted';

const TONE: Record<Tone, string> = {
  allow: 'bg-allow-bg text-allow border-allow/30',
  deny: 'bg-deny-bg text-deny border-deny/30',
  approval: 'bg-approval-bg text-approval border-approval/30',
  failed: 'bg-failed-bg text-failed border-failed/30',
  info: 'bg-info-bg text-info border-info/30',
  muted: 'bg-sunk text-ink-soft border-line-strong',
};

export function Badge({ tone, children, mono }: { tone: Tone; children: ReactNode; mono?: boolean }) {
  return (
    <span
      className={`inline-flex h-[20px] items-center whitespace-nowrap rounded-full border px-2 text-[11.5px] font-semibold leading-none ${TONE[tone]} ${mono ? 'font-mono' : ''}`}
    >
      {children}
    </span>
  );
}

/** effectBadge() */
export function EffectBadge({ effect }: { effect: Effect | string }) {
  const tone: Tone = effect === 'ALLOW' ? 'allow' : effect === 'DENY' ? 'deny' : effect === 'REQUIRE_APPROVAL' ? 'approval' : 'muted';
  return <Badge tone={tone}>{effect || '—'}</Badge>;
}

/** outcomeBadge() — all 8 ActionOutcome values. */
export const OUTCOME_TONE: Record<string, Tone> = {
  allowed: 'allow',
  executed: 'allow',
  approved: 'allow',
  pending_approval: 'approval',
  denied: 'deny',
  failed: 'failed',
  rejected: 'muted',
  expired: 'muted',
};

export function OutcomeBadge({ outcome }: { outcome: string }) {
  return <Badge tone={OUTCOME_TONE[outcome] ?? 'muted'}>{outcomeLabel(outcome)}</Badge>;
}

/** riskBadge() */
export function RiskBadge({ tier }: { tier?: string }) {
  if (!tier) return <span className="text-ink-soft">—</span>;
  const tone: Tone = tier === 'critical' ? 'deny' : tier === 'high' ? 'failed' : tier === 'medium' ? 'approval' : 'muted';
  return <Badge tone={tone}>{tier}</Badge>;
}

/** severityBadge() — new; values from mcp-security FindingSeverity. */
export function SeverityBadge({ severity }: { severity: FindingSeverity }) {
  const tone: Tone = severity === 'critical' ? 'deny' : severity === 'high' ? 'failed' : severity === 'medium' ? 'approval' : 'muted';
  return <Badge tone={tone}>{severity}</Badge>;
}

/** statusDot() — new. Dot plus text, never the dot alone. */
export function StatusDot({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap text-[13px] ${ok ? 'text-ink' : 'text-deny'}`}>
      <span aria-hidden className={`h-2 w-2 rounded-full ${ok ? 'bg-allow' : 'bg-deny'}`} />
      {label}
    </span>
  );
}

/** healthIndicator(status) — new. */
export function HealthDot({ status }: { status: 'ok' | 'degraded' }) {
  return (
    <span className={`inline-flex items-center gap-1.5 font-semibold ${status === 'ok' ? 'text-allow' : 'text-failed'}`}>
      <span aria-hidden className={`h-2 w-2 rounded-full ${status === 'ok' ? 'bg-allow' : 'bg-failed'}`} />
      {status}
    </span>
  );
}

/** Effect as a single letter for the matrix, with the full word for AT. */
export function EffectLetter({ effect }: { effect: Effect }) {
  const letter = effect === 'ALLOW' ? 'A' : effect === 'DENY' ? 'D' : 'R';
  const tone = effect === 'ALLOW' ? 'text-allow' : effect === 'DENY' ? 'text-deny' : 'text-approval';
  return (
    <span className={`font-mono text-[12px] font-bold ${tone}`} title={effect}>
      {letter}
      <span className="sr-only"> {effect}</span>
    </span>
  );
}
