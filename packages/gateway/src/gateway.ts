import {
  ACTING_AGENT_STATUS,
  ArcError,
  classifyAction,
  digest,
  newId,
  redactParameters,
  toArcError,
  type Action,
  type ActionRequest,
  type ActionResult,
  type ActionRiskAssessment,
  type AgentPrincipal,
  type ApprovalRequest,
  type Decision,
  type EvidenceRecord,
  type ExecutionAttempt,
  type Policy,
  type Tool,
} from '@arc-control/schemas';
import type { ControlStore } from '@arc-control/store';
import { AgentRegistry } from '@arc-control/agent-identity';
import { ApprovalEngine } from '@arc-control/approvals';
import { AuditLog } from '@arc-control/audit';
import { buildEvidence } from '@arc-control/evidence';
import { Executor, ToolRegistry, type Connector } from '@arc-control/execution';
import { buildPolicyInput, PolicyEngine } from '@arc-control/policy-engine';
import { PolicyStore } from './policies.js';
import { RateLimiter, type RateLimitOptions } from './rate-limit.js';
import { Administration } from './admin.js';

export interface ClassificationOptions {
  /**
   * Amount at or above which a monetary action escalates a risk class.
   *
   * No default: ARC cannot know whether 500 is a lot for this organization,
   * and inventing a number would make the classifier confidently wrong for
   * everyone it does not fit. Unset means monetary amounts are recorded as a
   * factor without escalating.
   */
  readonly monetaryEscalationThreshold?: number;
  /** Environments treated as production. Defaults to `['production']`. */
  readonly productionEnvironments?: readonly string[];
}

export interface GatewayOptions {
  readonly store: ControlStore;
  readonly policyEngine?: PolicyEngine;
  readonly executor?: Executor;
  readonly defaultOrganizationId?: string;
  readonly defaultEnvironment?: string;
  /** Runaway protection. Off unless configured; see `RateLimiter`. */
  readonly rateLimit?: RateLimitOptions;
  readonly classification?: ClassificationOptions;
  readonly now?: () => Date;
}

/** How the action reached the gateway. Recorded, never used to decide. */
export type ActionSource = 'api' | 'mcp' | 'cli' | 'sdk' | 'internal';

export interface SubmitOptions {
  readonly source?: ActionSource;
}

/**
 * The ARC Control gateway.
 *
 * Every agent action passes through here, and the order of the stages is the
 * product:
 *
 *   identify the agent → resolve and validate the action → evaluate policy
 *     → allow, hold for a human, or deny → execute → capture evidence → audit
 *
 * Two invariants hold on every path through this class, including every error
 * path:
 *
 *  1. **Nothing executes without a decision.** The only call to the executor
 *     is downstream of an ALLOW, or of an approval the policy itself demanded.
 *  2. **Every action produces evidence.** Denied, held, executed or failed —
 *     an action that reached the gateway leaves a record behind. The attempt
 *     is the security signal, so there is no path that discards it.
 */
export class Gateway {
  readonly agents: AgentRegistry;
  readonly tools: ToolRegistry;
  readonly policies: PolicyStore;
  readonly approvals: ApprovalEngine;
  readonly audit: AuditLog;
  /** Audited administration: registering agents and tools, publishing policy. */
  readonly admin: Administration;
  /** Runaway protection, checked before an action is recorded. */
  readonly rateLimiter: RateLimiter;

  readonly #store: ControlStore;
  readonly #policyEngine: PolicyEngine;
  readonly #executor: Executor;
  readonly #organizationId: string;
  readonly #environment: string;
  readonly #classification: ClassificationOptions;
  readonly #now: () => Date;

