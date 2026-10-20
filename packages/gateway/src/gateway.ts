import {
  ArcError,
  digest,
  newId,
  redactParameters,
  toArcError,
  type Action,
  type ActionRequest,
  type ActionResult,
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

export interface GatewayOptions {
  readonly store: ControlStore;
  readonly policyEngine?: PolicyEngine;
  readonly executor?: Executor;
  readonly defaultOrganizationId?: string;
  readonly defaultEnvironment?: string;
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

  readonly #store: ControlStore;
  readonly #policyEngine: PolicyEngine;
  readonly #executor: Executor;
  readonly #organizationId: string;
  readonly #environment: string;
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

    this.#policyEngine = options.policyEngine ?? new PolicyEngine(shared);
    this.#executor = options.executor ?? new Executor(shared);
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
    const approval = await this.approvals.consume(approvalId);

    const action = await this.#store.actions.get(approval.actionId);
    if (!action) throw new ArcError('not_found', `no action with id ${approval.actionId}`);

    const decision = await this.#store.decisions.get(approval.decisionId);
    if (!decision) throw new ArcError('not_found', `no decision with id ${approval.decisionId}`);

    const tool = await this.tools.get(action.toolId);
    if (!tool) throw new ArcError('unknown_tool', `tool ${action.toolId} is no longer registered`);

    const agent = await this.agents.require(action.agentId);
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
    const input = buildPolicyInput({ principal, tool, action, source });
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
    const record = buildEvidence({ ...input, now: this.#now() });
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
