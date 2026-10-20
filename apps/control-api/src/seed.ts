import type { Gateway } from '@arc-control/gateway';
import type { Policy } from '@arc-control/schemas';
import { SimulationConnector } from '@arc-control/connector-simulation';

/**
 * The worked example from the README, loaded into a running gateway.
 *
 * This exists so `npm run api` gives an evaluator something to try in under a
 * minute, and so the console has data to show. The effects are simulated; the
 * gateway, policy engine, approval engine, evidence and audit chain are all
 * real.
 *
 * The seed carries one policy per domain, governing only the three demo tools.
 * It is tempting to add a global floor — "no irreversible production action
 * without a human" — and that is a real and important pattern, but in a seed
 * it would shadow the refund bands below: because the strictest effect always
 * wins, such a floor turns the $120 ALLOW into REQUIRE_APPROVAL and the
 * headline example stops demonstrating the three-way split it is there to
 * show. Policy layering is covered in `docs/POLICY_MODEL.md` and exercised in
 * `evals/policy/`, where it can be read rather than tripped over.
 */
export const DEMO_POLICIES: readonly Policy[] = [
  {
    id: 'FINANCE-004',
    version: 1,
    name: 'Autonomous refund authority',
    description:
      'Bounds how much a finance agent may refund without a human. Refunds are irreversible, so the ceiling is a hard stop rather than a warning.',
    enabled: true,
    match: { tools: ['stripe.refund'] },
    rules: [
      {
        id: 'under-500',
        description: 'Routine customer-service refunds.',
        when: { lt: ['$.action.parameters.amount', 500] },
        effect: 'ALLOW',
        reason: 'within autonomous refund authority',
      },
      {
        id: 'needs-approval',
        description: 'Material refunds need a finance manager.',
        when: { lte: ['$.action.parameters.amount', 2500] },
        effect: 'REQUIRE_APPROVAL',
        reason: 'above autonomous refund authority, below the hard ceiling',
        approval: {
          approvers: ['role:finance-manager'],
          minApprovals: 1,
          expiresInSeconds: 3600,
          requireSeparationOfDuties: true,
        },
      },
      {
        id: 'over-ceiling',
        description: 'No agent refunds this much, approved or otherwise.',
        when: { always: true },
        effect: 'DENY',
        reason: 'exceeds autonomous refund authority',
      },
    ],
    fallback: { effect: 'DENY', reason: 'no refund rule matched' },
    labels: { domain: 'finance', control: 'SOX-302' },
  },
  {
    id: 'GITHUB-002',
    version: 1,
    name: 'Repository writes',
    description: 'Engineering agents may open issues and pull requests freely, but never touch the default branch.',
    enabled: true,
    match: { tools: ['github.*'] },
    rules: [
      {
        id: 'no-default-branch',
        when: { in: ['$.action.parameters.branch', ['main', 'master', 'release']] },
        effect: 'DENY',
        reason: 'agents may not write to a protected branch',
      },
      {
        id: 'issues-and-prs',
        when: { in: ['$.tool.name', ['github.create_issue', 'github.create_pull_request']] },
        effect: 'ALLOW',
        reason: 'opening issues and pull requests is reviewable by design',
      },
    ],
    fallback: { effect: 'REQUIRE_APPROVAL', reason: 'unclassified repository write' },
    labels: { domain: 'engineering' },
  },
];

/** Seeding is an administrative change like any other, and is audited as one. */
const SEED_ACTOR = { identifier: 'seed-script', via: 'seed' } as const;

export interface SeedResult {
  readonly apiKeys: Readonly<Record<string, string>>;
}

/** Registers the demo connector, tools, policies and agents. */
export async function seedDemo(gateway: Gateway): Promise<SeedResult> {
  const connector = new SimulationConnector()
    .handle('stripe.refund', (parameters) => ({
      refundId: `re_${Math.random().toString(16).slice(2, 10)}`,
      customer: parameters.customer,
      amount: parameters.amount,
      status: 'succeeded',
    }))
    .handle('stripe.get_charge', (parameters) => ({
      chargeId: parameters.chargeId,
      amount: 4200,
      currency: 'usd',
      refunded: false,
    }))
    .handle('github.create_issue', (parameters) => ({
      number: 412,
      url: `https://github.com/${String(parameters.repository)}/issues/412`,
      title: parameters.title,
    }));

  gateway.addConnector(connector);

  await gateway.admin.registerTool({
    name: 'stripe.refund',
    description: 'Refund a charge to the original payment method. Irreversible.',
    system: 'stripe',
    effect: 'irreversible',
    riskTier: 'critical',
    connector: connector.name,
    parameters: [
      { name: 'customer', type: 'string', required: true, description: 'Customer identifier.' },
      { name: 'amount', type: 'number', required: true, minimum: 0, description: 'Amount in dollars.' },
      { name: 'reason', type: 'string', description: 'Why the refund is being issued.' },
    ],
  }, SEED_ACTOR);

  await gateway.admin.registerTool({
    name: 'stripe.get_charge',
    description: 'Read a charge.',
    system: 'stripe',
    effect: 'read',
    connector: connector.name,
    parameters: [{ name: 'chargeId', type: 'string', required: true }],
  }, SEED_ACTOR);

  await gateway.admin.registerTool({
    name: 'github.create_issue',
    description: 'Open an issue on a repository.',
    system: 'github',
    effect: 'write',
    connector: connector.name,
    parameters: [
      { name: 'repository', type: 'string', required: true },
      { name: 'title', type: 'string', required: true, maxLength: 256 },
      { name: 'body', type: 'string', maxLength: 65_536 },
      { name: 'branch', type: 'string' },
    ],
  }, SEED_ACTOR);

  for (const policy of DEMO_POLICIES) {
    await gateway.admin.publishPolicy(policy, SEED_ACTOR);
  }

  const apiKeys: Record<string, string> = {};

  for (const registration of [
    {
      name: 'finance-agent',
      owner: 'finance-ops@example.com',
      description: 'Handles customer refund requests.',
      roles: ['finance'],
      declaredTools: ['stripe.refund', 'stripe.get_charge'],
    },
    {
      name: 'engineering-agent',
      owner: 'platform@example.com',
      description: 'Files issues from monitoring alerts.',
      roles: ['engineering'],
      declaredTools: ['github.create_issue'],
    },
  ] as const) {
    const agent = await gateway.admin.registerAgent(registration, SEED_ACTOR);
    const { apiKey } = await gateway.admin.issueKey(agent.id, SEED_ACTOR);
    apiKeys[agent.name] = apiKey;
  }

  return { apiKeys };
}
