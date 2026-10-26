/**
 * The control evaluators.
 *
 * Each evaluator is a pure function from a pre-loaded snapshot of the window
 * to a status, a sentence and a list of observations. That shape is forced by
 * what the results are for: an assessment has to be reproducible from the
 * records it cites, so an evaluator may not read anything it was not handed,
 * may not call out to a connector, and may not depend on the clock beyond the
 * window it was given.
 *
 * The rule the whole module turns on, stated once here and enforced in every
 * evaluator below: **a question that cannot be answered returns
 * `not_assessable`, never `pass`.** There is no path through this file that
 * reports success because there was nothing to look at. An empty window
 * reports an empty window. A deployment fact ARC cannot see reports that it
 * cannot see it. This costs us green ticks in demos and is the only reason the
 * output is worth anything.
 */
import type {
  Action,
  Agent,
  ApprovalRequest,
  AssessmentWindow,
  ChainVerification,
  ControlObservation,
  ControlStatus,
  EvidenceRecord,
  FindingSeverity,
  HumanAttestation,
  Policy,
  PolicyEffect,
  Tool,
} from '@arc-control/schemas';
import { matchSelectors } from '@arc-control/policy-engine';
import { DEFAULT_REVIEW_INTERVAL_DAYS } from './catalogue.js';

/** Everything an evaluator is allowed to look at. */
export interface EvaluationContext {
  readonly organizationId: string;
  readonly window: AssessmentWindow;
  readonly now: Date;

  /** Current, non-retired agents. */
  readonly agents: readonly Agent[];
  readonly tools: readonly Tool[];
  readonly policies: readonly Policy[];
  /** Actions whose `requestedAt` falls inside the window. */
  readonly actions: readonly Action[];
  /** Evidence records for those actions. */
  readonly evidence: readonly EvidenceRecord[];
  readonly approvals: readonly ApprovalRequest[];

  /** Chain verification as performed for this run. */
  readonly chain?: ChainVerification;
  /** True when the chain was checked against a head recorded outside ARC. */
  readonly externallyAnchored: boolean;
  /** The gateway's effect when no policy matches. */
  readonly fallbackEffect: PolicyEffect;
  /** A current, unexpired attestation for the control under evaluation. */
  readonly attestation?: HumanAttestation;
}

export interface EvaluationResult {
  readonly status: ControlStatus;
  readonly summary: string;
  readonly observations: readonly ControlObservation[];
  /**
   * Overrides the definition's `failureSeverity` for findings raised by this
   * result. Used where the same failure means different things in different
   * configurations — an uncovered tool behind a DENY fallback is a governance
   * gap; behind an ALLOW fallback it is an open door.
   */
  readonly severity?: FindingSeverity;
}

export type ControlEvaluator = (context: EvaluationContext) => EvaluationResult;

// --- helpers ---------------------------------------------------------------

/** An empty window cannot evidence anything about behaviour. */
function emptyWindow(what: string): EvaluationResult {
  return {
    status: 'not_assessable',
    summary: `No ${what} in the window, so there is nothing to assess. This is not a pass.`,
    observations: [],
  };
}

function fromObservations(
  observations: readonly ControlObservation[],
  describe: (failed: number, total: number) => string,
  severity?: FindingSeverity,
): EvaluationResult {
  const failed = observations.filter((observation) => !observation.ok).length;
  return {
    status: failed === 0 ? 'pass' : 'fail',
    summary: describe(failed, observations.length),
    observations,
    ...(severity ? { severity } : {}),
  };
}

function days(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / 86_400_000);
}

// --- ARC-AI-001: identity and ownership ------------------------------------

export const evaluateIdentityOwnership: ControlEvaluator = (context) => {
  const inScope = context.agents.filter((agent) => agent.status !== 'retired');
  if (inScope.length === 0) return emptyWindow('registered agents');

  const observations = inScope.map((agent): ControlObservation => {
    const missing: string[] = [];
    if (!agent.owner.trim()) missing.push('owner');
    if (!agent.governance) missing.push('governance record');
    else {
      if (!agent.governance.purpose.trim()) missing.push('business purpose');
      if (!agent.governance.criticality) missing.push('criticality');
    }

    return {
      subject: agent.id,
      subjectKind: 'agent',
      ok: missing.length === 0,
      detail:
        missing.length === 0
          ? `owned by ${agent.owner}; purpose and criticality recorded`
          : `agent "${agent.name}" is missing: ${missing.join(', ')}`,
    };
  });

  return fromObservations(
    observations,
    (failed, total) =>
      failed === 0
        ? `All ${total} agents have a recorded owner, business purpose and criticality.`
        : `${failed} of ${total} agents lack a complete governance record.`,
  );
};

