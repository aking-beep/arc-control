import { ArcError, digest } from '@arc-control/schemas';
import { compareGrades, gradeScan, scanManifest, type McpGrade, type McpServerManifest } from '@arc-control/mcp-security';
import { comparePromptGrades, reviewPrompt, type PromptGrade, type PromptReview } from '@arc-control/prompt-review';
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
import type { SpendInput, SpendLedger } from '@arc-control/spend';
import type { Budget, SpendRecord } from '@arc-control/schemas';
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
  readonly spend: SpendLedger;
  readonly gates?: GateOptions;
}

/**
 * Registration and activation gates (2.3, ADR-0002). Each is off until set,
 * and each can only refuse: a gate never makes a registration succeed that
 * would otherwise fail.
 */
export interface GateOptions {
  /**
   * Lowest grade an MCP server may have for its tools to be registered. Once
   * set, MCP tools can only be registered through `registerMcpServer`, which
   * scans the server first; `registerTool` refuses them.
   */
  readonly mcpMinimumGrade?: McpGrade;
  /**
   * Lowest prompt-review grade an agent may have to become active. Once set,
   * an agent must be registered as a draft, have its prompt reviewed, and be
   * activated; activating or resuming an agent with no review, or one graded
   * below this, is refused.
   */
  readonly promptMinimumGrade?: PromptGrade;
  /**
   * Vets the endpoint of every tool registered with a `connectorConfig.url`
   * (the generic HTTP connector's tools). A tool whose endpoint fails is not
   * registered; a vetter that throws refuses too.
   */
  readonly endpointVetter?: EndpointVetter;
}

/** What the endpoint gate needs from a vetter. The gateway holds no network code of its own. */
export interface EndpointVetter {
  vet(url: string): Promise<{
    readonly ok: boolean;
    readonly url: string;
    readonly findings: readonly { readonly id: string; readonly severity: string; readonly detail: string }[];
    readonly certificate?: { readonly validTo: string };
    readonly vettedAt: string;
  }>;
}

export class Administration {
  readonly #deps: AdminDependencies;

  constructor(dependencies: AdminDependencies) {
    this.#deps = dependencies;
  }

  /** The gates in force, so the API and console can say which are on. */
  get gates(): GateOptions {
    return this.#deps.gates ?? {};
  }

