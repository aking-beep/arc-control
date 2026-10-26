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
  type Agent,
  type AgentPrincipal,
  type ApprovalRequest,
  type Decision,
  type EvidenceRecord,
  type EvidenceRevalidation,
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
import { IdempotencyLedger, type KeyClaim } from './idempotency.js';
import { heldApprovalSatisfies, reapprovalReason, type Revalidation } from './revalidation.js';

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
  readonly #idempotency: IdempotencyLedger;
  readonly #policyEngine: PolicyEngine;
  readonly #executor: Executor;
  readonly #organizationId: string;
  readonly #environment: string;
  readonly #classification: ClassificationOptions;
  readonly #now: () => Date;

  constructor(options: GatewayOptions) {
    this.#store = options.store;
    this.#idempotency = new IdempotencyLedger(this.#store);
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

    const action = this.#buildAction(principal, request, tool, source);

    // Without a key there is nothing to be idempotent about: record and run.
    if (action.idempotencyKey === undefined) {
      await this.#store.actions.put(action.id, action);
      await this.#announceAction(action, tool);
      return this.#pipeline(principal, tool, action);
    }

    // With one, the key is claimed and the action recorded in a single
    // critical section. A caller that loses the claim never reaches policy
    // evaluation or a connector; see `IdempotencyLedger` for why the two
    // steps cannot be separate, and for the single-process bound on this.
    const claim = await this.#idempotency.claim(action);
    if (claim.kind !== 'claimed') return this.#resolveRepeat(action, claim);

    await this.#announceAction(action, tool);
    try {
      const result = await this.#pipeline(principal, tool, action);
      this.#idempotency.settle(claim.scope, result);
      return result;
    } catch (cause) {
      this.#idempotency.abandon(claim.scope, cause);
      throw cause;
    }
  }

  /** Decide, then act on the decision. One path, whatever the caller was. */
  async #pipeline(principal: AgentPrincipal, tool: Tool, action: Action): Promise<ActionResult> {
    const decision = await this.#decide(principal, tool, action);

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
   * The approval is consumed under the approvals store's lock, so a single
   * grant can authorize exactly one execution even if two callers race to
   * resume it.
   *
   * An approval is a statement about the past, and until 2.2 ARC acted on it
   * as a statement about the present: the decision recorded at submission
   * time was executed unchanged, so a deny policy published while the request
   * sat in the queue never reached it. A $1,850 refund held for a manager
   * still refunded the customer after `finance.refund` had been denied
   * outright, while an identical new request was correctly refused.
   * `#revalidate` closes that — current policy is evaluated again here,
   * alongside the lifecycle, kill-switch and binding gates below, and the
   * result goes into evidence whichever way it falls.
   *
   * **What is still not atomic.** Revalidation and the connector call are two
   * steps. The policy snapshot is taken under the policy collection's lock,
   * so a publish part-way through writing its document and version record
   * cannot be observed; the lock is released before the connector runs,
   * because holding it across a vendor API call would let one slow connector
   * stall every policy change in the deployment. A deny published inside that
   * window does not stop the call. ARC records the policy version it decided
   * against, so the gap is visible rather than deniable, but closing it would
   * need the connector to be transactional with the control plane — which is
   * not something ARC can impose on a third-party API.
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
    // Releasability first. The gate checks below audit a refused *approved*
    // release, so a grant that was never approved — still pending, rejected,
    // expired, cancelled or already spent — has to be rejected on its own
    // terms before them, or the caller is told the wrong reason and the chain
    // records a release that was never authorized to begin with.
    const pending = await this.approvals.requireReleasable(approvalId);

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

    // The grant must name *this* action and the decision it was granted
    // against. Nothing in the product routes an approval to a different
    // action, so a mismatch means the store has been edited underneath ARC or
    // an approval id was supplied for an action it never belonged to; either
    // way the human's agreement was not agreement to this.
    const binding = bindingFailure(pending, action, decision);
    if (binding) {
      const error = new ArcError('conflict', binding, {
        details: { approvalId, actionId: action.id, decisionId: decision.id },
      });
      await this.audit.append({
        type: 'action.denied',
        organizationId: action.organizationId,
        actor: 'system',
        subject: action.id,
        summary: `an approved action was refused at release: ${error.message}`,
        data: { code: error.code, approvalId, details: error.details },
      });
      throw error;
    }

    const principal = this.agents.toPrincipal(agent, 'approval-resumed');

    // The last gate, and the one this release exists to add: what does policy
    // say *now*? Evaluated before the grant is spent, so a release refused by
    // a policy that is later corrected does not cost the operator the human
    // decision they already have.
    const revalidation = await this.#revalidate({ principal, agent, tool, action, decision, approval: pending });

    await this.audit.append({
      type: 'action.revalidated',
      organizationId: action.organizationId,
      actor: 'system',
      subject: action.id,
      summary: `${action.tool} revalidated against current policy before release: ${revalidation.record.verdict} — ${revalidation.record.reason}`,
      data: { approvalId, ...revalidation.record },
    });

    if (revalidation.record.verdict === 'denied') {
      return this.#refuseAtRelease(principal, tool, action, decision, pending, revalidation);
    }

    if (revalidation.record.verdict === 'reapproval_required') {
      // The grant is spent even though nothing executed. It cannot authorize
      // this action under current policy, so leaving it releasable would do
      // nothing but mint a fresh superseding request on every retry.
      const spent = await this.approvals.consume(approvalId);
      return this.#finishSuperseded(principal, tool, action, decision, spent, revalidation);
    }

    // Only now is the grant spent for an execution.
    const approval = await this.approvals.consume(approvalId);

    await this.audit.append({
      type: 'approval.approved',
      organizationId: action.organizationId,
      actor: approval.votes.map((vote) => vote.approver).join(', ') || 'system',
      subject: action.id,
      summary: `approval granted for ${action.tool} by ${approval.votes.length} approver(s)`,
      data: { approvalId: approval.id, policyId: decision.policyId, ruleId: decision.ruleId },
    });

    return this.#executeAndFinish(principal, tool, action, decision, approval, revalidation.record);
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

  /**
   * Builds the action record. Pure, and separate from writing it, because
   * with an idempotency key the write happens inside the claim's critical
   * section rather than on its own.
   */
  #buildAction(principal: AgentPrincipal, request: ActionRequest, tool: Tool, source: ActionSource): Action {
    return {
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
      source,
      requestedAt: this.#now().toISOString(),
    };
  }

  /** Records the request in the chain, once the action row is committed. */
  async #announceAction(action: Action, tool: Tool): Promise<void> {
    await this.audit.append({
      type: 'action.requested',
      organizationId: action.organizationId,
      actor: action.agentId,
      subject: action.id,
      summary: `${action.agentName} requested ${action.tool}`,
      data: {
        tool: action.tool,
        parameters: redactParameters(action.parameters, tool.parameters),
        source: action.source,
        ...(action.correlationId ? { correlationId: action.correlationId } : {}),
      },
    });
  }

  /**
   * Answers a request whose idempotency key is already held.
   *
   * Three cases, and none of them reaches a connector. Different parameters
   * under the same key is a conflict and is refused. A key held by a request
   * still running in this process joins it and returns what it returns, so
   * eight parallel refunds produce one refund and eight identical answers. A
   * key held by a request that has finished reads back the outcome recorded
   * for it.
   */
  async #resolveRepeat(action: Action, claim: Exclude<KeyClaim, { kind: 'claimed' }>): Promise<ActionResult> {
    const { original } = claim;

    if (original.parametersDigest !== action.parametersDigest) {
      const error = new ArcError('conflict', 'this idempotency key was already used for different parameters', {
        details: { idempotencyKey: action.idempotencyKey, originalActionId: original.id },
      });
      await this.audit.append({
        type: 'action.denied',
        organizationId: action.organizationId,
        actor: action.agentId,
        subject: original.id,
        summary: `refused before policy evaluation: ${error.message}`,
        data: { code: error.code, details: error.details, source: action.source },
      });
      throw error;
    }

    await this.audit.append({
      type: 'action.replayed',
      organizationId: action.organizationId,
      actor: action.agentId,
      subject: original.id,
      summary:
        claim.kind === 'in_progress'
          ? `${action.agentName} repeated ${action.tool} while the original was still running; joined it rather than acting again`
          : `${action.agentName} repeated ${action.tool}; returned the recorded outcome rather than acting again`,
      data: {
        idempotencyKey: action.idempotencyKey,
        originalActionId: original.id,
        state: claim.kind,
        source: action.source,
      },
    });

    if (claim.kind === 'in_progress') return claim.outcome;
    return this.#recordedOutcome(original);
  }

  /**
   * Reads back the outcome recorded for an action, for a caller presenting
   * its idempotency key.
   *
   * The *latest* evidence for the action, not the first: an action held for
   * approval has a `pending_approval` record and, once released, an
   * `executed` one, and a retry after release must not be told the action is
   * still waiting on a human.
   */
  async #recordedOutcome(original: Action): Promise<ActionResult> {
    const evidence = await this.#latestEvidence(original.id);

    if (!evidence) {
      // The key is held by a request whose outcome was never recorded: the
      // process that claimed it died between the claim and the evidence
      // write, or it is running in another process against a shared
      // directory. ARC does not know whether the effect landed. Executing
      // again is the one answer that can double an irreversible effect, so it
      // refuses and says why.
      throw new ArcError(
        'conflict',
        'an earlier request holds this idempotency key and no outcome was recorded for it; ARC will not execute a second time',
        { details: { idempotencyKey: original.idempotencyKey, originalActionId: original.id } },
      );
    }

    const execution = evidence.execution ? await this.#store.executions.get(evidence.execution.id) : undefined;

    // Where a release-time revalidation changed the answer, it is the answer.
    // Reading `evidence.decision` alone would pair `outcome: 'denied'` with
    // the submission-time `REQUIRE_APPROVAL` that the human was asked about,
    // report no error, and hand back an approval id that is still live — so a
    // caller branching on `decision.effect` would go on waiting for an
    // approval that cannot authorize anything. A retry has to be told what
    // `resume` told the caller who released it.
    const superseded = evidence.revalidation && evidence.revalidation.verdict !== 'proceeded'
      ? evidence.revalidation
      : undefined;

    const decision = superseded
      ? {
          effect: superseded.effect,
          ...(superseded.policyId ? { policyId: superseded.policyId } : {}),
          ...(superseded.ruleId ? { ruleId: superseded.ruleId } : {}),
          reason: superseded.reason,
        }
      : {
          effect: evidence.decision.effect,
          ...(evidence.decision.policyId ? { policyId: evidence.decision.policyId } : {}),
          ...(evidence.decision.ruleId ? { ruleId: evidence.decision.ruleId } : {}),
          reason: evidence.decision.reason,
        };

    const error = superseded
      ? {
          code: superseded.verdict === 'denied' ? 'policy_denied' : 'approval_required',
          message: superseded.reason,
        }
      : execution?.error;

    // A denial names no approval to wait on, on this path as on the live one:
    // the grant on file is not what the caller should act against.
    const approvalId = evidence.outcome === 'denied' ? undefined : evidence.approval?.id;

    return {
      actionId: original.id,
      outcome: evidence.outcome as ActionResult['outcome'],
      decision,
      evidenceId: evidence.id,
      ...(execution?.result !== undefined ? { result: execution.result } : {}),
      ...(approvalId ? { approvalId } : {}),
      ...(error ? { error } : {}),
      completedAt: evidence.createdAt,
    };
  }

  /** The most recently written evidence record for an action. */
  async #latestEvidence(actionId: string): Promise<EvidenceRecord | undefined> {
    const records = await this.#store.evidence.filter((record) => record.actionId === actionId);
    return records.at(-1);
  }

  async #decide(principal: AgentPrincipal, tool: Tool, action: Action): Promise<Decision> {
    const policies: readonly Policy[] = await this.policies.list();
    const input = buildPolicyInput({
      principal,
      tool,
      action,
      ...(action.source ? { source: action.source } : {}),
      risk: this.#classify(tool, action),
    });
    const decision = this.#policyEngine.evaluate(policies, input);

    await this.#store.decisions.put(decision.id, decision);
    return decision;
  }

  /**
   * Re-evaluates current policy for an action that is about to be released,
   * and decides what the approval in hand is still good for.
   *
   * The lifecycle, kill-switch and binding gates have already run in
   * `resume`; their results are carried into the record so an auditor can see
   * they were checked rather than assume it.
   */
  async #revalidate(input: {
    readonly principal: AgentPrincipal;
    readonly agent: Agent;
    readonly tool: Tool;
    readonly action: Action;
    readonly decision: Decision;
    readonly approval: ApprovalRequest;
  }): Promise<Revalidation> {
    const { action, agent, approval, tool } = input;
    const performedAt = this.#now().toISOString();

    const base = {
      performedAt,
      agentStatus: agent.status,
      toolDisabled: tool.disabled === true,
      approvalBound: true,
      approvalId: approval.id,
    } as const;

    // Read and evaluate inside the policy collection's lock, so a publish
    // that is part-way through writing its document and version record
    // cannot be observed in between. Released before the connector runs: see
    // the note on `resume` for what that leaves open.
    const fresh = await this.#store.policies.transact(async () => {
      const policies: readonly Policy[] = await this.policies.list();
      return this.#policyEngine.evaluate(
        policies,
        buildPolicyInput({
          principal: input.principal,
          tool,
          action,
          // Conditions are evaluated as they stand now rather than as they
          // stood at submission. A rule confining an irreversible tool to
          // business hours is a control over when the effect lands, and
          // re-deciding it against yesterday's clock would void it.
          requestedAt: new Date(performedAt),
          ...(action.source ? { source: action.source } : {}),
          risk: this.#classify(tool, action),
        }),
      );
    });
    await this.#store.decisions.put(fresh.id, fresh);

    const cite = {
      decisionId: fresh.id,
      ...(fresh.policyId ? { policyId: fresh.policyId } : {}),
      ...(fresh.policyVersion !== undefined ? { policyVersion: fresh.policyVersion } : {}),
      ...(fresh.ruleId ? { ruleId: fresh.ruleId } : {}),
      traceDigest: digest(fresh.trace),
    };

    switch (fresh.effect) {
      case 'DENY':
        return { record: { ...base, ...cite, effect: 'DENY', verdict: 'denied', reason: fresh.reason }, decision: fresh };

      case 'ALLOW':
        return { record: { ...base, ...cite, effect: 'ALLOW', verdict: 'proceeded', reason: fresh.reason }, decision: fresh };

      case 'REQUIRE_APPROVAL': {
        if (!fresh.approval || fresh.approval.approvers.length === 0) {
          // A requirement naming nobody cannot be satisfied by anybody — the
          // same reading `#finishPending` takes on submission. An empty
          // approver list counts: `validatePolicy` refuses one, but a document
          // written straight into the store does not pass through it, and a
          // control that only holds for well-formed input is not a control.
          return {
            record: {
              ...base,
              ...cite,
              effect: 'REQUIRE_APPROVAL',
              verdict: 'denied',
              reason: 'current policy requires approval but names no approvers, so nothing can authorize this',
            },
            decision: fresh,
          };
        }

        if (heldApprovalSatisfies(fresh.approval, approval)) {
          return {
            record: {
              ...base,
              ...cite,
              effect: 'REQUIRE_APPROVAL',
              verdict: 'proceeded',
              reason: `current policy still requires approval and the approval on file satisfies it: ${fresh.reason}`,
            },
            decision: fresh,
          };
        }

        return {
          record: {
            ...base,
            ...cite,
            effect: 'REQUIRE_APPROVAL',
            verdict: 'reapproval_required',
            reason: reapprovalReason(fresh.approval, approval),
          },
          decision: fresh,
        };
      }
    }
  }

  /**
   * Refuses a release that current policy denies.
   *
   * Reported as an outcome rather than an error, the way a denial on
   * submission is: policy said no, which is a successful decision. Evidence
   * is written first, carrying the original decision and the approval history
   * untouched alongside the revalidation that stopped it — so the record shows
   * both what was agreed and why it did not happen.
   *
   * The grant is deliberately not consumed. An operator who publishes a deny
   * by mistake, or publishes one and then narrows it, should still have the
   * human decision they already obtained.
   */
  async #refuseAtRelease(
    principal: AgentPrincipal,
    tool: Tool,
    action: Action,
    decision: Decision,
    approval: ApprovalRequest,
    revalidation: Revalidation,
  ): Promise<ActionResult> {
    const record = revalidation.record;

    // The denial is claimed under the approvals lock, and only while the grant
    // is still unspent. A policy denial does not consume the grant, so without
    // this a caller whose revalidation denied could write a `denied` record for
    // an action that a concurrent caller had meanwhile released and executed —
    // telling its own caller `denied` about a refund that happened, and leaving
    // two records competing to describe one action. `ApprovalEngine.consume`
    // takes the same lock, so the two are mutually exclusive: either this
    // denial is recorded while the grant is unspent and any execution is
    // evidenced after it, or the grant is already gone and this caller is told
    // that instead of being told a falsehood.
    //
    // Today the executing path happens to write last in every interleaving we
    // can construct, because it does strictly more work after the shared
    // snapshot. That is an accident of await counts, not a property, and
    // evidence integrity is not something to leave resting on one.
    const evidence = await this.#store.approvals.transact(async () => {
      const current = await this.#store.approvals.get(approval.id);
      if (current?.consumedAt) return undefined;

      return this.#recordEvidence({
        principal,
        tool,
        action,
        decision,
        outcome: 'denied',
        approval,
        revalidation: record,
      });
    });

    if (!evidence) {
      throw new ArcError(
        'conflict',
        'this approval was released by another caller while current policy was being re-checked',
        { details: { approvalId: approval.id, actionId: action.id } },
      );
    }

    await this.audit.append({
      type: 'action.denied',
      organizationId: action.organizationId,
      actor: action.agentId,
      subject: action.id,
      summary: `${action.tool} refused at release by current policy: ${record.reason}`,
      data: {
        approvalId: approval.id,
        verdict: record.verdict,
        reason: record.reason,
        ...(record.policyId ? { policyId: record.policyId } : {}),
        ...(record.ruleId ? { ruleId: record.ruleId } : {}),
        evidenceId: evidence.id,
      },
    });

    return {
      actionId: action.id,
      outcome: 'denied',
      decision: summarize(revalidation.decision ?? decision),
      evidenceId: evidence.id,
      error: { code: 'policy_denied', message: record.reason },
      completedAt: this.#now().toISOString(),
    };
  }

  /**
   * Opens a fresh approval because current policy asks for authority the
   * granted one does not carry.
   *
   * The action goes back to `pending_approval` rather than executing or being
   * denied: policy still permits it, but not on the strength of the approval
   * on file. Whoever current policy names is asked instead.
   */
  async #finishSuperseded(
    principal: AgentPrincipal,
    tool: Tool,
    action: Action,
    decision: Decision,
    spent: ApprovalRequest,
    revalidation: Revalidation,
  ): Promise<ActionResult> {
    const fresh = revalidation.decision;
    if (!fresh?.approval) {
      throw new ArcError('internal', 'release-time revalidation asked for a new approval but named no approvers');
    }

    const approval = await this.approvals.request({
      action,
      decision: fresh,
      requirement: fresh.approval,
      parameters: redactParameters(action.parameters, tool.parameters),
      agentOwner: principal.owner,
    });

    const record: EvidenceRevalidation = { ...revalidation.record, supersedingApprovalId: approval.id };
    const evidence = await this.#recordEvidence({
      principal,
      tool,
      action,
      // The original decision stays the decision of record. The re-evaluation
      // lives in `revalidation`, where it adds to history instead of
      // overwriting it.
      decision,
      outcome: 'pending_approval',
      approval,
      revalidation: record,
    });

    await this.audit.append({
      type: 'approval.requested',
      organizationId: action.organizationId,
      actor: action.agentId,
      subject: action.id,
      summary: `${action.tool} held again at release for ${fresh.approval.approvers.join(', ')}: ${record.reason}`,
      data: {
        approvalId: approval.id,
        supersededApprovalId: spent.id,
        policyId: fresh.policyId,
        ruleId: fresh.ruleId,
        expiresAt: approval.expiresAt,
        evidenceId: evidence.id,
      },
    });

    return {
      actionId: action.id,
      outcome: 'pending_approval',
      decision: summarize(fresh),
      evidenceId: evidence.id,
      approvalId: approval.id,
      error: { code: 'approval_required', message: record.reason },
      completedAt: this.#now().toISOString(),
    };
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
    revalidation?: EvidenceRevalidation,
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
        ...(revalidation ? { revalidation } : {}),
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
      ...(revalidation ? { revalidation } : {}),
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
    revalidation?: EvidenceRevalidation;
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
}

