/**
 * Policy change tooling: diffing, version history and simulation.
 *
 * 1.0 could publish a policy and tell you what it says now. It could not tell
 * you what changed, who changed it, or what a proposed change would do before
 * you shipped it — which are the three questions that stand between an
 * operator and actually editing a production permission.
 *
 * The hard constraint on everything in this file: **simulation never writes
 * and never executes.** It builds an evaluation input, runs the policy engine
 * over an in-memory candidate document, and returns what the decision would
 * have been. No action is recorded, no evidence is minted, no connector is
 * called, and the stored policy set is untouched. That is enforced by
 * construction — nothing here is handed anything it could write to except the
 * version history, which only `recordVersion` touches.
 */
import {
  canonicalize,
  digest,
  newId,
  type Action,
  type Agent,
  type Decision,
  type Policy,
  type PolicyChange,
  type PolicyEffect,
  type PolicyInput,
  type PolicyVersionRecord,
  type Tool,
} from '@arc-control/schemas';
import { buildPolicyInput, PolicyEngine } from '@arc-control/policy-engine';
import type { ControlStore } from '@arc-control/store';

// --- diffing ---------------------------------------------------------------

/**
 * What changed between two versions of a policy.
 *
 * Structural rather than textual: an operator reading "rule
 * `over-10k` changed effect from REQUIRE_APPROVAL to ALLOW" learns something a
 * line diff of JSON does not tell them, and that sentence is what belongs in
 * an audit record.
 */
export function diffPolicies(previous: Policy | undefined, next: Policy): readonly PolicyChange[] {
  if (!previous) {
    return [
      {
        kind: 'metadata_changed',
        detail: `created at version ${next.version} with ${next.rules.length} rule(s), fallback ${next.fallback.effect}`,
      },
    ];
  }

  const changes: PolicyChange[] = [];

  if (previous.enabled !== next.enabled) {
    changes.push({ kind: next.enabled ? 'enabled' : 'disabled', detail: `policy ${next.enabled ? 'enabled' : 'disabled'}` });
  }

  const before = new Map(previous.rules.map((rule) => [rule.id, rule]));
  const after = new Map(next.rules.map((rule) => [rule.id, rule]));

  for (const [id, rule] of after) {
    const old = before.get(id);
    if (!old) {
      changes.push({ kind: 'rule_added', ruleId: id, detail: `rule "${id}" added with effect ${rule.effect}` });
      continue;
    }

    const differences: string[] = [];
    if (old.effect !== rule.effect) differences.push(`effect ${old.effect} -> ${rule.effect}`);
    if (canonicalize(old.when) !== canonicalize(rule.when)) differences.push('condition changed');
    if (old.reason !== rule.reason) differences.push('reason changed');
    if (canonicalize(old.approval ?? null) !== canonicalize(rule.approval ?? null)) {
      differences.push('approval requirement changed');
    }
    if (canonicalize(old.obligations ?? []) !== canonicalize(rule.obligations ?? [])) {
      differences.push('obligations changed');
    }

    if (differences.length > 0) {
      changes.push({ kind: 'rule_changed', ruleId: id, detail: `rule "${id}": ${differences.join(', ')}` });
    }
  }

  for (const id of before.keys()) {
    if (!after.has(id)) {
      changes.push({ kind: 'rule_removed', ruleId: id, detail: `rule "${id}" removed` });
    }
  }

  if (canonicalize(previous.match) !== canonicalize(next.match)) {
    changes.push({
      kind: 'match_changed',
      detail: `selectors changed from ${canonicalize(previous.match)} to ${canonicalize(next.match)}`,
    });
  }

  if (canonicalize(previous.fallback) !== canonicalize(next.fallback)) {
    changes.push({
      kind: 'fallback_changed',
      detail: `fallback changed from ${previous.fallback.effect} to ${next.fallback.effect}`,
    });
  }

  if (previous.name !== next.name || previous.description !== next.description) {
    changes.push({ kind: 'metadata_changed', detail: 'name or description changed' });
  }

  return changes;
}

// --- version history -------------------------------------------------------

export interface RecordVersionOptions {
  readonly store: ControlStore;
  readonly previous: Policy | undefined;
  readonly next: Policy;
  readonly publishedBy: string;
  readonly via: string;
  readonly now?: Date;
}

/**
 * Appends a version-history entry.
 *
 * The full document is stored, not a patch. Reconstructing version 3 by
 * replaying patches works until one of them is wrong, and the whole purpose of
 * the history is to be the thing you trust when something has gone wrong.
 */