  constructor(options: GatewayOptions) {
    this.#store = options.store;
    this.#organizationId = options.defaultOrganizationId ?? 'default';
    this.#environment = options.defaultEnvironment ?? 'production';
    this.#now = options.now ?? (() => new Date());

    const shared = {
      ...(options.now ? { now: options.now } : {}),
    };

    this.agents = new AgentRegistry(this.#store, {
      defaultOrganizationId: this.#organizationId,
      defaultEnvironment: this.#environment,
      ...shared,
    });
    this.tools = new ToolRegistry(this.#store, shared);
    this.policies = new PolicyStore(this.#store, shared);
    this.approvals = new ApprovalEngine(this.#store, shared);
    this.audit = new AuditLog(this.#store, shared);

    this.admin = new Administration({
      agents: this.agents,
      tools: this.tools,
      policies: this.policies,
      audit: this.audit,
    });

    this.#policyEngine = options.policyEngine ?? new PolicyEngine(shared);
    this.#executor = options.executor ?? new Executor(shared);
    this.#classification = options.classification ?? {};
    this.rateLimiter = new RateLimiter(this.#store, { ...(options.rateLimit ?? {}), ...shared });
  }

  /**
   * Classifies an action's risk.
   *
   * Pure and deterministic, so it is recomputed where it is needed rather than
   * threaded through every call path: policy evaluation and evidence writing
   * both call this with the same tool and action and cannot disagree. It
   * informs policy and is recorded in evidence; nothing consults it to permit
   * anything.
   */
  /**
   * How this gateway is configured to classify risk.
   *
   * Exposed because policy simulation has to classify the same way the
   * gateway does, or a candidate rule reading `$.action.risk.*` could look
   * safe in simulation and decide differently in production — which would
   * make the simulator worse than useless.
   */
  get classification(): ClassificationOptions {
    return this.#classification;
  }

  #classify(tool: Tool, action: Action): ActionRiskAssessment {
    return classifyAction({
      effect: tool.effect,
      riskTier: tool.riskTier,
      parameters: action.parameters,
      environment: action.environment,
      ...(this.#classification.monetaryEscalationThreshold !== undefined
        ? { monetaryEscalationThreshold: this.#classification.monetaryEscalationThreshold }
        : {}),
      ...(this.#classification.productionEnvironments
        ? { productionEnvironments: this.#classification.productionEnvironments }
        : {}),
    });
  }

  addConnector(connector: Connector): this {
    this.tools.addConnector(connector);
    return this;
  }

  /**
   * Authenticates a presented credential and submits an action. This is the
   * entry point the API and the MCP front door both use.
   */
  async handle(apiKey: string | undefined, request: ActionRequest, options: SubmitOptions = {}): Promise<ActionResult> {
    const principal = await this.agents.authenticate(apiKey);
    return this.submit(principal, request, options);
  }

  /**
   * Submits an action for an already-authenticated principal.
   *
   * Stages before the decision — resolving the tool, validating parameters —
   * can fail. Those failures are refusals, not decisions, and they are audited
   * without an evidence record: there is no decision to evidence, and minting
   * one would imply a policy looked at something it never saw.
   */
  async submit(principal: AgentPrincipal, request: ActionRequest, options: SubmitOptions = {}): Promise<ActionResult> {
    const source = options.source ?? 'api';

    let tool: Tool;
    try {
      tool = await this.tools.resolve(request.tool);
      this.tools.validate(tool, request.parameters);
    } catch (cause) {
      const error = toArcError(cause, 'invalid_request');
      await this.audit.append({
        type: 'action.denied',
        organizationId: principal.organizationId,
        actor: principal.agentId,
        subject: request.tool,
        summary: `refused before policy evaluation: ${error.message}`,
        data: { code: error.code, details: error.details, source },
      });
      throw error;
    }

    // Runaway protection sits here on purpose: after the tool is known, so a
    // tighter ceiling for irreversible tools can apply, and before the action
    // is recorded, so a refused action does not itself count toward the limit
    // and compound the problem.
    if (this.rateLimiter.configured) {
      const verdict = await this.rateLimiter.check(principal, tool);
      if (!verdict.allowed) {
        const error = new ArcError('rate_limited', 'rate limit exceeded');
        try {
          RateLimiter.refuse(principal, verdict);
        } catch (cause) {
          const refusal = cause instanceof ArcError ? cause : error;
          await this.audit.append({
            type: 'action.denied',
            organizationId: principal.organizationId,
            actor: principal.agentId,
            subject: request.tool,
            summary: `refused before policy evaluation: ${refusal.message}`,
            data: { code: refusal.code, details: refusal.details, source },
          });
          throw refusal;
        }
      }
    }

    const action = await this.#recordAction(principal, request, tool, source);

    // An idempotent repeat returns the original outcome rather than acting twice.
    const replay = await this.#findReplay(action);
    if (replay) return replay;

    const decision = await this.#decide(principal, tool, action, source);

    switch (decision.effect) {
      case 'DENY':
        return this.#finishDenied(principal, tool, action, decision);
      case 'REQUIRE_APPROVAL':
        return this.#finishPending(principal, tool, action, decision);
      case 'ALLOW':
        return this.#executeAndFinish(principal, tool, action, decision);
    }
  }

  /**
   * Executes an action whose approval has been granted.
   *
   * The approval is consumed first, under the approvals store's lock, so a
   * single grant can authorize exactly one execution even if two callers race
   * to resume it.
   */
  async resume(approvalId: string): Promise<ActionResult> {
    // The gates are re-checked here, and that is the whole point of this
    // block. An approval is a grant from the past; between the vote and the
    // release an operator may have hit the kill switch on the tool or
    // suspended the agent, and a held action that executes anyway makes both
    // controls a lie. `submit` gets these checks from `tools.resolve` and
    // `agents.authenticate`; this path reached neither, so it had to ask
    // again explicitly.
    //
    // They run *before* the approval is consumed, so a refusal does not burn
    // the grant: an operator who disables a tool, tries to resume, then
    // re-enables it should still have their approval. The race protection
    // still comes from `consume`, which remains the single serializing step.
    const pending = await this.approvals.require(approvalId);

    const action = await this.#store.actions.get(pending.actionId);
    if (!action) throw new ArcError('not_found', `no action with id ${pending.actionId}`);

    const decision = await this.#store.decisions.get(pending.decisionId);
    if (!decision) throw new ArcError('not_found', `no decision with id ${pending.decisionId}`);

    // Resolved by name, exactly as `submit` resolves it, so the kill switch is
    // enforced by the same code on both paths rather than by a copy.
    let tool: Tool;
    try {
      tool = await this.tools.resolve(action.tool);
    } catch (cause) {
      const error = toArcError(cause, 'unknown_tool');
      await this.audit.append({
        type: 'action.denied',
        organizationId: action.organizationId,
        actor: 'system',
        subject: action.id,
        summary: `an approved action was refused at release: ${error.message}`,
        data: { code: error.code, approvalId, tool: action.tool, details: error.details },
      });
      throw error;
    }

    const agent = await this.agents.require(action.agentId);
    if (agent.status !== ACTING_AGENT_STATUS) {
      const error = new ArcError(
        'agent_suspended',
        `agent "${agent.name}" is ${agent.status} and cannot act, so this approved action will not be released`,
        { details: { agentId: agent.id, status: agent.status, approvalId } },
      );
      await this.audit.append({
        type: 'action.denied',
        organizationId: action.organizationId,
        actor: 'system',
        subject: action.id,
        summary: `an approved action was refused at release: ${error.message}`,
        data: { code: error.code, approvalId, status: agent.status },
      });
      throw error;
    }

    // Only now is the grant spent.
    const approval = await this.approvals.consume(approvalId);
    const principal = this.agents.toPrincipal(agent, 'approval-resumed');

    await this.audit.append({
      type: 'approval.approved',
      organizationId: action.organizationId,
      actor: approval.votes.map((vote) => vote.approver).join(', ') || 'system',
      subject: action.id,
      summary: `approval granted for ${action.tool} by ${approval.votes.length} approver(s)`,
      data: { approvalId: approval.id, policyId: decision.policyId, ruleId: decision.ruleId },
    });

    return this.#executeAndFinish(principal, tool, action, decision, approval);
  }

  /**
   * The underlying store.
   *
   * Exposed so a surface can use a capability a particular implementation
   * offers — the API asks a `FileStore` for its recorded audit head, which is
   * what lets chain verification detect truncation. Reads and writes still go
   * through the methods above; this is not a general-purpose escape hatch.
   */
  get store(): ControlStore {
    return this.#store;
  }

  // --- reads --------------------------------------------------------------

  /** One evidence record by id. */
  async evidence(evidenceId: string): Promise<EvidenceRecord | undefined> {
    return this.#store.evidence.get(evidenceId);
  }

  /** Evidence for an action, if any has been written yet. */
  async evidenceForAction(actionId: string): Promise<EvidenceRecord | undefined> {
    return this.#store.evidence.find((record) => record.actionId === actionId);
  }

  /** Evidence records, newest first. The console's activity feed. */
  async listEvidence(filter: { agentId?: string; outcome?: string; limit?: number } = {}): Promise<readonly EvidenceRecord[]> {
    const all = await this.#store.evidence.list();
    return all
      .filter((record) => !filter.agentId || record.agent.id === filter.agentId)
      .filter((record) => !filter.outcome || record.outcome === filter.outcome)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, filter.limit ?? 100);
  }

  async action(actionId: string): Promise<Action | undefined> {
    return this.#store.actions.get(actionId);
  }

  /** The full decision, including the rule-by-rule trace. */
  async decision(decisionId: string): Promise<Decision | undefined> {
    return this.#store.decisions.get(decisionId);
  }

  async execution(executionId: string): Promise<ExecutionAttempt | undefined> {
    return this.#store.executions.get(executionId);
  }

  /**
   * Evaluates an action against current policy without recording or executing
   * anything. This is what `arc policy test` and the console's policy
   * simulator call: an operator must be able to ask "what would happen?"
   * without it happening.
   */
  async explain(principal: AgentPrincipal, request: ActionRequest): Promise<Decision> {
    const tool = await this.tools.resolve(request.tool);
    this.tools.validate(tool, request.parameters);

    const action: Action = {
      id: newId('action'),
      agentId: principal.agentId,
      agentName: principal.agentName,
      organizationId: principal.organizationId,
      environment: principal.environment,
      tool: tool.name,
      toolId: tool.id,
      parameters: request.parameters,
      parametersDigest: digest(request.parameters),
      requestedAt: this.#now().toISOString(),
    };

    const policies = await this.policies.list();
    return this.#policyEngine.evaluate(policies, buildPolicyInput({ principal, tool, action }));
  }

  // --- stages -------------------------------------------------------------

  async #recordAction(
    principal: AgentPrincipal,
    request: ActionRequest,
    tool: Tool,
    source: ActionSource,
  ): Promise<Action> {
    const action: Action = {
      id: newId('action'),
      agentId: principal.agentId,
      agentName: principal.agentName,
      organizationId: principal.organizationId,
      environment: principal.environment,
      tool: tool.name,
      toolId: tool.id,
      parameters: request.parameters,
      parametersDigest: digest(request.parameters),
      ...(request.idempotencyKey ? { idempotencyKey: request.idempotencyKey } : {}),
      ...(request.intent ? { intent: request.intent } : {}),
      ...(request.correlationId ? { correlationId: request.correlationId } : {}),
      requestedAt: this.#now().toISOString(),
    };

    await this.#store.actions.put(action.id, action);
    await this.audit.append({
      type: 'action.requested',
      organizationId: action.organizationId,
      actor: action.agentId,
      subject: action.id,
      summary: `${action.agentName} requested ${action.tool}`,
      data: {
        tool: action.tool,
        parameters: redactParameters(action.parameters, tool.parameters),
        source,
        ...(action.correlationId ? { correlationId: action.correlationId } : {}),
      },
    });

    return action;
  }

  async #decide(
    principal: AgentPrincipal,
    tool: Tool,
    action: Action,
    source: ActionSource,
  ): Promise<Decision> {
    const policies: readonly Policy[] = await this.policies.list();
    const input = buildPolicyInput({ principal, tool, action, source, risk: this.#classify(tool, action) });
    const decision = this.#policyEngine.evaluate(policies, input);

    await this.#store.decisions.put(decision.id, decision);
    return decision;
  }

  async #finishDenied(
    principal: AgentPrincipal,
    tool: Tool,
    action: Action,
    decision: Decision,
  ): Promise<ActionResult> {
    const evidence = await this.#recordEvidence({ principal, tool, action, decision, outcome: 'denied' });

    await this.audit.append({
      type: 'action.denied',
      organizationId: action.organizationId,
      actor: action.agentId,
      subject: action.id,
      summary: `${action.tool} denied: ${decision.reason}`,
      data: {
        policyId: decision.policyId,
        ruleId: decision.ruleId,
        reason: decision.reason,
        evidenceId: evidence.id,
      },
    });

    return {
      actionId: action.id,
      outcome: 'denied',
      decision: summarize(decision),
      evidenceId: evidence.id,
      error: { code: 'policy_denied', message: decision.reason },
      completedAt: this.#now().toISOString(),
    };
  }

  async #finishPending(
    principal: AgentPrincipal,
    tool: Tool,
    action: Action,
    decision: Decision,
  ): Promise<ActionResult> {
    if (!decision.approval) {
      // A REQUIRE_APPROVAL decision with no approvers cannot be satisfied by
      // anyone. Failing closed is the only safe reading.
      throw new ArcError('internal', 'policy required approval but named no approvers', {
        details: { policyId: decision.policyId, ruleId: decision.ruleId },
      });
    }

    const approval = await this.approvals.request({
      action,
      decision,
      requirement: decision.approval,
      parameters: redactParameters(action.parameters, tool.parameters),
      agentOwner: principal.owner,
    });

    const evidence = await this.#recordEvidence({
      principal,
      tool,
      action,
      decision,
      outcome: 'pending_approval',
      approval,
    });

    await this.audit.append({
      type: 'approval.requested',
      organizationId: action.organizationId,
      actor: action.agentId,
      subject: action.id,
      summary: `${action.tool} held for approval by ${decision.approval.approvers.join(', ')}`,
      data: {
        approvalId: approval.id,
        policyId: decision.policyId,
        ruleId: decision.ruleId,
        expiresAt: approval.expiresAt,
        evidenceId: evidence.id,
      },
    });

    return {
      actionId: action.id,
      outcome: 'pending_approval',
      decision: summarize(decision),
      evidenceId: evidence.id,
      approvalId: approval.id,
      completedAt: this.#now().toISOString(),
    };
  }

