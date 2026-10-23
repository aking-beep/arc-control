import { useProto } from '../state/ProtoContext';
import { PageHeader } from '../components/PageHeader';
import { RiskBadge } from '../components/Badges';
import { EmptyState } from '../components/EmptyState';

/** S5 — agentsPage tools half, split to GET /tools (same data). */
export function Tools() {
  const { tools } = useProto();
  return (
    <>
      <PageHeader
        title="Tools"
        lede="A tool is a capability an agent may ask to use. An action naming an unregistered tool is refused before policy runs."
      />
      {tools.length === 0 ? (
        <EmptyState>No tools are registered. An action naming an unregistered tool is refused before policy runs.</EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="dt">
            <caption className="sr-only">Registered tools</caption>
            <thead>
              <tr>
                <th scope="col">Tool</th>
                <th scope="col">Effect</th>
                <th scope="col">Risk tier</th>
                <th scope="col">System</th>
                <th scope="col">Connector</th>
                <th scope="col">Parameters</th>
              </tr>
            </thead>
            <tbody>
              {tools.map((tool) => (
                <tr key={tool.name}>
                  <td className="w-[28%]">
                    <div className="mono font-semibold">{tool.name}</div>
                    <div className="text-[13px] text-ink-soft">{tool.description}</div>
                  </td>
                  <td>
                    <span className={tool.effect === 'irreversible' ? 'font-semibold text-deny' : tool.effect === 'write' ? 'font-semibold' : 'text-ink-soft'}>
                      {tool.effect}
                    </span>
                  </td>
                  <td>
                    <RiskBadge tier={tool.riskTier} />
                  </td>
                  <td className="mono">{tool.system}</td>
                  <td className="mono">{tool.connector}</td>
                  <td>
                    <ul className="space-y-0.5">
                      {tool.parameters.map((p) => (
                        <li key={p.name} className="text-[13px]">
                          <span className="mono">{p.name}</span>
                          <span className="text-ink-soft">
                            {' '}
                            {p.type}
                            {p.required && <span className="font-semibold text-ink"> · required</span>}
                            {p.minimum !== undefined && ` · ≥ ${p.minimum}`}
                            {p.maxLength !== undefined && ` · max ${p.maxLength.toLocaleString('en-US')} chars`}
                            {p.sensitive && <span className="font-semibold text-approval"> · sensitive (redacted)</span>}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-4 text-[13px] text-ink-soft">A tool with no risk tier shows “—”. Risk is the static tier set at registration; there is no risk score.</p>
    </>
  );
}
