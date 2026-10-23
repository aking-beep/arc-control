import { fakeDigest, fakeId, GENESIS } from '../lib/digest';
import type {
  Agent,
  AgentCredential,
  ApprovalRequest,
  AuditEventType,
  AuditRecord,
  EvidenceRecord,
  Policy,
  RuleTrace,
  Tool,
} from './types';

/**
 * Demo seed data. Agents, tools and policies are copied from
 * apps/control-api/src/seed.ts (DEMO_POLICIES, registerTool, registerAgent).
 * Evidence, approvals and audit records are the README worked example run
 * against that seed: a $120 refund (ALLOW), a $1,800 refund (REQUIRE_APPROVAL),
 * a $9,000 refund (DENY), plus the engineering-agent issue paths.
 * Nothing here is production data.
 */

export const ORG = 'org_default';
export const ENV = 'production';
export const OPERATOR = { identity: 'ops@example.com', roles: ['finance-manager'] };
export const API_BASE = 'http://localhost:8787';
export const VERSION = '0.1.0';

const t = (hms: string) => `2026-10-20T${hms}Z`;

export const AGENT_IDS = {
  finance: fakeId('arc_ag', 'finance-agent'),
  engineering: fakeId('arc_ag', 'engineering-agent'),
};

export const SEED_AGENTS: Agent[] = [
  {
    id: AGENT_IDS.finance,
    name: 'finance-agent',
    kind: 'autonomous',
    status: 'active',
    organizationId: ORG,
    environment: ENV,
    owner: 'finance-ops@example.com',
    description: 'Handles customer refund requests.',
    roles: ['finance'],
    declaredTools: ['stripe.refund', 'stripe.get_charge'],
    labels: {},
    createdAt: t('05:30:00.214'),
    updatedAt: t('05:30:00.214'),
  },
  {
    id: AGENT_IDS.engineering,
    name: 'engineering-agent',
    kind: 'autonomous',
    status: 'active',
    organizationId: ORG,
    environment: ENV,
    owner: 'platform@example.com',
    description: 'Files issues from monitoring alerts.',
    roles: ['engineering'],
    declaredTools: ['github.create_issue'],
    labels: {},
    createdAt: t('05:30:00.231'),
    updatedAt: t('05:30:00.231'),
  },
];

export const SEED_CREDENTIALS: AgentCredential[] = [
  {
    id: fakeId('arc_key', 'finance'),
    agentId: AGENT_IDS.finance,
    displayPrefix: 'arc_sk_7f3a91',
    createdAt: t('05:30:00.219'),
    lastUsedAt: t('05:42:15.008'),
  },
  {
    id: fakeId('arc_key', 'engineering'),
    agentId: AGENT_IDS.engineering,
    displayPrefix: 'arc_sk_c20e4d',
    createdAt: t('05:30:00.236'),
    lastUsedAt: t('05:45:12.440'),
  },
];

export const SEED_TOOLS: Tool[] = [
  {
    name: 'stripe.refund',
    description: 'Refund a charge to the original payment method. Irreversible.',
    system: 'stripe',
    effect: 'irreversible',
    riskTier: 'critical',
    connector: 'simulation',
    parameters: [
      { name: 'customer', type: 'string', required: true, description: 'Customer identifier.' },
      { name: 'amount', type: 'number', required: true, minimum: 0, description: 'Amount in dollars.' },
      { name: 'reason', type: 'string', description: 'Why the refund is being issued.' },
    ],
  },
  {
    name: 'stripe.get_charge',
    description: 'Read a charge.',
    system: 'stripe',
    effect: 'read',
    connector: 'simulation',
    parameters: [{ name: 'chargeId', type: 'string', required: true }],
  },
  {
    name: 'github.create_issue',
    description: 'Open an issue on a repository.',
    system: 'github',
    effect: 'write',
    connector: 'simulation',
    parameters: [
      { name: 'repository', type: 'string', required: true },
      { name: 'title', type: 'string', required: true, maxLength: 256 },
      { name: 'body', type: 'string', maxLength: 65536 },
      { name: 'branch', type: 'string' },
    ],
  },
];

