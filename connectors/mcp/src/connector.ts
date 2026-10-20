import { ConnectorError, type Connector, type ConnectorResult, type ExecutionContext } from '@arc-control/execution';
import { detectDrift, manifestDigest, scanManifest, type McpServerManifest, type ScanReport } from '@arc-control/mcp-security';
import type { Tool, ToolRegistration } from '@arc-control/schemas';
import { McpClient, type McpClientOptions } from './client.js';

export interface McpConnectorOptions extends McpClientOptions {
  /**
   * Refuse to execute when the server's advertised tool surface no longer
   * matches what was pinned at registration. Defaults to true: a tool whose
   * description changed after a human approved it is not the tool that was
   * approved.
   */
  readonly enforceManifestPinning?: boolean;
  /**
   * How long a verified tool surface is trusted before it is re-read, in
   * milliseconds. Defaults to 60 seconds.
   *
   * Verifying on literally every call would double the latency ARC Control
   * adds to each action, and a server that rewrites a description mid-window
   * is caught by the next check, the console's drift report or the scheduled
   * re-scan. Set this to 0 to verify before every call where that cost is
   * worth paying.
   */
  readonly manifestRecheckMs?: number;
}

/**
 * Fronts an MCP server so that every tool call is authorized, executed and
 * evidenced by ARC Control.
 *
 * MCP is the first protocol ARC Control attaches to because it is where
 * enterprise agents are actually gaining the ability to act, and because the
 * protocol itself carries no notion of authorization: a client that can reach
 * a server can call anything the server advertises. Putting the gateway in
 * front turns the server's tool list from a set of capabilities into a set of
 * *requests*.
 *
 * `connectorConfig.mcpTool` names the tool on the remote server, so an
 * operator can expose `stripe.refund` to agents while the server calls it
 * `create_refund`.
 */
export class McpConnector implements Connector {
  readonly name: string;
  readonly #client: McpClient;
  readonly #enforcePinning: boolean;
  readonly #recheckMs: number;
  #pinned: McpServerManifest | undefined;
  #pinnedDigest: string | undefined;
  #verifiedAt = 0;

  constructor(options: McpConnectorOptions) {
    this.#client = new McpClient(options);
    this.name = `mcp:${this.#client.name}`;
    this.#enforcePinning = options.enforceManifestPinning ?? true;
    this.#recheckMs = options.manifestRecheckMs ?? 60_000;
  }

  get endpoint(): string {
    return this.#client.endpoint;
  }

  /**
   * Connects to the server, scans its tool surface and pins it.
   *
   * Scanning happens before any tool is registered, not after: an operator
   * should see a poisoned description while deciding whether to expose the
   * server, not once agents are already calling it.
   */
  async connect(options: { suppress?: readonly string[] } = {}): Promise<{
    readonly manifest: McpServerManifest;
    readonly report: ScanReport;
  }> {
    await this.#client.initialize();
    const manifest = await this.#client.listTools();
    const report = scanManifest(manifest, options.suppress ? { suppress: options.suppress } : {});

    this.#pinned = manifest;
    this.#pinnedDigest = manifestDigest(manifest);
    this.#verifiedAt = Date.now();

    return { manifest, report };
  }

  /** The manifest pinned at connect time, if any. */
  get pinnedManifest(): McpServerManifest | undefined {
    return this.#pinned;
  }

