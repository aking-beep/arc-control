import { Link } from 'react-router-dom';
import { useProto } from '../state/ProtoContext';
import { PageHeader } from '../components/PageHeader';
import { Badge } from '../components/Badges';
import { ScopeChips, ControlTags } from '../components/ScopeChips';
import { DecisionLadder } from '../components/DecisionLadder';
import { RawJson } from '../components/RawJson';
import { EmptyState } from '../components/EmptyState';

/** S6 — policiesPage, pages.ts:166-214. */
export function Policies() {
  const { policies, setPolicyEnabled } = useProto();

  return (
    <>
      <PageHeader
        title="Policies"
        lede="Every matching policy is evaluated and the strictest effect wins, so adding a policy can only tighten authorization, never loosen it. A policy that matches but whose rules do not fire falls through to its own fallback. There is no path on which no policy decides."
      />
      {policies.length === 0 ? (
        <EmptyState>No policies are published. With no policy, every action is denied.</EmptyState>
      ) : (
        <div className="space-y-6">
          {policies.map((policy) => (
            <section key={policy.id} aria-labelledby={`p-${policy.id}`} className={`rounded-lg border border-line bg-surface ${policy.enabled ? '' : 'opacity-75'}`}>
              <header className="flex items-start justify-between gap-6 border-b border-line px-6 py-4">
                <div className="min-w-0">
                  <h2 id={`p-${policy.id}`} className="flex flex-wrap items-center gap-2 text-[16px] font-[650]">
                    <Link to={`/policies/${policy.id}`} className="link mono">
                      {policy.id}
                    </Link>
                    <span className="tnum text-[13px] font-normal text-ink-soft">v{policy.version}</span>
                    <span>{policy.name}</span>
                    {policy.enabled ? <Badge tone="allow">enabled</Badge> : <Badge tone="muted">disabled</Badge>}
                  </h2>
                  {policy.description && <p className="mt-1 max-w-[90ch] text-[13px] text-ink-soft">{policy.description}</p>}
                  <div className="mt-2.5 flex flex-wrap items-center gap-3">
                    <ScopeChips match={policy.match} />
                    <ControlTags labels={policy.labels} />
                  </div>
                </div>
                {policy.enabled ? (
                  <Link
                    to={`/confirm/disable/${policy.id}`}
                    className="btn inline-flex h-8 shrink-0 items-center rounded-md border border-deny/40 px-3 text-[14px] font-semibold text-deny hover:bg-deny-bg"
                  >
                    Disable…
                  </Link>
                ) : (
                  <button
                    type="button"
                    onClick={() => setPolicyEnabled(policy.id, true)}
                    className="btn h-8 shrink-0 rounded-md bg-accent px-3 text-[14px] font-semibold text-accent-ink hover:opacity-90"
                  >
                    Enable
                  </button>
                )}
              </header>
              <div className="px-6 pb-4 pt-1">
                <DecisionLadder policy={policy} />
                <RawJson label="Raw policy (JSON)" value={policy} />
              </div>
            </section>
          ))}
        </div>
      )}
    </>
  );
}
