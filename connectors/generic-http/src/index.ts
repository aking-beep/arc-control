import { ConnectorError, type Connector, type ConnectorResult, type ExecutionContext } from '@arc-control/execution';
import type { Tool } from '@arc-control/schemas';

export interface GenericHttpConnectorOptions {
  readonly name?: string;
  /**
   * Hostnames this connector may reach. A tool whose URL resolves outside the
   * allowlist is refused.
   *
   * This is not optional security theatre. The connector holds real
   * credentials and is driven by parameters an agent chose, so without an
   * allowlist a templated URL is a server-side request forgery primitive
   * pointed at the cloud metadata service. An empty allowlist refuses
   * everything.
   */
  readonly allowedHosts: readonly string[];
  readonly timeoutMs?: number;
  /** Headers applied to every request, e.g. a bearer token for the target API. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly maxResponseBytes?: number;
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * Executes an authorized action as an HTTP request.
 *
 * The tool's `connectorConfig` carries the request shape; the action's
 * parameters fill it in. Templates may appear in the path and the body, and
 * only in those places — never in the host — so an agent can choose *what* to
 * act on but never *where*.
 */
export class GenericHttpConnector implements Connector {
  readonly name: string;
  readonly #allowedHosts: readonly string[];
  readonly #timeoutMs: number;
  readonly #headers: Record<string, string>;
  readonly #maxResponseBytes: number;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: GenericHttpConnectorOptions) {
    this.name = options.name ?? 'generic-http';
    this.#allowedHosts = options.allowedHosts.map((host) => host.toLowerCase());
    this.#timeoutMs = options.timeoutMs ?? 20_000;
    this.#headers = { ...options.headers };
    this.#maxResponseBytes = options.maxResponseBytes ?? 1_048_576;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  supports(tool: Tool): boolean {
    if (tool.connector !== this.name) return false;
    const { url, method } = tool.connectorConfig;
    if (typeof url !== 'string') return false;
    if (method !== undefined && typeof method !== 'string') return false;

    try {
      return this.#hostAllowed(new URL(url).hostname);
    } catch {
      return false;
    }
  }

  async execute(context: ExecutionContext): Promise<ConnectorResult> {
    const config = context.tool.connectorConfig;
    const method = String(config.method ?? 'POST').toUpperCase();
    const template = String(config.url ?? '');

    const url = this.#buildUrl(template, context.action.parameters);
    const body = this.#buildBody(config, context.action.parameters);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    const onAbort = (): void => controller.abort();
    context.signal.addEventListener('abort', onAbort, { once: true });

    try {
      const response = await this.#fetch(url, {
        method,
        headers: {
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...this.#headers,
          ...asHeaders(config.headers),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        // The target may legitimately redirect, but following one would leave
        // the allowlist behind, so a redirect is reported instead.
        redirect: 'manual',
        signal: controller.signal,
      });

      if (response.status >= 300 && response.status < 400) {
        throw new ConnectorError(
          'redirect_refused',
          `${url} responded with a ${response.status} redirect; following it would leave the allowed hosts`,
          { metadata: { status: response.status, location: response.headers.get('location') } },
        );
      }

      const payload = await this.#readBody(response);

      if (!response.ok) {
        throw new ConnectorError('http_error', `${method} ${url} returned HTTP ${response.status}`, {
          retryable: response.status >= 500 || response.status === 429,
          metadata: { status: response.status, body: payload },
        });
      }

      return {
        output: payload,
        metadata: { status: response.status, url, method },
      };
    } catch (cause) {
      if (cause instanceof ConnectorError) throw cause;
      if (controller.signal.aborted) {
        throw new ConnectorError('timeout', `${method} ${url} did not respond within the execution budget`);
      }
      throw new ConnectorError('unreachable', `could not reach ${url}: ${describe(cause)}`, {
        retryable: true,
        cause,
      });
    } finally {
      clearTimeout(timer);
      context.signal.removeEventListener('abort', onAbort);
    }
  }

  /**
   * Fills `{parameter}` placeholders in the configured URL.
   *
   * Values are percent-encoded as single path segments, so a parameter cannot
   * introduce a new segment, a query string or a scheme. The resulting host is
   * re-checked against the allowlist afterwards: the check is on the final URL,
   * not the template, because only the final URL is what gets requested.
   */
  #buildUrl(template: string, parameters: Readonly<Record<string, unknown>>): string {
    const filled = template.replace(/\{([A-Za-z0-9_]+)\}/g, (_match, name: string) => {
      const value = parameters[name];
      if (value === undefined || value === null) {
        throw new ConnectorError('invalid_url', `the tool URL references "{${name}}" but the action did not provide it`);
      }
      return encodeURIComponent(String(value));
    });

    let url: URL;
    try {
      url = new URL(filled);
    } catch {
      throw new ConnectorError('invalid_url', `"${filled}" is not a valid URL`);
    }

    if (url.protocol !== 'https:' && !isLoopback(url.hostname)) {
      throw new ConnectorError('insecure_url', `refusing to send ${url.protocol} traffic to ${url.hostname}`);
    }

    if (!this.#hostAllowed(url.hostname)) {
      throw new ConnectorError('host_not_allowed', `${url.hostname} is not in this connector's allowed hosts`, {
        metadata: { host: url.hostname, allowed: this.#allowedHosts },
      });
    }

    return url.toString();
  }

  /**
   * Builds the request body. `bodyTemplate` maps body fields to parameter
   * names; with no template, the validated parameters are sent as-is.
   */
  #buildBody(
    config: Readonly<Record<string, unknown>>,
    parameters: Readonly<Record<string, unknown>>,
  ): Record<string, unknown> | undefined {
    const method = String(config.method ?? 'POST').toUpperCase();
    if (method === 'GET' || method === 'HEAD') return undefined;

    const template = config.bodyTemplate;
    if (template === undefined) return { ...parameters };

    if (typeof template !== 'object' || template === null || Array.isArray(template)) {
      throw new ConnectorError('invalid_config', 'bodyTemplate must be an object mapping fields to parameter names');
    }

    const body: Record<string, unknown> = {};
    for (const [field, source] of Object.entries(template as Record<string, unknown>)) {
      body[field] = typeof source === 'string' && source.startsWith('$') ? parameters[source.slice(1)] : source;
    }
    return body;
  }

  /** Reads a bounded response body, parsing JSON when the server says so. */
  async #readBody(response: Response): Promise<unknown> {
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > this.#maxResponseBytes) {
      throw new ConnectorError('response_too_large', `the response exceeds ${this.#maxResponseBytes} bytes`);
    }

    const text = await response.text();
    if (text.length > this.#maxResponseBytes) {
      throw new ConnectorError('response_too_large', `the response exceeds ${this.#maxResponseBytes} bytes`);
    }
    if (!text) return null;

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('json')) return text;

    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }

  /** Exact host match, or a `.example.com` suffix for a whole domain. */
  #hostAllowed(hostname: string): boolean {
    const host = hostname.toLowerCase();
    return this.#allowedHosts.some((allowed) =>
      allowed.startsWith('.') ? host === allowed.slice(1) || host.endsWith(allowed) : host === allowed,
    );
  }
}

function asHeaders(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === 'string') out[key] = raw;
  }
  return out;
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
export { vetEndpoint, classifyAddress, type EndpointVetting, type EndpointProbe, type VetOptions, type VettingFinding } from './vet.js';
