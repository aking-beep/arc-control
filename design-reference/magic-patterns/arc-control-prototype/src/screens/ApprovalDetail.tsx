import { Link, useParams } from 'react-router-dom';
import { useProto } from '../state/ProtoContext';
import { PageHeader, SectionTitle } from '../components/PageHeader';
import { Badge } from '../components/Badges';
import { ParameterTable } from '../components/ParameterTable';
import { RequirementLine } from '../components/RequirementLine';
import { VoteList } from '../components/VoteList';
import { RawJson } from '../components/RawJson';
import { actionHeadline } from '../lib/actionHeadline';
import { timestamp } from '../lib/format';
import { ErrorScreen } from './ErrorScreen';

/** S3b — API-ONLY: GET /v1/approvals/:id, needs SDK read `getApproval`. */
export function ApprovalDetail() {
  const { id } = useParams();
  const { approvals, evidence, tools } = useProto();
  const request = approvals.find((a) => a.id === id);
  if (!request) return <ErrorScreen status={404} message={`approval ${id} not found`} />;

  const headline = actionHeadline(request.tool, request.parameters);
  const records = evidence.filter((e) => e.approval?.id === request.id);
  const tone = request.status === 'approved' ? 'allow' : request.status === 'pending' ? 'approval' : request.status === 'rejected' ? 'deny' : 'muted';

  return (
    <>
      <p className="mb-3 text-[13px]">
        <Link to="/approvals" className="link">
          ← Approvals
        </Link>
      </p>
      <PageHeader
        display
        title={
          <>
            {headline.verb} {headline.strong} {headline.rest}
          </>
        }
        lede={
          <>
            Approval <span className="mono text-ink">{request.id}</span>
          </>
        }
        actions={<Badge tone={tone}>{request.status}</Badge>}
      />

      <div className="grid grid-cols-[7fr_5fr] gap-8">
        <div>
          <h2 className="mb-2 text-[12px] font-semibold text-ink-soft">Parameters (as recorded, redacted)</h2>
          <ParameterTable params={request.parameters} spec={tools.find((t) => t.name === request.tool)?.parameters} caption="Parameters" />

          <SectionTitle>Lifecycle</SectionTitle>
          <dl className="grid grid-cols-[160px_1fr] gap-y-2 text-[13px]">
            <dt className="text-ink-soft">Created</dt>
            <dd className="mono">{timestamp(request.createdAt)}</dd>
            <dt className="text-ink-soft">Expires</dt>
            <dd className="mono">{timestamp(request.expiresAt)}</dd>
            <dt className="text-ink-soft">Resolved</dt>
            <dd className="mono">{timestamp(request.resolvedAt)}</dd>
            <dt className="text-ink-soft">Consumed</dt>
            <dd>
              {request.consumedAt ? (
                <span className="mono">{timestamp(request.consumedAt)}</span>
              ) : (
                <span className="text-ink-soft">not consumed: no execution has used this approval</span>
              )}
            </dd>
            <dt className="text-ink-soft">Policy · rule</dt>
            <dd>
              <Link to={`/policies/${request.policyId}`} className="link mono">
                {request.policyId}
              </Link>{' '}
              · <span className="mono">{request.ruleId}</span>
            </dd>
            <dt className="text-ink-soft">Agent</dt>
            <dd>
              <Link to={`/agents/${request.agentId}`} className="link">
                {request.agentName}
              </Link>{' '}
              <span className="text-ink-soft">owner {request.agentOwner}</span>
            </dd>
          </dl>

          <SectionTitle>Evidence</SectionTitle>
          <ul className="space-y-1 text-[13px]">
            {records.map((record) => (
              <li key={record.id}>
                <Link to={`/evidence/${record.id}`} className="link mono">
                  {record.id}
                </Link>{' '}
                <span className="text-ink-soft">({record.outcome.replace(/_/g, ' ')})</span>
              </li>
            ))}
          </ul>
          <div className="mt-6">
            <RawJson label="Raw approval request (JSON)" value={request} />
          </div>
        </div>
        <aside className="space-y-5 rounded-lg border border-line bg-surface p-5">
          <RequirementLine requirement={request.requirement} />
          <div>
            <h2 className="mb-2 text-[12px] font-semibold text-ink-soft">Votes</h2>
            <VoteList votes={request.votes} />
          </div>
          {request.status === 'pending' && (
            <Link to="/approvals" className="link inline-block text-[14px] font-semibold">
              Vote on this request in the queue →
            </Link>
          )}
        </aside>
      </div>
    </>
  );
}
