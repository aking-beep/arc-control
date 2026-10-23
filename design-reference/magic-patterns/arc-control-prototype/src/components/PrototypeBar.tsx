import { useProto, type Scenario } from '../state/ProtoContext';

/**
 * Canvas-only chrome, outside the console. Never ships. Carries the fixed
 * prototype label (plan §6 PrototypeLabel) and the review controls.
 */
export function PrototypeBar() {
  const { theme, setTheme, scenario, setScenario, mappingOpen, setMappingOpen } = useProto();

  return (
    <div className="flex h-9 shrink-0 items-center gap-4 border-b border-line bg-proto-bg px-4 text-[12px] text-proto">
      <span className="font-semibold">Prototype</span>
      <span className="truncate">
        Demo seed data from <span className="mono">apps/control-api/src/seed.ts</span>. Not production data. Ships as server-rendered
        templates, not React.
      </span>
      <div className="ml-auto flex shrink-0 items-center gap-3">
        <label className="flex items-center gap-1.5">
          <span>State</span>
          <select
            value={scenario}
            onChange={(event) => setScenario(event.target.value as Scenario)}
            className="h-6 rounded border border-line-strong bg-surface px-1.5 text-[12px] text-ink"
          >
            <option value="seed">Seed as shipped</option>
            <option value="chain-broken">Audit chain broken</option>
            <option value="connector-drift">MCP connector drifted</option>
          </select>
        </label>
        <div role="group" aria-label="Theme" className="flex overflow-hidden rounded border border-line-strong">
          {(['light', 'dark'] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={theme === value}
              onClick={() => setTheme(value)}
              className={`btn h-6 px-2 capitalize ${theme === value ? 'bg-proto text-surface' : 'bg-surface text-ink hover:bg-sunk'}`}
            >
              {value}
            </button>
          ))}
        </div>
        <button
          type="button"
          aria-pressed={mappingOpen}
          onClick={() => setMappingOpen(!mappingOpen)}
          className={`btn h-6 rounded border border-line-strong px-2 ${mappingOpen ? 'bg-proto text-surface' : 'bg-surface text-ink hover:bg-sunk'}`}
        >
          Repository mapping
        </button>
      </div>
    </div>
  );
}
