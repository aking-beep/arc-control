import { Link, useParams } from 'react-router-dom';
import { useProto } from '../state/ProtoContext';
import { PageHeader, SectionTitle } from '../components/PageHeader';
import { Badge, EffectBadge } from '../components/Badges';
import { ScopeChips, ControlTags } from '../components/ScopeChips';
import { DecisionLadder } from '../components/DecisionLadder';
import { RawJson } from '../components/RawJson';
import { matchSelectors } from '../lib/match';
import { ErrorScreen } from './ErrorScreen';

/** S6a — API-ONLY: GET /v1/policies/:id, needs SDK read `getPolicy`. */
export function PolicyDetail() {
  const { id } = useParams();
  const { policies, agents, tools, evidence } = useProto();
  const policy = policies.find((p) => p.id === id);
  if (!policy) return <ErrorScreen status={404} message={`policy ${id} not found`} />;

  const pairs = agents.flatMap((agent) => tools.filter((tool) => matchSelectors(policy.match, agent, tool)).map((tool) => ({ agent, tool })));
  const decided = evidence.filter((e) => e.decision.policyId === policy.id);
  const byRule = new Map<string, number>();
  for (const record of decided) byRule.set(record.decision.ruleId ?? '—', (byRule.get(record.decision.ruleId ?? '—') ?? 0) + 1);

  return (
    <>
      <p className="mb-3 text-[13px]">
        <Link to="/policies" className="link">
          ← Policies
        </Link>
      </p>
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            <span className="mono text-[22px]">{policy.id}</span>
            <span>{policy.name}</span>
          </span>
        }
        lede={policy.description}
        actions={
          <>
            <span className="tnum text-[13px] text-ink-soft">version {policy.version}</span>
            {policy.enabled ? <Badge tone="allow">enabled</Badge> : <Badge tone="muted">disabled</Badge>}
          </>
        }
      />
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-[12px] font-semibold text-ink-soft">Scope</span>
        <ScopeChips match={policy.match} />
        <ControlTags labels={policy.labels} />
      </div>

      <div className="mt-6 grid grid-cols-[8fr_4fr] gap-10">
        <section>
          <h2 className="mb-1 text-[16px] font-[650]">Decision ladder</h2>
          <p className="mb-2 text-[13px] text-ink-soft">Rules are tried in order and the first match decides for this policy.</p>
          <DecisionLadder policy={policy} />
          <div className="mt-4">
            <RawJson label="Raw policy (JSON)" value={policy} />
          </div>
        </section>
        <aside>
          <h2 className="mb-2 text-[16px] font-[650]">In scope today</h2>
          <p className="mb-2 text-[13px] text-ink-soft">Agent and tool pairs this policy’s selectors match. Scope, not permission.</p>
          <ul className="divide-y divide-line rounded-lg border border-line bg-surface text-[13px]">
            {pairs.length === 0 && <li className="px-3 py-2 text-ink-soft">No registered pair matches.</li>}
            {pairs.map(({ agent, tool }) => (
              <li key={`${agent.id}-${tool.name}`} className="flex items-center justify-between px-3 py-2">
                <Link to={`/agents/${agent.id}`} className="link">
                  {agent.name}
                </Link>
                <span className="mono">{tool.name}</span>
              </li>
            ))}
          </ul>

          <SectionTitle>Decisions in loaded evidence</SectionTitle>
          <p className="-mt-1 mb-2 text-[12px] text-ink-soft">Most recent {evidence.length} records only.</p>
          <table className="dt compact rounded-lg border border-line bg-surface">
            <caption className="sr-only">Decisions per rule</caption>
            <thead>
              <tr>
                <th scope="col">Rule</th>
                <th scope="col">Effect</th>
                <th scope="col" className="text-right">
                  Records
                </th>
              </tr>
            </thead>
            <tbody>
              {policy.rules.map((rule) => (
                <tr key={rule.id}>
                  <td className="mono">{rule.id}</td>
                  <td>
                    <EffectBadge effect={rule.effect} />
                  </td>
                  <td className="tnum text-right">{byRule.get(rule.id) ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-3 text-[13px]">
            <Link to="/evidence" className="link">
              Evidence decided by this policy →
            </Link>
          </p>
        </aside>
      </div>
    </>
  );
}
