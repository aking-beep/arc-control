import { useState } from 'react';
import { useProto } from '../state/ProtoContext';
import { PageHeader, SectionTitle } from '../components/PageHeader';
import { ChainVerdict } from '../components/ChainVerdict';
import { ConnectorTable } from '../components/ConnectorTable';
import { Badge, SeverityBadge } from '../components/Badges';
import type { ScanReport } from '../data/types';
import { SAMPLE_TOOLS_JSON, scanPreview } from '../lib/scanPreview';

/** S11 — chain, connector posture, on-demand MCP scan (stateless). */
export function Security() {
  const { verification, health } = useProto();
  const [name, setName] = useState('docs');
  const [endpoint, setEndpoint] = useState('http://mcp.example.com');
  const [toolsJson, setToolsJson] = useState(SAMPLE_TOOLS_JSON);
  const [report, setReport] = useState<ScanReport | undefined>();
  const [error, setError] = useState<string | undefined>();

  return (
    <>
      <PageHeader
        title="Security"
        lede="Integrity of the record, posture of the connectors that carry actions out, and an on-demand check of an MCP server’s advertised tools. Ordered by consequence."
      />

      <h2 className="mb-3 text-[16px] font-[650]">Audit chain</h2>
      <ChainVerdict verification={verification} compact />

      <SectionTitle>Connector posture</SectionTitle>
      <ConnectorTable connectors={health.connectors} />
      <p className="mt-2 text-[13px] text-ink-soft">
        An MCP connector reports drift when its advertised tool surface no longer matches the pinned manifest. The added, removed and modified
        tools are listed by <span className="mono">arc mcp diff</span>; the API exposes only this message.
      </p>

      <SectionTitle>MCP manifest scan</SectionTitle>
      <p className="-mt-1 mb-4 text-[13px] text-ink-soft">
        Results are not saved, and scanning registers nothing. Run <span className="mono">arc mcp scan</span> in CI for a record.
      </p>
      <div className="grid grid-cols-[5fr_7fr] gap-8">
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (toolsJson.length > 64 * 1024) {
              setError('The tools JSON is larger than the 64 KB form limit.');
              return;
            }
            try {
              const tools = JSON.parse(toolsJson);
              if (!Array.isArray(tools)) throw new Error('tools must be a JSON array');
              setError(undefined);
              setReport(scanPreview(name, endpoint, tools));
            } catch (cause) {
              setReport(undefined);
              setError(`invalid_request: ${cause instanceof Error ? cause.message : String(cause)}`);
            }
          }}
        >
          <label className="block text-[12px] font-semibold">
            Server name
            <input value={name} onChange={(e) => setName(e.target.value)} className="mono mt-1 block h-8 w-full rounded-md border border-line-strong bg-surface px-2 text-ink" />
          </label>
          <label className="block text-[12px] font-semibold">
            Endpoint
            <input value={endpoint} onChange={(e) => setEndpoint(e.target.value)} className="mono mt-1 block h-8 w-full rounded-md border border-line-strong bg-surface px-2 text-ink" />
          </label>
          <label className="block text-[12px] font-semibold">
            Tools (JSON array, as the server advertises them)
            <textarea
              value={toolsJson}
              onChange={(e) => setToolsJson(e.target.value)}
              rows={12}
              className="mono mt-1 block w-full rounded-md border border-line-strong bg-surface px-2 py-1.5 text-ink"
            />
          </label>
          <div className="flex items-center gap-3">
            <button type="submit" className="btn h-8 rounded-md bg-accent px-4 text-[14px] font-semibold text-accent-ink hover:opacity-90">
              Scan
            </button>
            <span className="text-[12px] text-ink-soft">Limit 64 KB (MAX_FORM_BYTES)</span>
          </div>
          {error && (
            <p role="alert" className="rounded-md border border-deny/40 bg-deny-bg px-3 py-2 text-[13px] text-deny">
              {error}
            </p>
          )}
        </form>

        <div>
          {!report ? (
            <p className="rounded-lg border border-dashed border-line-strong px-4 py-10 text-center text-[13px] text-ink-soft">
              Findings appear here after a scan. A reload scans again and changes nothing.
            </p>
          ) : (
            <section aria-label="Scan result">
              <div className="mb-3 flex items-center gap-3">
                <Badge tone={report.passed ? 'allow' : 'deny'}>{report.passed ? 'PASS' : 'FAIL'}</Badge>
                <span className="text-[13px]">
                  <span className="mono">{report.server}</span> · {report.toolsScanned} tool(s) · {report.findings.length} finding(s) · highest{' '}
                  <strong>{report.highestSeverity}</strong>
                </span>
              </div>
              <p className="mb-3 text-[12px] text-ink-soft">Fails when any finding is high or critical (scanner.ts). Prototype mirrors a subset of the checks.</p>
              <div className="overflow-hidden rounded-lg border border-line bg-surface">
                <table className="dt">
                  <caption className="sr-only">Findings</caption>
                  <thead>
                    <tr>
                      <th scope="col">Severity</th>
                      <th scope="col">Finding</th>
                      <th scope="col">Tool</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.findings.map((f, i) => (
                      <tr key={`${f.id}-${i}`}>
                        <td>
                          <SeverityBadge severity={f.severity} />
                        </td>
                        <td className="text-[13px]">
                          <div>
                            <span className="mono text-ink-soft">{f.id}</span> <span className="font-semibold">{f.title}</span>
                          </div>
                          <p className="mt-0.5 text-ink-soft">{f.detail}</p>
                          <p className="mt-1">
                            <span className="font-semibold">Remediation:</span> {f.remediation}
                          </p>
                        </td>
                        <td className="mono">{f.tool ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </div>
      </div>
    </>
  );
}
