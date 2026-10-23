import { Link } from 'react-router-dom';
import { useProto } from '../state/ProtoContext';
import { PageHeader, SectionTitle } from '../components/PageHeader';
import { StackedBar, type Segment } from '../components/StackedBar';
import { ConnectorTable } from '../components/ConnectorTable';
import { CountLine } from '../components/CountLine';
import { OUTCOMES } from '../data/types';
import { outcomeLabel, timestamp } from '../lib/format';

const OUTCOME_COLOR: Record<string, string> = {
  allowed: 'color-mix(in srgb, var(--allow) 55%, var(--surface))',
  executed: 'var(--allow)',
  pending_approval: 'var(--approval)',
  approved: 'color-mix(in srgb, var(--allow) 30%, var(--surface))',
  rejected: 'var(--ink-soft)',
  expired: 'color-mix(in srgb, var(--ink-soft) 45%, var(--surface))',
  denied: 'var(--deny)',
  failed: 'var(--failed)',
};

/** S13 — DERIVED snapshot. Window always stated; no time axis, rates or trends (R8). */
export function Reports() {
  const { evidence, health, approvals, agents, tools, audit } = useProto();
  const window = evidence.slice(0, 200);
  const times = window.map((e) => e.createdAt).sort();
  const n = window.length;

  const segments: Segment[] = OUTCOMES.map((o) => ({ key: o, label: outcomeLabel(o), value: window.filter((e) => e.outcome === o).length, color: OUTCOME_COLOR[o] }));
  const summary = `Of ${n} records: ${segments.filter((s) => s.value).map((s) => `${s.value} ${s.label}`).join(', ')}.`;

  const byRule = new Map<string, { allow: number; approval: number; deny: number }>();
  for (const e of window) {
    const key = e.decision.policyId ? `${e.decision.policyId}/${e.decision.ruleId}` : 'engine default';
    const row = byRule.get(key) ?? { allow: 0, approval: 0, deny: 0 };
    if (e.decision.effect === 'ALLOW') row.allow += 1;
    else if (e.decision.effect === 'DENY') row.deny += 1;
    else row.approval += 1;
    byRule.set(key, row);
  }

  const execByTool = tools.map((t) => {
    const runs = window.filter((e) => e.tool.name === t.name && e.execution).map((e) => e.execution!);
    const d = runs.map((r) => r.durationMs).sort((a, b) => a - b);
    const median = d.length ? (d.length % 2 ? d[(d.length - 1) / 2] : (d[d.length / 2 - 1] + d[d.length / 2]) / 2) : undefined;
    return { tool: t.name, count: runs.length, failures: runs.filter((r) => r.status === 'failed').length, median, max: d[d.length - 1] };
  });

  return (
    <>
      <PageHeader
        title="Reports"
        lede="An operational snapshot computed from records the console already reads. It describes a window of recent records, not a trend."
      />
      <p className="mb-6 rounded-lg border border-line bg-surface px-4 py-3 text-[13px]">
        Window: most recent <strong className="tnum">{n}</strong> evidence records, <span className="mono">{timestamp(times[0])}</span> to{' '}
        <span className="mono">{timestamp(times[times.length - 1])}</span>. Generated {timestamp(new Date().toISOString())}. Pending approvals and inventory are current.
      </p>

      <h2 className="mb-3 text-[16px] font-[650]">Outcome mix</h2>
      <StackedBar segments={segments} summary={summary} />
      <table className="dt compact mt-3 rounded-lg border border-line bg-surface">
        <caption className="sr-only">Outcome mix, data table</caption>
        <thead>
          <tr>
            {segments.map((s) => (
              <th key={s.key} scope="col">
                <span className="inline-flex items-center gap-1.5">
                  <span aria-hidden className="h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />
                  {s.label}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            {segments.map((s) => (
              <td key={s.key} className={`tnum ${s.value ? 'font-semibold' : 'text-ink-soft'}`}>
                {s.value} <span className="font-normal text-ink-soft">({Math.round((s.value / (n || 1)) * 100)}%)</span>
              </td>
            ))}
          </tr>
        </tbody>
      </table>

      <div className="mt-8 grid grid-cols-2 gap-8">
        <section>
          <h2 className="mb-3 text-[16px] font-[650]">By policy and rule</h2>
          <table className="dt compact rounded-lg border border-line bg-surface">
            <caption className="sr-only">Decisions per policy and rule within the window</caption>
            <thead>
              <tr>
                <th scope="col">Policy / rule</th>
                <th scope="col" className="text-right">ALLOW</th>
                <th scope="col" className="text-right">APPROVAL</th>
                <th scope="col" className="text-right">DENY</th>
              </tr>
            </thead>
            <tbody>
              {[...byRule.entries()].map(([key, r]) => (
                <tr key={key}>
                  <td className="mono">
                    {key === 'engine default' ? <span className="font-sans text-ink-soft">engine default</span> : <Link to={`/policies/${key.split('/')[0]}`} className="link">{key}</Link>}
                  </td>
                  <td className="tnum text-right">{r.allow}</td>
                  <td className="tnum text-right">{r.approval}</td>
                  <td className="tnum text-right">{r.deny}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <section>
          <h2 className="mb-3 text-[16px] font-[650]">Execution</h2>
          <table className="dt compact rounded-lg border border-line bg-surface">
            <caption className="sr-only">Execution per tool within the window</caption>
            <thead>
              <tr>
                <th scope="col">Tool</th>
                <th scope="col" className="text-right">Runs</th>
                <th scope="col" className="text-right">Failures</th>
                <th scope="col" className="text-right">Median ms</th>
                <th scope="col" className="text-right">Max ms</th>
              </tr>
            </thead>
            <tbody>
              {execByTool.map((r) => (
                <tr key={r.tool}>
                  <td className="mono">{r.tool}</td>
                  <td className="tnum text-right">{r.count}</td>
                  <td className="tnum text-right">{r.failures}</td>
                  <td className="tnum text-right">{r.median ?? '—'}</td>
                  <td className="tnum text-right">{r.max ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>

      <SectionTitle>Inventory (current)</SectionTitle>
      <CountLine
        items={[
          { value: health.counts.agents, label: 'agents' },
          { value: agents.filter((a) => a.status === 'suspended').length, label: 'suspended' },
          { value: health.counts.tools, label: 'tools' },
          { value: tools.filter((t) => t.riskTier === 'critical').length, label: 'critical-tier tools' },
          { value: health.counts.policies, label: 'policies' },
          { value: approvals.filter((a) => a.status === 'pending').length, label: 'pending approvals' },
          { value: audit.length, label: 'audit records' },
        ]}
      />
      <div className="mt-4">
        <ConnectorTable connectors={health.connectors} />
      </div>
    </>
  );
}
