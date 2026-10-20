import {
  ArcError,
  newId,
  type Agent,
  type AgentCredential,
  type AgentPrincipal,
  type AgentRegistration,
} from '@arc-control/schemas';
import type { ControlStore } from '@arc-control/store';
import { issueCredential, parseApiKey, verifySecret, type IssuedCredential } from './credentials.js';

export interface AgentRegistryOptions {
  readonly defaultOrganizationId?: string;
  readonly defaultEnvironment?: string;
  readonly now?: () => Date;
}

/**
 * The agent registry answers the gateway's first question: *which agent is
 * asking?* Nothing downstream — policy, approval, execution, evidence — runs
 * until this produces a principal, so an unidentified caller can never reach
 * a tool.
 */
export class AgentRegistry {
  readonly #store: ControlStore;
  readonly #organizationId: string;
  readonly #environment: string;
  readonly #now: () => Date;

  constructor(store: ControlStore, options: AgentRegistryOptions = {}) {
    this.#store = store;
    this.#organizationId = options.defaultOrganizationId ?? 'default';
    this.#environment = options.defaultEnvironment ?? 'production';
    this.#now = options.now ?? (() => new Date());
  }

  async register(registration: AgentRegistration): Promise<Agent> {
    return this.#store.agents.transact(async () => {
      if (!/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(registration.name)) {
        throw new ArcError(
          'invalid_request',
          'agent name must be 3-64 lowercase letters, digits or dashes, e.g. "finance-agent"',
          { details: { name: registration.name } },
        );
      }

      const existing = await this.#store.agents.find((agent) => agent.name === registration.name);
      if (existing) {
        throw new ArcError('conflict', `an agent named "${registration.name}" already exists`, {
          details: { agentId: existing.id },
        });
      }

      const timestamp = this.#now().toISOString();
      const agent: Agent = {
        id: newId('agent'),
        name: registration.name,
        kind: registration.kind ?? 'autonomous',
        status: 'active',
        organizationId: registration.organizationId ?? this.#organizationId,
        environment: registration.environment ?? this.#environment,
        owner: registration.owner,
        ...(registration.description ? { description: registration.description } : {}),
        roles: registration.roles ?? [],
        declaredTools: registration.declaredTools ?? [],
        labels: registration.labels ?? {},
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      await this.#store.agents.put(agent.id, agent);
      return agent;
    });
  }

  async get(agentId: string): Promise<Agent | undefined> {
    return this.#store.agents.get(agentId);
  }

  async getByName(name: string): Promise<Agent | undefined> {
    return this.#store.agents.find((agent) => agent.name === name);
  }

  async list(): Promise<readonly Agent[]> {
    return this.#store.agents.list();
  }

  async require(agentId: string): Promise<Agent> {
    const agent = await this.get(agentId);
    if (!agent) throw new ArcError('not_found', `no agent with id ${agentId}`);
    return agent;
  }

  /**
   * Suspends an agent. Every subsequent action is refused at authentication,
   * before policy evaluation — this is the per-agent stop button the console
   * exposes, and the seam the v0.2 kill switch builds on.
   */
  async suspend(agentId: string): Promise<Agent> {
    return this.#setStatus(agentId, 'suspended');
  }

  async resume(agentId: string): Promise<Agent> {
    return this.#setStatus(agentId, 'active');
  }

  async #setStatus(agentId: string, status: Agent['status']): Promise<Agent> {
    return this.#store.agents.transact(async () => {
      const agent = await this.require(agentId);
      const updated: Agent = { ...agent, status, updatedAt: this.#now().toISOString() };
      await this.#store.agents.put(updated.id, updated);
      return updated;
    });
  }

  async issueKey(agentId: string, options: { expiresAt?: string } = {}): Promise<IssuedCredential> {
    await this.require(agentId);
    const issued = issueCredential(agentId, options);
    await this.#store.credentials.put(issued.credential.id, issued.credential);
    return issued;
  }

  async revokeKey(credentialId: string): Promise<AgentCredential> {
    return this.#store.credentials.transact(async () => {
      const credential = await this.#store.credentials.get(credentialId);
      if (!credential) throw new ArcError('not_found', `no credential with id ${credentialId}`);
      const revoked: AgentCredential = { ...credential, revokedAt: this.#now().toISOString() };
      await this.#store.credentials.put(revoked.id, revoked);
      return revoked;
    });
  }

  async listKeys(agentId: string): Promise<readonly AgentCredential[]> {
    return this.#store.credentials.filter((credential) => credential.agentId === agentId);
  }

  /**
   * Resolves a presented API key to a principal.
   *
   * Every failure path raises the same `unauthenticated` error with the same
   * message. A caller learns only that the key did not work — not whether the
   * reference existed, whether the secret was wrong, or whether the key had
   * expired — so the endpoint cannot be used to enumerate valid credentials.
   * Suspension is the one deliberate exception: an operator who has pulled an
   * agent's stop button wants that reflected in the agent's own logs.
   */
  async authenticate(apiKey: string | undefined): Promise<AgentPrincipal> {
    if (!apiKey) throw invalidCredential();

    const parsed = parseApiKey(apiKey);
    if (!parsed) throw invalidCredential();

    const credential = await this.#store.credentials.find(
      (candidate) => candidate.displayPrefix === parsed.displayPrefix,
    );
    if (!credential) throw invalidCredential();
    if (credential.revokedAt) throw invalidCredential();
    if (credential.expiresAt && Date.parse(credential.expiresAt) <= this.#now().getTime()) {
      throw invalidCredential();
    }
    if (!verifySecret(parsed.secret, credential)) throw invalidCredential();

    const agent = await this.#store.agents.get(credential.agentId);
    if (!agent) throw invalidCredential();

    if (agent.status === 'suspended') {
      throw new ArcError('agent_suspended', `agent "${agent.name}" is suspended and cannot act`, {
        details: { agentId: agent.id },
      });
    }

    await this.#store.credentials.put(credential.id, {
      ...credential,
      lastUsedAt: this.#now().toISOString(),
    });

    return this.toPrincipal(agent, credential.id);
  }

  /** Builds a principal directly. Used by trusted in-process callers such as the CLI. */
  toPrincipal(agent: Agent, credentialId: string): AgentPrincipal {
    return {
      agentId: agent.id,
      agentName: agent.name,
      kind: agent.kind,
      organizationId: agent.organizationId,
      environment: agent.environment,
      owner: agent.owner,
      roles: agent.roles,
      labels: agent.labels,
      credentialId,
    };
  }
}

/**
 * One error, one message, for every way authentication can fail. The caller
 * learns that the key did not work and nothing more.
 */
function invalidCredential(): ArcError {
  return new ArcError('unauthenticated', 'the presented agent credential is not valid');
}
