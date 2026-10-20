/**
 * An agent is the principal ARC Control authorizes. It is never a human: a
 * human acts through the console or an approval, an agent acts through the
 * gateway. Every agent has an owner who is accountable for what it does.
 */
export type AgentStatus = 'active' | 'suspended';

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
}
