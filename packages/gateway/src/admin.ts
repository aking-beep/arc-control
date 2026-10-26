import { digest } from '@arc-control/schemas';
import type {
  Agent,
  AgentGovernance,
  AgentRegistration,
  Policy,
  Tool,
  ToolRegistration,
} from '@arc-control/schemas';
import type { AgentRegistry, IssuedCredential } from '@arc-control/agent-identity';
import type { AuditLog } from '@arc-control/audit';
import type { ToolRegistry } from '@arc-control/execution';
import type { PolicyStore } from './policies.js';

/**
 * Administration, with auditing attached.
 *
 * Registering an agent, defining a tool and publishing a policy all change
 * what agents are permitted to do, so each belongs in the audit log as much as
 * an action does — "who widened this policy, and when?" is the first question
 * any incident review asks.
 *
 * These operations live on the gateway rather than in the API layer so that
 * every entry point is audited by construction. The HTTP API, the CLI and a
 * seed script all go through this path, and none of them can forget to.
 */

/** Who performed an administrative change. */
export interface Actor {
  readonly identifier: string;
  /** How the change arrived, recorded for context. */
  readonly via?: 'api' | 'cli' | 'console' | 'seed' | 'system';
}

export interface AdminDependencies {
  readonly agents: AgentRegistry;
  readonly tools: ToolRegistry;
  readonly policies: PolicyStore;
  readonly audit: AuditLog;
}

export class Administration {
  readonly #deps: AdminDependencies;

  constructor(dependencies: AdminDependencies) {
    this.#deps = dependencies;
  }

