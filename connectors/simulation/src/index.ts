import { ConnectorError, type Connector, type ConnectorResult, type ExecutionContext } from '@arc-control/execution';
import type { Tool } from '@arc-control/schemas';

export type SimulationHandler = (
  parameters: Readonly<Record<string, unknown>>,
  context: ExecutionContext,
) => unknown | Promise<unknown>;

export interface SimulationConnectorOptions {
  readonly name?: string;
  /** Handlers by tool name. */
  readonly handlers?: Readonly<Record<string, SimulationHandler>>;
}

/**
 * An in-process connector whose effects are entirely simulated.
 *
 * It exists so the control path can be exercised honestly — examples, evals
 * and tests all run the real gateway, the real policy engine and the real
 * evidence chain, and only the final side effect is fictional. Nothing about
 * authorization is stubbed out, which is the whole point: a demo that fakes
 * the decision proves nothing.
 *
 * It records every call it was asked to make, so a test can assert on the
 * stronger claim — that a denied action never reached the system at all.
 */
export class SimulationConnector implements Connector {
  readonly name: string;
  readonly #handlers = new Map<string, SimulationHandler>();
  readonly #calls: { tool: string; parameters: Readonly<Record<string, unknown>>; at: string }[] = [];

  constructor(options: SimulationConnectorOptions = {}) {
    this.name = options.name ?? 'simulation';
    for (const [tool, handler] of Object.entries(options.handlers ?? {})) {
      this.#handlers.set(tool, handler);
    }
  }

  handle(tool: string, handler: SimulationHandler): this {
    this.#handlers.set(tool, handler);
    return this;
  }

  supports(tool: Tool): boolean {
    return tool.connector === this.name;
  }

  async execute(context: ExecutionContext): Promise<ConnectorResult> {
    const { action, tool } = context;

    this.#calls.push({
      tool: tool.name,
      parameters: action.parameters,
      at: new Date().toISOString(),
    });

    const handler = this.#handlers.get(tool.name);
    if (!handler) {
      throw new ConnectorError('not_implemented', `the simulation connector has no handler for "${tool.name}"`);
    }

    const output = await handler(action.parameters, context);
    return { output, metadata: { simulated: true, attempt: context.attempt } };
  }

  async health(): Promise<{ healthy: boolean; detail?: string }> {
    return { healthy: true, detail: `${this.#handlers.size} simulated tool(s)` };
  }

  /** Every call that actually reached the connector, in order. */
  get calls(): readonly { tool: string; parameters: Readonly<Record<string, unknown>>; at: string }[] {
    return this.#calls;
  }

  /** How many times a tool was actually executed. Zero is the assertion that matters for a denial. */
  callCount(tool?: string): number {
    return tool ? this.#calls.filter((call) => call.tool === tool).length : this.#calls.length;
  }

  reset(): void {
    this.#calls.length = 0;
  }
}
