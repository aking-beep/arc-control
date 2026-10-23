import type { ReactNode } from 'react';
import type { EvidenceRecord } from '../data/types';
import { timeMs } from '../lib/format';
import { EffectBadge } from './Badges';

/**
 * evidenceTimeline(record) — nodes come only from fields that exist. A stage
 * with no data is drawn hollow and labelled.
 */
export function EvidenceTimeline({ record }: { record: EvidenceRecord }) {
  const d = record.decision;
  const notExecutedReason =
    record.outcome === 'denied'
      ? 'not executed: denied'
      : record.outcome === 'pending_approval'
        ? 'not executed: waiting on approval'
        : record.outcome === 'rejected'
          ? 'not executed: rejected'
          : record.outcome === 'expired'
            ? 'not executed: approval expired'
            : 'not executed';

  const stages: { title: string; filled: boolean; tone?: 'deny' | 'approval' | 'allow'; time?: string; body: ReactNode }[] = [
    {
      title: 'Requested',
      filled: true,
      time: timeMs(record.request.requestedAt),
      body: (
        <>
          {record.agent.name} → <span className="mono">{record.tool.name}</span>
          {record.request.correlationId && <div className="mono text-ink-soft">correlation {record.request.correlationId}</div>}
        </>
      ),
    },
    {
      title: 'Decided',
      filled: true,
      tone: d.effect === 'DENY' ? 'deny' : d.effect === 'ALLOW' ? 'allow' : 'approval',
      time: `+${d.evaluationMs} ms`,
      body: (
        <>
          <EffectBadge effect={d.effect} />{' '}
          {d.policyId ? (
            <span className="mono">
              {d.policyId} v{d.policyVersion} · {d.ruleId}
            </span>
          ) : (
            <span className="text-ink-soft">engine default</span>
          )}
          <div className="text-ink-soft">{d.reason}</div>
        </>
      ),
    },
    record.approval
      ? {
          title: 'Approval',
          filled: record.approval.status !== 'pending',
          tone: record.approval.status === 'approved' ? 'allow' : record.approval.status === 'pending' ? 'approval' : 'deny',
          time: record.approval.resolvedAt ? timeMs(record.approval.resolvedAt) : undefined,
          body: (
            <>
              {record.approval.status} · {record.approval.votes.length} of {record.approval.minApprovals} required vote(s)
              {record.approval.votes.map((v) => (
                <div key={v.votedAt} className="text-ink-soft">
                  {v.approver} voted {v.vote}
                </div>
              ))}
            </>
          ),
        }
      : { title: 'Approval', filled: false, body: <span className="text-ink-soft">not required</span> },
    record.execution
      ? {
          title: 'Executed',
          filled: true,
          tone: record.execution.status === 'failed' ? 'deny' : 'allow',
          time: timeMs(record.execution.finishedAt),
          body: (
            <>
              <span className="tnum">{record.execution.durationMs} ms</span> · {record.execution.status === 'succeeded' ? 'ok' : 'failed'} via{' '}
              <span className="mono">{record.execution.connector}</span>
              {record.execution.error && (
                <div className="text-failed">
                  {record.execution.error.code}: {record.execution.error.message}
                </div>
              )}
            </>
          ),
        }
      : { title: 'Executed', filled: false, body: <span className="text-ink-soft">{notExecutedReason}</span> },
  ];

  return (
    <ol aria-label="Timeline">
      {stages.map((stage, index) => {
        const color = stage.tone === 'deny' ? 'border-deny bg-deny' : stage.tone === 'approval' ? 'border-approval bg-approval' : stage.tone === 'allow' ? 'border-allow bg-allow' : 'border-ink bg-ink';
        return (
          <li key={stage.title} className="relative grid grid-cols-[20px_1fr] gap-3 pb-5">
            {index < stages.length - 1 && <span aria-hidden className="absolute bottom-0 left-[9px] top-4 w-px bg-line-strong" />}
            <span aria-hidden className={`relative mt-1 h-[11px] w-[11px] justify-self-center rounded-full border-2 ${stage.filled ? color : 'border-line-strong bg-surface'}`} />
            <div className="text-[13px]">
              <div className="flex items-baseline justify-between gap-3">
                <span className={`font-semibold ${stage.filled ? '' : 'text-ink-soft'}`}>
                  {stage.title}
                  {!stage.filled && <span className="sr-only"> (no data)</span>}
                </span>
                {stage.time && <span className="mono tnum text-ink-soft">{stage.time}</span>}
              </div>
              <div className="mt-0.5">{stage.body}</div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
