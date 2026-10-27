/**
 * An agent is the principal ARC Control authorizes. It is never a human: a
 * human acts through the console or an approval, an agent acts through the
 * gateway. Every agent has an owner who is accountable for what it does.
 */
/**
 * The agent lifecycle.
 *
 * 1.0 had only `active` and `suspended`. 2.0 adds the two states a real
 * inventory needs: `draft`, for an agent registered but not yet cleared to
 * act, and `retired`, for one withdrawn permanently — distinct from
 * `suspended`, which implies it may come back.
 *
 * Only `active` may act. The gateway checks for that positively rather than
 * excluding the states it knows about, so adding a state here can never
 * accidentally grant one the right to act.
 */
export type AgentStatus = 'draft' | 'active' | 'suspended' | 'retired';

/** The only status an agent may submit actions in. */
export const ACTING_AGENT_STATUS: AgentStatus = 'active';

/**
 * How much it matters if this agent misbehaves. Drives review cadence and
 * finding severity; deliberately the organization's judgement rather than
 * something inferred from the tools the agent holds, because the business
 * consequence of a wrong action is not a property of the API it calls.
 */
export type AgentCriticality = 'low' | 'medium' | 'high' | 'business_critical';

/**
 * The governance record for an agent: who owns it in business terms, what it
 * is for, and when it was last looked at.
 *
 * Optional on purpose. An agent registered through the 1.0 API has none, and
 * the honest representation of that is an absent record that coverage
 * analysis reports as a gap — not a synthesised default that makes an
 * ungoverned agent look governed.
 */
export interface AgentGovernance {
  /** What this agent exists to do, in business language. */
  readonly purpose: string;
  /** Accountable business unit, e.g. `finance-operations`. */
  readonly department?: string;
  readonly criticality: AgentCriticality;
  /** Where the agent actually runs: a repository, service or deployment reference. */
  readonly deploymentRef?: string;
  /** Classification of the data this agent can reach, e.g. `pii`, `internal`. */
  readonly dataClassification?: readonly string[];
  /** Expected days between permission reviews. */
  readonly reviewIntervalDays?: number;
  readonly lastReviewedAt?: string;
  readonly lastReviewedBy?: string;
  readonly reviewDueAt?: string;
  /** Free-form note from the last review. */
  readonly reviewNote?: string;
}

/**
 * What ARC keeps of a prompt review: the outcome and a digest of what was
 * reviewed — never the prompt, which is the likeliest place for a secret.
 */
export interface AgentPromptReview {
  readonly grade: 'A' | 'B' | 'C' | 'D' | 'F';
  readonly score: number;
  /** `sha256:` digest of the reviewed prompt, so a later prompt can be matched against it. */
  readonly promptDigest: string;
  /** Ids of the checks that failed. */
  readonly failed: readonly string[];
  readonly reviewedAt: string;
  readonly reviewedBy: string;
}

/** Fields a governance record must carry to count as complete. */
export const REQUIRED_GOVERNANCE_FIELDS = ['purpose', 'criticality'] as const;

export type AgentKind = 'autonomous' | 'assistant' | 'workflow' | 'service';

export interface Agent {
  /** Opaque identifier, `arc_ag_...`. */
  readonly id: string;
  /** Stable, human-meaningful handle used in policies and audit, e.g. `finance-agent`. */
  readonly name: string;
  readonly kind: AgentKind;
  readonly status: AgentStatus;
  /** Organization the agent belongs to. */
  readonly organizationId: string;
  /** Deployment environment: policies may scope to it. */
  readonly environment: string;
  /** Email or identifier of the human or team accountable for this agent. */
  readonly owner: string;
  readonly description?: string;
  /** Roles the agent holds. Policies match on these to avoid naming agents directly. */
  readonly roles: readonly string[];
  /** Tool identifiers the agent declares it needs. Policy still decides. */
  readonly declaredTools: readonly string[];
  readonly labels: Readonly<Record<string, string>>;
  /** Business and governance context. Absent on agents registered before 2.0. */
  readonly governance?: AgentGovernance;
  /**
   * The latest static review of the agent's system prompt (2.3). Reaches
   * policy as `$.agent.promptGrade`, and gates activation once a minimum
   * grade is configured.
   */
  readonly promptReview?: AgentPromptReview;
  /** Set when the agent was retired, so a retirement is dated rather than implied. */
  readonly retiredAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The authenticated, policy-ready view of an agent for a single request. */
export interface AgentPrincipal {
  readonly agentId: string;
  readonly agentName: string;
  readonly kind: AgentKind;
  readonly organizationId: string;
  readonly environment: string;
  readonly owner: string;
  readonly roles: readonly string[];
  readonly labels: Readonly<Record<string, string>>;
  /** Identifier of the credential that authenticated this request. */
  readonly credentialId: string;
  /** Set when a delegation chain produced this principal (v0.4 onwards). */
  readonly delegatedFrom?: readonly string[];
}

/**
 * A credential proves an agent's identity. ARC Control stores only a salted
 * hash of the secret; the plaintext is returned once, at issue time, and never
 * recoverable afterwards.
 */
export interface AgentCredential {
  readonly id: string;
  readonly agentId: string;
  /** Non-secret prefix of the key, shown in the console so operators can tell keys apart. */
  readonly displayPrefix: string;
  readonly algorithm: 'sha256';
  readonly salt: string;
  readonly secretHash: string;
  readonly createdAt: string;
  readonly expiresAt?: string;
  readonly revokedAt?: string;
  readonly lastUsedAt?: string;
}

export interface AgentRegistration {
  readonly name: string;
  readonly kind?: AgentKind;
  readonly organizationId?: string;
  readonly environment?: string;
  readonly owner: string;
  readonly description?: string;
  readonly roles?: readonly string[];
  readonly declaredTools?: readonly string[];
  readonly labels?: Readonly<Record<string, string>>;
  /** Registers the agent in `draft` rather than `active`, so it cannot act until cleared. */
  readonly draft?: boolean;
  readonly governance?: AgentGovernance;
}

/**
 * A credential as the inventory shows it: never the secret, and with its
 * state worked out rather than left for the reader to infer from three
 * nullable timestamps.
 */
export type CredentialState = 'active' | 'expiring' | 'expired' | 'revoked';

export interface CredentialInventoryEntry {
  readonly id: string;
  readonly agentId: string;
  readonly agentName: string;
  readonly displayPrefix: string;
  readonly state: CredentialState;
  readonly createdAt: string;
  readonly expiresAt?: string;
  readonly revokedAt?: string;
  readonly lastUsedAt?: string;
  /** Days until expiry; negative once expired, absent when the key never expires. */
  readonly daysUntilExpiry?: number;
  /** True when the key has never been used, which usually means it leaked or was forgotten. */
  readonly neverUsed: boolean;
}