  async registerAgent(registration: AgentRegistration, actor: Actor): Promise<Agent> {
    const agent = await this.#deps.agents.register(registration);
    await this.#deps.audit.append({
      type: 'agent.registered',
      organizationId: agent.organizationId,
      actor: actor.identifier,
      subject: agent.id,
      summary: `${actor.identifier} registered agent "${agent.name}" owned by ${agent.owner}`,
      data: { name: agent.name, owner: agent.owner, roles: agent.roles, kind: agent.kind, via: actor.via },
    });
    return agent;
  }

  /**
   * Retires an agent and revokes its credentials.
   *
   * Separate from `setAgentStatus` because it is not a status change that can
   * be undone — the registry refuses to revive a retired agent, so an operator
   * who wants it back must register it again and be seen doing so.
   */
  async retireAgent(agentId: string, actor: Actor): Promise<Agent> {
    const { agent, revoked } = await this.#deps.agents.retire(agentId);

    await this.#deps.audit.append({
      type: 'agent.retired',
      organizationId: agent.organizationId,
      actor: actor.identifier,
      subject: agent.id,
      summary: `${actor.identifier} retired agent "${agent.name}" and revoked ${revoked.length} credential(s)`,
      data: { revokedCredentialIds: revoked, via: actor.via },
    });

    return agent;
  }

  /** Records an agent's governance record, or a completed permission review. */
  async setAgentGovernance(agentId: string, governance: AgentGovernance, actor: Actor): Promise<Agent> {
    const agent = await this.#deps.agents.setGovernance(agentId, governance);

    await this.#deps.audit.append({
      type: 'agent.updated',
      organizationId: agent.organizationId,
      actor: actor.identifier,
      subject: agent.id,
      summary: `${actor.identifier} recorded the governance record for "${agent.name}"`,
      data: {
        purpose: governance.purpose,
        criticality: governance.criticality,
        lastReviewedAt: governance.lastReviewedAt,
        lastReviewedBy: governance.lastReviewedBy,
        via: actor.via,
      },
    });

    return agent;
  }

  /**
   * The per-tool kill switch.
   *
   * Audited with the reason, because "who turned off stripe.refund and why" is
   * the first thing asked after the incident and the hardest thing to
   * reconstruct from memory.
   */
  async setToolDisabled(
    toolId: string,
    disabled: boolean,
    actor: Actor,
    reason?: string,
  ): Promise<Tool> {
    const tool = await this.#deps.tools.setDisabled(toolId, disabled, {
      identifier: actor.identifier,
      ...(reason ? { reason } : {}),
    });

    await this.#deps.audit.append({
      type: disabled ? 'tool.disabled' : 'tool.enabled',
      organizationId: 'default',
      actor: actor.identifier,
      subject: tool.id,
      summary: `${actor.identifier} ${disabled ? 'disabled' : 're-enabled'} tool "${tool.name}"${reason ? `: ${reason}` : ''}`,
      data: { toolId: tool.id, name: tool.name, reason, via: actor.via },
    });

    return tool;
  }

  /**
   * The connector-level kill switch: disables every tool that connector runs.
   *
   * Implemented by flipping the tools rather than by holding a list of
   * suspended connectors, so it survives a restart. The gap, audited along
   * with everything else: a tool registered on that connector afterwards is
   * not covered, so re-run this after registering anything new.
   */
  async setConnectorDisabled(
    connectorName: string,
    disabled: boolean,
    actor: Actor,
    reason?: string,
  ): Promise<readonly Tool[]> {
    const affected = await this.#deps.tools.setConnectorDisabled(connectorName, disabled, {
      identifier: actor.identifier,
      ...(reason ? { reason } : {}),
    });

    await this.#deps.audit.append({
      type: disabled ? 'connector.disabled' : 'connector.enabled',
      organizationId: 'default',
      actor: actor.identifier,
      subject: connectorName,
      summary: `${actor.identifier} ${disabled ? 'disabled' : 're-enabled'} connector "${connectorName}", affecting ${affected.length} tool(s)${reason ? `: ${reason}` : ''}`,
      data: {
        connector: connectorName,
        tools: affected.map((tool) => tool.name),
        reason,
        via: actor.via,
        limitation: 'a tool registered on this connector after this change is not covered by it',
      },
    });

    return affected;
  }

  /** Issues a replacement credential and revokes the old one, in that order. */
  async rotateKey(credentialId: string, actor: Actor, options: { expiresAt?: string } = {}): Promise<IssuedCredential> {
    const { issued, revoked } = await this.#deps.agents.rotateKey(credentialId, options);
    const agent = await this.#deps.agents.require(issued.credential.agentId);

    await this.#deps.audit.append({
      type: 'credential.rotated',
      organizationId: agent.organizationId,
      actor: actor.identifier,
      subject: agent.id,
      summary: `${actor.identifier} rotated a credential for "${agent.name}"`,
      data: {
        issuedCredentialId: issued.credential.id,
        revokedCredentialId: revoked.id,
        displayPrefix: issued.credential.displayPrefix,
        via: actor.via,
      },
    });

    return issued;
  }

  /**
   * Suspends an agent, or brings one back.
   *
   * Going to `active` goes through `agents.activate`, not `agents.resume`.
   * `resume` sets the status with no questions asked, so every caller of this
   * method — the API's `/resume` and `/activate` routes among them — could
   * revive a retired agent, which retirement is supposed to make impossible.
   * Routing it through `activate` means the refusal lives in one place and
   * no route can miss it.
   */
  async setAgentStatus(agentId: string, status: 'active' | 'suspended', actor: Actor): Promise<Agent> {
    const agent =
      status === 'suspended'
        ? await this.#deps.agents.suspend(agentId)
        : await this.#deps.agents.activate(agentId);

    await this.#deps.audit.append({
      type: status === 'suspended' ? 'agent.suspended' : 'agent.resumed',
      organizationId: agent.organizationId,
      actor: actor.identifier,
      subject: agent.id,
      summary: `${actor.identifier} ${status === 'suspended' ? 'suspended' : 'resumed'} agent "${agent.name}"`,
      data: { via: actor.via },
    });
    return agent;
  }

  async issueKey(agentId: string, actor: Actor, options: { expiresAt?: string } = {}): Promise<IssuedCredential> {
    const agent = await this.#deps.agents.require(agentId);
    const issued = await this.#deps.agents.issueKey(agentId, options);

    await this.#deps.audit.append({
      type: 'credential.issued',
      organizationId: agent.organizationId,
      actor: actor.identifier,
      subject: agent.id,
      summary: `${actor.identifier} issued credential ${issued.credential.displayPrefix} for "${agent.name}"`,
      data: {
        credentialId: issued.credential.id,
        displayPrefix: issued.credential.displayPrefix,
        expiresAt: issued.credential.expiresAt,
        via: actor.via,
      },
    });

    return issued;
  }

  async revokeKey(credentialId: string, actor: Actor): Promise<void> {
    const credential = await this.#deps.agents.revokeKey(credentialId);
    const agent = await this.#deps.agents.get(credential.agentId);

    await this.#deps.audit.append({
      type: 'credential.revoked',
      organizationId: agent?.organizationId ?? 'default',
      actor: actor.identifier,
      subject: credential.agentId,
      summary: `${actor.identifier} revoked credential ${credential.displayPrefix}`,
      data: { credentialId: credential.id, via: actor.via },
    });
  }

  async registerTool(registration: ToolRegistration, actor: Actor): Promise<Tool> {
    const tool = await this.#deps.tools.register(registration);
    await this.#deps.audit.append({
      type: 'tool.registered',
      organizationId: 'default',
      actor: actor.identifier,
      subject: tool.id,
      summary: `${actor.identifier} registered tool "${tool.name}" (${tool.effect}, ${tool.riskTier} risk) on connector ${tool.connector}`,
      data: {
        name: tool.name,
        connector: tool.connector,
        effect: tool.effect,
        riskTier: tool.riskTier,
        parameters: tool.parameters.map((spec) => spec.name),
        via: actor.via,
      },
    });
    return tool;
  }

  /**
   * Publishes a policy. The audit record carries the document's digest, so a
   * decision citing `FINANCE-004` version 3 can be matched against the exact
   * text that was in force when it was made.
   */
  async publishPolicy(policy: Policy, actor: Actor): Promise<Policy> {
    const previous = await this.#deps.policies.get(policy.id);
    const stored = await this.#deps.policies.publish(policy, { identifier: actor.identifier, via: actor.via ?? 'api' });

    await this.#deps.audit.append({
      type: previous ? 'policy.updated' : 'policy.created',
      organizationId: 'default',
      actor: actor.identifier,
      subject: stored.id,
      summary: previous
        ? `${actor.identifier} updated ${stored.id} from version ${previous.version} to ${stored.version}`
        : `${actor.identifier} created ${stored.id} version ${stored.version}`,
      data: {
        policyId: stored.id,
        version: stored.version,
        previousVersion: previous?.version,
        enabled: stored.enabled,
        rules: stored.rules.map((rule) => ({ id: rule.id, effect: rule.effect })),
        documentDigest: digest(stored),
        via: actor.via,
      },
    });

    return stored;
  }

  async setPolicyEnabled(policyId: string, enabled: boolean, actor: Actor): Promise<Policy> {
    const policy = await this.#deps.policies.setEnabled(policyId, enabled, {
      identifier: actor.identifier,
      via: actor.via ?? 'api',
    });
    await this.#deps.audit.append({
      type: enabled ? 'policy.updated' : 'policy.disabled',
      organizationId: 'default',
      actor: actor.identifier,
      subject: policy.id,
      summary: `${actor.identifier} ${enabled ? 'enabled' : 'disabled'} ${policy.id}`,
      data: { policyId: policy.id, version: policy.version, enabled, via: actor.via },
    });
    return policy;
  }
}
