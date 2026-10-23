import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useProto } from '../state/ProtoContext';
import { PageHeader, SectionTitle } from '../components/PageHeader';
import { CountLine } from '../components/CountLine';
import { EvidenceTable } from '../components/EvidenceTable';
import { EmptyState } from '../components/EmptyState';
import { HealthDot } from '../components/Badges';
import { shortDigest, timestamp } from '../lib/format';

/** S2 — "does anything need me?" (overviewPage, pages.ts:49-106). */
export function Overview() {
  const { approvals, verification, health, evidence } = useProto();
  const pending = approvals.filter((a) => a.status === 'pending');
  const unhealthy = health.connectors.filter((c) => !c.healthy);
  const oldestExpiry = pending.map((a) => a.expiresAt).sort()[0];

  const items: { tone: 'deny' | 'approval' | 'ok'; body: ReactNode; to: string; cta: string }[] = [];

  if (!verification.valid) {
    items.push({
      tone: 'deny',
      body: (
        <>
          <strong>Audit chain BROKEN</strong> · {verification.failures.length} problem(s) in {verification.recordsChecked} records, first at
          sequence <span className="tnum">{verification.failures[0]?.sequence}</span> ({verification.failures[0]?.problem})
        </>
      ),
      to: '/audit',
      cta: 'Audit',
    });
  }
  if (pending.length > 0) {
    items.push({
      tone: 'approval',
      body: (
        <>
          <strong className="tnum">{pending.length}</strong> approval{pending.length === 1 ? '' : 's'} pending · oldest expires{' '}
          <span className="mono">{timestamp(oldestExpiry)}</span>
        </>
      ),
      to: '/approvals',
      cta: 'Review approvals',
    });
  }
  for (const connector of unhealthy) {
    items.push({
      tone: 'deny',
      body: (
        <>
          Connector <span className="mono font-semibold">{connector.name}</span> unhealthy: “{connector.detail}”
        </>
      ),
      to: '/security',
      cta: 'Security',
    });
  }

  return (
    <>
      <PageHeader
        title="Overview"
        lede="Every action an agent attempted, whether it was allowed, held for a human or refused. A denial is recorded as durably as an execution: the attempt is itself the signal."
      />

      <section aria-labelledby="attention">
        <h2 id="attention" className="mb-3 text-[16px] font-[650]">
          Needs attention
        </h2>
        {items.length === 0 ? (
          <p className="rounded-lg border border-line bg-surface px-5 py-4 text-[15px]">Nothing is waiting on you.</p>
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
            {items.map((item, index) => (
              <li key={index} className="flex items-center gap-4 px-5 py-3.5">
                <span aria-hidden className={`h-8 w-[3px] shrink-0 rounded ${item.tone === 'deny' ? 'bg-deny' : 'bg-approval'}`} />
                <p className={`min-w-0 flex-1 text-[15px] ${item.tone === 'deny' ? 'text-deny' : ''}`}>{item.body}</p>
                <Link to={item.to} className="link shrink-0 whitespace-nowrap text-[14px] font-semibold">
                  {item.cta} →
                </Link>
              </li>
            ))}
          </ul>
        )}
        {verification.valid && (
          <p className="mt-3 text-[13px] text-ink-soft">
            Audit chain <span className="font-semibold text-allow">intact</span> · {verification.recordsChecked} records · head{' '}
            <span className="mono" title={verification.headDigest}>
              {shortDigest(verification.headDigest)}
            </span>{' '}
            · checked against itself only, see{' '}
            <Link to="/audit" className="link">
              Audit
            </Link>
          </p>
        )}
      </section>

      <div className="mt-6 flex items-center justify-between border-y border-line py-3">
        <CountLine
          items={[
            { value: health.counts.agents, label: 'agents', to: '/agents' },
            { value: health.counts.tools, label: 'tools', to: '/tools' },
            { value: health.counts.policies, label: 'policies', to: '/policies' },
            { value: health.counts.auditRecords, label: 'audit records', to: '/audit' },
          ]}
        />
        <span className="flex items-center gap-2 text-[13px] text-ink-soft">
          API <HealthDot status={health.status} />
        </span>
      </div>

      <SectionTitle
        aside={
          <Link to="/evidence" className="link">
            All evidence →
          </Link>
        }
      >
        Recent activity
      </SectionTitle>
      {evidence.length === 0 ? (
        <EmptyState>No actions have reached the gateway yet.</EmptyState>
      ) : (
        <EvidenceTable records={evidence.slice(0, 12)} caption="The 12 most recent evidence records" />
      )}
    </>
  );
}
