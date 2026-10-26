/**
 * Builders for assurance tests.
 *
 * Each returns a complete, valid object with sensible defaults so a test can
 * state only the field under test. Keeping them here rather than inline means
 * a test reads as the assertion it is making.
 */
import { digest, rateRisk, type Action, type Agent, type ApprovalRequest, type ControlDefinition, type EvidenceRecord, type Policy, type Tool } from '@arc-control/schemas';

export const AT = '2026-10-20T12:00:00.000Z';

export function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'arc_ag_1111111111111111111111111111111a',
    name: 'finance-agent',
    kind: 'autonomous',
    status: 'active',
    organizationId: 'default',
    environment: 'production',
    owner: 'ops@example.com',
    roles: ['finance'],
    declaredTools: [],
    labels: {},
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

export function governedAgent(overrides: Partial<Agent> = {}): Agent {
  return agent({
    governance: {
      purpose: 'Issues customer refunds within policy limits.',
      criticality: 'high',
      department: 'finance-operations',
      reviewIntervalDays: 90,
      lastReviewedAt: AT,
      lastReviewedBy: 'risk@example.com',
    },
    ...overrides,
  });
}

export function tool(overrides: Partial<Tool> = {}): Tool {
  return {
    id: 'arc_tl_2222222222222222222222222222222a',
    name: 'stripe.refund',
    description: 'Refund a charge.',
    system: 'stripe',
    effect: 'irreversible',
    riskTier: 'critical',
    connector: 'simulation',
    connectorConfig: {},
    parameters: [],
    labels: {},
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

export function policy(overrides: Partial<Policy> = {}): Policy {
  return {
    id: 'FINANCE-001',
    version: 1,
    name: 'Refund control',
    enabled: true,
    match: { tools: ['stripe.*'] },
    rules: [{ id: 'r1', when: { always: true }, effect: 'ALLOW', reason: 'within policy' }],
    fallback: { effect: 'DENY', reason: 'no rule matched' },
    ...overrides,
  };
}

export function action(overrides: Partial<Action> = {}): Action {
  const parameters = overrides.parameters ?? { amount: 100 };
  return {
    id: 'arc_act_3333333333333333333333333333333a',
    agentId: agent().id,
    agentName: 'finance-agent',
    organizationId: 'default',
    environment: 'production',
    tool: 'stripe.refund',
    toolId: tool().id,
    parameters,
    parametersDigest: digest(parameters),
    requestedAt: AT,
    ...overrides,
  };
}

export function evidence(overrides: Partial<EvidenceRecord> = {}): EvidenceRecord {
  const base = action();
  const content: Omit<EvidenceRecord, 'integrityDigest'> = {
    id: 'arc_ev_4444444444444444444444444444444a',
    schemaVersion: 1,
    actionId: base.id,
    organizationId: 'default',
    environment: 'production',
    agent: { id: base.agentId, name: base.agentName, owner: 'ops@example.com', roles: ['finance'], credentialId: 'arc_cred_x' },
    tool: { name: 'stripe.refund', system: 'stripe', effect: 'irreversible', riskTier: 'critical', connector: 'simulation' },
    request: {
      parameters: base.parameters,
      parametersDigest: base.parametersDigest,
      requestedAt: AT,
    },
    decision: {
      id: 'arc_dec_5555555555555555555555555555555a',
      effect: 'ALLOW',
      policyId: 'FINANCE-001',
      policyVersion: 1,
      ruleId: 'r1',
      reason: 'within policy',
      decidedAt: AT,
      evaluationMs: 1,
      traceDigest: 'sha256:trace',
    },
    outcome: 'executed',
    obligations: [],
    createdAt: AT,
    ...(overrides as object),
  } as Omit<EvidenceRecord, 'integrityDigest'>;

  return { ...content, integrityDigest: digest(content) } as EvidenceRecord;
}

export function execution(startedAt = AT): NonNullable<EvidenceRecord['execution']> {
  return {
    id: 'arc_exe_6666666666666666666666666666666a',
    connector: 'simulation',
    status: 'succeeded',
    startedAt,
    finishedAt: startedAt,
    durationMs: 5,
  };
}

export function approval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: 'arc_apr_7777777777777777777777777777777a',
    actionId: action().id,
    decisionId: 'arc_dec_5555555555555555555555555555555a',
    agentId: agent().id,
    agentName: 'finance-agent',
    agentOwner: 'ops@example.com',
    organizationId: 'default',
    tool: 'stripe.refund',
    parameters: { amount: 100 },
    policyId: 'FINANCE-001',
    ruleId: 'r1',
    reason: 'over threshold',
    requirement: { approvers: ['role:finance-manager'], minApprovals: 1 },
    status: 'approved',
    votes: [{ approver: 'cfo@example.com', vote: 'approve', votedAt: AT }],
    createdAt: AT,
    expiresAt: '2026-10-20T13:00:00.000Z',
    resolvedAt: AT,
    consumedAt: AT,
    ...overrides,
  };
}

export function control(overrides: Partial<ControlDefinition> = {}): ControlDefinition {
  return {
    id: 'ARC-AI-001',
    version: 1,
    title: 'test control',
    objective: 'o',
    procedure: 'p',
    assurance: 'automated',
    frequency: 'continuous',
    enabled: true,
    category: 'governance',
    failureSeverity: 'high',
    limitations: [],
    labels: {},
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

export function risk() {
  return { inherent: rateRisk(4, 4) };
}