// --- ARC-AI-002: policy coverage of high-impact tools ----------------------

/** Tools this control cares about: high or critical tier, or irreversible. */
export function highImpactTools(tools: readonly Tool[]): readonly Tool[] {
  return tools.filter(
    (tool) => tool.riskTier === 'high' || tool.riskTier === 'critical' || tool.effect === 'irreversible',
  );
}

/**
 * Whether any enabled policy selects this tool for this agent.
 *
 * Built as a synthetic evaluation input rather than by reading `policy.match`
 * by hand, so coverage uses exactly the same selector logic the gateway uses
 * to decide. A coverage report that disagreed with the enforcement path about
 * what a policy matches would be worse than none.
 */
export function policiesCovering(
  policies: readonly Policy[],
  agent: Agent,
  tool: Tool,
  at: Date,
): readonly Policy[] {
  const input = {
    agent: {
      id: agent.id,
      name: agent.name,
      kind: agent.kind,
      environment: agent.environment,
      owner: agent.owner,
      roles: agent.roles,
      labels: agent.labels,
    },
    tool: {
      name: tool.name,
      system: tool.system,
      effect: tool.effect,
      riskTier: tool.riskTier,
      labels: tool.labels,
    },
    action: { id: 'arc_act_coverage_probe', parameters: {} },
    context: {
      environment: agent.environment,
      requestedAt: at.toISOString(),
      hourUtc: at.getUTCHours(),
      dayOfWeekUtc: at.getUTCDay(),
    },
  } as const;

  return policies.filter((policy) => policy.enabled && matchSelectors(policy.match, input));
}

export const evaluatePolicyCoverage: ControlEvaluator = (context) => {
  const tools = highImpactTools(context.tools);
  if (tools.length === 0) {
    return {
      status: 'not_applicable',
      summary: 'No tool is registered at high or critical risk, and none declares an irreversible effect.',
      observations: [],
    };
  }

  const agents = context.agents.filter((agent) => agent.status === 'active');
  if (agents.length === 0) return emptyWindow('active agents');

  const observations: ControlObservation[] = [];
  for (const tool of tools) {
    for (const agent of agents) {
      const covering = policiesCovering(context.policies, agent, tool, context.now);
      const blanket = covering.filter((policy) => !policy.match.tools && !policy.match.systems);

      observations.push({
        subject: `${agent.name} -> ${tool.name}`,
        subjectKind: 'tool',
        ok: covering.length > 0,
        detail:
          covering.length === 0
            ? `no enabled policy governs ${tool.name} for ${agent.name}; an action would fall to the gateway default of ${context.fallbackEffect}`
            : blanket.length === covering.length
              ? `covered only by policies that select every tool (${covering.map((policy) => policy.id).join(', ')}), which is coverage but probably not the coverage intended`
              : `covered by ${covering.map((policy) => policy.id).join(', ')}`,
      });
    }
  }

  // A gap behind a DENY fallback means the tool is unusable and ungoverned.
  // Behind ALLOW it means it is usable and ungoverned, which is an entirely
  // different conversation, so the finding is ranked differently.
  const severity: FindingSeverity = context.fallbackEffect === 'ALLOW' ? 'critical' : 'medium';

  return fromObservations(
    observations,
    (failed, total) =>
      failed === 0
        ? `Every high-impact tool is governed by an enabled policy for all ${agents.length} active agents (${total} pairs checked).`
        : `${failed} of ${total} agent/tool pairs involving a high-impact tool have no enabled policy; the gateway default is ${context.fallbackEffect}.`,
    severity,
  );
};

// --- ARC-AI-003: nothing executes without authorization --------------------