export async function recordVersion(options: RecordVersionOptions): Promise<PolicyVersionRecord> {
  const record: PolicyVersionRecord = {
    id: newId('policyVersion'),
    policyId: options.next.id,
    version: options.next.version,
    document: options.next,
    ...(options.previous ? { previous: options.previous } : {}),
    publishedBy: options.publishedBy,
    via: options.via,
    publishedAt: (options.now ?? new Date()).toISOString(),
    documentDigest: digest(options.next),
    changes: diffPolicies(options.previous, options.next),
  };

  await options.store.policyVersions.put(record.id, record);
  return record;
}

/**
 * Version history for one policy, newest first.
 *
 * Ordered by publish time, then by reverse insertion order. The second part is
 * not redundant: enabling or disabling a policy records a history entry
 * *without* bumping its version, so two entries can share both a version and a
 * millisecond, and sorting on those alone put a disable ahead of the creation
 * that preceded it, depending on how fast the machine was. The collection
 * preserves insertion order and every entry is appended, so insertion order is
 * chronological order and breaks the tie correctly every time.
 */
export async function policyHistory(store: ControlStore, policyId: string): Promise<readonly PolicyVersionRecord[]> {
  const records = await store.policyVersions.filter((record) => record.policyId === policyId);
  return records
    .map((record, index) => ({ record, index }))
    .sort((a, b) => Date.parse(b.record.publishedAt) - Date.parse(a.record.publishedAt) || b.index - a.index)
    .map((entry) => entry.record);
}

// --- simulation ------------------------------------------------------------

export interface SimulationSubject {
  readonly agentName: string;
  readonly tool: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly at?: Date;
}

export interface SimulatedDecision {
  readonly effect: PolicyEffect;
  readonly policyId?: string;
  readonly ruleId?: string;
  readonly reason: string;
}

export interface HypotheticalResult {
  readonly subject: SimulationSubject;
  /** What the policies currently in force would decide. */
  readonly current: SimulatedDecision;
  /** What they would decide with the candidate document applied. */
  readonly candidate: SimulatedDecision;
  readonly changed: boolean;
  /** Full trace under the candidate, for the operator to read. */
  readonly candidateTrace: Decision['trace'];
}

export interface ReplayOutcome {
  readonly actionId: string;
  readonly tool: string;
  readonly agentName: string;
  readonly requestedAt: string;
  readonly currentEffect: PolicyEffect;
  readonly candidateEffect: PolicyEffect;
  readonly candidateReason: string;
}

export interface ReplayResult {
  /** Every action re-decided, in the order they were requested. */
  readonly considered: number;
  /** Only the actions whose effect would differ. */
  readonly changes: readonly ReplayOutcome[];
  readonly from: string;
  readonly to: string;
  /** Actions skipped because the agent or tool they used no longer exists. */
  readonly skipped: readonly { readonly actionId: string; readonly reason: string }[];
  /**
   * Stated on the result because it is the caveat people forget: a replay
   * says what the candidate would have decided about *past* traffic. It says
   * nothing about traffic the change itself would cause, and nothing about
   * actions that never reached ARC.
   */
  readonly limitations: readonly string[];
}

/** Replaces the candidate's own id in the stored set, leaving every other policy in place. */
function withCandidate(policies: readonly Policy[], candidate: Policy): readonly Policy[] {
  return [...policies.filter((policy) => policy.id !== candidate.id), candidate];
}

function summarise(decision: Decision): SimulatedDecision {
  return {
    effect: decision.effect,
    ...(decision.policyId ? { policyId: decision.policyId } : {}),
    ...(decision.ruleId ? { ruleId: decision.ruleId } : {}),
    reason: decision.reason,
  };
}

function inputFor(agent: Agent, tool: Tool, parameters: Readonly<Record<string, unknown>>, at: Date): PolicyInput {
  const action: Action = {
    id: 'arc_act_simulation',
    agentId: agent.id,
    agentName: agent.name,
    organizationId: agent.organizationId,
    environment: agent.environment,
    tool: tool.name,
    toolId: tool.id,
    parameters,
    parametersDigest: digest(parameters),
    requestedAt: at.toISOString(),
  };

  return buildPolicyInput({
    principal: {
      agentId: agent.id,
      agentName: agent.name,
      kind: agent.kind,
      organizationId: agent.organizationId,
      environment: agent.environment,
      owner: agent.owner,
      roles: agent.roles,
      labels: agent.labels,
      credentialId: 'arc_cred_simulation',
    },
    tool,
    action,
    requestedAt: at,
    source: 'internal',
  });
}

