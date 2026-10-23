import { NoSource, Slot } from '../components/ConceptFrame';

export function PolicySimulator() {
  return (
    <div className="grid grid-cols-[5fr_7fr] gap-8">
      <div className="grid grid-cols-2 gap-3">
        <Slot label="Agent" />
        <Slot label="Tool" />
        <Slot label="Parameters (JSON)" wide />
        <Slot label="Environment" />
        <div className="flex items-end">
          <button type="button" disabled className="h-8 cursor-not-allowed rounded-md border border-line-strong px-4 text-[14px] text-ink-soft">
            Explain (unavailable)
          </button>
        </div>
      </div>
      <div>
        <div className="mb-1 text-[12px] font-semibold text-ink-soft">Would-be decision and trace</div>
        <table className="dt compact rounded-md border border-line">
          <thead>
            <tr>
              <th>Policy</th>
              <th>Rule</th>
              <th>Result</th>
              <th>Effect</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td colSpan={4} className="p-0">
                <NoSource>No data source: the explain endpoint is agent-only.</NoSource>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
