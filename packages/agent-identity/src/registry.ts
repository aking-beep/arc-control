import {
  ACTING_AGENT_STATUS,
  ArcError,
  newId,
  type Agent,
  type AgentCredential,
  type AgentPrincipal,
  type AgentGovernance,
  type AgentRegistration,
  type CredentialInventoryEntry,
  type CredentialState,
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
        status: registration.draft === true ? 'draft' : 'active',
        organizationId: registration.organizationId ?? this.#organizationId,
        environment: registration.environment ?? this.#environment,
        owner: registration.owner,
        ...(registration.description ? { description: registration.description } : {}),
        roles: registration.roles ?? [],
        declaredTools: registration.declaredTools ?? [],
        labels: registration.labels ?? {},
        ...(registration.governance ? { governance: registration.governance } : {}),
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

  /**
   * Clears a draft agent to act, or brings a suspended one back. Refuses a
   * retired agent: retirement is meant to be final, and an operator who
   * genuinely wants it back should register it again and be seen to do so.
   */
  async activate(agentId: string): Promise<Agent> {
    const agent = await this.require(agentId);
    if (agent.status === 'retired') {
      throw new ArcError('conflict', `agent "${agent.name}" is retired; register a new agent rather than reviving it`, {
        details: { agentId: agent.id },
      });
    }
    return this.#setStatus(agentId, 'active');
  }

  /**
   * Retires an agent permanently and revokes every credential it holds.
   *
   * Revoking here matters: a retired agent whose keys still verify is a live
   * credential with no owner watching it, which is the shape of most
   * credential incidents. Status alone would stop it acting today, but the key
   * would still be a valid secret in whatever file it was copied into.
   */
  async retire(agentId: string): Promise<{ readonly agent: Agent; readonly revoked: readonly string[] }> {
    await this.require(agentId);
    const credentials = await this.listKeys(agentId);
    const revoked: string[] = [];

    for (const credential of credentials) {
      if (credential.revokedAt) continue;
      await this.revokeKey(credential.id);
      revoked.push(credential.id);
    }

    const retired = await this.#store.agents.transact(async () => {
      const current = await this.require(agentId);
      const timestamp = this.#now().toISOString();
      const updated: Agent = { ...current, status: 'retired', retiredAt: timestamp, updatedAt: timestamp };
      await this.#store.agents.put(updated.id, updated);
      return updated;
    });

    return { agent: retired, revoked };
  }

  /** Records or replaces the agent's governance record. */
  async setGovernance(agentId: string, governance: AgentGovernance): Promise<Agent> {
    return this.#store.agents.transact(async () => {
      const agent = await this.require(agentId);
      const updated: Agent = { ...agent, governance, updatedAt: this.#now().toISOString() };
      await this.#store.agents.put(updated.id, updated);
      return updated;
    });
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
    const agent = await this.require(agentId);
    if (agent.status === 'retired') {
      throw new ArcError('conflict', `agent "${agent.name}" is retired and cannot be issued a credential`, {
        details: { agentId: agent.id },
      });
    }
    const issued = issueCredential(agentId, options);
    await this.#store.credentials.put(issued.credential.id, issued.credential);
    return issued;
  }

  /**
   * Issues a replacement credential and revokes the old one.
   *
   * The order is deliberate: issue first, then revoke. The reverse would open
   * a window in which the agent has no working credential at all, and an
   * agent mid-run would start failing authentication during a routine
   * rotation. Both keys are briefly valid, which is the lesser problem and
   * the one every rotation scheme accepts.
   */
  async rotateKey(
    credentialId: string,
    options: { expiresAt?: string } = {},
  ): Promise<{ readonly issued: IssuedCredential; readonly revoked: AgentCredential }> {
    const existing = await this.#store.credentials.get(credentialId);
    if (!existing) throw new ArcError('not_found', `no credential with id ${credentialId}`);
    if (existing.revokedAt) {
      throw new ArcError('conflict', 'that credential is already revoked; issue a new key instead', {
        details: { credentialId },
      });
    }

    const issued = await this.issueKey(existing.agentId, options);
    const revoked = await this.revokeKey(credentialId);
    return { issued, revoked };
  }

  /**
   * Every credential ARC holds, with its state resolved and the agent it
   * belongs to named.
   *
   * `expiringWithinDays` decides what counts as `expiring`; it is a parameter
   * rather than a constant because "soon" depends on how fast the customer can
   * actually rotate.
   */
  async credentialInventory(options: { expiringWithinDays?: number } = {}): Promise<readonly CredentialInventoryEntry[]> {
    const horizon = options.expiringWithinDays ?? 14;
    const now = this.#now().getTime();
    const agents = new Map((await this.list()).map((agent) => [agent.id, agent]));
    const credentials = await this.#store.credentials.list();

    return credentials.map((credential) => {
      const expiresAt = credential.expiresAt ? Date.parse(credential.expiresAt) : undefined;
      const days = expiresAt === undefined ? undefined : Math.floor((expiresAt - now) / 86_400_000);

      const state: CredentialState = credential.revokedAt
        ? 'revoked'
        : expiresAt !== undefined && expiresAt <= now
          ? 'expired'
          : days !== undefined && days <= horizon
            ? 'expiring'
            : 'active';

      return {
        id: credential.id,
        agentId: credential.agentId,
        agentName: agents.get(credential.agentId)?.name ?? '(unknown agent)',
        displayPrefix: credential.displayPrefix,
        state,
        createdAt: credential.createdAt,
        ...(credential.expiresAt ? { expiresAt: credential.expiresAt } : {}),
        ...(credential.revokedAt ? { revokedAt: credential.revokedAt } : {}),
        ...(credential.lastUsedAt ? { lastUsedAt: credential.lastUsedAt } : {}),
        ...(days === undefined ? {} : { daysUntilExpiry: days }),
        neverUsed: credential.lastUsedAt === undefined,
      };
    });
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

    // Positive check, not an exclusion list. 1.0 asked "is it suspended?",
    // which was correct while `active` and `suspended` were the only states.
    // 2.0 adds `draft` and `retired`, and under the old test both of those
    // would have been allowed to act — a draft agent acting before it was
    // cleared, and a retired one acting after it was withdrawn. Asking "is it
    // active?" fails closed for every state that exists now and every state
    // added later.
    if (agent.status !== ACTING_AGENT_STATUS) {
      throw new ArcError('agent_suspended', `agent "${agent.name}" is ${agent.status} and cannot act`, {
        details: { agentId: agent.id, status: agent.status },
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
