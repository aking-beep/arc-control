import { Gateway } from '@arc-control/gateway';
import { MemoryStore } from '@arc-control/store';
import { SimulationConnector } from '@arc-control/connector-simulation';

export const SEED_ACTOR = { identifier: 'evals', via: 'system' };

/** The refund policy used throughout the evals and in the README. */
export const FINANCE_004 = {
  id: 'FINANCE-004',
  version: 1,
  name: 'Autonomous refund authority',
  enabled: true,
  match: { tools: ['stripe.refund'] },
  rules: [
    {
      id: 'under-500',
      when: { lt: ['$.action.parameters.amount', 500] },
      effect: 'ALLOW',
      reason: 'within autonomous refund authority',
    },
    {
      id: 'needs-approval',
      when: { lte: ['$.action.parameters.amount', 2500] },
      effect: 'REQUIRE_APPROVAL',
      reason: 'above autonomous refund authority, below the hard ceiling',
      approval: { approvers: ['role:finance-manager'], minApprovals: 1, expiresInSeconds: 3600 },
    },
    {
      id: 'over-ceiling',
      when: { always: true },
      effect: 'DENY',
      reason: 'exceeds autonomous refund authority',
    },
  ],
  fallback: { effect: 'DENY', reason: 'no refund rule matched' },
};

/**
 * A production floor: no irreversible action in production without a named
 * human. Used to demonstrate layering — it coexists with FINANCE-004, and
 * because the strictest effect wins it can tighten the refund bands but never
 * loosen them.
 */
export const GLOBAL_001 = {
  id: 'GLOBAL-001',
  version: 1,
  name: 'Production irreversible actions',
  enabled: true,
  match: { environments: ['production'], effects: ['irreversible'] },
  rules: [
    {
      id: 'irreversible-needs-a-human',
      when: { always: true },
      effect: 'REQUIRE_APPROVAL',
      reason: 'irreversible production actions require a named human',
      approval: { approvers: ['role:platform-oncall'], minApprovals: 1 },
    },
  ],
  fallback: { effect: 'DENY', reason: 'no rule matched' },
};

/** A permissive policy, used to prove that adding one cannot loosen anything. */
export const AAA_PERMISSIVE = {
  id: 'AAA-PERMISSIVE',
  version: 1,
  name: 'Permissive refunds',
  enabled: true,
  match: { tools: ['stripe.*'] },
  rules: [{ id: 'allow-all', when: { always: true }, effect: 'ALLOW', reason: 'permitted by the finance team' }],
  fallback: { effect: 'ALLOW', reason: 'permitted' },
};

/**
 * Builds a gateway with the refund tool and a finance agent.
 *
 * Only the refund itself is simulated: identity, policy, approvals, evidence
 * and the audit chain are the real implementations, so an eval that passes
 * here is a statement about the shipped control path.
 */
export async function buildHarness({ policies = [FINANCE_004], extraTools = [] } = {}) {
  const connector = new SimulationConnector()
    .handle('stripe.refund', (parameters) => ({ refundId: 're_eval', amount: parameters.amount }))
    .handle('stripe.get_charge', (parameters) => ({ chargeId: parameters.chargeId, amount: 4200 }))
    .handle('vault.write', () => ({ written: true }));

  const gateway = new Gateway({ store: new MemoryStore() });
  gateway.addConnector(connector);

  await gateway.admin.registerTool(
    {
      name: 'stripe.refund',
      description: 'Refund a charge. Irreversible.',
      effect: 'irreversible',
      riskTier: 'critical',
      connector: connector.name,
      parameters: [
        { name: 'customer', type: 'string', required: true },
        { name: 'amount', type: 'number', required: true, minimum: 0 },
        { name: 'reason', type: 'string' },
      ],
    },
    SEED_ACTOR,
  );

  await gateway.admin.registerTool(
    {
      name: 'stripe.get_charge',
      description: 'Read a charge.',
      effect: 'read',
      connector: connector.name,
      parameters: [{ name: 'chargeId', type: 'string', required: true }],
    },
    SEED_ACTOR,
  );

  for (const tool of extraTools) {
    await gateway.admin.registerTool({ connector: connector.name, ...tool }, SEED_ACTOR);
  }

  for (const policy of policies) {
    await gateway.admin.publishPolicy(policy, SEED_ACTOR);
  }

  const agent = await gateway.admin.registerAgent(
    { name: 'finance-agent', owner: 'finance-ops@example.com', roles: ['finance'] },
    SEED_ACTOR,
  );
  const { apiKey } = await gateway.admin.issueKey(agent.id, SEED_ACTOR);

  return { gateway, connector, agent, apiKey };
}

export const financeManager = { identifier: 'cfo@example.com', roles: ['finance-manager'] };
export const platformOncall = { identifier: 'sre@example.com', roles: ['platform-oncall'] };

/**
 * Flips the last hex digit of an API key, producing a key with a valid shape
 * and the wrong secret. Appending a fixed digit would not do: when the key
 * already ends in that digit the result is the original key, which
 * authenticates and makes the test flaky rather than strict.
 */
export function tamperKey(apiKey) {
  const last = apiKey.at(-1);
  const replacement = last === '0' ? '1' : '0';
  return `${apiKey.slice(0, -1)}${replacement}`;
}

export function refund(amount, overrides = {}) {
  return { tool: 'stripe.refund', parameters: { customer: 'customer_123', amount }, ...overrides };
}
