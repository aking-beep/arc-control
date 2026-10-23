import { NoSource } from '../components/ConceptFrame';

export function RunTrace() {
  const lanes = ['Requested', 'Decided', 'Approval', 'Executed'];
  return (
    <div>
      <div className="mb-2 flex items-center gap-3 text-[13px] text-ink-soft">
        <span className="font-semibold">Correlation</span>
        <span className="h-7 w-72 rounded-md border border-line-strong bg-sunk/60" aria-hidden />
      </div>
      <div className="grid grid-cols-[140px_1fr] overflow-hidden rounded-md border border-line">
        {lanes.map((lane) => (
          <div key={lane} className="contents">
            <div className="border-b border-r border-line bg-sunk px-3 py-3 text-[13px] font-semibold text-ink-soft">{lane}</div>
            <div className="relative border-b border-line px-3 py-3">
              <div className="h-px w-full bg-line" aria-hidden />
            </div>
          </div>
        ))}
      </div>
      <div className="mt-3">
        <NoSource>No data source: evidence cannot be queried by correlationId.</NoSource>
      </div>
    </div>
  );
}