  async registerAgent(registration: AgentRegistration, actor: Actor): Promise<Agent> {
    // Registering straight into `active` would step around the activation
    // gate, so with it on an agent starts as a draft or not at all.
    if (this.gates.promptMinimumGrade !== undefined && registration.draft !== true) {
      await this.#deps.audit.append({
        type: 'agent.activation_refused',
        organizationId: registration.organizationId ?? 'default',
        actor: actor.identifier,
        subject: registration.name,
        summary: `${actor.identifier} tried to register "${registration.name}" as active; refused because the prompt gate requires a reviewed draft first`,
        data: { name: registration.name, reason: 'register_as_draft', minimumGrade: this.gates.promptMinimumGrade, via: actor.via },
      });
      throw new ArcError(
        'gate_refused',
        `the prompt gate is on: register "${registration.name}" as a draft, review its prompt, then activate it`,
        { details: { gate: 'prompt', reason: 'register_as_draft' } },
      );
    }
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
    if (status === 'active') await this.#checkPromptGate(agentId, actor);
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
    // With the MCP gate on, an MCP tool registered one at a time would never
    // be scanned — the gate would hold only for callers who chose to use it.
    if (this.gates.mcpMinimumGrade !== undefined && registration.connector.startsWith('mcp:')) {
      await this.#deps.audit.append({
        type: 'mcp.registration_refused',
        organizationId: 'default',
        actor: actor.identifier,
        subject: registration.name,
        summary: `${actor.identifier} tried to register MCP tool "${registration.name}" without a scan; refused because the MCP gate is on`,
        data: { name: registration.name, connector: registration.connector, reason: 'unscanned', via: actor.via },
      });
      throw new ArcError(
        'gate_refused',
        `"${registration.name}" runs on an MCP connector, and the MCP gate requires its server to be scanned: register it through the MCP registration path`,
        { details: { gate: 'mcp', reason: 'unscanned' } },
      );
    }
    return this.#registerTool(registration, actor);
  }

  /**
   * Scans an MCP server's manifest, grades it, and registers the chosen tools
   * from it — or registers none of them.
   *
   * The scan runs here, on the manifest, rather than accepting a report from
   * the caller: a gate that trusted a supplied grade would be a form field.
   * Every registration must run on this server's connector and name a tool
   * the manifest advertises, so a clean manifest cannot carry tools from
   * somewhere else through the gate. Each registered tool is labelled with
   * the grade and a digest of the findings it was admitted with.
   */
  async registerMcpServer(
    input: { readonly manifest: McpServerManifest; readonly registrations: readonly ToolRegistration[] },
    actor: Actor,
  ): Promise<{ readonly tools: readonly Tool[]; readonly grade: McpGrade; readonly score: number; readonly findings: number }> {
    const { manifest, registrations } = input;
    const report = scanManifest(manifest);
    const graded = gradeScan(report);
    const connector = `mcp:${manifest.name}`;
    const advertised = new Set(manifest.tools.map((tool) => tool.name));

    const refuse = async (reason: string, message: string, details: Record<string, unknown> = {}): Promise<never> => {
      await this.#deps.audit.append({
        type: 'mcp.registration_refused',
        organizationId: 'default',
        actor: actor.identifier,
        subject: manifest.name,
        summary: `${actor.identifier} tried to register ${registrations.length} tool(s) from MCP server "${manifest.name}": ${message}`,
        data: {
          server: manifest.name,
          endpoint: redactUrl(manifest.endpoint),
          grade: graded.grade,
          score: graded.score,
          minimumGrade: this.gates.mcpMinimumGrade,
          findings: report.findings.map((finding) => ({ id: finding.id, severity: finding.severity, tool: finding.tool })),
          reason,
          via: actor.via,
          ...details,
        },
      });
      throw new ArcError('gate_refused', message, {
        details: { gate: 'mcp', reason, grade: graded.grade, score: graded.score, basis: graded.basis, ...details },
      });
    };

    if (registrations.length === 0) {
      throw new ArcError('invalid_request', 'name at least one tool to register from this server');
    }
    for (const registration of registrations) {
      const remote = typeof registration.connectorConfig?.mcpTool === 'string' ? registration.connectorConfig.mcpTool : undefined;
      if (registration.connector !== connector || remote === undefined || !advertised.has(remote)) {
        await refuse(
          'not_in_manifest',
          `"${registration.name}" must run on ${connector} and name a tool this server advertises in connectorConfig.mcpTool`,
          { tool: registration.name },
        );
      }
    }

    const minimum = this.gates.mcpMinimumGrade;
    if (minimum !== undefined && compareGrades(graded.grade, minimum) < 0) {
      await refuse(
        'below_minimum_grade',
        `MCP server "${manifest.name}" grades ${graded.grade} (${graded.basis}); the minimum for registration is ${minimum}`,
      );
    }

    const findingsDigest = digest(report.findings.map((finding) => ({ id: finding.id, severity: finding.severity, tool: finding.tool })));
    // All or none: vet every endpoint first, then register the batch in one
    // critical section, so a failure on the last tool leaves no earlier one
    // behind as an unannounced half of a server.
    const prepared: ToolRegistration[] = [];
    for (const registration of registrations) {
      const vetted = await this.#vetEndpoint(registration, actor);
      prepared.push({
        ...registration,
        labels: { ...(registration.labels ?? {}), ...(vetted ?? {}), mcpGrade: graded.grade, mcpFindingsDigest: findingsDigest },
      });
    }
    const tools = await this.#deps.tools.registerAll(prepared);
    for (const tool of tools) await this.#auditRegistered(tool, actor);
    return { tools, grade: graded.grade, score: graded.score, findings: report.findings.length };
  }

  async #registerTool(registration: ToolRegistration, actor: Actor): Promise<Tool> {
    const vetted = await this.#vetEndpoint(registration, actor);
    const tool = await this.#deps.tools.register(
      vetted === undefined ? registration : { ...registration, labels: { ...(registration.labels ?? {}), ...vetted } },
    );
    await this.#auditRegistered(tool, actor);
    return tool;
  }

  async #auditRegistered(tool: Tool, actor: Actor): Promise<void> {
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

  /**
   * Creates a budget, or replaces one. Audited with the full document, so
   * "who raised this agent's limit, and from what" is answerable.
   */
  async saveBudget(
    value: unknown,
    actor: Actor,
    options: { readonly organizationId?: string; readonly id?: string } = {},
  ): Promise<Budget> {
    const previous = options.id === undefined ? undefined : await this.#deps.spend.budget(options.id);
    const budget = await this.#deps.spend.saveBudget(value, {
      organizationId: options.organizationId ?? 'default',
      ...(options.id !== undefined ? { id: options.id } : {}),
    });

    await this.#deps.audit.append({
      type: previous ? 'budget.updated' : 'budget.created',
      organizationId: budget.organizationId,
      actor: actor.identifier,
      subject: budget.id,
      summary: previous
        ? `${actor.identifier} changed budget "${budget.name}" from $${previous.limitUsd} to $${budget.limitUsd} per ${budget.period} (${budget.onExceeded}${budget.enabled ? '' : ', disabled'})`
        : `${actor.identifier} created budget "${budget.name}": $${budget.limitUsd} per ${budget.period}, ${budget.onExceeded} when exhausted`,
      data: {
        budget,
        ...(previous ? { previous: { limitUsd: previous.limitUsd, onExceeded: previous.onExceeded, enabled: previous.enabled, version: previous.version } } : {}),
        via: actor.via,
      },
    });
    return budget;
  }

  /**
   * Records spend reported by an agent or an operator. Always unverified:
   * ARC did not fetch it. It counts toward budgets all the same, because the
   * only thing a reporter can do with it is make a budget tighter.
   */
  async reportSpend(input: SpendInput, actor: Actor): Promise<SpendRecord> {
    const record = await this.#deps.spend.record(input, 'reported', actor.identifier);
    await this.#deps.audit.append({
      type: 'spend.reported',
      organizationId: record.organizationId,
      actor: actor.identifier,
      subject: record.agentId ?? record.organizationId,
      summary: `${actor.identifier} reported $${record.amountUsd} of ${record.provider} spend (unverified)`,
      data: {
        spendId: record.id,
        agentId: record.agentId,
        provider: record.provider,
        amountUsd: record.amountUsd,
        occurredAt: record.occurredAt,
        via: actor.via,
      },
    });
    return record;
  }

  /**
   * Reviews an agent's system prompt and records the outcome on the agent.
   *
   * The prompt is reviewed and dropped: the record and the audit entry carry
   * the grade, the failed checks and a digest, never the text.
   */
  async reviewAgentPrompt(
    agentId: string,
    input: { readonly prompt: string; readonly tools?: readonly { readonly name: string; readonly description?: string }[] },
    actor: Actor,
  ): Promise<{ readonly agent: Agent; readonly review: PromptReview }> {
    if (typeof input.prompt !== 'string') throw new ArcError('invalid_request', 'prompt must be a string');
    const review = reviewPrompt(input);
    const agent = await this.#deps.agents.setPromptReview(agentId, {
      grade: review.grade,
      score: review.score,
      promptDigest: review.promptDigest,
      failed: review.failed,
      reviewedAt: new Date().toISOString(),
      reviewedBy: actor.identifier,
    });

    await this.#deps.audit.append({
      type: 'agent.updated',
      organizationId: agent.organizationId,
      actor: actor.identifier,
      subject: agent.id,
      summary: `${actor.identifier} reviewed the prompt of "${agent.name}": grade ${review.grade} (${review.basis})`,
      data: {
        promptReview: { grade: review.grade, score: review.score, promptDigest: review.promptDigest, failed: review.failed },
        via: actor.via,
      },
    });
    // A review that falls below the gate on an agent already acting takes it
    // out of action: the gate is about what may act, not only about what may
    // start. Resuming it goes back through the gate.
    const minimum = this.gates.promptMinimumGrade;
    if (minimum !== undefined && agent.status === 'active' && comparePromptGrades(review.grade, minimum) < 0) {
      const suspended = await this.#deps.agents.suspend(agent.id);
      await this.#deps.audit.append({
        type: 'agent.suspended',
        organizationId: agent.organizationId,
        actor: actor.identifier,
        subject: agent.id,
        summary: `"${agent.name}" was suspended because its prompt review graded ${review.grade}, below the minimum of ${minimum}`,
        data: { reason: 'prompt_review_below_minimum', grade: review.grade, minimumGrade: minimum, via: actor.via },
      });
      return { agent: suspended, review };
    }
    return { agent, review };
  }

  /** Refuses to make an agent active when the prompt gate is on and its review is missing or below the minimum. */
  async #checkPromptGate(agentId: string, actor: Actor): Promise<void> {
    const minimum = this.gates.promptMinimumGrade;
    if (minimum === undefined) return;
    const agent = await this.#deps.agents.require(agentId);
    const review = agent.promptReview;
    if (review !== undefined && comparePromptGrades(review.grade, minimum) >= 0) return;

    const reason = review === undefined ? 'not_reviewed' : 'below_minimum_grade';
    const message =
      review === undefined
        ? `"${agent.name}" has no prompt review, and the prompt gate requires grade ${minimum} or better to become active`
        : `"${agent.name}" has a prompt graded ${review.grade}; the minimum to become active is ${minimum}`;
    await this.#deps.audit.append({
      type: 'agent.activation_refused',
      organizationId: agent.organizationId,
      actor: actor.identifier,
      subject: agent.id,
      summary: `${actor.identifier} tried to activate "${agent.name}": ${message}`,
      data: { reason, grade: review?.grade, minimumGrade: minimum, via: actor.via },
    });
    throw new ArcError('gate_refused', message, { details: { gate: 'prompt', reason, grade: review?.grade, minimumGrade: minimum } });
  }

  /**
   * The endpoint gate. Returns labels to stamp on the tool when it passes,
   * nothing when the gate is off or the tool has no URL, and throws — after
   * auditing — when the endpoint fails or cannot be vetted.
   */
  async #vetEndpoint(registration: ToolRegistration, actor: Actor): Promise<Record<string, string> | undefined> {
    const vetter = this.gates.endpointVetter;
    const url = registration.connectorConfig?.url;
    if (vetter === undefined || typeof url !== 'string') return undefined;

    let result: Awaited<ReturnType<EndpointVetter['vet']>> | undefined;
    let failure: string | undefined;
    try {
      result = await vetter.vet(url);
    } catch (cause) {
      failure = `the endpoint could not be vetted: ${cause instanceof Error ? cause.message : String(cause)}`;
    }
    const errors = result?.findings.filter((finding) => finding.severity === 'error') ?? [];
    if (result !== undefined && result.ok && errors.length === 0) {
      return {
        endpointVettedAt: result.vettedAt,
        ...(result.certificate ? { endpointCertificateValidTo: result.certificate.validTo } : {}),
      };
    }

    // The URL can carry credentials, and a vetter's findings can quote it;
    // neither may reach the audit chain or the error as written (invariant 8).
    const safe = redactUrl(url);
    const scrub = (text: string): string => text.split(url).join(safe);
    const findings = (result?.findings ?? []).map((finding) => ({ ...finding, detail: scrub(finding.detail) }));
    const message = scrub(
      failure ??
        `the endpoint of "${registration.name}" failed vetting: ${findings
          .filter((finding) => finding.severity === 'error')
          .map((finding) => `${finding.id} ${finding.detail}`)
          .join('; ')}`,
    );
    await this.#deps.audit.append({
      type: 'tool.registration_refused',
      organizationId: 'default',
      actor: actor.identifier,
      subject: registration.name,
      summary: `${actor.identifier} tried to register tool "${registration.name}": ${message}`,
      data: {
        name: registration.name,
        connector: registration.connector,
        url: safe,
        findings,
        ...(failure ? { error: scrub(failure) } : {}),
        via: actor.via,
      },
    });
    throw new ArcError('gate_refused', message, {
      details: { gate: 'endpoint', reason: failure ? 'vetting_failed' : 'endpoint_refused', findings },
    });
  }
}

/**
 * A URL with its credentials and query values removed, for records. An
 * unparseable one is not echoed at all: whatever it is, it is not safe to
 * assume it holds no secret.
 */
export function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.username || url.password) {
      url.username = 'redacted';
      url.password = '';
    }
    for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, 'redacted');
    url.hash = '';
    return url.toString();
  } catch {
    return '[unparseable url]';
  }
}
