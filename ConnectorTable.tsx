import type { Health } from '../data/types';
import { StatusDot } from './Badges';

/** connectorTable(connectors) — /health connectors[], detail verbatim. */
export function ConnectorTable({ connectors }: { connectors: Health['connectors'] }) {
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-surface">
      <table className="dt">
        <caption className="sr-only">Connector health</caption>
        <thead>
          <tr>
            <th scope="col">Connector</th>
            <th scope="col">Health</th>
            <th scope="col">Detail (as reported)</th>
          </tr>
        </thead>
        <tbody>
          {connectors.map((c) => (
            <tr key={c.name} className={c.healthy ? '' : 'bg-deny-bg'}>
              <td className="mono font-semibold">{c.name}</td>
              <td>
                <StatusDot ok={c.healthy} label={c.healthy ? 'healthy' : 'unhealthy'} />
              </td>
              <td className={c.healthy ? 'text-ink-soft' : 'text-deny'}>{c.detail ?? 'No health check; reported healthy by default'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
