import { Link, useNavigate } from 'react-router-dom';
import type { EvidenceRecord } from '../data/types';
import { shortId, timestamp } from '../lib/format';
import { EffectBadge, OutcomeBadge } from './Badges';

/**
 * Evidence rows used on Overview (S2), Evidence (S7) and Agent detail (S4a).
 * Every identifier links to its own page (plan §3 cross-linking rule).
 */
export function EvidenceTable({ records, caption, hideAgent }: { records: EvidenceRecord[]; caption: string; hideAgent?: boolean }) {
  const navigate = useNavigate();
  return (
    <div className="overflow-x-auto rounded-lg border border-line bg-surface">
      <table className="dt">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">When (UTC)</th>
            {!hideAgent && <th scope="col">Agent</th>}
            <th scope="col">Tool</th>
            <th scope="col">Decision</th>
            <th scope="col">Outcome</th>
            <th scope="col">Execution</th>
            <th scope="col">Policy · rule</th>
            <th scope="col">Evidence</th>
          </tr>
        </thead>
        <tbody>
          {records.map((record) => (
            <tr key={record.id} className="row-link cursor-pointer" onClick={() => navigate(`/evidence/${record.id}`)}>
              <td className="mono tnum whitespace-nowrap text-ink-soft">{timestamp(record.createdAt)}</td>
              {!hideAgent && (
                <td>
                  <Link to={`/agents/${record.agent.id}`} className="link" onClick={(e) => e.stopPropagation()}>
                    {record.agent.name}
                  </Link>
                </td>
              )}
              <td className="mono whitespace-nowrap">{record.tool.name}</td>
              <td>
                <EffectBadge effect={record.decision.effect} />
              </td>
              <td>
                <OutcomeBadge outcome={record.outcome} />
              </td>
              <td className="tnum whitespace-nowrap text-[13px]">
                {record.execution ? (
                  <span className={record.execution.status === 'failed' ? 'text-failed' : ''}>
                    {record.execution.status === 'succeeded' ? 'ok' : 'failed'} · {record.execution.durationMs} ms
                  </span>
                ) : (
                  <span className="text-ink-soft">not executed</span>
                )}
              </td>
              <td className="mono whitespace-nowrap">
                {record.decision.policyId ? (
                  <Link to={`/policies/${record.decision.policyId}`} className="link" onClick={(e) => e.stopPropagation()}>
                    {record.decision.policyId}
                    <span className="text-ink-soft"> · {record.decision.ruleId}</span>
                  </Link>
                ) : (
                  <span className="text-ink-soft">engine default</span>
                )}
              </td>
              <td className="mono whitespace-nowrap">
                <Link to={`/evidence/${record.id}`} title={record.id} className="link" onClick={(e) => e.stopPropagation()}>
                  {shortId(record.id)}
                  <span className="sr-only">{record.id}</span>
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
