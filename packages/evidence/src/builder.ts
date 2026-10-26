import {
  type ActionRiskAssessment,
  assuranceOf,
  digest,
  newId,
  redactParameters,
  type Action,
  type ActionOutcome,
  type AgentPrincipal,
  type ApprovalRequest,
  type Decision,
  type EvidenceRecord,
  type EvidenceRevalidation,
  type ExecutionAttempt,
  type Tool,
} from '@arc-control/schemas';

export interface EvidenceInput {
  readonly action: Action;
  readonly principal: AgentPrincipal;
  readonly tool: Tool;
  readonly decision: Decision;
  readonly outcome: ActionOutcome;
  readonly approval?: ApprovalRequest;
  readonly execution?: ExecutionAttempt;
  /**
   * The release-time revalidation, when there was one.
   *
   * Passed in rather than derived because it is a fact about a moment the
   * builder is not present for: what current policy said, and what the agent
   * and tool looked like, immediately before the connector was called.
   */
  readonly revalidation?: EvidenceRevalidation;
  /** Risk classification as of decision time, recorded for the auditor. */
  readonly risk?: ActionRiskAssessment;
  readonly now?: Date;
}

/**
 * Builds the evidence record for one action.
 *
 * Evidence is written for every outcome, including a denial — the attempt is
 * the security signal, and a control plane that only records its successes
 * cannot answer the question an incident review actually asks.
 *
 * The record is self-contained: an auditor holding the JSON can see who acted,
 * what they asked for, which policy decided, who approved, and what happened,
 * without access to ARC Control itself. The trailing `integrityDigest` covers
 * every other field, so a record that has been edited no longer verifies.
 */
export function buildEvidence(input: EvidenceInput): EvidenceRecord {
  const { action, principal, tool, decision } = input;
  const createdAt = (input.now ?? new Date()).toISOString();

  const content = {
    schemaVersion: 1 as const,
    actionId: action.id,
    organizationId: action.organizationId,
    environment: action.environment,

    agent: {
      id: principal.agentId,
      name: principal.agentName,
      owner: principal.owner,
      roles: principal.roles,
      credentialId: principal.credentialId,
    },

    tool: {
      name: tool.name,
      system: tool.system,
      effect: tool.effect,
      riskTier: tool.riskTier,
      connector: tool.connector,
    },

    request: {
      parameters: redactParameters(action.parameters, tool.parameters),
      parametersDigest: action.parametersDigest,
      ...(action.intent ? { intent: action.intent } : {}),
      ...(action.correlationId ? { correlationId: action.correlationId } : {}),
      requestedAt: action.requestedAt,
    },

    decision: {
      id: decision.id,
      effect: decision.effect,
      ...(decision.policyId ? { policyId: decision.policyId } : {}),
      ...(decision.policyVersion !== undefined ? { policyVersion: decision.policyVersion } : {}),
      ...(decision.ruleId ? { ruleId: decision.ruleId } : {}),
      reason: decision.reason,
      decidedAt: decision.decidedAt,
      evaluationMs: decision.evaluationMs,
      traceDigest: digest(decision.trace),
    },

    ...(input.approval
      ? {
          approval: {
            id: input.approval.id,
            status: input.approval.status,
            approvers: input.approval.requirement.approvers,
            minApprovals: input.approval.requirement.minApprovals,
            votes: input.approval.votes.map((vote) => ({
              approver: vote.approver,
              vote: vote.vote,
              votedAt: vote.votedAt,
              // Carried into the exported record. An approval an auditor reads
              // without knowing whether the name was verified invites them to
              // assume it was.
              assurance: assuranceOf(vote),
              ...(vote.issuer ? { issuer: vote.issuer } : {}),
            })),
            ...(input.approval.resolvedAt ? { resolvedAt: input.approval.resolvedAt } : {}),
          },
        }
      : {}),

    ...(input.execution
      ? {
          execution: {
            id: input.execution.id,
            connector: input.execution.connector,
            status: input.execution.status,
            startedAt: input.execution.startedAt,
            finishedAt: input.execution.finishedAt,
            durationMs: input.execution.durationMs,
            ...(input.execution.resultDigest ? { resultDigest: input.execution.resultDigest } : {}),
            ...(input.execution.error ? { error: input.execution.error } : {}),
          },
        }
      : {}),

    ...(input.revalidation ? { revalidation: input.revalidation } : {}),
    ...(input.risk ? { risk: input.risk } : {}),
    outcome: input.outcome,
    obligations: decision.obligations,
    createdAt,
  };

  const id = newId('evidence');

  return {
    id,
    ...content,
    integrityDigest: digest({ id, ...content }),
  };
}

/**
 * Recomputes an evidence record's digest. Pure, so it can be run against an
 * exported record by a party who does not trust the exporter.
 */
export function verifyEvidence(record: EvidenceRecord): boolean {
  const { integrityDigest, ...content } = record;
  return digest(content) === integrityDigest;
}
