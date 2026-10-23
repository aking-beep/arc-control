import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useProto } from '../state/ProtoContext';
import { PageHeader, SectionTitle } from '../components/PageHeader';
import { ChainVerdict } from '../components/ChainVerdict';
import { FilterBar } from '../components/FilterBar';
import { EmptyState } from '../components/EmptyState';
import type { AuditEventType, ChainVerification } from '../data/types';
import { shortDigest, timestamp } from '../lib/format';

const FAMILY_TONE: Record<string, string> = {
  agent: 'bg-info',
  credential: 'bg-info',
  tool: 'bg-ink-soft',
  policy: 'bg-ink-soft',
  action: 'bg-allow',
  approval: 'bg-approval',
  evidence: 'bg-line-strong',
};

/** eventFamily(type) */
const family = (type: AuditEventType) => type.split('.')[0];

/** S9 / S9a — auditPage, pages.ts:356-412. */
export function Audit() {
  const { audit, verification } = useProto();
  const [params, setParams] = useSearchParams();
  const fam = params.get('family') ?? '';
  const [digest, setDigest] = useState(params.get('headDigest') ?? '');
  const [seq, setSeq] = useState(params.get('headSequence') ?? '');

  const anchoredDigest = params.get('headDigest');
  const anchoredSeq = params.get('headSequence');
  let shownVerification: ChainVerification = verification;
  if (anchoredDigest || anchoredSeq) {
    // GET /v1/audit/verify?headDigest=&headSequence= — head_mismatch / truncated when they disagree.
    const failures = [...verification.failures];
    if (anchoredDigest && anchoredDigest !== verification.headDigest) {
      failures.push({ sequence: verification.headSequence ?? 0, id: '', problem: 'head_mismatch', detail: 'the chain head does not match the expected head digest' });
    }
    if (anchoredSeq && Number(anchoredSeq) > (verification.headSequence ?? 0)) {
      failures.push({ sequence: verification.headSequence ?? 0, id: '', problem: 'truncated', detail: `expected the chain to reach sequence ${anchoredSeq}` });
    }
    shownVerification = { ...verification, failures, valid: failures.length === 0, checkedAgainstExpectation: true };
  }

  const desc = [...audit].reverse();
  const rows = (fam ? desc.filter((r) => family(r.type) === fam) : desc).slice(0, 150);
  const families = ['agent', 'credential', 'tool', 'policy', 'action', 'approval', 'evidence'];

  return (
    <>
      <PageHeader
        title="Audit"
        lede="Append-only and hash-chained: each record carries the digest of its predecessor, so editing one breaks every link after it and removing one from the middle leaves a sequence gap."
      />
      {(anchoredDigest || anchoredSeq) && (
        <p className="mb-2 text-[13px] text-ink-soft">
          Verified against the anchored head you supplied.{' '}
          <Link to="/audit" className="link">
            Clear
          </Link>
        </p>
      )}
      <ChainVerdict verification={shownVerification} />

      <details className="mt-3 rounded-lg border border-line bg-surface">
        <summary className="px-4 py-2.5 text-[13px] font-semibold">Verify against an anchored head</summary>
        <form
          className="flex flex-wrap items-end gap-3 border-t border-line px-4 py-3"
          onSubmit={(event) => {
            event.preventDefault();
            const q = new URLSearchParams();
            if (digest) q.set('headDigest', digest);
            if (seq) q.set('headSequence', seq);
            setParams(q);
          }}
        >
          <label className="flex-1 text-[12px] font-semibold">
            headDigest
            <input value={digest} onChange={(e) => setDigest(e.target.value)} placeholder="sha256:…" className="mono mt-1 block h-8 w-full rounded-md border border-line-strong bg-surface px-2 text-ink" />
          </label>
          <label className="w-40 text-[12px] font-semibold">
            headSequence
            <input value={seq} onChange={(e) => setSeq(e.target.value)} inputMode="numeric" className="mono mt-1 block h-8 w-full rounded-md border border-line-strong bg-surface px-2 text-ink" />
          </label>
          <button type="submit" className="btn h-8 rounded-md bg-accent px-4 text-[14px] font-semibold text-accent-ink hover:opacity-90">
            Verify
          </button>
        </form>
      </details>

      <SectionTitle aside={<span className="text-ink-soft">Newest first · {rows.length} of {audit.length} shown</span>}>Records</SectionTitle>
      <div className="mb-3">
        <FilterBar
          label="Family (within loaded page)"
          current={fam}
          options={[{ value: '', label: 'All' }, ...families.map((f) => ({ value: f, label: f }))]}
          hrefFor={(value) => (value ? `/audit?family=${value}` : '/audit')}
        />
      </div>
      {rows.length === 0 ? (
        <EmptyState>The audit log is empty.</EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="dt compact">
            <caption className="sr-only">Audit records</caption>
            <thead>
              <tr>
                <th scope="col" className="text-right">
                  #
                </th>
                <th scope="col">When (UTC)</th>
                <th scope="col">Event</th>
                <th scope="col">Actor</th>
                <th scope="col">Summary</th>
                <th scope="col">Digest</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const failed = shownVerification.failures.some((f) => f.sequence === r.sequence && f.id === r.id);
                return (
                  <tr key={r.id} className={failed ? 'bg-deny-bg' : ''}>
                    <td className="mono tnum text-right">{r.sequence}</td>
                    <td className="mono tnum whitespace-nowrap text-ink-soft">{timestamp(r.occurredAt)}</td>
                    <td className="whitespace-nowrap">
                      <span className="inline-flex items-center gap-2">
                        <span aria-hidden className={`h-2 w-2 rounded-sm ${FAMILY_TONE[family(r.type)]}`} />
                        <span className="mono">{r.type}</span>
                      </span>
                    </td>
                    <td className="mono max-w-[180px] truncate" title={r.actor}>
                      {r.actor}
                    </td>
                    <td className="text-[13px]">
                      {r.type === 'evidence.recorded' ? (
                        <Link to={`/evidence/${r.subject}`} className="link">
                          {r.summary}
                        </Link>
                      ) : (
                        r.summary
                      )}
                    </td>
                    <td className="mono whitespace-nowrap text-ink-soft" title={r.digest}>
                      {shortDigest(r.digest)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-3 text-[13px] text-ink-soft">Older records appear here through the “Older records” link once the log exceeds 150 rows (afterSequence paging).</p>
    </>
  );
}
