import { ConceptFrame } from './components/ConceptFrame';
import { PolicySimulator } from './concepts/PolicySimulator';
import { RunTrace } from './concepts/RunTrace';
import { Trends } from './concepts/Trends';
import { FindingsInbox } from './concepts/FindingsInbox';
import { DriftDiff } from './concepts/DriftDiff';
import { DelegationChain } from './concepts/DelegationChain';
import { SmallConcepts } from './concepts/SmallConcepts';
import { NotPrototyped } from './concepts/NotPrototyped';

/**
 * Proposed set (plan §12). Every frame is a concept that needs backend work
 * not in aking-beep/arc-control @ d998a110. Structure and empty states only:
 * no sample numbers, names or trends.
 */
export function App() {
  return (
    <div className="theme-light bg-bg text-ink">
      <header className="border-b border-line bg-proto-bg px-12 py-8">
        <p className="text-[13px] font-semibold text-proto">Proposed design · not supported by the code</p>
        <h1 className="mt-1 text-[28px] font-[650] tracking-tight">ARC Control: proposed concepts</h1>
        <p className="mt-2 max-w-[80ch] text-[15px] text-ink-soft">
          Each frame below needs backend work that does not exist in the repository. They show structure and empty states only and must not be
          read as product capability or as data. The implemented console is the separate prototype.
        </p>
      </header>

      <div className="mx-auto max-w-[1180px] space-y-12 px-12 py-10">
        <ConceptFrame
          title="Policy simulator"
          why="/v1/actions/explain requires an agent key, so the console cannot call it."
          roadmap="Not on the roadmap"
        >
          <PolicySimulator />
        </ConceptFrame>
        <ConceptFrame title="Agent run trace" why="No query by correlationId; grouping across the full store is planned." roadmap="ROADMAP v0.3 Observability">
          <RunTrace />
        </ConceptFrame>
        <ConceptFrame title="Trends over time" why="No time-series or aggregation endpoint exists." roadmap="ROADMAP v0.3">
          <Trends />
        </ConceptFrame>
        <ConceptFrame title="Security findings inbox" why="Scans are stateless; there is no findings store, history or triage state." roadmap="ROADMAP v0.2 Scanner">
          <FindingsInbox />
        </ConceptFrame>
        <ConceptFrame title="Manifest drift diff" why="detectDrift is CLI-only (arc mcp diff); the API exposes only a health message." roadmap="ROADMAP v0.2">
          <DriftDiff />
        </ConceptFrame>
        <ConceptFrame title="Delegation chain" why="delegatedFrom is never populated." roadmap="ROADMAP v0.4">
          <DelegationChain />
        </ConceptFrame>
        <SmallConcepts />
        <NotPrototyped />
      </div>
    </div>
  );
}