export const evaluateAuthorizationEnforcement: ControlEvaluator = (context) => {
  if (context.evidence.length === 0) return emptyWindow('actions');

  const approvals = new Map(context.approvals.map((approval) => [approval.id, approval]));

  const observations = context.evidence.map((record): ControlObservation => {
    const executed = record.execution !== undefined;
    const effect = record.decision.effect;

    if (!executed) {
      return {
        subject: record.actionId,
        subjectKind: 'action',
        ok: true,
        detail: `decided ${effect} and did not execute`,
        evidenceIds: [record.id],
      };
    }

    if (effect === 'DENY') {
      return {
        subject: record.actionId,
        subjectKind: 'action',
        ok: false,
        detail: `executed despite a DENY decision citing ${record.decision.policyId ?? 'no policy'}`,
        evidenceIds: [record.id],
      };
    }

    if (effect === 'REQUIRE_APPROVAL') {
      const approval = record.approval ? approvals.get(record.approval.id) : undefined;
      const status = record.approval?.status ?? approval?.status;
      const ok = status === 'approved';
      return {
        subject: record.actionId,
        subjectKind: 'action',
        ok,
        detail: ok
          ? `executed after approval ${record.approval?.id ?? '(unknown)'} reached approved`
          : `executed while its approval was ${status ?? 'absent'}`,
        evidenceIds: [record.id],
      };
    }

    return {
      subject: record.actionId,
      subjectKind: 'action',
      ok: true,
      detail: `executed under an ALLOW from ${record.decision.policyId ?? 'the gateway default'}`,
      evidenceIds: [record.id],
    };
  });

  return fromObservations(observations, (failed, total) =>
    failed === 0
      ? `All ${total} actions in the window executed only under a decision that permitted them.`
      : `${failed} of ${total} actions executed without a decision that permitted them.`,
  );
};

// --- ARC-AI-004: approvals actually happened -------------------------------

export const evaluateApprovalIntegrity: ControlEvaluator = (context) => {
  const held = context.evidence.filter(
    (record) => record.decision.effect === 'REQUIRE_APPROVAL' && record.execution !== undefined,
  );

  if (held.length === 0) {
    return {
      status: 'not_assessable',
      summary:
        'No action in the window both required approval and executed, so the approval path was not exercised. This is not a pass.',
      observations: [],
    };
  }

  const approvals = new Map(context.approvals.map((approval) => [approval.id, approval]));
  const observations: ControlObservation[] = [];

  for (const record of held) {
    const snapshot = record.approval;
    const stored = snapshot ? approvals.get(snapshot.id) : undefined;
    const problems: string[] = [];

    if (!snapshot) {
      problems.push('the evidence record carries no approval although the decision required one');
    } else {
      if (snapshot.status !== 'approved') problems.push(`the approval is ${snapshot.status}, not approved`);

      const approving = new Set(
        snapshot.votes.filter((vote) => vote.vote === 'approve').map((vote) => vote.approver),
      );
      if (approving.size < snapshot.minApprovals) {
        problems.push(`${approving.size} distinct approvals recorded, ${snapshot.minApprovals} required`);
      }

      // Votes must precede execution. A vote timestamped after the action ran
      // is the signature of an approval applied retrospectively, which is the
      // failure this control exists to catch.
      const startedAt = record.execution ? Date.parse(record.execution.startedAt) : undefined;
      if (startedAt !== undefined) {
        const late = snapshot.votes.filter((vote) => Date.parse(vote.votedAt) > startedAt);
        if (late.length > 0) {
          problems.push(
            `${late.length} vote(s) were cast after execution began (${late.map((vote) => vote.approver).join(', ')})`,
          );
        }
      }

      if (stored?.requirement.requireSeparationOfDuties === true) {
        const owner = stored.agentOwner;
        if (approving.has(owner)) {
          problems.push(`separation of duties was required but the agent owner ${owner} approved it`);
        }
      }

      if (stored && stored.consumedAt === undefined) {
        problems.push('the approval was never marked consumed, so it could be replayed');
      }
    }

    observations.push({
      subject: record.actionId,
      subjectKind: 'approval',
      ok: problems.length === 0,
      detail:
        problems.length === 0
          ? `approval ${snapshot?.id} approved by ${snapshot?.approvers.join(', ')} before execution`
          : problems.join('; '),
      evidenceIds: [record.id],
    });
  }

  return fromObservations(observations, (failed, total) =>
    failed === 0
      ? `All ${total} approval-gated executions had a valid human approval recorded before they ran.`
      : `${failed} of ${total} approval-gated executions had a defective approval.`,
  );
};

