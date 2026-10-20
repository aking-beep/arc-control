import { ArcError, type ActionRequest, type ChainExpectation, type Policy } from '@arc-control/schemas';
import type { Gateway } from '@arc-control/gateway';
import { scanManifest, type McpServerManifest } from '@arc-control/mcp-security';
import { Router, withStatus, type RequestContext } from './http.js';
import type { OperatorAuth } from './operator.js';

export interface RouteOptions {
  readonly gateway: Gateway;
  readonly operators: OperatorAuth;
  readonly version: string;
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
  const { gateway, operators } = options;
  const router = new Router();

  // --- health -------------------------------------------------------------

  router.get('/health', async () => {
    const [agents, tools, policies, auditCount] = await Promise.all([
      gateway.agents.list(),
      gateway.tools.list(),
      gateway.policies.list(),
      gateway.audit.count(),
    ]);

    const connectors = await Promise.all(
      gateway.tools.connectors().map(async (connector) => ({
        name: connector.name,
        ...(connector.health ? await connector.health() : { healthy: true }),
      })),
    );

    return {
      status: connectors.every((connector) => connector.healthy) ? 'ok' : 'degraded',
      version: options.version,
      operatorAuthConfigured: operators.configured,
      counts: {
        agents: agents.length,
        tools: tools.length,
        policies: policies.length,
        auditRecords: auditCount,
      },
      connectors,
    };
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
    operators.authenticate(context);
    return { agents: await gateway.agents.list() };
  });

  router.post('/v1/agents', async (context) => {
    const operator = operators.authenticate(context);
    const body = await context.body<{ name?: string; owner?: string }>();
    requireFields(body, ['name', 'owner']);

    const agent = await gateway.admin.registerAgent(
      body as Parameters<typeof gateway.admin.registerAgent>[0],
      { identifier: operator.identifier, via: 'api' },
    );
    return withStatus(201, agent);
  });

  router.get('/v1/agents/:id', async (context) => {
    operators.authenticate(context);
    return gateway.agents.require(context.params.id!);
  });

  router.post('/v1/agents/:id/suspend', async (context) => {
    const operator = operators.authenticate(context);
    return gateway.admin.setAgentStatus(context.params.id!, 'suspended', {
      identifier: operator.identifier,
      via: 'api',
    });
  });

  router.post('/v1/agents/:id/resume', async (context) => {
    const operator = operators.authenticate(context);
    return gateway.admin.setAgentStatus(context.params.id!, 'active', {
      identifier: operator.identifier,
      via: 'api',
    });
  });

  /** Issues an agent key. The plaintext is in this response and nowhere else, ever. */
  router.post('/v1/agents/:id/keys', async (context) => {
    const operator = operators.authenticate(context);
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
    operators.authenticate(context);
    return { credentials: await gateway.agents.listKeys(context.params.id!) };
  });

  // --- tools --------------------------------------------------------------

  router.get('/v1/tools', async (context) => {
    operators.authenticate(context);
    return { tools: await gateway.tools.list() };
  });

  router.post('/v1/tools', async (context) => {
    const operator = operators.authenticate(context);
    const body = await context.body<{ name?: string; description?: string; effect?: string; connector?: string }>();
    requireFields(body, ['name', 'description', 'effect', 'connector']);

    const tool = await gateway.admin.registerTool(
      body as Parameters<typeof gateway.admin.registerTool>[0],
      { identifier: operator.identifier, via: 'api' },
    );
    return withStatus(201, tool);
  });

  // --- policies -----------------------------------------------------------

  router.get('/v1/policies', async (context) => {
    operators.authenticate(context);
    return { policies: await gateway.policies.list() };
  });

  router.get('/v1/policies/:id', async (context) => {
    operators.authenticate(context);
    return gateway.policies.require(context.params.id!);
  });

  router.post('/v1/policies', async (context) => {
    const operator = operators.authenticate(context);
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
    const operator = operators.authenticate(context);
    return gateway.admin.setPolicyEnabled(context.params.id!, true, {
      identifier: operator.identifier,
      via: 'api',
    });
  });

  router.post('/v1/policies/:id/disable', async (context) => {
    const operator = operators.authenticate(context);
    return gateway.admin.setPolicyEnabled(context.params.id!, false, {
      identifier: operator.identifier,
      via: 'api',
    });
  });

  // --- approvals ----------------------------------------------------------

  router.get('/v1/approvals', async (context) => {
    const operator = operators.authenticate(context);
    await gateway.approvals.expireDue();

    const mine = context.query.get('mine') === 'true';
    return {
      approvals: await gateway.approvals.listPending(mine ? { approver: operator } : {}),
    };
  });

  router.get('/v1/approvals/:id', async (context) => {
    operators.authenticate(context);
    return gateway.approvals.require(context.params.id!);
  });

  router.post('/v1/approvals/:id/vote', async (context) => {
    const operator = operators.authenticate(context);
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
    operators.authenticate(context);
    return gateway.resume(context.params.id!);
  });

  // --- evidence, decisions and audit --------------------------------------

  router.get('/v1/evidence', async (context) => {
    operators.authenticate(context);
    return {
      evidence: await gateway.listEvidence({
        ...(context.query.get('agentId') ? { agentId: context.query.get('agentId')! } : {}),
        ...(context.query.get('outcome') ? { outcome: context.query.get('outcome')! } : {}),
        limit: positiveInt(context.query.get('limit'), 100),
      }),
    };
  });

  router.get('/v1/evidence/:id', async (context) => {
    operators.authenticate(context);
    const record = await gateway.evidence(context.params.id!);
    if (!record) throw new ArcError('not_found', `no evidence record with id ${context.params.id}`);
    return record;
  });

  /** The full rule-by-rule trace behind a decision. */
  router.get('/v1/decisions/:id', async (context) => {
    operators.authenticate(context);
    const decision = await gateway.decision(context.params.id!);
    if (!decision) throw new ArcError('not_found', `no decision with id ${context.params.id}`);
    return decision;
  });

  router.get('/v1/audit', async (context) => {
    operators.authenticate(context);
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
    operators.authenticate(context);

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
    operators.authenticate(context);
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