  /** Re-reads the server's tool surface and compares it against the pin. */
  async checkForDrift(): Promise<ReturnType<typeof detectDrift>> {
    if (!this.#pinned) {
      throw new ConnectorError('not_pinned', 'connect() must pin a manifest before drift can be detected');
    }
    return detectDrift(this.#pinned, await this.#client.listTools());
  }

  supports(tool: Tool): boolean {
    if (tool.connector !== this.name) return false;
    const remote = tool.connectorConfig.mcpTool;
    return remote === undefined || typeof remote === 'string';
  }

  async execute(context: ExecutionContext): Promise<ConnectorResult> {
    const remoteName = this.#remoteName(context.tool);

    if (this.#enforcePinning) await this.#assertSurfaceUnchanged(remoteName);

    const output = await this.#client.callTool(remoteName, context.action.parameters, context.signal);
    return { output, metadata: { mcpServer: this.#client.name, mcpTool: remoteName } };
  }

  async health(): Promise<{ healthy: boolean; detail?: string }> {
    try {
      const manifest = await this.#client.listTools();
      const drifted = this.#pinnedDigest !== undefined && manifestDigest(manifest) !== this.#pinnedDigest;
      if (!drifted) this.#verifiedAt = Date.now();
      return {
        healthy: !drifted,
        detail: drifted
          ? 'the advertised tool surface no longer matches the pinned manifest'
          : `${manifest.tools.length} tool(s) advertised`,
      };
    } catch (cause) {
      return { healthy: false, detail: cause instanceof Error ? cause.message : String(cause) };
    }
  }

  /**
   * Builds ARC Control tool definitions from the server's advertised tools, so
   * an operator can register a scanned server without transcribing schemas by
   * hand.
   *
   * Every generated definition is `effect: 'write'` unless the server
   * annotates the tool as read-only, and `riskTier: 'high'`. Guessing low on
   * an unknown remote capability is the one mistake that cannot be walked
   * back, so the default is deliberately pessimistic and the operator is
   * expected to lower it deliberately.
   */
  toToolRegistrations(options: { prefix?: string; only?: readonly string[] } = {}): ToolRegistration[] {
    if (!this.#pinned) {
      throw new ConnectorError('not_pinned', 'connect() must pin a manifest before tools can be derived');
    }

    const prefix = options.prefix ?? this.#client.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    const only = options.only ? new Set(options.only) : undefined;

    return this.#pinned.tools
      .filter((tool) => !only || only.has(tool.name))
      .map((tool) => {
        const readOnly = tool.annotations?.readOnlyHint === true;
        return {
          name: `${prefix}.${tool.name}`.toLowerCase(),
          description: tool.description ?? `MCP tool "${tool.name}" on ${this.#client.name}.`,
          system: prefix,
          effect: readOnly ? ('read' as const) : ('write' as const),
          riskTier: readOnly ? ('medium' as const) : ('high' as const),
          connector: this.name,
          connectorConfig: { mcpTool: tool.name },
          parameters: parametersFromSchema(tool.inputSchema),
          labels: { source: 'mcp', mcpServer: this.#client.name },
        };
      });
  }

  #remoteName(tool: Tool): string {
    const configured = tool.connectorConfig.mcpTool;
    if (typeof configured === 'string' && configured.length > 0) return configured;
    // Fall back to the segment after the system prefix: `github.create_issue` → `create_issue`.
    const separator = tool.name.indexOf('.');
    return separator === -1 ? tool.name : tool.name.slice(separator + 1);
  }

  async #assertSurfaceUnchanged(remoteName: string): Promise<void> {
    if (!this.#pinned || this.#pinnedDigest === undefined) return;
    if (this.#recheckMs > 0 && Date.now() - this.#verifiedAt < this.#recheckMs) return;

    const observed = await this.#client.listTools();
    if (manifestDigest(observed) === this.#pinnedDigest) {
      this.#verifiedAt = Date.now();
      return;
    }

    const drift = detectDrift(this.#pinned, observed);
    const affected =
      drift.modified.includes(remoteName) || drift.removed.includes(remoteName)
        ? remoteName
        : undefined;

    throw new ConnectorError(
      'manifest_drift',
      affected
        ? `"${affected}" changed on ${this.#client.name} after it was reviewed; refusing to call it`
        : `the tool surface of ${this.#client.name} changed after it was reviewed; refusing to call it`,
      {
        metadata: {
          added: drift.added,
          removed: drift.removed,
          modified: drift.modified,
          expectedDigest: drift.expectedDigest,
          observedDigest: drift.observedDigest,
        },
      },
    );
  }
}

/**
 * Translates a JSON Schema object into ARC Control parameter specs. Only the
 * subset ARC Control enforces is carried across; anything richer stays the
 * remote server's business.
 */
function parametersFromSchema(schema: Readonly<Record<string, unknown>> | undefined): ToolRegistration['parameters'] {
  if (!schema || typeof schema !== 'object') return [];

  const properties = schema.properties;
  if (typeof properties !== 'object' || properties === null) return [];

  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);

  return Object.entries(properties as Record<string, unknown>).map(([name, raw]) => {
    const spec = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
    return {
      name,
      type: mapType(spec.type),
      required: required.has(name),
      ...(typeof spec.description === 'string' ? { description: spec.description } : {}),
      ...(Array.isArray(spec.enum) ? { enum: spec.enum as readonly (string | number | boolean)[] } : {}),
      ...(typeof spec.minimum === 'number' ? { minimum: spec.minimum } : {}),
      ...(typeof spec.maximum === 'number' ? { maximum: spec.maximum } : {}),
      ...(typeof spec.pattern === 'string' ? { pattern: spec.pattern } : {}),
      ...(typeof spec.maxLength === 'number' ? { maxLength: spec.maxLength } : {}),
    };
  });
}

function mapType(type: unknown): 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' {
  const named = Array.isArray(type) ? type.find((candidate) => candidate !== 'null') : type;
  switch (named) {
    case 'number':
      return 'number';
    case 'integer':
      return 'integer';
    case 'boolean':
      return 'boolean';
    case 'object':
      return 'object';
    case 'array':
      return 'array';
    default:
      return 'string';
  }
}
