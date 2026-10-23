import { ConceptFrame, NoSource } from '../components/ConceptFrame';

/** Smaller concepts: risk score column, tool kill switch, compliance export. */
export function SmallConcepts() {
  return (
    <div className="grid grid-cols-3 gap-6">
      <ConceptFrame title="Risk score column" why="No risk engine; only the static riskTier exists." roadmap="ROADMAP v0.2">
        <table className="dt compact rounded-md border border-line">
          <thead>
            <tr>
              <th>Tool</th>
              <th>Risk tier</th>
              <th>Score</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td colSpan={3} className="p-0">
                <NoSource>No data source</NoSource>
              </td>
            </tr>
          </tbody>
        </table>
      </ConceptFrame>
      <ConceptFrame title="Tool / connector kill switch" why="Only per-agent suspend exists." roadmap="ROADMAP v0.2">
        <p className="text-[13px] text-ink-soft">Reuses the confirm-page pattern. Disabled: no endpoint to call.</p>
        <button type="button" disabled className="mt-3 h-8 cursor-not-allowed rounded-md border border-line-strong px-3 text-[14px] text-ink-soft">
          Stop tool… (unavailable)
        </button>
      </ConceptFrame>
      <ConceptFrame title="Compliance export" why="No export or retention service." roadmap="ROADMAP v0.5">
        <div className="space-y-2">
          {['Window', 'Format', 'Scope'].map((l) => (
            <div key={l}>
              <div className="mb-1 text-[12px] font-semibold text-ink-soft">{l}</div>
              <div className="h-7 rounded-md border border-line-strong bg-sunk/60" aria-hidden />
            </div>
          ))}
          <button type="button" disabled className="mt-1 h-8 cursor-not-allowed rounded-md border border-line-strong px-3 text-[14px] text-ink-soft">
            Export (unavailable)
          </button>
        </div>
      </ConceptFrame>
    </div>
  );
}
