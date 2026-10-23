/**
 * Prototype-side mirrors of `packages/schemas/src/*`. Field names are copied
 * verbatim so every screen reads the same shape the console receives from the
 * control API. Nothing here is a new contract.
 */

export type Effect = 'ALLOW' | 'REQUIRE_APPROVAL' | 'DENY';

/** packages/schemas/src/action.ts `ActionOutcome` — all 8, fixed order. */
export const OUTCOMES = [
  'allowed',
  'executed',
  'pending_approval',
  'approved',
  'rejected',
  'expired',
  'denied',
  'failed',
] as const;
export type ActionOutcome = (typeof OUTCOMES)[number];

/** packages/schemas/src/agent.ts */
export interface Agent {
  id: string;
  name: string;
  kind: 'autonomous' | 'assistant' | 'workflow' | 'service';
  status: 'active' | 'suspended';
  organizationId: string;
  environment: string;
  owner: string;
  description?: string;
  roles: string[];
  declaredTools: string[];
  labels: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

/** packages/schemas/src/agent.ts `AgentCredential` — metadata only, never a secret. */
export interface AgentCredential {
  id: string;
  agentId: string;
  displayPrefix: string;
  createdAt: string;
  expiresAt?: string;
  revokedAt?: string;
  lastUsedAt?: string;
}

/** packages/schemas/src/tool.ts */
export interface ParameterSpec {
  name: string;
  type: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array';
  required?: boolean;
  description?: string;
  minimum?: number;
  maximum?: number;
  maxLength?: number;
  pattern?: string;
  enum?: (string | number)[];
  sensitive?: boolean;
}

export interface Tool {
  name: string;
  description: string;
  system: string;
  effect: 'read' | 'write' | 'irreversible';
  riskTier?: 'low' | 'medium' | 'high' | 'critical';
  connector: string;
  parameters: ParameterSpec[];
}

/** packages/schemas/src/policy.ts */
export type Operand = string | number | boolean | null | (string | number | boolean)[];
export type Condition =
  | { always: true }
  | { eq: [Operand, Operand] }
  | { ne: [Operand, Operand] }
  | { gt: [Operand, Operand] }
  | { gte: [Operand, Operand] }
  | { lt: [Operand, Operand] }
  | { lte: [Operand, Operand] }
  | { in: [Operand, Operand] }
  | { nin: [Operand, Operand] }
  | { contains: [Operand, Operand] }
  | { startsWith: [Operand, Operand] }
  | { endsWith: [Operand, Operand] }
  | { matches: [Operand, string] }
  | { exists: Operand }
  | { and: Condition[] }
  | { or: Condition[] }
  | { not: Condition };

export interface ApprovalRequirement {
  approvers: string[];
  minApprovals: number;
  expiresInSeconds?: number;
  requireSeparationOfDuties?: boolean;
}

export interface PolicyRule {
  id: string;
  description?: string;
  when: Condition;
  effect: Effect;
  reason: string;
  approval?: ApprovalRequirement;
  obligations?: string[];
}

export interface PolicyMatch {
  agents?: string[];
  tools?: string[];
  systems?: string[];
  environments?: string[];
  effects?: string[];
}

export interface Policy {
  id: string;
  version: number;
  name: string;
  description?: string;
  enabled: boolean;
  match: PolicyMatch;
  rules: PolicyRule[];
  fallback: { effect: Effect; reason: string };
  labels?: Record<string, string>;
}

/** packages/schemas/src/approval.ts */
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled';
export interface ApprovalVote {
  approver: string;
  vote: 'approve' | 'reject';
  comment?: string;
  votedAt: string;
}
export interface ApprovalRequest {
  id: string;
  actionId: string;
  decisionId: string;
  agentId: string;
  agentName: string;
  agentOwner: string;
  organizationId: string;
  tool: string;
  parameters: Record<string, unknown>;
  policyId?: string;
  ruleId?: string;
  reason: string;
  requirement: ApprovalRequirement;
  status: ApprovalStatus;
  votes: ApprovalVote[];
  createdAt: string;
  expiresAt: string;
  resolvedAt?: string;
  consumedAt?: string;
}

/** packages/schemas/src/evidence.ts */
export interface EvidenceRecord {
  id: string;
  schemaVersion: 1;
  actionId: string;
  organizationId: string;
  environment: string;
  agent: { id: string; name: string; owner: string; roles: string[]; credentialId: string };
  tool: { name: string; system: string; effect: string; riskTier: string; connector: string };
  request: {
    parameters: Record<string, unknown>;
    parametersDigest: string;
    intent?: string;
    correlationId?: string;
    requestedAt: string;
  };
  decision: {
    id: string;
    effect: Effect;
    policyId?: string;
    policyVersion?: number;
    ruleId?: string;
    reason: string;
    decidedAt: string;
    evaluationMs: number;
    traceDigest: string;
  };
  approval?: {
    id: string;
    status: string;
    approvers: string[];
    minApprovals: number;
    votes: { approver: string; vote: string; votedAt: string }[];
    resolvedAt?: string;
  };
  execution?: {
    id: string;
    connector: string;
    status: 'succeeded' | 'failed';
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    resultDigest?: string;
    error?: { code: string; message: string };
  };
  outcome: ActionOutcome;
  obligations: string[];
  createdAt: string;
  integrityDigest: string;
}

/** packages/schemas `Decision.trace: RuleTrace[]` */
export interface RuleTrace {
  policyId: string;
  policyVersion: number;
  ruleId: string;
  matched: boolean;
  effect?: Effect;
  reason?: string;
  error?: string;
}

/** packages/schemas/src/audit.ts */
export type AuditEventType =
  | 'agent.registered'
  | 'agent.updated'
  | 'agent.suspended'
  | 'agent.resumed'
  | 'credential.issued'
  | 'credential.revoked'
  | 'tool.registered'
  | 'tool.updated'
  | 'policy.created'
  | 'policy.updated'
  | 'policy.disabled'
  | 'action.requested'
  | 'action.allowed'
  | 'action.denied'
  | 'action.executed'
  | 'action.failed'
  | 'approval.requested'
  | 'approval.voted'
  | 'approval.approved'
  | 'approval.rejected'
  | 'approval.expired'
  | 'evidence.recorded';

export interface AuditRecord {
  id: string;
  sequence: number;
  type: AuditEventType;
  organizationId: string;
  occurredAt: string;
  actor: string;
  subject: string;
  summary: string;
  data: Record<string, unknown>;
  previousDigest: string;
  digest: string;
}

export type ChainProblem = 'digest_mismatch' | 'broken_link' | 'sequence_gap' | 'truncated' | 'head_mismatch' | 'empty';

export interface ChainVerification {
  valid: boolean;
  recordsChecked: number;
  failures: { sequence: number; id: string; problem: ChainProblem; detail: string }[];
  headDigest?: string;
  headSequence?: number;
  checkedAgainstExpectation: boolean;
}

/** GET /health (apps/control-api/src/routes.ts:30-57) */
export interface Health {
  status: 'ok' | 'degraded';
  version: string;
  operatorAuthConfigured: boolean;
  counts: { agents: number; tools: number; policies: number; auditRecords: number };
  connectors: { name: string; healthy: boolean; detail?: string }[];
}

/** packages/mcp-security/src/manifest.ts */
export type FindingSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';
export interface Finding {
  id: string;
  severity: FindingSeverity;
  title: string;
  detail: string;
  tool?: string;
  remediation: string;
}
export interface ScanReport {
  server: string;
  endpoint: string;
  scannedAt: string;
  toolsScanned: number;
  findings: Finding[];
  highestSeverity: FindingSeverity;
  passed: boolean;
}