  async #executeAndFinish(
    principal: AgentPrincipal,
    tool: Tool,
    action: Action,
    decision: Decision,
    approval?: ApprovalRequest,
  ): Promise<ActionResult> {
    const connector = this.tools.connector(tool.connector);

    if (!connector) {
      const error = new ArcError('connector_unavailable', `connector "${tool.connector}" is not registered`, {
        details: { tool: tool.name },
      });
      const evidence = await this.#recordEvidence({
        principal,
        tool,
        action,
        decision,
        outcome: 'failed',
        ...(approval ? { approval } : {}),
      });
      await this.audit.append({
        type: 'action.failed',
        organizationId: action.organizationId,
        actor: action.agentId,
        subject: action.id,
        summary: `${action.tool} authorized but not executable: ${error.message}`,
        data: { evidenceId: evidence.id, code: error.code },
      });
      throw error;
    }

    await this.audit.append({
      type: 'action.allowed',
      organizationId: action.organizationId,
      actor: action.agentId,
      subject: action.id,
      summary: `${action.tool} authorized by ${decision.policyId ?? 'default policy'}`,
      data: { policyId: decision.policyId, ruleId: decision.ruleId, reason: decision.reason },
    });

    const { attempt, output } = await this.#executor.execute({ connector, action, tool, principal });
    await this.#store.executions.put(attempt.id, attempt);

    const succeeded = attempt.status === 'succeeded';
    const evidence = await this.#recordEvidence({
      principal,
      tool,
      action,
      decision,
      outcome: succeeded ? 'executed' : 'failed',
      ...(approval ? { approval } : {}),
      execution: attempt,
    });

    await this.audit.append({
      type: succeeded ? 'action.executed' : 'action.failed',
      organizationId: action.organizationId,
      actor: action.agentId,
      subject: action.id,
      summary: succeeded
        ? `${action.tool} executed in ${attempt.durationMs}ms`
        : `${action.tool} failed: ${attempt.error?.message ?? 'unknown error'}`,
      data: {
        executionId: attempt.id,
        connector: attempt.connector,
        durationMs: attempt.durationMs,
        evidenceId: evidence.id,
        ...(attempt.error ? { error: attempt.error } : {}),
      },
    });

    return {
      actionId: action.id,
      outcome: succeeded ? 'executed' : 'failed',
      decision: summarize(decision),
      evidenceId: evidence.id,
      ...(succeeded ? { result: output } : {}),
      ...(attempt.error ? { error: attempt.error } : {}),
      completedAt: this.#now().toISOString(),
    };
  }

  async #recordEvidence(input: {
    principal: AgentPrincipal;
    tool: Tool;
    action: Action;
    decision: Decision;
    outcome: Parameters<typeof buildEvidence>[0]['outcome'];
    approval?: ApprovalRequest;
    execution?: ExecutionAttempt;
  }): Promise<EvidenceRecord> {
    const record = buildEvidence({
      ...input,
      risk: this.#classify(input.tool, input.action),
      now: this.#now(),
    });
    await this.#store.evidence.put(record.id, record);

    await this.audit.append({
      type: 'evidence.recorded',
      organizationId: record.organizationId,
      actor: 'system',
      subject: record.actionId,
      summary: `evidence ${record.id} recorded for ${record.tool.name} (${record.outcome})`,
      data: { evidenceId: record.id, integrityDigest: record.integrityDigest },
    });

    return record;
  }

  /**
   * Finds the outcome of an earlier action with the same idempotency key, so a
   * retrying agent cannot cause a second effect. The key is scoped to the
   * agent and tool: two agents may use the same key without colliding.
   */
  async #findReplay(action: Action): Promise<ActionResult | undefined> {
    if (!action.idempotencyKey) return undefined;

    const earlier = await this.#store.actions.find(
      (candidate) =>
        candidate.id !== action.id &&
        candidate.idempotencyKey === action.idempotencyKey &&
        candidate.agentId === action.agentId &&
        candidate.tool === action.tool,
    );
    if (!earlier) return undefined;

    const evidence = await this.#store.evidence.find((record) => record.actionId === earlier.id);
    if (!evidence) return undefined;

    if (evidence.request.parametersDigest !== action.parametersDigest) {
      throw new ArcError(
        'conflict',
        'this idempotency key was already used for different parameters',
        { details: { idempotencyKey: action.idempotencyKey, originalActionId: earlier.id } },
      );
    }

    const execution = evidence.execution
      ? await this.#store.executions.get(evidence.execution.id)
      : undefined;

    return {
      actionId: earlier.id,
      outcome: evidence.outcome as ActionResult['outcome'],
      decision: {
        effect: evidence.decision.effect,
        ...(evidence.decision.policyId ? { policyId: evidence.decision.policyId } : {}),
        ...(evidence.decision.ruleId ? { ruleId: evidence.decision.ruleId } : {}),
        reason: evidence.decision.reason,
      },
      evidenceId: evidence.id,
      ...(execution?.result !== undefined ? { result: execution.result } : {}),
      ...(evidence.approval ? { approvalId: evidence.approval.id } : {}),
      ...(execution?.error ? { error: execution.error } : {}),
      completedAt: evidence.createdAt,
    };
  }
}

function summarize(decision: Decision): ActionResult['decision'] {
  return {
    effect: decision.effect,
    ...(decision.policyId ? { policyId: decision.policyId } : {}),
    ...(decision.ruleId ? { ruleId: decision.ruleId } : {}),
    reason: decision.reason,
  };
}
