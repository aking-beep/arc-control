import { Link, useSearchParams } from 'react-router-dom';
import { useProto } from '../state/ProtoContext';
import { PageHeader } from '../components/PageHeader';
import { EffectLetter, RiskBadge, StatusDot } from '../components/Badges';
import { DecisionLadder } from '../components/DecisionLadder';
import { ScopeChips } from '../components/ScopeChips';
import { cellScope } from '../lib/match';

/**
 * S12 — DERIVED. Agents × tools, using matchSelectors() from
 * packages/policy-engine/src/match.ts. Shows which enabled policies are in
 * scope and which effects they can produce. Never "allowed" (R3).
 */
export function Access() {
  const { agents, tools, policies } = useProto();
  const [params] = useSearchParams();
  const selAgent = agents.find((a) => a.id === params.get('agent'));
  const selTool = tools.find((t) => t.name === params.get('tool'));
  const selScope = selAgent && selTool ? cellScope(selAgent, selTool, policies) : undefined;

  return (
    <>
      <PageHeader
        title="Access"
        lede="Which enabled policies govern each agent and tool pair, and which effects their rules can produce. This is scope, not permission: the effect for a real request depends on its parameters at request time."
      />

      <div className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-2 text-[13px] text-ink-soft" aria-label="Legend">
        <span>
          <span className="font-semibold text-ink">◆ declared</span> agent lists the tool (not enforced)
        </span>
        <span className="flex items-center gap-1.5">
          <EffectLetter effect="ALLOW" /> ALLOW <EffectLetter effect="REQUIRE_APPROVAL" /> REQUIRE_APPROVAL <EffectLetter effect="DENY" /> DENY possible
        </span>
        <span>Empty cell: no policy in scope, engine default applies</span>
      </div>

      <div className={`grid gap-6 ${selScope ? 'grid-cols-[1fr_400px]' : 'grid-cols-1'}`}>
        <div className="overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="w-full border-collapse text-[13px]">
            <caption className="sr-only">Access matrix: agents by tools</caption>
            <thead>
              <tr>
                <th scope="col" className="sticky left-0 z-10 min-w-[200px] border-b border-r border-line-strong bg-sunk px-3 py-2 text-left text-[12px] font-semibold text-ink-soft">
                  Agent
                </th>
                {tools.map((tool) => (
                  <th key={tool.name} scope="col" className="min-w-[180px] border-b border-l border-line-strong bg-sunk px-3 py-2 text-left align-bottom">
                    <div className="mono text-[12.5px] font-semibold text-ink">{tool.name}</div>
                    <div className="mt-1 flex items-center gap-1.5 text-[12px] font-normal text-ink-soft">
                      {tool.effect} <RiskBadge tier={tool.riskTier} />
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {agents.map((agent) => {
                const suspended = agent.status === 'suspended';
                return (
                  <tr key={agent.id} className={suspended ? 'opacity-60' : ''}>
                    <th scope="row" className="sticky left-0 z-10 border-b border-r border-line-strong bg-surface px-3 py-2.5 text-left align-top font-normal">
                      <Link to={`/agents/${agent.id}`} className="link font-semibold">
                        {agent.name}
                      </Link>
                      <div className="mt-0.5 flex items-center gap-2">
                        <StatusDot ok={!suspended} label={agent.status} />
                        <span className="mono text-ink-soft">{agent.roles.join(', ')}</span>
                      </div>
                      {suspended && <p className="mt-1 text-[12px] text-deny">Refused at authentication, before policy</p>}
                    </th>
                    {tools.map((tool) => {
                      const scope = cellScope(agent, tool, policies);
                      const selected = selAgent?.id === agent.id && selTool?.name === tool.name;
                      return (
                        <td key={tool.name} className={`border-b border-l border-line p-0 align-top ${selected ? 'bg-info-bg' : ''}`}>
                          <Link
                            to={`/access?agent=${agent.id}&tool=${encodeURIComponent(tool.name)}`}
                            aria-current={selected ? 'true' : undefined}
                            className="btn block h-full px-3 py-2.5 hover:bg-sunk"
                          >
                            <span className="sr-only">
                              {agent.name}, {tool.name}:{' '}
                            </span>
                            <div className={`text-[12px] ${scope.declared ? 'font-semibold text-ink' : 'text-ink-soft'}`}>
                              {scope.declared ? '◆ declared' : 'not declared'}
                            </div>
                            {scope.enabled.length > 0 ? (
                              <>
                                <div className="mono mt-1 text-ink">{scope.enabled.map((p) => p.id).join(', ')}</div>
                                <div className="mt-1 flex gap-2">
                                  {scope.effects.map((effect) => (
                                    <span key={effect}>
                                      <EffectLetter effect={effect} />
                                    </span>
                                  ))}
                                </div>
                              </>
                            ) : (
                              <div className="mt-1 text-[12px] text-ink-soft">No policy in scope</div>
                            )}
                            {scope.disabled.length > 0 && <div className="mt-1 text-[12px] text-ink-soft">+{scope.disabled.length} disabled</div>}
                          </Link>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {selScope && selAgent && selTool && (
          <aside aria-label="Pair detail" className="self-start rounded-lg border border-line bg-surface">
            <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
              <div>
                <h2 className="text-[15px] font-[650]">
                  {selAgent.name} → <span className="mono">{selTool.name}</span>
                </h2>
                <p className="mt-0.5 text-[12px] text-ink-soft">{selScope.declared ? 'Declared by the agent. Not a grant.' : 'Not declared by the agent.'}</p>
              </div>
              <Link to="/access" className="link text-[13px]">
                Close
              </Link>
            </div>
            <div className="px-5 py-4">
              {selScope.enabled.length === 0 ? (
                <p className="text-[13px]">
                  No enabled policy is in scope, so the engine default applies: <strong>DENY</strong> (“no policy authorizes this action”), or ALLOW
                  if the deployment runs monitor-only. The console cannot read which.
                </p>
              ) : (
                selScope.enabled.map((policy) => (
                  <div key={policy.id} className="mb-4">
                    <div className="flex items-center justify-between">
                      <Link to={`/policies/${policy.id}`} className="link mono font-semibold">
                        {policy.id}
                      </Link>
                      <span className="text-[12px] text-ink-soft">{policy.name}</span>
                    </div>
                    <div className="mt-1.5">
                      <ScopeChips match={policy.match} />
                    </div>
                    <DecisionLadder policy={policy} />
                  </div>
                ))
              )}
              {selScope.disabled.length > 0 && (
                <p className="mt-2 text-[12px] text-ink-soft">Disabled and not evaluated: {selScope.disabled.map((p) => p.id).join(', ')}</p>
              )}
              <p className="mt-3 border-t border-line pt-3 text-[12px] text-ink-soft">
                Across policies the strictest effect wins. Which rung fires depends on the request’s parameters.
              </p>
            </div>
          </aside>
        )}
      </div>
    </>
  );
}