// --- ARC-AI-005: evidence exists for every action --------------------------

export const evaluateEvidenceCompleteness: ControlEvaluator = (context) => {
  if (context.actions.length === 0) return emptyWindow('actions');

  const byAction = new Map(context.evidence.map((record) => [record.actionId, record]));

  const observations = context.actions.map((action): ControlObservation => {
    const record = byAction.get(action.id);
    if (!record) {
      return {
        subject: action.id,
        subjectKind: 'action',
        ok: false,
        detail: `action on ${action.tool} has no evidence record`,
      };
    }

    const consistent = record.request.parametersDigest === action.parametersDigest;
    return {
      subject: action.id,
      subjectKind: 'action',
      ok: consistent,
      detail: consistent
        ? `evidence ${record.id} recorded, parameter digest matches the action`
        : `evidence ${record.id} records a parameter digest that does not match the stored action`,
      evidenceIds: [record.id],
    };
  });

  return fromObservations(observations, (failed, total) =>
    failed === 0
      ? `All ${total} actions in the window have a consistent evidence record.`
      : `${failed} of ${total} actions have missing or inconsistent evidence.`,
  );
};

// --- ARC-AI-006: audit chain integrity -------------------------------------

export const evaluateAuditIntegrity: ControlEvaluator = (context) => {
  const chain = context.chain;
  if (!chain) {
    return {
      status: 'not_assessable',
      summary: 'The audit chain was not verified during this run.',
      observations: [],
    };
  }

  if (!chain.valid) {
    return {
      status: 'fail',
      summary: `The audit chain failed verification at ${chain.failures.length} point(s).`,
      observations: chain.failures.map((failure) => ({
        subject: String(failure.sequence),
        subjectKind: 'audit' as const,
        ok: false,
        detail: `${failure.problem}: ${failure.detail}`,
      })),
    };
  }

  // The subject is a stable name for the thing being observed, not the value
  // observed. Keying this on the head digest meant every run saw a "new"
  // subject as soon as one more record was appended, so each run opened a
  // fresh finding and resolved the previous one — 720 findings a month for a
  // single unchanged condition. The digest belongs in the detail.
  const observation: ControlObservation = {
    subject: 'audit-chain',
    subjectKind: 'audit',
    ok: context.externallyAnchored,
    detail: context.externallyAnchored
      ? `${chain.recordsChecked} records verified against an externally recorded head at sequence ${chain.headSequence ?? '?'} (${chain.headDigest ?? 'no head digest'})`
      : `${chain.recordsChecked} records are internally consistent, but the head (${chain.headDigest ?? 'none'}) was not checked against an external anchor, so truncation cannot be ruled out`,
  };

  // The deliberate decision in this module: an internally valid but unanchored
  // chain is not a pass. ARC verifying its own log against its own copy of the
  // head proves nothing to a reader who does not trust ARC, and rendering that
  // as green is how an audit finding becomes a surprise.
  return context.externallyAnchored
    ? { status: 'pass', summary: observation.detail, observations: [observation] }
    : {
        status: 'not_assessable',
        summary:
          'The chain is internally consistent, but without an externally anchored head this control cannot pass: truncation is undetectable from the records alone.',
        observations: [observation],
      };
};

// --- ARC-AI-007: MCP manifest pinning --------------------------------------

export const evaluateMcpManifestPinning: ControlEvaluator = (context) => {
  const mcpTools = context.tools.filter((tool) => tool.connector === 'mcp' || tool.connector.startsWith('mcp'));
  if (mcpTools.length === 0) {
    return {
      status: 'not_applicable',
      summary: 'No tool is executed by an MCP connector.',
      observations: [],
    };
  }

  const observations = mcpTools.map((tool): ControlObservation => {
    const config = tool.connectorConfig as Record<string, unknown>;
    const pinned = config['manifestDigest'] ?? config['manifest_digest'] ?? config['pinnedDigest'];
    const ok = typeof pinned === 'string' && pinned.length > 0;
    return {
      subject: tool.name,
      subjectKind: 'tool',
      ok,
      detail: ok
        ? `manifest pinned at ${String(pinned)}, so upstream drift is detectable`
        : `no manifest digest is pinned, so a change to this tool upstream would not be detected`,
    };
  });

  return fromObservations(observations, (failed, total) =>
    failed === 0
      ? `All ${total} MCP-backed tools pin a manifest digest.`
      : `${failed} of ${total} MCP-backed tools pin no manifest digest.`,
  );
};

