import type { ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useState } from 'react';
import { useProto } from '../state/ProtoContext';
import { PageHeader } from '../components/PageHeader';
import { actionHeadline } from '../lib/actionHeadline';
import { ErrorScreen } from './ErrorScreen';

/**
 * confirmPage(action, target) — render-only GET (R6). The form posts to the
 * existing POST path; nothing changes until it is submitted.
 */
export function ConfirmPage() {
  const { action, id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { approvals, agents, policies, vote, setAgentStatus, setPolicyEnabled } = useProto();
  const [comment, setComment] = useState(params.get('comment') ?? '');

  if (action === 'reject') {
    const request = approvals.find((a) => a.id === id);
    if (!request) return <ErrorScreen status={404} message={`approval ${id} not found`} />;
    const h = actionHeadline(request.tool, request.parameters);
    return (
      <Confirm
        title="Reject this request?"
        what={
          <>
            {h.verb} <strong>{h.strong}</strong> {h.rest}, requested by {request.agentName}.
          </>
        }
        effect="Rejecting resolves the request immediately. The action will not run. Your vote and reason are recorded in evidence and the audit log."
        post={`POST /approvals/${request.id}/vote  vote=reject`}
        confirmLabel="Reject request"
        cancelTo="/approvals"
        onConfirm={() => {
          vote(request.id, 'reject', comment || undefined);
          navigate('/approvals');
        }}
      >
        <label htmlFor="reject-comment" className="mb-1 block text-[12px] font-semibold">
          Reason, recorded in evidence
        </label>
        <textarea
          id="reject-comment"
          name="comment"
          rows={3}
          value={comment}
          onChange={(event) => setComment(event.target.value)}
          className="mb-5 w-full rounded-md border border-line-strong bg-surface px-3 py-2 text-[14px] text-ink"
        />
      </Confirm>
    );
  }

  if (action === 'suspend') {
    const agent = agents.find((a) => a.id === id);
    if (!agent) return <ErrorScreen status={404} message={`agent ${id} not found`} />;
    return (
      <Confirm
        title={`Suspend ${agent.name}?`}
        what={
          <>
            <strong>{agent.name}</strong> ({agent.kind}, {agent.environment}), owned by {agent.owner}.
          </>
        }
        effect="Suspended agents are refused at authentication, before any policy runs. This is recorded in the audit log, and the agent can be resumed from the Agents page."
        post={`POST /agents/${agent.id}/suspend`}
        confirmLabel="Suspend agent"
        cancelTo="/agents"
        onConfirm={() => {
          setAgentStatus(agent.id, 'suspended');
          navigate('/agents');
        }}
      />
    );
  }

  if (action === 'disable') {
    const policy = policies.find((p) => p.id === id);
    if (!policy) return <ErrorScreen status={404} message={`policy ${id} not found`} />;
    return (
      <Confirm
        title={`Disable ${policy.id}?`}
        what={
          <>
            <strong>{policy.name}</strong>, version {policy.version}, governing <span className="mono">{JSON.stringify(policy.match)}</span>.
          </>
        }
        effect="A disabled policy is no longer evaluated. Actions it governed fall to any other matching policy, or to the engine default (DENY unless the deployment runs monitor-only). This takes effect immediately and is recorded in the audit log."
        post={`POST /policies/${policy.id}/disable`}
        confirmLabel="Disable policy"
        cancelTo="/policies"
        onConfirm={() => {
          setPolicyEnabled(policy.id, false);
          navigate('/policies');
        }}
      />
    );
  }

  return <ErrorScreen status={404} message={`no such confirmation: ${action}`} />;
}

function Confirm({
  title,
  what,
  effect,
  post,
  confirmLabel,
  cancelTo,
  onConfirm,
  children,
}: {
  title: string;
  what: ReactNode;
  effect: string;
  post: string;
  confirmLabel: string;
  cancelTo: string;
  onConfirm: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="max-w-[640px]">
      <PageHeader title={title} />
      <p className="text-[15px]">{what}</p>
      <p className="mt-3 text-[14px] leading-relaxed text-ink-soft">{effect}</p>
      <form
        className="mt-6"
        onSubmit={(event) => {
          event.preventDefault();
          onConfirm();
        }}
      >
        {children}
        <div className="flex items-center gap-4">
          <button type="submit" className="btn h-8 rounded-md bg-deny px-4 text-[14px] font-semibold text-surface hover:opacity-90">
            {confirmLabel}
          </button>
          <Link to={cancelTo} className="link text-[14px]">
            Cancel
          </Link>
        </div>
        <p className="mono mt-5 text-ink-soft">Submits {post} (unchanged contract)</p>
      </form>
    </div>
  );
}
