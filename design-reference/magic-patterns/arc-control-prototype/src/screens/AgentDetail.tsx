import { Link, useParams } from 'react-router-dom';
import { useProto } from '../state/ProtoContext';
import { PageHeader, SectionTitle } from '../components/PageHeader';
import { StatusDot, EffectLetter } from '../components/Badges';
import { EvidenceTable } from '../components/EvidenceTable';
import { EmptyState } from '../components/EmptyState';
import { timestamp } from '../lib/format';
import { cellScope } from '../lib/match';
import { ErrorScreen } from './ErrorScreen';

/** S4a — API-ONLY: GET /v1/agents/:id, /keys, /v1/evidence?agentId=. */
export function AgentDetail() {
  const { id } = useParams();
  const { agents, credentials, evidence, tools, policies } = useProto();
  const agent = agents.find((a) => a.id === id);
  if (!agent) return <ErrorScreen status={404} message={`agent ${id} not found`} />;

  const keys = credentials.filter((c) => c.agentId === agent.id);
  const records = evidence.filter((e) => e.agent.id === agent.id);
  const suspended = agent.status === 'suspended';

  return (
    <>
      <p className="mb-3 text-[13px]">
        <Link to="/agents" className="link">
          ← Agents
        </Link>
      </p>
      <PageHeader
        title={agent.name}
        lede={agent.description}
        actions={
          suspended ? null : (
            <Link
              to={`/confirm/suspend/${agent.id}`}
              className="btn inline-flex h-8 items-center rounded-md border border-deny/40 px-3 text-[14px] font-semibold text-deny hover:bg-deny-bg"
            >
              Suspend…
            </Link>
          )
        }
      />
      {suspended && (
        <p className="mb-5 rounded-lg border border-deny/40 bg-deny-bg px-4 py-2.5 text-[14px] text-deny">
          Suspended: refused at authentication, before policy. Resume from the Agents list.
        </p>
      )}

      <div className="grid grid-cols-[5fr_7fr] gap-10">
        <section>
          <h2 className="mb-3 text-[16px] font-[650]">Profile</h2>
          <dl className="grid grid-cols-[130px_1fr] gap-y-2 text-[13px]">
            <dt className="text-ink-soft">Status</dt>
            <dd>
              <StatusDot ok={!suspended} label={agent.status} />
            </dd>
            <dt className="text-ink-soft">Id</dt>
            <dd className="mono break-all">{agent.id}</dd>
            <dt className="text-ink-soft">Kind</dt>
            <dd>{agent.kind}</dd>
            <dt className="text-ink-soft">Environment</dt>
            <dd className="mono">{agent.environment}</dd>
            <dt className="text-ink-soft">Organization</dt>
            <dd className="mono">{agent.organizationId}</dd>
            <dt className="text-ink-soft">Owner</dt>
            <dd>{agent.owner}</dd>
            <dt className="text-ink-soft">Roles</dt>
            <dd className="mono">{agent.roles.join(', ') || '—'}</dd>
            <dt className="text-ink-soft">Labels</dt>
            <dd className="mono">{Object.keys(agent.labels).length ? Object.entries(agent.labels).map(([k, v]) => `${k}=${v}`).join(', ') : '—'}</dd>
            <dt className="text-ink-soft">Registered</dt>
            <dd className="mono">{timestamp(agent.createdAt)}</dd>
          </dl>
        </section>

        <section>
          <h2 className="mb-1 text-[16px] font-[650]">Declared tools</h2>
          <p className="mb-3 text-[13px] text-ink-soft">Declared, not a grant. Policies in scope and the effects their rules can produce:</p>
          <div className="overflow-hidden rounded-lg border border-line bg-surface">
            <table className="dt compact">
              <caption className="sr-only">Declared tools and policy scope</caption>
              <thead>
                <tr>
                  <th scope="col">Tool</th>
                  <th scope="col">Policies in scope</th>
                  <th scope="col">Possible effects</th>
                </tr>
              </thead>
              <tbody>
                {agent.declaredTools.map((name) => {
                  const tool = tools.find((t) => t.name === name);
                  const scope = tool ? cellScope(agent, tool, policies) : undefined;
                  return (
                    <tr key={name}>
                      <td className="mono">{name}</td>
                      <td className="mono">
                        {scope && scope.enabled.length > 0 ? (
                          scope.enabled.map((p) => (
                            <Link key={p.id} to={`/policies/${p.id}`} className="link mr-2">
                              {p.id}
                            </Link>
                          ))
                        ) : (
                          <span className="font-sans text-ink-soft">None: engine default applies</span>
                        )}
                      </td>
                      <td>
                        {scope && scope.effects.length > 0 ? (
                          <span className="inline-flex gap-2">
                            {scope.effects.map((e) => (
                              <span key={e}>
                                <EffectLetter effect={e} />
                              </span>
                            ))}
                          </span>
                        ) : (
                          <span className="text-[13px] text-ink-soft">DENY, or ALLOW if monitor-only</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <SectionTitle>Credentials</SectionTitle>
      <p className="-mt-1 mb-3 text-[13px] text-ink-soft">Metadata only. ARC Control stores a hash of each key; the secret is shown once, at issue, and never again.</p>
      {keys.length === 0 ? (
        <EmptyState>No credentials have been issued to this agent.</EmptyState>
      ) : (
        <div className="overflow-hidden rounded-lg border border-line bg-surface">
          <table className="dt">
            <caption className="sr-only">Agent credentials</caption>
            <thead>
              <tr>
                <th scope="col">Prefix</th>
                <th scope="col">State</th>
                <th scope="col">Created</th>
                <th scope="col">Expires</th>
                <th scope="col">Revoked</th>
                <th scope="col">Last used</th>
              </tr>
            </thead>
            <tbody>
              {keys.map((key) => (
                <tr key={key.id}>
                  <td className="mono">{key.displayPrefix}…</td>
                  <td>
                    <StatusDot ok={!key.revokedAt} label={key.revokedAt ? 'revoked' : 'valid'} />
                  </td>
                  <td className="mono text-ink-soft">{timestamp(key.createdAt)}</td>
                  <td className="text-ink-soft">{key.expiresAt ? <span className="mono">{timestamp(key.expiresAt)}</span> : 'no expiry set'}</td>
                  <td className="mono text-ink-soft">{timestamp(key.revokedAt)}</td>
                  <td className="mono text-ink-soft">{timestamp(key.lastUsedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <SectionTitle
        aside={
          <Link to={`/evidence?agentId=${agent.id}`} className="link">
            All evidence for {agent.name} →
          </Link>
        }
      >
        Activity
      </SectionTitle>
      {records.length === 0 ? (
        <EmptyState>This agent has not requested any actions.</EmptyState>
      ) : (
        <EvidenceTable records={records} caption={`Evidence for ${agent.name}`} hideAgent />
      )}
    </>
  );
}