function summarize(decision: Decision): ActionResult['decision'] {
  return {
    effect: decision.effect,
    ...(decision.policyId ? { policyId: decision.policyId } : {}),
    ...(decision.ruleId ? { ruleId: decision.ruleId } : {}),
    reason: decision.reason,
  };
}

/**
 * Why a grant does not bind to the action being released, or `undefined` when
 * it does.
 *
 * The approval, the action and the decision are three separate rows, and the
 * action and decision are loaded *through* the approval — so comparing their
 * ids back to the approval's own fields would be vacuous. What is checkable is
 * whether the three rows agree about what was approved: that the decision was
 * reached about this action, that the approval's own record of the agent and
 * tool matches it, and that the parameters still hash to the digest the human
 * was shown. A store edited underneath ARC fails at least one of them.
 */
function bindingFailure(approval: ApprovalRequest, action: Action, decision: Decision): string | undefined {
  if (decision.actionId !== action.id) {
    return 'this approval was granted against a decision that is not a decision about this action';
  }
  if (approval.agentId !== action.agentId) {
    return 'this approval names a different agent than the action it would release';
  }
  if (approval.tool !== action.tool) {
    return 'this approval names a different tool than the action it would release';
  }
  if (digest(action.parameters) !== action.parametersDigest) {
    return "the recorded action's parameters no longer match the digest they were approved under";
  }
  return undefined;
}
