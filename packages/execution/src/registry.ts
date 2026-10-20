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
      if (duplicate) {
        throw new ArcError('conflict', `a tool named "${registration.name}" already exists`, {
          details: { toolId: duplicate.id },
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

      await this.#store.tools.put(tool.id, tool);
      return tool;
    });
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
  async resolve(name: string): Promise<Tool> {
    const tool = await this.getByName(name);
    if (!tool) {
      throw new ArcError('unknown_tool', `no tool named "${name}" is registered with ARC Control`, {
        details: { tool: name },
      });
    }
    return tool;
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
