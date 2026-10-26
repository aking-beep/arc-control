/**
 * Coverage analysis: what is not governed at all.
 *
 * This is a different question from "are the controls passing", and in sales
 * conversations it is the more dangerous one. A deployment can have every
 * control green and twelve agents nobody has ever written a policy for,
 * because a control can only assess what is in scope and an ungoverned agent
 * is, by construction, out of scope. Coverage closes that gap by reporting the
 * denominators rather than the ratios.
 *
 * Nothing here produces a percentage. A single number invites a target, a
 * target invites gaming it, and "94% covered" tells a reader nothing about
 * whether the missing 6% is a dormant test agent or the one with production
 * database credentials. The report lists the actual gaps, by name.
 */
import type {
  Action,
  Agent,
  ControlAssessment,
  ControlDefinition,
  ControlFrequency,
  CoverageReport,
  EvidenceRecord,
  Policy,
  Tool,
} from '@arc-control/schemas';
import { REQUIRED_GOVERNANCE_FIELDS } from '@arc-control/schemas';
import type { ControlStore } from '@arc-control/store';
import { highImpactTools, policiesCovering } from './evaluate.js';

/** How long a control's result stays current, by its stated frequency. */
const FRESHNESS_DAYS: Readonly<Record<ControlFrequency, number>> = {
  continuous: 1,
  daily: 2,
  weekly: 10,
  monthly: 40,
  quarterly: 100,
  annual: 400,
};

export interface CoverageOptions {
  readonly store: ControlStore;
  readonly organizationId?: string;
  readonly from?: Date;
  readonly to?: Date;
  readonly now?: () => Date;
}

export async function buildCoverageReport(options: CoverageOptions): Promise<CoverageReport> {
  const now = (options.now ?? (() => new Date()))();
  const to = options.to ?? now;
  const from = options.from ?? new Date(to.getTime() - 30 * 86_400_000);

  const [agents, tools, policies, allActions, allEvidence, controls, assessments] = await Promise.all([
    options.store.agents.list(),
    options.store.tools.list(),
    options.store.policies.list(),
    options.store.actions.list(),
    options.store.evidence.list(),
    options.store.controls.list(),
    options.store.assessments.list(),
  ]);

  const actions = allActions.filter((action) => {
    const at = Date.parse(action.requestedAt);
    return at >= from.getTime() && at <= to.getTime();
  });
  const actionIds = new Set(actions.map((action) => action.id));
  const evidence = allEvidence.filter((record) => actionIds.has(record.actionId));

  return {
    organizationId: options.organizationId ?? 'default',
    window: {
      from: from.toISOString(),
      to: to.toISOString(),
      actionsConsidered: actions.length,
      evidenceConsidered: evidence.length,
    },
    ungovernedAgents: ungoverned(agents),
    uncoveredTools: uncoveredTools(tools, agents, policies, now),
    uncoveredAgents: uncoveredAgents(agents, tools, policies, now),
    staleControls: staleControls(controls, assessments, now),
    actionsMissingEvidence: missingEvidence(actions, evidence),
    totals: {
      agents: agents.length,
      tools: tools.length,
      policies: policies.filter((policy) => policy.enabled).length,
      controls: controls.filter((control) => control.enabled).length,
      controlsAssessed: new Set(assessments.map((assessment) => assessment.controlId)).size,
    },
    generatedAt: now.toISOString(),
  };
}

/** Agents whose governance record is absent or incomplete. */
function ungoverned(agents: readonly Agent[]): CoverageReport['ungovernedAgents'] {
  const out: { id: string; name: string; missing: string[] }[] = [];

  for (const agent of agents) {
    if (agent.status === 'retired') continue;
    const missing: string[] = [];

    if (!agent.owner.trim()) missing.push('owner');
    if (!agent.governance) missing.push('governance record');
    else {
      for (const field of REQUIRED_GOVERNANCE_FIELDS) {
        const value = agent.governance[field];
        if (value === undefined || (typeof value === 'string' && !value.trim())) missing.push(field);
      }
    }

    if (missing.length > 0) out.push({ id: agent.id, name: agent.name, missing });
  }

  return out;
}

/**
 * High-impact tools no enabled policy selects for any active agent.
 *
 * Restricted to high-impact tools on purpose: reporting every low-risk read
 * tool with no bespoke policy would bury the two that matter.
 */
function uncoveredTools(
  tools: readonly Tool[],
  agents: readonly Agent[],
  policies: readonly Policy[],
  now: Date,
): CoverageReport['uncoveredTools'] {
  const active = agents.filter((agent) => agent.status === 'active');

  return highImpactTools(tools)
    .filter((tool) => !active.some((agent) => policiesCovering(policies, agent, tool, now).length > 0))
    .map((tool) => ({ name: tool.name, riskTier: tool.riskTier, effect: tool.effect }));
}

/** Active agents no enabled policy selects for any registered tool. */
function uncoveredAgents(
  agents: readonly Agent[],
  tools: readonly Tool[],
  policies: readonly Policy[],
  now: Date,
): CoverageReport['uncoveredAgents'] {
  return agents
    .filter((agent) => agent.status === 'active')
    .filter((agent) => !tools.some((tool) => policiesCovering(policies, agent, tool, now).length > 0))
    .map((agent) => ({ id: agent.id, name: agent.name }));
}

/** Controls never assessed, or whose newest assessment is older than their frequency allows. */
function staleControls(
  controls: readonly ControlDefinition[],
  assessments: readonly ControlAssessment[],
  now: Date,
): CoverageReport['staleControls'] {
  const newest = new Map<string, string>();
  for (const assessment of assessments) {
    const current = newest.get(assessment.controlId);
    if (!current || Date.parse(assessment.evaluatedAt) > Date.parse(current)) {
      newest.set(assessment.controlId, assessment.evaluatedAt);
    }
  }

  const out: { controlId: string; lastAssessedAt?: string; frequency: ControlFrequency }[] = [];
  for (const control of controls) {
    if (!control.enabled) continue;
    const last = newest.get(control.id);

    if (!last) {
      out.push({ controlId: control.id, frequency: control.frequency });
      continue;
    }

    const age = (now.getTime() - Date.parse(last)) / 86_400_000;
    if (age > FRESHNESS_DAYS[control.frequency]) {
      out.push({ controlId: control.id, lastAssessedAt: last, frequency: control.frequency });
    }
  }

  return out;
}

/**
 * Actions in the window with no evidence record.
 *
 * This should always be empty. The gateway writes evidence on every path,
 * including every error path, so a non-empty list here is not a governance gap
 * but a defect in ARC itself — which is why it is reported separately from
 * everything else above rather than folded into a coverage count.
 */
function missingEvidence(actions: readonly Action[], evidence: readonly EvidenceRecord[]): readonly string[] {
  const covered = new Set(evidence.map((record) => record.actionId));
  return actions.filter((action) => !covered.has(action.id)).map((action) => action.id);
}
