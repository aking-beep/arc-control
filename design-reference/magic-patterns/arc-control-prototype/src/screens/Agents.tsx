import { Link, useNavigate } from 'react-router-dom';
import { useProto } from '../state/ProtoContext';
import { PageHeader } from '../components/PageHeader';
import { StatusDot } from '../components/Badges';
import { EmptyState } from '../components/EmptyState';

/** S4 — agentsPage (agents half), pages.ts:110-162. */
export function Agents() {
  const { agents, setAgentStatus } = useProto();
  const navigate = useNavigate();

  return (
    <>
      <PageHeader
        title="Agents"
        lede="An agent is the principal ARC Control authorizes. Suspending an agent stops it at authentication, before any policy is consulted."
      />
      {agents.length === 0 ? (
        <EmptyState>No agents are registered.</EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="dt">
            <caption className="sr-only">Registered agents</caption>
            <thead>
              <tr>
                <th scope="col">Status</th>
                <th scope="col">Agent</th>
                <th scope="col">Kind</th>
                <th scope="col">Environment</th>
                <th scope="col">Owner</th>
                <th scope="col">Roles</th>
                <th scope="col" className="text-right">
                  Declared tools
                </th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {agents.map((agent) => {
                const suspended = agent.status === 'suspended';
                return (
                  <tr key={agent.id} className="row-link cursor-pointer" onClick={() => navigate(`/agents/${agent.id}`)}>
                    <td>
                      <StatusDot ok={!suspended} label={agent.status} />
                    </td>
                    <td className={suspended ? 'opacity-70' : ''}>
                      <Link to={`/agents/${agent.id}`} className="link font-semibold" onClick={(e) => e.stopPropagation()}>
                        {agent.name}
                      </Link>
                      <div className="text-[13px] text-ink-soft">{agent.description}</div>
                    </td>
                    <td>{agent.kind}</td>
                    <td className="mono">{agent.environment}</td>
                    <td className="max-w-[200px] truncate" title={agent.owner}>
                      {agent.owner}
                    </td>
                    <td className="mono">{agent.roles.join(', ') || '—'}</td>
                    <td className="tnum text-right">{agent.declaredTools.length}</td>
                    <td className="text-right" onClick={(e) => e.stopPropagation()}>
                      {suspended ? (
                        <button
                          type="button"
                          onClick={() => setAgentStatus(agent.id, 'active')}
                          className="btn h-7 rounded-md border border-line-strong px-3 text-[13px] font-semibold hover:bg-sunk"
                        >
                          Resume
                        </button>
                      ) : (
                        <Link
                          to={`/confirm/suspend/${agent.id}`}
                          className="btn inline-flex h-7 items-center rounded-md border border-deny/40 px-3 text-[13px] font-semibold text-deny hover:bg-deny-bg"
                        >
                          Suspend…
                        </Link>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-4 text-[13px] text-ink-soft">
        Declared tools are what the agent says it uses. They are not a grant: policy decides each request.{' '}
        <Link to="/access" className="link">
          See which policies govern each pair →
        </Link>
      </p>
    </>
  );
}