export const SEED_POLICIES: Policy[] = [
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

// --- the worked example ---------------------------------------------------

interface Scenario {
  key: string;
  agent: 'finance' | 'engineering';
  tool: string;
  parameters: Record<string, unknown>;
  intent?: string;
  at: string;
  effect: EvidenceRecord['decision']['effect'];
  policyId?: string;
  ruleId?: string;
  reason: string;
  evaluationMs: number;
  outcome: EvidenceRecord['outcome'];
  executionMs?: number;
  trace: RuleTrace[];
  approvalKey?: string;
}

const financeTrace = (amount: number): RuleTrace[] => {
  const under = amount < 500;
  const lte = amount <= 2500;
  const rows: RuleTrace[] = [
    { policyId: 'FINANCE-004', policyVersion: 1, ruleId: 'under-500', matched: under, ...(under ? { effect: 'ALLOW' as const, reason: 'within autonomous refund authority' } : {}) },
  ];
  if (under) return rows;
  rows.push({ policyId: 'FINANCE-004', policyVersion: 1, ruleId: 'needs-approval', matched: lte, ...(lte ? { effect: 'REQUIRE_APPROVAL' as const, reason: 'above autonomous refund authority, below the hard ceiling' } : {}) });
  if (lte) return rows;
  rows.push({ policyId: 'FINANCE-004', policyVersion: 1, ruleId: 'over-ceiling', matched: true, effect: 'DENY', reason: 'exceeds autonomous refund authority' });
  return rows;
};

const SCENARIOS: Scenario[] = [
  {
    key: 'refund-120',
    agent: 'finance',
    tool: 'stripe.refund',
    parameters: { customer: 'customer_123', amount: 120, reason: 'damaged on arrival' },
    intent: 'Customer reported the item arrived damaged; refunding the order.',
    at: '05:39:26.112',
    effect: 'ALLOW',
    policyId: 'FINANCE-004',
    ruleId: 'under-500',
    reason: 'within autonomous refund authority',
    evaluationMs: 3.1,
    outcome: 'executed',
    executionMs: 412,
    trace: financeTrace(120),
  },
  {
    key: 'refund-1800',
    agent: 'finance',
    tool: 'stripe.refund',
    parameters: { customer: 'customer_123', amount: 1800, reason: 'duplicate charge' },
    intent: 'Customer was charged twice for the annual plan.',
    at: '05:41:02.504',
    effect: 'REQUIRE_APPROVAL',
    policyId: 'FINANCE-004',
    ruleId: 'needs-approval',
    reason: 'above autonomous refund authority, below the hard ceiling',
    evaluationMs: 2.8,
    outcome: 'pending_approval',
    trace: financeTrace(1800),
    approvalKey: 'apr-1800',
  },
  {
    key: 'refund-9000',
    agent: 'finance',
    tool: 'stripe.refund',
    parameters: { customer: 'customer_481', amount: 9000, reason: 'contract termination' },
    at: '05:42:15.008',
    effect: 'DENY',
    policyId: 'FINANCE-004',
    ruleId: 'over-ceiling',
    reason: 'exceeds autonomous refund authority',
    evaluationMs: 2.6,
    outcome: 'denied',
    trace: financeTrace(9000),
  },
  {
    key: 'charge-read',
    agent: 'finance',
    tool: 'stripe.get_charge',
    parameters: { chargeId: 'ch_3Q8xLm2eZvKYlo2C' },
    at: '05:43:01.770',
    effect: 'DENY',
    reason: 'no policy authorizes this action',
    evaluationMs: 0.4,
    outcome: 'denied',
    trace: [],
  },
  {
    key: 'issue-ok',
    agent: 'engineering',
    tool: 'github.create_issue',
    parameters: { repository: 'acme/payments', title: 'Elevated 5xx rate on /v1/refunds', body: 'p95 error rate 4.2% over 10 min (alert #8812).' },
    intent: 'Filing the monitoring alert so on-call can triage it.',
    at: '05:44:40.391',
    effect: 'ALLOW',
    policyId: 'GITHUB-002',
    ruleId: 'issues-and-prs',
    reason: 'opening issues and pull requests is reviewable by design',
    evaluationMs: 1.9,
    outcome: 'executed',
    executionMs: 388,
    trace: [
      { policyId: 'GITHUB-002', policyVersion: 1, ruleId: 'no-default-branch', matched: false },
      { policyId: 'GITHUB-002', policyVersion: 1, ruleId: 'issues-and-prs', matched: true, effect: 'ALLOW', reason: 'opening issues and pull requests is reviewable by design' },
    ],
  },
  {
    key: 'issue-main',
    agent: 'engineering',
    tool: 'github.create_issue',
    parameters: { repository: 'acme/payments', title: 'Hotfix: retry budget', branch: 'main' },
    at: '05:45:12.440',
    effect: 'DENY',
    policyId: 'GITHUB-002',
    ruleId: 'no-default-branch',
    reason: 'agents may not write to a protected branch',
    evaluationMs: 1.7,
    outcome: 'denied',
    trace: [
      { policyId: 'GITHUB-002', policyVersion: 1, ruleId: 'no-default-branch', matched: true, effect: 'DENY', reason: 'agents may not write to a protected branch' },
    ],
  },
  {
    key: 'refund-2400',
    agent: 'finance',
    tool: 'stripe.refund',
    parameters: { customer: 'customer_207', amount: 2400, reason: 'goodwill credit' },
    intent: 'Customer escalated; offering a goodwill credit.',
    at: '05:46:30.902',
    effect: 'REQUIRE_APPROVAL',
    policyId: 'FINANCE-004',
    ruleId: 'needs-approval',
    reason: 'above autonomous refund authority, below the hard ceiling',
    evaluationMs: 2.9,
    outcome: 'rejected',
    trace: financeTrace(2400),
    approvalKey: 'apr-2400',
  },
];

const agentById = (key: 'finance' | 'engineering') => SEED_AGENTS.find((a) => a.id === AGENT_IDS[key])!;
const toolByName = (name: string) => SEED_TOOLS.find((tool) => tool.name === name)!;

export const APPROVAL_IDS = {
  'apr-1800': fakeId('arc_apr', 'apr-1800'),
  'apr-2400': fakeId('arc_apr', 'apr-2400'),
};

function addMs(iso: string, ms: number): string {
  return new Date(new Date(iso).getTime() + ms).toISOString();
}

export const SEED_TRACES: Record<string, RuleTrace[]> = {};

export const SEED_EVIDENCE: EvidenceRecord[] = SCENARIOS.map((s): EvidenceRecord => {
  const agent = agentById(s.agent);
  const tool = toolByName(s.tool);
  const requestedAt = t(s.at);
  const decidedAt = addMs(requestedAt, Math.ceil(s.evaluationMs));
  const decisionId = fakeId('arc_dec', s.key);
  SEED_TRACES[decisionId] = s.trace;
  const execution = s.executionMs
    ? {
        id: fakeId('arc_exe', s.key),
        connector: tool.connector,
        status: 'succeeded' as const,
        startedAt: addMs(decidedAt, 2),
        finishedAt: addMs(decidedAt, 2 + s.executionMs),
        durationMs: s.executionMs,
        resultDigest: fakeDigest(`${s.key}-result`),
      }
    : undefined;
  const approval =
    s.approvalKey === 'apr-2400'
      ? {
          id: APPROVAL_IDS['apr-2400'],
          status: 'rejected',
          approvers: ['role:finance-manager'],
          minApprovals: 1,
          votes: [{ approver: 'controller@example.com', vote: 'reject', votedAt: addMs(requestedAt, 412_000) }],
          resolvedAt: addMs(requestedAt, 412_000),
        }
      : s.approvalKey === 'apr-1800'
        ? { id: APPROVAL_IDS['apr-1800'], status: 'pending', approvers: ['role:finance-manager'], minApprovals: 1, votes: [] }
        : undefined;
  return {
    id: fakeId('arc_ev', s.key),
    schemaVersion: 1,
    actionId: fakeId('arc_act', s.key),
    organizationId: ORG,
    environment: ENV,
    agent: { id: agent.id, name: agent.name, owner: agent.owner, roles: agent.roles, credentialId: SEED_CREDENTIALS.find((c) => c.agentId === agent.id)!.id },
    tool: { name: tool.name, system: tool.system, effect: tool.effect, riskTier: tool.riskTier ?? 'low', connector: tool.connector },
    request: {
      parameters: s.parameters,
      parametersDigest: fakeDigest(`${s.key}-params`),
      ...(s.intent ? { intent: s.intent } : {}),
      correlationId: fakeId('c', s.key).slice(0, 18),
      requestedAt,
    },
    decision: {
      id: decisionId,
      effect: s.effect,
      ...(s.policyId ? { policyId: s.policyId, policyVersion: 1, ruleId: s.ruleId } : {}),
      reason: s.reason,
      decidedAt,
      evaluationMs: s.evaluationMs,
      traceDigest: fakeDigest(`${s.key}-trace`),
    },
    ...(approval ? { approval } : {}),
    ...(execution ? { execution } : {}),
    outcome: s.outcome,
    obligations: [],
    createdAt: addMs(decidedAt, s.executionMs ? s.executionMs + 4 : 1),
    integrityDigest: fakeDigest(`${s.key}-integrity`),
  };
}).reverse();

export const SEED_APPROVALS: ApprovalRequest[] = [
  {
    id: APPROVAL_IDS['apr-1800'],
    actionId: fakeId('arc_act', 'refund-1800'),
    decisionId: fakeId('arc_dec', 'refund-1800'),
    agentId: AGENT_IDS.finance,
    agentName: 'finance-agent',
    agentOwner: 'finance-ops@example.com',
    organizationId: ORG,
    tool: 'stripe.refund',
    parameters: { customer: 'customer_123', amount: 1800, reason: 'duplicate charge' },
    policyId: 'FINANCE-004',
    ruleId: 'needs-approval',
    reason: 'above autonomous refund authority, below the hard ceiling',
    requirement: { approvers: ['role:finance-manager'], minApprovals: 1, expiresInSeconds: 3600, requireSeparationOfDuties: true },
    status: 'pending',
    votes: [],
    createdAt: t('05:41:02.507'),
    expiresAt: t('06:41:02.507'),
  },
  {
    id: APPROVAL_IDS['apr-2400'],
    actionId: fakeId('arc_act', 'refund-2400'),
    decisionId: fakeId('arc_dec', 'refund-2400'),
    agentId: AGENT_IDS.finance,
    agentName: 'finance-agent',
    agentOwner: 'finance-ops@example.com',
    organizationId: ORG,
    tool: 'stripe.refund',
    parameters: { customer: 'customer_207', amount: 2400, reason: 'goodwill credit' },
    policyId: 'FINANCE-004',
    ruleId: 'needs-approval',
    reason: 'above autonomous refund authority, below the hard ceiling',
    requirement: { approvers: ['role:finance-manager'], minApprovals: 1, expiresInSeconds: 3600, requireSeparationOfDuties: true },
    status: 'rejected',
    votes: [
      {
        approver: 'controller@example.com',
        vote: 'reject',
        comment: 'Goodwill credits over $1,000 go through the account manager, not a refund.',
        votedAt: t('05:53:22.902'),
      },
    ],
    createdAt: t('05:46:30.905'),
    expiresAt: t('06:46:30.905'),
    resolvedAt: t('05:53:22.902'),
  },
];

// --- audit chain ------------------------------------------------------------

interface AuditSeed {
  type: AuditEventType;
  at: string;
  actor: string;
  subject: string;
  summary: string;
}

const auditSeeds: AuditSeed[] = [
  { type: 'tool.registered', at: '05:30:00.101', actor: 'seed-script', subject: 'stripe.refund', summary: 'seed-script registered tool "stripe.refund" (irreversible, critical)' },
  { type: 'tool.registered', at: '05:30:00.104', actor: 'seed-script', subject: 'stripe.get_charge', summary: 'seed-script registered tool "stripe.get_charge" (read)' },
  { type: 'tool.registered', at: '05:30:00.107', actor: 'seed-script', subject: 'github.create_issue', summary: 'seed-script registered tool "github.create_issue" (write)' },
  { type: 'policy.created', at: '05:30:00.150', actor: 'seed-script', subject: 'FINANCE-004', summary: 'seed-script published policy FINANCE-004 v1 "Autonomous refund authority"' },
  { type: 'policy.created', at: '05:30:00.162', actor: 'seed-script', subject: 'GITHUB-002', summary: 'seed-script published policy GITHUB-002 v1 "Repository writes"' },
  { type: 'agent.registered', at: '05:30:00.214', actor: 'seed-script', subject: AGENT_IDS.finance, summary: 'seed-script registered agent "finance-agent" owned by finance-ops@example.com' },
  { type: 'credential.issued', at: '05:30:00.219', actor: 'seed-script', subject: AGENT_IDS.finance, summary: 'seed-script issued a credential to "finance-agent" (arc_sk_7f3a91…)' },
  { type: 'agent.registered', at: '05:30:00.231', actor: 'seed-script', subject: AGENT_IDS.engineering, summary: 'seed-script registered agent "engineering-agent" owned by platform@example.com' },
  { type: 'credential.issued', at: '05:30:00.236', actor: 'seed-script', subject: AGENT_IDS.engineering, summary: 'seed-script issued a credential to "engineering-agent" (arc_sk_c20e4d…)' },
];

for (const record of [...SEED_EVIDENCE].reverse()) {
  const at = record.request.requestedAt.slice(11, 23);
  const actor = record.agent.id;
  const subject = record.actionId;
  auditSeeds.push({ type: 'action.requested', at, actor, subject, summary: `${record.agent.name} requested ${record.tool.name}` });
  if (record.decision.effect === 'ALLOW') {
    auditSeeds.push({ type: 'action.allowed', at: record.decision.decidedAt.slice(11, 23), actor: 'system', subject, summary: `ALLOW by ${record.decision.policyId}/${record.decision.ruleId}: ${record.decision.reason}` });
  } else if (record.decision.effect === 'DENY') {
    auditSeeds.push({ type: 'action.denied', at: record.decision.decidedAt.slice(11, 23), actor: 'system', subject, summary: `DENY${record.decision.policyId ? ` by ${record.decision.policyId}/${record.decision.ruleId}` : ''}: ${record.decision.reason}` });
  } else {
    auditSeeds.push({ type: 'approval.requested', at: record.decision.decidedAt.slice(11, 23), actor: 'system', subject: record.approval!.id, summary: `approval requested from role:finance-manager for ${record.tool.name}` });
    if (record.approval?.status === 'rejected') {
      auditSeeds.push({ type: 'approval.voted', at: record.approval.resolvedAt!.slice(11, 23), actor: 'controller@example.com', subject: record.approval.id, summary: 'controller@example.com voted reject' });
      auditSeeds.push({ type: 'approval.rejected', at: record.approval.resolvedAt!.slice(11, 23), actor: 'system', subject: record.approval.id, summary: 'approval rejected; the action will not run' });
    }
  }
  if (record.execution) {
    auditSeeds.push({ type: 'action.executed', at: record.execution.finishedAt.slice(11, 23), actor: 'system', subject, summary: `${record.tool.name} executed via ${record.execution.connector} in ${record.execution.durationMs} ms` });
  }
  auditSeeds.push({ type: 'evidence.recorded', at: record.createdAt.slice(11, 23), actor: 'system', subject: record.id, summary: `evidence recorded: ${record.outcome}` });
}

export function buildAuditChain(seeds: AuditSeed[] = auditSeeds): AuditRecord[] {
  let previous = GENESIS;
  return seeds
    .slice()
    .sort((a, b) => a.at.localeCompare(b.at))
    .map((seed, index) => {
      const sequence = index + 1;
      const digest = fakeDigest(`audit-${sequence}-${seed.type}-${seed.subject}`);
      const record: AuditRecord = {
        id: fakeId('arc_aud', `${sequence}`),
        sequence,
        type: seed.type,
        organizationId: ORG,
        occurredAt: t(seed.at),
        actor: seed.actor,
        subject: seed.subject,
        summary: seed.summary,
        data: {},
        previousDigest: previous,
        digest,
      };
      previous = digest;
      return record;
    });
}

export const SEED_AUDIT: AuditRecord[] = buildAuditChain();
export type { AuditSeed };
