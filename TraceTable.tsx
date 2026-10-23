import { Link } from 'react-router-dom';
import type { RuleTrace } from '../data/types';
import { EffectBadge } from './Badges';

/** traceTable(trace) — replaces trace JSON as the primary view. */
export function TraceTable({ trace }: { trace: RuleTrace[] }) {
  if (trace.length === 0) {
    return <p className="text-[13px] text-ink-soft">No policy matched this action, so no rule was examined. The engine default decided.</p>;
  }
  return (
    <div className="overflow-hidden rounded-md border border-line">
      <table className="dt compact">
        <caption className="sr-only">Decision trace: every rule the engine examined, in order</caption>
        <thead>
          <tr>
            <th scope="col">Policy</th>
            <th scope="col">Rule</th>
            <th scope="col">Result</th>
            <th scope="col">Effect</th>
          </tr>
        </thead>
        <tbody>
          {trace.map((row) => (
            <tr key={`${row.policyId}-${row.ruleId}`} className={row.matched ? '' : 'text-ink-soft'}>
              <td className="mono">
                <Link to={`/policies/${row.policyId}`} className="link">
                  {row.policyId}
                </Link>{' '}
                <span className="text-ink-soft">v{row.policyVersion}</span>
              </td>
              <td className="mono">{row.ruleId}</td>
              <td className={row.error ? 'text-failed' : row.matched ? 'font-semibold' : ''}>{row.error ? `error: ${row.error}` : row.matched ? 'matched' : 'not matched'}</td>
              <td>{row.effect ? <EffectBadge effect={row.effect} /> : <span>—</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
