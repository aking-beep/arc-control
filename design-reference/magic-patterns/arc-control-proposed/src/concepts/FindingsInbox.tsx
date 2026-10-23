import { NoSource } from '../components/ConceptFrame';

export function FindingsInbox() {
  return (
    <div>
      <div className="mb-3 flex gap-1">
        {['Open', 'Acknowledged', 'Suppressed', 'Resolved'].map((s) => (
          <span key={s} className="inline-flex h-7 items-center rounded-md border border-line px-2.5 text-[13px] text-ink-soft">
            {s}
          </span>
        ))}
      </div>
      <table className="dt compact rounded-md border border-line">
        <thead>
          <tr>
            <th>Severity</th>
            <th>Finding</th>
            <th>Server · tool</th>
            <th>First seen</th>
            <th>State</th>
            <th>Owner</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td colSpan={6} className="p-0">
              <NoSource>No data source: findings are not persisted.</NoSource>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
