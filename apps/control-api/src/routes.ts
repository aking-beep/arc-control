import { ArcError, type ActionRequest, type AgentGovernance, type ChainExpectation, type Policy } from '@arc-control/schemas';
import type { Gateway } from '@arc-control/gateway';
import type { AssuranceEngine } from '@arc-control/assurance';
import { scanManifest, type McpServerManifest } from '@arc-control/mcp-security';
import { Router, withStatus, type RequestContext } from './http.js';
import type { OperatorAuth } from './operator.js';
import type { Notifier } from '@arc-control/notify';

export interface RouteOptions {
  readonly gateway: Gateway;
  readonly assurance: AssuranceEngine;
  readonly operators: OperatorAuth;
  readonly version: string;
  /** Reported on `/health` so the console can label a demonstration as one. */
  readonly demoSeed?: boolean;
  /** Tells somebody when an action is held for a human. Absent in tests that do not care. */
  readonly notifier?: Notifier;
  readonly defaultOrganizationId?: string;
}

/**
 * The ARC Control API.
 *
 * Two audiences, two credentials, and the distinction is load-bearing:
 *
 *  - **Agents** present an agent API key and may do exactly one thing —
 *    submit an action for a decision. They cannot read policy, cannot read
 *    evidence, cannot approve anything and cannot see other agents. An agent
 *    that could edit the policy governing it would not be governed.
 *  - **Operators** present the operator token and manage everything else.
 */
