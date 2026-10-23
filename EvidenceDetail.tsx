import { Link, useParams } from 'react-router-dom';
import { useProto } from '../state/ProtoContext';
import { PageHeader } from '../components/PageHeader';
import { EffectBadge, OutcomeBadge } from '../components/Badges';
import { EvidenceTimeline } from '../components/EvidenceTimeline';
import { ParameterTable } from '../components/ParameterTable';
import { TraceTable } from '../components/TraceTable';
import { DigestBlock } from '../components/DigestBlock';
import { RawJson } from '../components/RawJson';
import { ErrorScreen } from './ErrorScreen';

/** S8 — evidenceDetailPage, pages.ts:312-352. Timeline left, detail panel right. */
export function EvidenceDetail() {
  const { id } = useParams();
  const { evidence, traces, tools } = useProto();
  const record = evidence.find((e) => e.id === id);
  if (!record) return <ErrorScreen status={404} message={`evidence ${id} not found`} />;
  const trace = traces[record.decision.id];
  const d = record.decision;

  return (
    <>
      <p className="mb-3 text-[13px]">
        <Link to="/evidence" className="link">
          ← All evidence
        </Link>
      </p>
      <PageHeader
        display
        title={
          <>
            Evidence <span className="mono text-[20px] font-normal text-ink-soft">{record.id}</span>
          </>
        }
        lede={
          <>
            <Link to={`/agents/${record.agent.id}`} className="link">
              {record.agent.name}
            </Link>{' '}
            requested <span className="mono text-ink">{record.tool.name}</span> · {d.reason}
          </>
        }
        actions={
          <>
            <OutcomeBadge outcome={record.outcome} />
            <EffectBadge effect={d.effect} />
          </>
        }
      />

      <div className="grid grid-cols-[5fr_7fr] gap-10">
        <section aria-labelledby="tl">
          <h2 id="tl" className="mb-4 text-[16px] font-[650]">
            What happened
          </h2>
          <EvidenceTimeline record={record} />
          {record.approval && (
            <p className="text-[13px]">
              <Link to={`/approvals/${record.approval.id}`} className="link">
                Approval request →
              </Link>
            </p>
          )}
          <dl className="mt-6 grid grid-cols-[110px_1fr] gap-y-1.5 border-t border-line pt-4 text-[13px]">
            <dt className="text-ink-soft">Environment</dt>
            <dd className="mono">{record.environment}</dd>
            <dt className="text-ink-soft">Owner</dt>
            <dd>{record.agent.owner}</dd>
            <dt className="text-ink-soft">Tool</dt>
            <dd>
              {record.tool.effect} · {record.tool.riskTier} · <span className="mono">{record.tool.system}</span>
            </dd>
            <dt className="text-ink-soft">Credential</dt>
            <dd className="mono break-all">{record.agent.credentialId}</dd>
          </dl>
        </section>

        <section aria-label="Detail" className="space-y-7">
          <div>
            <h2 className="mb-2 text-[16px] font-[650]">Parameters</h2>
            <ParameterTable params={record.request.parameters} spec={tools.find((t) => t.name === record.tool.name)?.parameters} caption="Recorded parameters" />
            {record.request.intent && (
              <p className="mt-2 text-[13px] text-ink-soft">
                <span className="font-semibold">Agent-stated intent (advisory, not used by policy):</span> “{record.request.intent}”
              </p>
            )}
          </div>
          <div>
            <h2 className="mb-1 text-[16px] font-[650]">Decision trace</h2>
            <p className="mb-2 text-[13px] text-ink-soft">
              Every rule the engine examined, in order. The evidence record stores a digest of this trace, so a tampered trace is detectable
              without duplicating it.
            </p>
            {trace ? (
              <TraceTable trace={trace} />
            ) : (
              <p className="text-[13px] text-ink-soft">The full trace for this decision is no longer held. The trace digest below still binds it.</p>
            )}
          </div>
          <div>
            <h2 className="mb-1 text-[16px] font-[650]">Obligations</h2>
            <p className="text-[13px]">{record.obligations.length ? record.obligations.join(', ') : <span className="text-ink-soft">None</span>}</p>
          </div>
          <div>
            <h2 className="mb-1 text-[16px] font-[650]">Integrity</h2>
            <DigestBlock label="integrityDigest" value={record.integrityDigest} note="over every field" />
            <DigestBlock label="parametersDigest" value={record.request.parametersDigest} />
            <DigestBlock label="traceDigest" value={d.traceDigest} />
            {record.execution?.resultDigest && <DigestBlock label="resultDigest" value={record.execution.resultDigest} />}
          </div>
          <div className="space-y-2">
            <RawJson label="Raw record (JSON)" value={record} />
            {trace && <RawJson label="Raw decision trace (JSON)" value={trace} />}
          </div>
        </section>
      </div>
    </>
  );
}
