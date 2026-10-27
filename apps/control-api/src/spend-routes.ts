import { ArcError } from '@arc-control/schemas';
import type { Gateway } from '@arc-control/gateway';
import { withStatus, type Router } from './http.js';
import type { OperatorAuth } from './operator.js';

export interface SpendRouteOptions {
  readonly gateway: Gateway;
  readonly operators: OperatorAuth;
  readonly defaultOrganizationId?: string;
}

/**
 * Spend and budgets (2.3, ADR-0002).
 *
 * Operators manage budgets and can record spend against any agent. Agents get
 * exactly one new capability, and it is a narrow one: reporting their **own**
 * spend. It is recorded as unverified, and the only thing an agent can do
 * with it is bring its own budget closer to exhausted — the ledger refuses
 * negative amounts, and a reported record never replaces another.
 */
export function addSpendRoutes(router: Router, options: SpendRouteOptions): Router {
  const { gateway, operators } = options;
  const organizationId = options.defaultOrganizationId ?? 'default';

  router.get('/v1/budgets', async (context) => {
    await operators.authenticate(context);
    const [budgets, standings] = await Promise.all([gateway.spend.budgets(), gateway.spend.standings()]);
    return { budgets, standings };
  });

  router.post('/v1/budgets', async (context) => {
    const operator = await operators.authenticate(context);
    const budget = await gateway.admin.saveBudget(
      await context.body<unknown>(),
      { identifier: operator.identifier, via: 'api' },
      { organizationId },
    );
    return withStatus(201, budget);
  });

  /** Replaces a budget. The whole document, so a partial update cannot leave half of one in force. */
  router.add('PUT', '/v1/budgets/:id', async (context) => {
    const operator = await operators.authenticate(context);
    return gateway.admin.saveBudget(
      await context.body<unknown>(),
      { identifier: operator.identifier, via: 'api' },
      { organizationId, id: context.params.id! },
    );
  });

  router.get('/v1/spend', async (context) => {
    await operators.authenticate(context);
    const agentId = context.query.get('agentId') ?? undefined;
    const since = context.query.get('since');
    const sinceDate = since === null ? undefined : new Date(since);
    if (sinceDate !== undefined && Number.isNaN(sinceDate.getTime())) {
      throw new ArcError('invalid_request', 'since must be an ISO 8601 timestamp');
    }
    const [records, standings] = await Promise.all([
      gateway.spend.list({
        ...(agentId !== undefined ? { agentId } : {}),
        ...(sinceDate !== undefined ? { since: sinceDate } : {}),
      }),
      gateway.spend.standings(agentId !== undefined ? { agentId } : {}),
    ]);
    return { records, standings };
  });

  /** An operator records spend, e.g. from an invoice. Unverified: ARC did not fetch it. */
  router.post('/v1/spend', async (context) => {
    const operator = await operators.authenticate(context);
    const body = await context.body<Record<string, unknown>>();
    if (body.agentId !== undefined && !(await gateway.agents.get(String(body.agentId)))) {
      throw new ArcError('invalid_request', `no agent with id ${String(body.agentId)}`);
    }
    const record = await gateway.admin.reportSpend(
      {
        organizationId,
        ...(body.agentId !== undefined ? { agentId: String(body.agentId) } : {}),
        ...spendFields(body),
      },
      { identifier: operator.identifier, via: 'api' },
    );
    return withStatus(201, record);
  });

  /** An agent reports its own spend. The agent is whoever the key says it is; the body cannot name another. */
  router.post('/v1/spend/report', async (context) => {
    const principal = await gateway.agents.authenticate(context.bearer);
    const body = await context.body<Record<string, unknown>>();
    if (body.agentId !== undefined && body.agentId !== principal.agentId) {
      throw new ArcError('invalid_request', 'an agent can only report its own spend');
    }
    const record = await gateway.admin.reportSpend(
      { organizationId: principal.organizationId, agentId: principal.agentId, ...spendFields(body) },
      { identifier: principal.agentId, via: 'api' },
    );
    return withStatus(201, record);
  });

  return router;
}

function spendFields(body: Record<string, unknown>) {
  return {
    provider: String(body.provider ?? ''),
    // Passed through untouched so the ledger, not a coercion here, decides
    // what counts as an amount: `"5"` must be refused, not read as 5.
    amountUsd: body.amountUsd as number,
    occurredAt: body.occurredAt === undefined ? new Date().toISOString() : String(body.occurredAt),
    ...(body.reference !== undefined ? { reference: String(body.reference) } : {}),
    ...(body.model !== undefined ? { model: String(body.model) } : {}),
  };
}
