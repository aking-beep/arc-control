import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { ApprovalRequest } from '../data/types';
import { useProto } from '../state/ProtoContext';
import { actionHeadline } from '../lib/actionHeadline';
import { expiresIn, shortId } from '../lib/format';
import { RiskBadge } from './Badges';
import { ParameterTable } from './ParameterTable';
import { RequirementLine } from './RequirementLine';
import { VoteList } from './VoteList';
import { ConditionInline } from './ConditionInline';

/**
 * Approval block in approvalsPage (pages.ts:218+). The vote form keeps field
 * names `vote` and `comment` and posts to /approvals/:id/vote. Reject goes
 * through a render-only confirm page first.
 */
export function ApprovalRequestCard({ request }: { request: ApprovalRequest }) {
  const { tools, policies, evidence, vote } = useProto();
  const navigate = useNavigate();
  const [comment, setComment] = useState('');
  const tool = tools.find((t) => t.name === request.tool);
  const policy = policies.find((p) => p.id === request.policyId);
  const rule = policy?.rules.find((r) => r.id === request.ruleId);
  const intent = evidence.find((e) => e.approval?.id === request.id)?.request.intent;
  const headline = actionHeadline(request.tool, request.parameters);
  const commentId = `comment-${request.id}`;

  return (
    <article className="overflow-hidden rounded-lg border border-line bg-surface">
      <header className="flex items-start justify-between gap-6 border-b border-line px-6 py-4">
        <div className="min-w-0">
          <h2 className="text-[22px] font-[650] leading-tight tracking-tight">
            {headline.verb} {headline.strong && <span className="tnum">{headline.strong}</span>} {headline.rest}
          </h2>
          <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-ink-soft">
            <Link to={`/agents/${request.agentId}`} className="link">
              {request.agentName}
            </Link>
            <span aria-hidden>·</span>
            <Link to="/tools" className="link mono">
              {request.tool}
            </Link>
            {tool && (
              <>
                <span>({tool.effect}</span>
                <RiskBadge tier={tool.riskTier} />
                <span className="-ml-1">)</span>
              </>
            )}
            <span aria-hidden>·</span>
            <span>owner {request.agentOwner}</span>
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className="tnum text-[14px] font-semibold text-approval">{expiresIn(request.expiresAt)}</p>
          <Link to={`/approvals/${request.id}`} title={request.id} className="link mono mt-1 inline-block">
            {shortId(request.id, 16)}
          </Link>
        </div>
      </header>

      <div className="grid grid-cols-[7fr_5fr]">
        <div className="space-y-5 px-6 py-5">
          <section>
            <h3 className="mb-2 text-[12px] font-semibold text-ink-soft">Parameters (as recorded, redacted)</h3>
            <ParameterTable params={request.parameters} spec={tool?.parameters} caption="Requested parameters" />
          </section>
          <section className="text-[13px]">
            <h3 className="mb-1.5 text-[12px] font-semibold text-ink-soft">Why it is held</h3>
            <p>
              Policy{' '}
              <Link to={`/policies/${request.policyId}`} className="link mono">
                {request.policyId}
              </Link>{' '}
              · rule <span className="mono">{request.ruleId}</span>
              {rule && (
                <>
                  {' '}
                  · when <ConditionInline condition={rule.when} />
                </>
              )}
            </p>
            <p className="mt-1 text-ink-soft">{request.reason}</p>
          </section>
          {intent && (
            <section className="text-[13px]">
              <h3 className="mb-1.5 text-[12px] font-semibold text-ink-soft">Agent-stated intent (advisory, not used by policy)</h3>
              <p className="text-ink-soft">“{intent}”</p>
            </section>
          )}
        </div>

        <div className="space-y-5 border-l border-line bg-sunk/50 px-6 py-5">
          <RequirementLine requirement={request.requirement} />
          <VoteList votes={request.votes} />
          <form
            onSubmit={(event) => {
              event.preventDefault();
              vote(request.id, 'approve', comment || undefined);
            }}
            className="space-y-3"
          >
            <div>
              <label htmlFor={commentId} className="mb-1 block text-[12px] font-semibold">
                Reason, recorded in evidence
              </label>
              <textarea
                id={commentId}
                name="comment"
                rows={2}
                value={comment}
                onChange={(event) => setComment(event.target.value)}
                className="w-full resize-y rounded-md border border-line-strong bg-surface px-3 py-2 text-[14px] text-ink"
              />
            </div>
            <div className="flex items-center gap-3">
              <button type="submit" name="vote" value="approve" className="btn h-8 rounded-md bg-accent px-4 text-[14px] font-semibold text-accent-ink hover:opacity-90">
                Approve
              </button>
              <button
                type="button"
                onClick={() => navigate(`/confirm/reject/${request.id}?comment=${encodeURIComponent(comment)}`)}
                className="btn h-8 rounded-md border border-deny/40 px-3 text-[14px] font-semibold text-deny hover:bg-deny-bg"
              >
                Reject…
              </button>
            </div>
            <p className="text-[12px] leading-relaxed text-ink-soft">
              Approving does not execute. The action runs only once the request is approved, as a separate audited call. The approvals
              engine decides whether your vote counts.
            </p>
          </form>
        </div>
      </div>
    </article>
  );
}
