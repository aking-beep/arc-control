import type { Policy } from '../data/types';
import { EffectBadge } from './Badges';
import { ConditionInline } from './ConditionInline';
import { RequirementLine } from './RequirementLine';

/**
 * ruleLadder(policy) — rules in evaluation order, first match within a
 * policy decides; the fallback is the last rung. Across policies the
 * strictest effect wins.
 */
export function DecisionLadder({ policy, highlightRule }: { policy: Policy; highlightRule?: string }) {
  return (
    <ol className="relative">
      {policy.rules.map((rule, index) => (
        <li
          key={rule.id}
          className={`grid grid-cols-[28px_150px_1fr_auto] items-start gap-3 border-b border-line py-3 ${highlightRule === rule.id ? 'bg-sunk' : ''}`}
        >
          <span className="tnum pt-0.5 text-center text-[12px] font-semibold text-ink-soft" aria-label={`Rule ${index + 1}`}>
            {index + 1}
          </span>
          <span className="mono pt-0.5 font-semibold">{rule.id}</span>
          <div className="min-w-0 text-[13px]">
            <p>
              <span className="text-ink-soft">when</span> <ConditionInline condition={rule.when} />
            </p>
            <p className="mt-1 text-ink-soft">{rule.reason}</p>
            {rule.description && <p className="mt-0.5 text-[12px] text-ink-soft">{rule.description}</p>}
            {rule.approval && (
              <p className="mt-1.5">
                <span className="text-ink-soft">needs </span>
                <RequirementLine requirement={rule.approval} compact />
              </p>
            )}
            {rule.obligations && rule.obligations.length > 0 && (
              <p className="mono mt-1 text-ink-soft">obligations: {rule.obligations.join(', ')}</p>
            )}
          </div>
          <EffectBadge effect={rule.effect} />
        </li>
      ))}
      <li className="grid grid-cols-[28px_150px_1fr_auto] items-start gap-3 py-3">
        <span aria-hidden className="pt-0.5 text-center text-[12px] text-ink-soft">
          ↳
        </span>
        <span className="pt-0.5 font-semibold text-ink-soft">Fallback</span>
        <p className="text-[13px] text-ink-soft">
          if no rule matched: {policy.fallback.reason}
        </p>
        <EffectBadge effect={policy.fallback.effect} />
      </li>
    </ol>
  );
}