export function buildRoutes(options: RouteOptions): Router {
  const { gateway, assurance, operators } = options;
  const router = new Router();

  // --- health -------------------------------------------------------------

  /**
   * Every connector is probed and reported, but only one that an enabled tool
   * routes to is `inService` and can make enforcement unhealthy.
   *
   * A disabled tool is refused before policy is consulted, so a connector with
   * no enabled tool takes part in no outcome. Counting it would let one
   * vendor's outage take a whole instance out of a load balancer's rotation
   * even after its tools were switched off — the only recovery then being a
   * restart (#17). Re-enabling a tool puts the connector back in service on
   * the next probe; nothing is cached.
   */
  const connectorHealth = async (tools: readonly { connector: string; disabled?: boolean }[]) => {
    const inService = new Set(tools.filter((tool) => tool.disabled !== true).map((tool) => tool.connector));
    return Promise.all(
      gateway.tools.connectors().map(async (connector) => ({
        name: connector.name,
        inService: inService.has(connector.name),
        ...(connector.health ? await connector.health() : { healthy: true }),
      })),
    );
  };
  const enforcementHealthy = (connectors: readonly { inService: boolean; healthy: boolean }[]) =>
    connectors.every((connector) => !connector.inService || connector.healthy);


  /**
   * Health, with enforcement and assurance reported separately.
   *
   * `status` describes **enforcement only**, and that is deliberate rather
   * than sloppy. A caller gating traffic on this endpoint wants to know
   * whether authorization is working; folding assurance into the same figure
   * would make a stale control assessment look like a reason to stop sending
   * actions, and — far worse — would teach operators to treat a degraded
   * reading as routine.
   *
   * Assurance is reported in its own object, with its own status, so a
   * dashboard can show both and nobody has to guess which one went red.
   * Authorization does not depend on assurance: the engine holds no path into
   * a decision, so there is no failure here that can open the gateway. The
   * reverse is not true, and `assurance.dependsOnEnforcement` says so.
   */
  router.get('/health', async () => {
    const [agents, tools, policies, auditCount] = await Promise.all([
      gateway.agents.list(),
      gateway.tools.list(),
      gateway.policies.list(),
      gateway.audit.count(),
    ]);

    const connectors = await connectorHealth(tools);
    const enforcementOk = enforcementHealthy(connectors);
    const disabledTools = tools.filter((tool) => tool.disabled === true);

    // Assurance is read defensively. A thrown error here must not be able to
    // make the enforcement reading look unhealthy, so it is caught and
    // reported as the assurance layer's own problem.
    let assuranceReport: Record<string, unknown>;
    try {
      const summary = await assurance.summary();
      assuranceReport = {
        status: 'ok',
        controls: summary.controls,
        controlsEnabled: summary.controlsEnabled,
        lastRun: summary.lastRun,
        totals: summary.totals,
        openFindings: summary.openFindings,
        attestedOrUnassessable: summary.attestedOrUnassessable,
        window: summary.window,
      };
    } catch (cause) {
      assuranceReport = {
        status: 'unavailable',
        reason: cause instanceof Error ? cause.message : String(cause),
      };
    }

    return {
      status: enforcementOk ? 'ok' : 'degraded',
      version: options.version,
      operatorAuthConfigured: operators.configured,
      /**
       * How operators are authenticated, stated rather than implied.
       *
       * The console renders this verbatim on its settings page and in its
       * masthead. A deployment whose strongest mode is `claimed` must say so
       * where an operator will see it, because every approval it records is
       * worth less than it looks.
       */
      operatorAuth: {
        modes: operators.modes,
        strongest: operators.strongestAssurance ?? null,
        attributable: operators.strongestAssurance !== undefined && operators.strongestAssurance !== 'claimed',
      },
      demoSeed: options.demoSeed === true,

      enforcement: {
        status: enforcementOk ? 'ok' : 'degraded',
        failureMode: 'closed',
        policyFallbackEffect: 'DENY',
        rateLimiting: gateway.rateLimiter.configured ? 'configured' : 'off',
        connectors,
        disabledTools: disabledTools.map((tool) => tool.name),
      },

      assurance: {
        ...assuranceReport,
        dependsOnEnforcement: true,
        enforcementDependsOnAssurance: false,
      },

      counts: {
        agents: agents.length,
        tools: tools.length,
        policies: policies.length,
        auditRecords: auditCount,
      },
      connectors,
    };
  });

  /**
   * Enforcement health alone.
   *
   * Separate from `/health` so a load balancer or a deployment gate has
   * something to probe that cannot be turned red by the assurance layer. It
   * reads nothing from assurance at all.
   */
  router.get('/health/enforcement', async () => {
    const connectors = await connectorHealth(await gateway.tools.list());
    const healthy = enforcementHealthy(connectors);
    return withStatus(healthy ? 200 : 503, {
      status: healthy ? 'ok' : 'degraded',
      failureMode: 'closed',
      connectors,
    });
  });

  /**
   * Readiness, which is a different question from liveness.
   *
   * Liveness asks "is this process alive"; `/health` answers that and stays
   * 200 through a degraded assurance layer on purpose. Readiness asks "should
   * traffic go here", and the honest answer is no while the store cannot be
   * written to — an orchestrator that cannot tell those apart either restarts
   * a healthy process or routes agents at one that will fail every write.
   *
   * The check is a real read against the store rather than a flag, because the
   * failure this is meant to catch is a volume that has gone away, and a flag
   * set at startup would still say yes.
   */
  router.get('/health/ready', async () => {
    const checks: Record<string, unknown> = {};
    let ready = true;

    try {
      await gateway.policies.list();
      checks.store = 'ok';
    } catch (cause) {
      ready = false;
      checks.store = describeCause(cause);
    }

    try {
      const head = await gateway.audit.head();
      checks.audit = head === undefined ? 'empty' : `sequence ${String(head.sequence)}`;
    } catch (cause) {
      ready = false;
      checks.audit = describeCause(cause);
    }

    // Deliberately not part of readiness: a failing control, an unreachable
    // connector and a broken webhook are all conditions an operator must see
    // and none of them is a reason to stop sending authorization decisions
    // here. Enforcement fails closed by denying, not by refusing traffic.
    return withStatus(ready ? 200 : 503, {
      ready,
      checks,
      notice: ready
        ? null
        : 'This instance cannot reach its own store. Authorization requests sent here will fail.',
    });
  });

  // --- the agent surface --------------------------------------------------

  /**
   * Submit an action. This is the single endpoint an agent needs, and the
   * only one it is permitted to reach.
   */
  router.post('/v1/actions', async (context) => {
    const request = await context.body<ActionRequest>();
    requireFields(request, ['tool']);

    const result = await gateway.handle(
      context.bearer,
      {
        tool: String(request.tool),
        parameters: request.parameters ?? {},
        ...(request.idempotencyKey ? { idempotencyKey: String(request.idempotencyKey) } : {}),
        ...(request.intent ? { intent: String(request.intent) } : {}),
        ...(request.correlationId ? { correlationId: String(request.correlationId) } : {}),
      },
      { source: 'api' },
    );

    // Somebody is now waiting on a human. Telling them is the whole reason
    // the notifier exists, and it happens here rather than inside the gateway
    // so that enforcement keeps no dependency on an outbound network call.
    //
    // Deliberately not awaited for its success: a broken webhook must not turn
    // a correctly held action into an error for the agent. The delivery record
    // carries the failure, and the scheduler retries it.
    if (result.outcome === 'pending_approval' && options.notifier !== undefined && result.approvalId !== undefined) {
      try {
        const request = await gateway.approvals.require(result.approvalId);
        await options.notifier.notify({
          event: 'approval.requested',
          subject: request.id,
          summary:
            `${request.tool} needs a human: ${String(request.requirement.minApprovals)} approval(s) from ` +
            `${request.requirement.approvers.join(', ')}. Requested by ${request.agentName}.`,
          path: `/approvals/${request.id}`,
          details: {
            tool: request.tool,
            agent: request.agentName,
            reason: request.reason,
            expiresAt: request.expiresAt,
          },
          // Already redacted on the request. Sent only to channels that asked.
          parameters: request.parameters,
        });
      } catch (cause) {
        // Recorded, never raised. The action is held correctly whether or not
        // anyone could be told about it.
        await gateway.audit
          .append({
            type: 'action.requested',
            organizationId: options.defaultOrganizationId ?? 'default',
            actor: 'system',
            subject: String(result.approvalId),
            summary: `an approval was raised but could not be notified: ${describeCause(cause)}`,
            data: { approvalId: result.approvalId },
          })
          .catch(() => undefined);
      }
    }

    // A held action is accepted but incomplete; a denial is a successful
    // decision that happens to be "no", and is reported as 200 with the
    // policy citation rather than as a transport error.
    return withStatus(result.outcome === 'pending_approval' ? 202 : 200, result);
  });

  /** Ask what policy *would* do, without recording or executing anything. */
  router.post('/v1/actions/explain', async (context) => {
    const request = await context.body<ActionRequest>();
    requireFields(request, ['tool']);

    const principal = await gateway.agents.authenticate(context.bearer);
    const decision = await gateway.explain(principal, {
      tool: String(request.tool),
      parameters: request.parameters ?? {},
    });

    return {
      effect: decision.effect,
      policyId: decision.policyId,
      ruleId: decision.ruleId,
      reason: decision.reason,
      approval: decision.approval,
      evaluations: decision.evaluations,
      trace: decision.trace,
    };
  });

  // --- agents -------------------------------------------------------------

  router.get('/v1/agents', async (context) => {
    await operators.authenticate(context);
    return { agents: await gateway.agents.list() };
  });

  router.post('/v1/agents', async (context) => {
    const operator = await operators.authenticate(context);
    const body = await context.body<{ name?: string; owner?: string }>();
    requireFields(body, ['name', 'owner']);

    const agent = await gateway.admin.registerAgent(
      body as Parameters<typeof gateway.admin.registerAgent>[0],
      { identifier: operator.identifier, via: 'api' },
    );
    return withStatus(201, agent);
  });

  router.get('/v1/agents/:id', async (context) => {
    await operators.authenticate(context);
    return gateway.agents.require(context.params.id!);
  });

  router.post('/v1/agents/:id/suspend', async (context) => {
    const operator = await operators.authenticate(context);
    return gateway.admin.setAgentStatus(context.params.id!, 'suspended', {
      identifier: operator.identifier,
      via: 'api',
    });
  });

  router.post('/v1/agents/:id/resume', async (context) => {
    const operator = await operators.authenticate(context);
    return gateway.admin.setAgentStatus(context.params.id!, 'active', {
      identifier: operator.identifier,
      via: 'api',
    });
  });

  /** Issues an agent key. The plaintext is in this response and nowhere else, ever. */
  router.post('/v1/agents/:id/keys', async (context) => {
    const operator = await operators.authenticate(context);
    const body = await context.body<{ expiresAt?: string }>();

    const issued = await gateway.admin.issueKey(
      context.params.id!,
      { identifier: operator.identifier, via: 'api' },
      body.expiresAt ? { expiresAt: body.expiresAt } : {},
    );

    return withStatus(201, {
      credential: issued.credential,
      apiKey: issued.apiKey,
      notice: 'This key is shown once. ARC Control stores only a salted hash and cannot recover it.',
    });
  });

  router.get('/v1/agents/:id/keys', async (context) => {
    await operators.authenticate(context);
    return { credentials: await gateway.agents.listKeys(context.params.id!) };
  });

  /** Records an agent's governance record, or a completed permission review. */
  router.post('/v1/agents/:id/governance', async (context) => {
    const operator = await operators.authenticate(context);
    const body = await context.body<Record<string, unknown>>();
    requireFields(body, ['purpose', 'criticality']);

    const criticality = String(body.criticality);
    if (!['low', 'medium', 'high', 'business_critical'].includes(criticality)) {
      throw new ArcError('invalid_request', 'criticality must be low, medium, high or business_critical');
    }

    const governance: AgentGovernance = {
      purpose: String(body.purpose),
      criticality: criticality as AgentGovernance['criticality'],
      ...(body.department ? { department: String(body.department) } : {}),
      ...(body.deploymentRef ? { deploymentRef: String(body.deploymentRef) } : {}),
      ...(Array.isArray(body.dataClassification)
        ? { dataClassification: body.dataClassification.map(String) }
        : {}),
      ...(typeof body.reviewIntervalDays === 'number' ? { reviewIntervalDays: body.reviewIntervalDays } : {}),
      ...(body.lastReviewedAt ? { lastReviewedAt: String(body.lastReviewedAt) } : {}),
      ...(body.lastReviewedBy ? { lastReviewedBy: String(body.lastReviewedBy) } : {}),
      ...(body.reviewDueAt ? { reviewDueAt: String(body.reviewDueAt) } : {}),
      ...(body.reviewNote ? { reviewNote: String(body.reviewNote) } : {}),
    };

    return gateway.admin.setAgentGovernance(context.params.id!, governance, {
      identifier: operator.identifier,
      via: 'api',
    });
  });

  /** Clears a draft agent to act, or brings a suspended one back. */
  router.post('/v1/agents/:id/activate', async (context) => {
    const operator = await operators.authenticate(context);
    return gateway.admin.setAgentStatus(context.params.id!, 'active', {
      identifier: operator.identifier,
      via: 'api',
    });
  });

  /**
   * Retires an agent permanently and revokes every credential it holds.
   *
   * Not reversible: the registry refuses to revive a retired agent, so an
   * operator who wants it back registers a new one and is seen doing so.
   */
  router.post('/v1/agents/:id/retire', async (context) => {
    const operator = await operators.authenticate(context);
    return gateway.admin.retireAgent(context.params.id!, { identifier: operator.identifier, via: 'api' });
  });

  // --- credential inventory -----------------------------------------------

  router.get('/v1/credentials', async (context) => {
    await operators.authenticate(context);
    return {
      credentials: await gateway.agents.credentialInventory({
        expiringWithinDays: positiveInt(context.query.get('expiringWithinDays'), 14),
      }),
    };
  });

  /** Issues a replacement credential and revokes the old one, in that order. */
  router.post('/v1/credentials/:id/rotate', async (context) => {
    const operator = await operators.authenticate(context);
    const body = await context.body<{ expiresAt?: string }>().catch(() => ({}) as { expiresAt?: string });

    const issued = await gateway.admin.rotateKey(
      context.params.id!,
      { identifier: operator.identifier, via: 'api' },
      body.expiresAt ? { expiresAt: body.expiresAt } : {},
    );

    return withStatus(201, {
      credential: issued.credential,
      apiKey: issued.apiKey,
      notice: 'This key is shown once. ARC Control stores only a salted hash and cannot recover it.',
    });
  });

  // --- tools --------------------------------------------------------------

  router.get('/v1/tools', async (context) => {
    await operators.authenticate(context);
    return { tools: await gateway.tools.list() };
  });

  router.post('/v1/tools', async (context) => {
    const operator = await operators.authenticate(context);
    const body = await context.body<{ name?: string; description?: string; effect?: string; connector?: string }>();
    requireFields(body, ['name', 'description', 'effect', 'connector']);

    const tool = await gateway.admin.registerTool(
      body as Parameters<typeof gateway.admin.registerTool>[0],
      { identifier: operator.identifier, via: 'api' },
    );
    return withStatus(201, tool);
  });

  /**
   * The per-tool kill switch.
   *
   * Takes a reason, because the first question on finding a tool switched off
   * is why and the second is who. Both are audited.
   */
  router.post('/v1/tools/:id/disable', async (context) => {
    const operator = await operators.authenticate(context);
    const body = await context.body<{ reason?: string }>().catch(() => ({}) as { reason?: string });
    return gateway.admin.setToolDisabled(
      context.params.id!,
      true,
      { identifier: operator.identifier, via: 'api' },
      body.reason ? String(body.reason) : undefined,
    );
  });

  router.post('/v1/tools/:id/enable', async (context) => {
    const operator = await operators.authenticate(context);
    return gateway.admin.setToolDisabled(context.params.id!, false, {
      identifier: operator.identifier,
      via: 'api',
    });
  });

  /** The connector-level kill switch: disables every tool that connector runs. */
  router.post('/v1/connectors/:name/disable', async (context) => {
    const operator = await operators.authenticate(context);
    const body = await context.body<{ reason?: string }>().catch(() => ({}) as { reason?: string });
    const affected = await gateway.admin.setConnectorDisabled(
      context.params.name!,
      true,
      { identifier: operator.identifier, via: 'api' },
      body.reason ? String(body.reason) : undefined,
    );

    return {
      connector: context.params.name,
      disabled: affected.map((tool) => tool.name),
      notice:
        'A tool registered on this connector after this call is not covered by it. Re-run this after registering anything new.',
    };
  });

  router.post('/v1/connectors/:name/enable', async (context) => {
    const operator = await operators.authenticate(context);
    const affected = await gateway.admin.setConnectorDisabled(context.params.name!, false, {
      identifier: operator.identifier,
      via: 'api',
    });
    return { connector: context.params.name, enabled: affected.map((tool) => tool.name) };
  });

  // --- policies -----------------------------------------------------------

  router.get('/v1/policies', async (context) => {
    await operators.authenticate(context);
    return { policies: await gateway.policies.list() };
  });

  router.get('/v1/policies/:id', async (context) => {
    await operators.authenticate(context);
    return gateway.policies.require(context.params.id!);
  });

  router.post('/v1/policies', async (context) => {
    const operator = await operators.authenticate(context);
    const policy = await context.body<Policy>();
    requireFields(policy, ['id', 'version', 'name', 'rules']);

    const existing = await gateway.policies.get(policy.id);
    // A document that omits `enabled` is published enabled; an explicit false is honoured.
    const stored = await gateway.admin.publishPolicy(
      { ...policy, enabled: policy.enabled ?? true },
      { identifier: operator.identifier, via: 'api' },
    );

    return withStatus(existing ? 200 : 201, stored);
  });

  router.post('/v1/policies/:id/enable', async (context) => {
    const operator = await operators.authenticate(context);
    return gateway.admin.setPolicyEnabled(context.params.id!, true, {
      identifier: operator.identifier,
      via: 'api',
    });
  });

  router.post('/v1/policies/:id/disable', async (context) => {
    const operator = await operators.authenticate(context);
    return gateway.admin.setPolicyEnabled(context.params.id!, false, {
      identifier: operator.identifier,
      via: 'api',
    });
  });

  // --- approvals ----------------------------------------------------------

  router.get('/v1/approvals', async (context) => {
    const operator = await operators.authenticate(context);
    await gateway.approvals.expireDue();

    const mine = context.query.get('mine') === 'true';
    return {
      approvals: await gateway.approvals.listPending(mine ? { approver: operator } : {}),
    };
  });

  router.get('/v1/approvals/:id', async (context) => {
    await operators.authenticate(context);
    return gateway.approvals.require(context.params.id!);
  });

  router.post('/v1/approvals/:id/vote', async (context) => {
    const operator = await operators.authenticate(context);
    const body = await context.body<{ vote?: string; comment?: string }>();

    if (body.vote !== 'approve' && body.vote !== 'reject') {
      throw new ArcError('invalid_request', 'vote must be "approve" or "reject"');
    }

    const request = await gateway.approvals.vote({
      approvalId: context.params.id!,
      approver: operator,
      vote: body.vote,
      ...(body.comment ? { comment: String(body.comment) } : {}),
    });

    await gateway.audit.append({
      type: 'approval.voted',
      organizationId: request.organizationId,
      actor: operator.identifier,
      subject: request.actionId,
      summary: `${operator.identifier} voted to ${body.vote} ${request.tool}`,
      data: { approvalId: request.id, status: request.status, comment: body.comment },
    });

    return request;
  });

  /** Executes an approved action. Separate from voting, so approving is never itself an act. */
  router.post('/v1/approvals/:id/execute', async (context) => {
    await operators.authenticate(context);
    return gateway.resume(context.params.id!);
  });

  // --- evidence, decisions and audit --------------------------------------

  router.get('/v1/evidence', async (context) => {
    await operators.authenticate(context);
    return {
      evidence: await gateway.listEvidence({
        ...(context.query.get('agentId') ? { agentId: context.query.get('agentId')! } : {}),
        ...(context.query.get('outcome') ? { outcome: context.query.get('outcome')! } : {}),
        limit: positiveInt(context.query.get('limit'), 100),
      }),
    };
  });

  router.get('/v1/evidence/:id', async (context) => {
    await operators.authenticate(context);
    const record = await gateway.evidence(context.params.id!);
    if (!record) throw new ArcError('not_found', `no evidence record with id ${context.params.id}`);
    return record;
  });

  /** The full rule-by-rule trace behind a decision. */
  router.get('/v1/decisions/:id', async (context) => {
    await operators.authenticate(context);
    const decision = await gateway.decision(context.params.id!);
    if (!decision) throw new ArcError('not_found', `no decision with id ${context.params.id}`);
    return decision;
  });

  router.get('/v1/audit', async (context) => {
    await operators.authenticate(context);
    return {
      records: await gateway.audit.read({
        ...(context.query.get('afterSequence')
          ? { afterSequence: positiveInt(context.query.get('afterSequence'), 0) }
          : {}),
        limit: positiveInt(context.query.get('limit'), 200),
        reverse: context.query.get('order') !== 'asc',
      }),
      total: await gateway.audit.count(),
    };
  });

  /**
   * Verifies the hash chain end to end.
   *
   * When the store keeps a head marker, the chain is checked against it, which
   * catches truncation of the log — walking the records alone cannot, since a
   * truncated chain is internally valid. An operator who has anchored the head
   * digest elsewhere can pass it as `?headDigest=` to check against that
   * instead, which is the stronger test.
   */
  router.get('/v1/audit/verify', async (context) => {
    await operators.authenticate(context);

    const expectation = await resolveExpectation(gateway, context);
    const verification = await gateway.audit.verify(expectation);

    return withStatus(verification.valid ? 200 : 409, {
      ...verification,
      ...(verification.checkedAgainstExpectation
        ? {}
        : {
            notice:
              'The chain was checked against itself only. This detects an edited record and a missing record in the middle, but not truncation. Anchor the head digest outside ARC Control and pass it as ?headDigest= to detect that.',
          }),
    });
  });

  // --- MCP security -------------------------------------------------------

  /** Scans an MCP server manifest without registering anything from it. */
  router.post('/v1/mcp/scan', async (context) => {
    await operators.authenticate(context);
    const manifest = await context.body<McpServerManifest>();
    requireFields(manifest, ['name', 'endpoint']);

    return scanManifest({
      name: String(manifest.name),
      endpoint: String(manifest.endpoint),
      tools: Array.isArray(manifest.tools) ? manifest.tools : [],
    });
  });

  return router;
}

/**
 * Works out what to check the chain against: an explicitly supplied head wins,
 * then the store's own head marker, then nothing.
 */
async function resolveExpectation(
  gateway: Gateway,
  context: RequestContext,
): Promise<ChainExpectation | undefined> {
  const headDigest = context.query.get('headDigest');
  const headSequence = context.query.get('headSequence');

  if (headDigest || headSequence) {
    return {
      ...(headDigest ? { headDigest } : {}),
      ...(headSequence ? { headSequence: positiveInt(headSequence, 0) } : {}),
    };
  }

  return gateway.store.recordedAuditHead?.();
}

function requireFields(body: unknown, fields: readonly string[]): void {
  const record = (body ?? {}) as Record<string, unknown>;
  const missing = fields.filter((field) => record[field] === undefined || record[field] === null);
  if (missing.length > 0) {
    throw new ArcError('invalid_request', `missing required field(s): ${missing.join(', ')}`, { details: { missing } });
  }
}

function positiveInt(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

export type { RequestContext };

function describeCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}