export interface SimulateOptions {
  readonly store: ControlStore;
  /** The document being proposed. Not published, not stored. */
  readonly candidate: Policy;
  readonly engine?: PolicyEngine;
}

/**
 * Decides one hypothetical action under both the current and the candidate
 * policy set.
 *
 * Nothing is recorded. The returned trace is the same structure the gateway
 * would have produced, so an operator can read exactly which rule would have
 * fired without an action ever having existed.
 */
export async function simulateHypothetical(
  options: SimulateOptions & { readonly subject: SimulationSubject },
): Promise<HypotheticalResult> {
  const engine = options.engine ?? new PolicyEngine();
  const agent = await options.store.agents.find((candidate) => candidate.name === options.subject.agentName);
  if (!agent) throw new Error(`no agent named "${options.subject.agentName}"`);

  const tool = await options.store.tools.find((candidate) => candidate.name === options.subject.tool);
  if (!tool) throw new Error(`no tool named "${options.subject.tool}"`);

  const policies = await options.store.policies.list();
  const at = options.subject.at ?? new Date();
  const input = inputFor(agent, tool, options.subject.parameters, at);

  const current = engine.evaluate(policies, input);
  const candidate = engine.evaluate(withCandidate(policies, options.candidate), input);

  return {
    subject: options.subject,
    current: summarise(current),
    candidate: summarise(candidate),
    changed: current.effect !== candidate.effect,
    candidateTrace: candidate.trace,
  };
}

/**
 * Re-decides historical actions under a candidate policy and reports what
 * would differ.
 *
 * This is the question an operator actually has before changing a policy —
 * "what does this break?" — and answering it from recorded traffic is far more
 * convincing than reasoning about the rules. The honest limits are returned
 * with the result rather than left to the reader.
 */
export async function simulateAgainstHistory(
  options: SimulateOptions & { readonly from?: Date; readonly to?: Date; readonly limit?: number },
): Promise<ReplayResult> {
  const engine = options.engine ?? new PolicyEngine();
  const to = options.to ?? new Date();
  const from = options.from ?? new Date(to.getTime() - 30 * 86_400_000);

  const [agents, tools, policies, allActions] = await Promise.all([
    options.store.agents.list(),
    options.store.tools.list(),
    options.store.policies.list(),
    options.store.actions.list(),
  ]);

  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
  const candidateSet = withCandidate(policies, options.candidate);

  const actions = allActions
    .filter((action) => {
      const at = Date.parse(action.requestedAt);
      return at >= from.getTime() && at <= to.getTime();
    })
    .slice()
    .sort((a, b) => Date.parse(a.requestedAt) - Date.parse(b.requestedAt))
    .slice(0, options.limit ?? 1000);

  const changes: ReplayOutcome[] = [];
  const skipped: { actionId: string; reason: string }[] = [];

  for (const action of actions) {
    const agent = agentsById.get(action.agentId);
    const tool = toolsByName.get(action.tool);

    // An action whose agent or tool has since been deleted cannot be
    // re-decided faithfully. Skipping it and saying so is better than
    // substituting a default and reporting a difference that is an artefact
    // of the substitution.
    if (!agent) {
      skipped.push({ actionId: action.id, reason: `agent ${action.agentId} no longer exists` });
      continue;
    }
    if (!tool) {
      skipped.push({ actionId: action.id, reason: `tool ${action.tool} is no longer registered` });
      continue;
    }

    const at = new Date(action.requestedAt);
    const input = inputFor(agent, tool, action.parameters, at);

    const current = engine.evaluate(policies, input);
    const candidate = engine.evaluate(candidateSet, input);

    if (current.effect !== candidate.effect) {
      changes.push({
        actionId: action.id,
        tool: action.tool,
        agentName: action.agentName,
        requestedAt: action.requestedAt,
        currentEffect: current.effect,
        candidateEffect: candidate.effect,
        candidateReason: candidate.reason,
      });
    }
  }

  return {
    considered: actions.length - skipped.length,
    changes,
    from: from.toISOString(),
    to: to.toISOString(),
    skipped,
    limitations: [
      'A replay re-decides traffic that already happened. It cannot predict traffic the change itself would cause.',
      'Actions that never reached the gateway are invisible to it, so a replay says nothing about bypass.',
      'Parameters are replayed as recorded. A sensitive parameter that was redacted before storage is replayed redacted, which can change the decision.',
    ],
  };
}
