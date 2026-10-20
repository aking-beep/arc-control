import { ConnectorError } from '@arc-control/execution';
import type { McpServerManifest, McpToolDescriptor } from '@arc-control/mcp-security';

/**
 * A minimal MCP client over Streamable HTTP, speaking just enough JSON-RPC to
 * list tools and call one.
 *
 * It is written against Node's built-in fetch rather than an MCP SDK so the
 * control plane has no dependency it cannot audit, and so the request ARC
 * Control actually sends is visible in this file. Transports beyond HTTP
 * (stdio in particular) are the next step and are tracked in the roadmap.
 */
export interface McpClientOptions {
  readonly endpoint: string;
  readonly name?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly protocolVersion?: string;
  /** Injection seam for tests; defaults to global fetch. */
  readonly fetch?: typeof globalThis.fetch;
}

interface JsonRpcResponse {
  readonly jsonrpc?: string;
  readonly id?: number | string | null;
  readonly result?: unknown;
  readonly error?: { readonly code?: number; readonly message?: string; readonly data?: unknown };
}

const DEFAULT_PROTOCOL_VERSION = '2025-06-18';

export class McpClient {
  readonly name: string;
  readonly endpoint: string;
  readonly #headers: Record<string, string>;
  readonly #timeoutMs: number;
  readonly #protocolVersion: string;
  readonly #fetch: typeof globalThis.fetch;
  #nextId = 1;
  #sessionId: string | undefined;

  constructor(options: McpClientOptions) {
    this.endpoint = options.endpoint;
    this.name = options.name ?? new URL(options.endpoint).host;
    this.#headers = { ...options.headers };
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.#protocolVersion = options.protocolVersion ?? DEFAULT_PROTOCOL_VERSION;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  /** Performs the MCP initialize handshake and remembers any session id. */
  async initialize(): Promise<void> {
    await this.#call('initialize', {
      protocolVersion: this.#protocolVersion,
      capabilities: {},
      clientInfo: { name: 'arc-control', version: '0.1.0' },
    });
  }

  /** Reads the server's advertised tool surface. */
  async listTools(): Promise<McpServerManifest> {
    const result = await this.#call('tools/list', {});
    const tools = isRecord(result) && Array.isArray(result.tools) ? result.tools : [];

    return {
      name: this.name,
      endpoint: this.endpoint,
      protocolVersion: this.#protocolVersion,
      tools: tools.filter(isRecord).map(
        (tool): McpToolDescriptor => ({
          name: String(tool.name ?? ''),
          ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
          ...(isRecord(tool.inputSchema) ? { inputSchema: tool.inputSchema } : {}),
          ...(isRecord(tool.annotations) ? { annotations: tool.annotations } : {}),
        }),
      ),
      capturedAt: new Date().toISOString(),
    };
  }

  /** Calls a tool. The arguments have already been authorized by the gateway. */
  async callTool(
    name: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const result = await this.#call('tools/call', { name, arguments: args }, signal);

    // An MCP server reports a tool-level failure in the result body rather
    // than as a JSON-RPC error. Treating that as success would write a false
    // evidence record, so it is raised.
    if (isRecord(result) && result.isError === true) {
      throw new ConnectorError('tool_error', describeContent(result.content) || `tool "${name}" reported an error`, {
        metadata: { tool: name },
      });
    }

    return result;
  }

  async #call(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    const id = this.#nextId++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    const onAbort = (): void => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const response = await this.#fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': this.#protocolVersion,
          ...(this.#sessionId ? { 'mcp-session-id': this.#sessionId } : {}),
          ...this.#headers,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal: controller.signal,
      });

      const sessionId = response.headers.get('mcp-session-id');
      if (sessionId) this.#sessionId = sessionId;

      if (!response.ok) {
        throw new ConnectorError('mcp_http_error', `MCP server returned HTTP ${response.status}`, {
          retryable: response.status >= 500 || response.status === 429,
          metadata: { status: response.status, method },
        });
      }

      const payload = await this.#parse(response);

      if (payload.error) {
        throw new ConnectorError('mcp_error', payload.error.message ?? 'the MCP server returned an error', {
          metadata: { code: payload.error.code, method },
        });
      }

      return payload.result;
    } catch (cause) {
      if (cause instanceof ConnectorError) throw cause;
      if (controller.signal.aborted) {
        throw new ConnectorError('timeout', `the MCP server did not respond to ${method} in time`);
      }
      throw new ConnectorError('mcp_unreachable', `could not reach the MCP server: ${describeError(cause)}`, {
        retryable: true,
        cause,
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /**
   * Reads a response body as either JSON or a single SSE frame. Streamable
   * HTTP permits a server to answer a request either way.
   */
  async #parse(response: Response): Promise<JsonRpcResponse> {
    const contentType = response.headers.get('content-type') ?? '';
    const text = await response.text();

    if (contentType.includes('text/event-stream')) {
      for (const line of text.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice('data:'.length).trim();
        if (!data) continue;
        try {
          return JSON.parse(data) as JsonRpcResponse;
        } catch {
          continue;
        }
      }
      throw new ConnectorError('mcp_protocol_error', 'the MCP event stream carried no JSON-RPC payload');
    }

    try {
      return JSON.parse(text) as JsonRpcResponse;
    } catch {
      throw new ConnectorError('mcp_protocol_error', 'the MCP server returned a body that is not JSON');
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Extracts readable text from an MCP content array. */
function describeContent(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter(isRecord)
    .map((block) => (typeof block.text === 'string' ? block.text : ''))
    .filter(Boolean)
    .join(' ')
    .trim();
}

function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