// --- ARC-AI-008: periodic permission review --------------------------------

export const evaluatePermissionReview: ControlEvaluator = (context) => {
  const active = context.agents.filter((agent) => agent.status === 'active');
  if (active.length === 0) return emptyWindow('active agents');

  const observations = active.map((agent): ControlObservation => {
    const governance = agent.governance;
    const interval = governance?.reviewIntervalDays ?? DEFAULT_REVIEW_INTERVAL_DAYS;
    const last = governance?.lastReviewedAt;

    if (!last) {
      return {
        subject: agent.id,
        subjectKind: 'agent',
        ok: false,
        detail: `no permission review has ever been recorded for "${agent.name}"`,
      };
    }

    const age = days(new Date(last), context.now);
    const ok = age <= interval;
    return {
      subject: agent.id,
      subjectKind: 'agent',
      ok,
      detail: ok
        ? `last reviewed ${age} day(s) ago by ${governance?.lastReviewedBy ?? 'an unrecorded reviewer'}, within the ${interval}-day interval`
        : `last reviewed ${age} day(s) ago, past the ${interval}-day interval`,
    };
  });

  return fromObservations(observations, (failed, total) =>
    failed === 0
      ? `All ${total} active agents have had their permissions reviewed within their interval.`
      : `${failed} of ${total} active agents are overdue a permission review or have never had one.`,
  );
};

// --- ARC-AI-009: gateway bypass (deployment-verified) ----------------------

export const evaluateBypassPrevention: ControlEvaluator = (context) => {
  const systems = [...new Set(context.tools.map((tool) => tool.system))].sort();

  if (!context.attestation) {
    return {
      status: 'not_assessable',
      summary:
        systems.length === 0
          ? 'No governed system is registered, and no attestation is on file. ARC cannot determine this from its own records.'
          : `Whether ${systems.join(', ')} can be reached without passing through ARC depends on network routes and credential scope, which are outside ARC's records. A current attestation from a named reviewer is required; none is on file.`,
      observations: systems.map((system) => ({
        subject: system,
        subjectKind: 'system' as const,
        ok: false,
        detail: 'no current attestation that direct access is prevented',
      })),
    };
  }

  return {
    status: 'attested',
    summary: `Attested by ${context.attestation.attestedBy} on ${context.attestation.attestedAt.slice(0, 10)}; valid until ${context.attestation.expiresAt.slice(0, 10)}. This is a human statement, not a test ARC performed.`,
    observations: systems.map((system) => ({
      subject: system,
      subjectKind: 'system' as const,
      ok: true,
      detail: `covered by attestation ${context.attestation!.id}: ${context.attestation!.statement}`,
    })),
  };
};

/** The evaluator for each baseline control. */
export const EVALUATORS: Readonly<Record<string, ControlEvaluator>> = {
  'ARC-AI-001': evaluateIdentityOwnership,
  'ARC-AI-002': evaluatePolicyCoverage,
  'ARC-AI-003': evaluateAuthorizationEnforcement,
  'ARC-AI-004': evaluateApprovalIntegrity,
  'ARC-AI-005': evaluateEvidenceCompleteness,
  'ARC-AI-006': evaluateAuditIntegrity,
  'ARC-AI-007': evaluateMcpManifestPinning,
  'ARC-AI-008': evaluatePermissionReview,
  'ARC-AI-009': evaluateBypassPrevention,
};

/**
 * A control with no implemented evaluator.
 *
 * Returned for a customer-defined control ARC has no code for, so adding a
 * control to the library never silently produces a pass. The honest answer to
 * "how is this control doing" when nothing evaluates it is "nobody checked".
 */
export const unimplementedEvaluator: ControlEvaluator = () => ({
  status: 'not_assessable',
  summary: 'No automated evaluator is implemented for this control, and no current attestation is on file.',
  observations: [],
});


