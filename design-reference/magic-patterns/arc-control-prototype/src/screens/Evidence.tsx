import { useSearchParams } from 'react-router-dom';
import { useProto } from '../state/ProtoContext';
import { PageHeader } from '../components/PageHeader';
import { FilterBar } from '../components/FilterBar';
import { EvidenceTable } from '../components/EvidenceTable';
import { EmptyState } from '../components/EmptyState';
import { OUTCOMES } from '../data/types';
import { outcomeLabel } from '../lib/format';

/** S7 — evidencePage, pages.ts:267-310. Filters: all 8 outcomes and agentId. */
export function Evidence() {
  const { evidence, agents } = useProto();
  const [params] = useSearchParams();
  const outcome = params.get('outcome') ?? '';
  const agentId = params.get('agentId') ?? '';

  const href = (next: { outcome?: string; agentId?: string }) => {
    const q = new URLSearchParams();
    const o = next.outcome ?? outcome;
    const a = next.agentId ?? agentId;
    if (o) q.set('outcome', o);
    if (a) q.set('agentId', a);
    const s = q.toString();
    return s ? `/evidence?${s}` : '/evidence';
  };

  const byAgent = agentId ? evidence.filter((e) => e.agent.id === agentId) : evidence;
  const shown = (outcome ? byAgent.filter((e) => e.outcome === outcome) : byAgent).slice(0, 100);

  return (
    <>
      <PageHeader
        title="Evidence"
        lede="One record per action, binding what was requested to who or what authorized it and what actually happened. Each record carries a digest over its own contents, so it can be exported to an auditor and verified without trusting the system that produced it."
      />
      <div className="mb-5 space-y-2.5">
        <FilterBar
          label="Outcome"
          current={outcome}
          options={[{ value: '', label: 'All', count: byAgent.length }, ...OUTCOMES.map((o) => ({ value: o, label: outcomeLabel(o), count: byAgent.filter((e) => e.outcome === o).length }))]}
          hrefFor={(value) => href({ outcome: value })}
        />
        <FilterBar
          label="Agent"
          current={agentId}
          options={[{ value: '', label: 'All agents' }, ...agents.map((a) => ({ value: a.id, label: a.name }))]}
          hrefFor={(value) => href({ agentId: value })}
        />
      </div>
      {shown.length === 0 ? <EmptyState>No evidence records match.</EmptyState> : <EvidenceTable records={shown} caption="Evidence records, newest first" />}
      <p className="mt-3 text-[12px] text-ink-soft">Newest first, up to 100 records. Counts are within the loaded records.</p>
    </>
  );
}
