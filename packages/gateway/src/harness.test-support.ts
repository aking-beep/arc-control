import type { Tool } from '@arc-control/schemas';
import { ConnectorError, type Connector, type ConnectorResult, type ExecutionContext } from '@arc-control/execution';

/**
 * A recording connector for gateway tests. It is deliberately local to this
 * package: the gateway must not depend on any real connector, so its tests
 * do not either.
 */
export class RecordingConnector implements Connector {
  readonly name = 'recording';
  readonly calls: { tool: string; parameters: Readonly<Record<string, unknown>> }[] = [];
  #failWith: ConnectorError | undefined;

  constructor(private readonly reply: (parameters: Readonly<Record<string, unknown>>) => unknown = () => ({ ok: true })) {}

  failWith(error: ConnectorError | undefined): void {
    this.#failWith = error;
  }

  supports(tool: Tool): boolean {
    return tool.connector === this.name;
  }

  async execute(context: ExecutionContext): Promise<ConnectorResult> {
    this.calls.push({ tool: context.tool.name, parameters: context.action.parameters });
    if (this.#failWith) throw this.#failWith;
    return { output: this.reply(context.action.parameters) };
  }

  callCount(tool?: string): number {
    return tool ? this.calls.filter((call) => call.tool === tool).length : this.calls.length;
  }
}
