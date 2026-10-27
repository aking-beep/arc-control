import {
  ArcError,
  newId,
  validateParameters,
  type Tool,
  type ToolRegistration,
} from '@arc-control/schemas';
import type { ControlStore } from '@arc-control/store';
import type { Connector } from './connector.js';

export interface ToolRegistryOptions {
  readonly now?: () => Date;
}

/**
 * The tool registry is the catalogue of what agents may ask for. An action
 * naming a tool that is not registered is refused before policy evaluation:
 * ARC Control will not reason about a capability nobody declared.
 */
export class ToolRegistry {
  readonly #store: ControlStore;
  readonly #connectors = new Map<string, Connector>();
  readonly #now: () => Date;

  constructor(store: ControlStore, options: ToolRegistryOptions = {}) {
    this.#store = store;
    this.#now = options.now ?? (() => new Date());
  }

  addConnector(connector: Connector): this {
    if (this.#connectors.has(connector.name)) {
      throw new ArcError('conflict', `a connector named "${connector.name}" is already registered`);
    }
    this.#connectors.set(connector.name, connector);
    return this;
  }

  connector(name: string): Connector | undefined {
    return this.#connectors.get(name);
  }

  connectors(): readonly Connector[] {
    return [...this.#connectors.values()];
  }

  async register(registration: ToolRegistration): Promise<Tool> {
    return this.#store.tools.transact(async () => {
      const tool = await this.#build(registration, new Set());
      await this.#store.tools.put(tool.id, tool);
      return tool;
    });
  }

  /**
   * Registers several tools, all or none: every registration is validated
   * inside one critical section before any is written, so a failure part-way
   * through a batch leaves nothing behind.
   */
  async registerAll(registrations: readonly ToolRegistration[]): Promise<readonly Tool[]> {
    return this.#store.tools.transact(async () => {
      const pending = new Set<string>();
      const tools: Tool[] = [];
      for (const registration of registrations) {
        const tool = await this.#build(registration, pending);
        pending.add(tool.name);
        tools.push(tool);
      }
      for (const tool of tools) await this.#store.tools.put(tool.id, tool);
      return tools;
    });
  }

  /** Validates a registration and builds the tool, without writing it. Called inside the tools lock. */
  async #build(registration: ToolRegistration, pending: ReadonlySet<string>): Promise<Tool> {
    if (!/^[a-z0-9][a-z0-9._-]{1,126}[a-z0-9]$/.test(registration.name)) {
      throw new ArcError(
        'invalid_request',
        'tool name must be 3-128 lowercase characters of letters, digits, dot, dash or underscore, e.g. "stripe.refund"',
        { details: { name: registration.name } },
      );
    }

    const connector = this.#connectors.get(registration.connector);
    if (!connector) {
      throw new ArcError('invalid_request', `no connector named "${registration.connector}" is registered`, {
        details: { available: [...this.#connectors.keys()] },
      });
    }

    const duplicate = await this.#store.tools.find((tool) => tool.name === registration.name);
    if (duplicate || pending.has(registration.name)) {
      throw new ArcError('conflict', `a tool named "${registration.name}" already exists`, {
        details: { toolId: duplicate?.id },
      });
    }

    const parameterNames = new Set<string>();
    for (const spec of registration.parameters ?? []) {
      if (parameterNames.has(spec.name)) {
        throw new ArcError('invalid_request', `parameter "${spec.name}" is declared more than once`);
      }
      parameterNames.add(spec.name);
    }

    const timestamp = this.#now().toISOString();
    const tool: Tool = {
      id: newId('tool'),
      name: registration.name,
      description: registration.description,
      system: registration.system ?? registration.name.split('.')[0]!,
      effect: registration.effect,
      riskTier: registration.riskTier ?? defaultRiskTier(registration.effect),
      connector: registration.connector,
      connectorConfig: registration.connectorConfig ?? {},
      parameters: registration.parameters ?? [],
      labels: registration.labels ?? {},
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    if (!connector.supports(tool)) {
      throw new ArcError(
        'invalid_request',
        `connector "${connector.name}" cannot execute tool "${tool.name}" as configured`,
        { details: { connectorConfig: tool.connectorConfig } },
      );
    }

    return tool;
  }

  async get(toolId: string): Promise<Tool | undefined> {
    return this.#store.tools.get(toolId);
  }

  async getByName(name: string): Promise<Tool | undefined> {
    return this.#store.tools.find((tool) => tool.name === name);
  }

  async list(): Promise<readonly Tool[]> {
    return this.#store.tools.list();
  }

  /** Resolves a tool by name, refusing an unknown one. */
  /**
   * Resolves a tool by name for execution.
   *
   * A disabled tool is refused here, at the same stage an unregistered one is
   * — before any policy is consulted. That is the whole value of the switch:
   * nothing downstream can re-enable it, so flipping a tool off is a decision
   * no rule ordering, fallback effect or policy edit can undo.
   */
  async resolve(name: string): Promise<Tool> {
    const tool = await this.getByName(name);
    if (!tool) {
      throw new ArcError('unknown_tool', `no tool named "${name}" is registered with ARC Control`, {
        details: { tool: name },
      });
    }

    if (tool.disabled === true) {
      throw new ArcError('tool_disabled', `tool "${name}" is disabled and cannot be invoked`, {
        details: {
          tool: name,
          disabledAt: tool.disabledAt,
          disabledBy: tool.disabledBy,
          reason: tool.disabledReason,
        },
      });
    }

    return tool;
  }

  /**
   * The per-tool kill switch.
   *
   * Takes a reason when disabling, because the first question on finding a
   * tool switched off at 3am is why, and the second is who.
   */
  async setDisabled(
    toolId: string,
    disabled: boolean,
    actor: { readonly identifier: string; readonly reason?: string },
  ): Promise<Tool> {
    return this.#store.tools.transact(async () => {
      const tool = await this.#store.tools.get(toolId);
      if (!tool) throw new ArcError('not_found', `no tool with id ${toolId}`);

      const timestamp = this.#now().toISOString();
      const updated: Tool = disabled
        ? {
            ...tool,
            disabled: true,
            disabledAt: timestamp,
            disabledBy: actor.identifier,
            ...(actor.reason ? { disabledReason: actor.reason } : {}),
            updatedAt: timestamp,
          }
        : {
            ...tool,
            disabled: false,
            disabledAt: undefined,
            disabledBy: undefined,
            disabledReason: undefined,
            updatedAt: timestamp,
          };

      await this.#store.tools.put(updated.id, updated);
      return updated;
    });
  }

  /**
   * Disables every tool a connector executes.
   *
   * This is the connector-level kill switch, and it works by flipping the
   * tools rather than by holding a list of suspended connector names, so it
   * survives a restart — a connector switch that forgot itself on reboot
   * would be worse than none.
   *
   * The limitation, stated because it is real: a tool registered on that
   * connector *afterwards* is not disabled. Registering a tool takes an
   * operator credential and is audited, so this is a narrow gap, but it is a
   * gap. Re-run the switch after registering anything new.
   */
  async setConnectorDisabled(
    connectorName: string,
    disabled: boolean,
    actor: { readonly identifier: string; readonly reason?: string },
  ): Promise<readonly Tool[]> {
    const affected = await this.#store.tools.filter((tool) => tool.connector === connectorName);
    const updated: Tool[] = [];
    for (const tool of affected) {
      updated.push(await this.setDisabled(tool.id, disabled, actor));
    }
    return updated;
  }

  /**
   * Validates an action's parameters against the tool contract. Run before
   * policy evaluation so a policy never has to reason about a parameter the
   * tool does not declare.
   */
  validate(tool: Tool, parameters: Readonly<Record<string, unknown>>): void {
    const result = validateParameters(tool.parameters, parameters);
    if (!result.valid) {
      throw new ArcError('invalid_parameters', `the parameters for "${tool.name}" do not match its contract`, {
        details: { issues: result.issues },
      });
    }
  }
}

/** An operator may override this, but the default should never under-state risk. */
function defaultRiskTier(effect: Tool['effect']): Tool['riskTier'] {
  switch (effect) {
    case 'read':
      return 'low';
    case 'write':
      return 'medium';
    case 'irreversible':
      return 'high';
  }
}
