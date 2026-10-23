import { useProto } from '../state/ProtoContext';
import { API_BASE, OPERATOR } from '../data/seed';
import { HealthDot } from './Badges';

/**
 * Masthead in layout(). Operator identity comes from ARC_OPERATOR_IDENTITY
 * (server.ts:15-20) and is a configured header, not a login (TRUST_MODEL.md).
 */
export function Masthead() {
  const { health } = useProto();
  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-6 border-b border-line bg-surface px-8">
      <p className="text-[13px] text-ink-soft">
        Acting as <span className="font-semibold text-ink">{OPERATOR.identity}</span>{' '}
        <span>(configured, not authenticated)</span>
      </p>
      <p className="flex items-center gap-3 text-[13px] text-ink-soft">
        <span>
          API <span className="mono text-ink">{API_BASE}</span>
        </span>
        <HealthDot status={health.status} />
        <span className="tnum">v{health.version}</span>
      </p>
    </header>
  );
}
