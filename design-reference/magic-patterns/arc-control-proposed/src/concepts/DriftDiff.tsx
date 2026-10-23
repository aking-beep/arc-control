import { NoSource } from '../components/ConceptFrame';

export function DriftDiff() {
  const cols = [
    { title: 'Added', note: 'never reviewed (MCP-SEC-031)', tone: 'text-failed' },
    { title: 'Modified', note: 'changed after review (MCP-SEC-030)', tone: 'text-deny' },
    { title: 'Removed', note: 'no longer advertised (MCP-SEC-032)', tone: 'text-approval' },
  ];
  return (
    <div className="grid grid-cols-3 gap-4">
      {cols.map((c) => (
        <div key={c.title}>
          <h3 className={`text-[14px] font-semibold ${c.tone}`}>{c.title}</h3>
          <p className="mb-2 text-[12px] text-ink-soft">{c.note}</p>
          <NoSource>No data source</NoSource>
        </div>
      ))}
    </div>
  );
}
