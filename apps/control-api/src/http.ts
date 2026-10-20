import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ArcError, toArcError } from '@arc-control/schemas';

export interface RequestContext {
  readonly method: string;
  readonly path: string;
  readonly params: Readonly<Record<string, string>>;
  readonly query: URLSearchParams;
  readonly headers: IncomingMessage['headers'];
  readonly requestId: string;
  /** Parsed JSON body, or undefined for a request without one. */
  body<T>(): Promise<T>;
  /** The presented agent credential, if the request carried one. */
  readonly bearer: string | undefined;
}

export type Handler = (context: RequestContext) => Promise<unknown>;

interface Route {
  readonly method: string;
  readonly pattern: readonly string[];
  readonly handler: Handler;
}

/** Largest request body the API will read. */
const MAX_BODY_BYTES = 1_048_576;

/**
 * A small router over `node:http`.
 *
 * The control plane has no web framework dependency on purpose: this is the
 * component an enterprise security team will read line by line before putting
 * it in front of their systems, and every line of it is here.
 */
export class Router {
  readonly #routes: Route[] = [];

  add(method: string, path: string, handler: Handler): this {
    this.#routes.push({ method, pattern: path.split('/').filter(Boolean), handler });
    return this;
  }

  get(path: string, handler: Handler): this {
    return this.add('GET', path, handler);
  }

  post(path: string, handler: Handler): this {
    return this.add('POST', path, handler);
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestId = randomUUID();
    response.setHeader('x-arc-request-id', requestId);
    // The API serves JSON to programmatic clients only; these headers keep a
    // response from ever being interpreted as a document by a browser.
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('cache-control', 'no-store');

    const url = new URL(request.url ?? '/', 'http://localhost');
    const segments = url.pathname.split('/').filter(Boolean);

    for (const route of this.#routes) {
      if (route.method !== (request.method ?? 'GET')) continue;
      const params = matchPattern(route.pattern, segments);
      if (!params) continue;

      const context: RequestContext = {
        method: route.method,
        path: url.pathname,
        params,
        query: url.searchParams,
        headers: request.headers,
        requestId,
        body: <T>() => readJsonBody<T>(request),
        bearer: readBearer(request),
      };

      try {
        const result = await route.handler(context);
        if (result === undefined) {
          send(response, 204, undefined);
        } else if (isSentinel(result)) {
          send(response, result.status, result.payload);
        } else {
          send(response, 200, result);
        }
      } catch (cause) {
        const error = toArcError(cause);
        // `approval_required` is a 202 rather than an error status: the action
        // has been accepted and is waiting on a human, which is a normal
        // outcome of the control path rather than a failure.
        send(response, error.httpStatus, error.toJSON());
      }
      return;
    }

    send(response, 404, new ArcError('not_found', `no route for ${request.method} ${url.pathname}`).toJSON());
  }
}

interface Sentinel {
  readonly __arcStatus: true;
  readonly status: number;
  readonly payload: unknown;
}

/** Wraps a payload to be sent with a specific status code. */
export function withStatus(status: number, payload: unknown): Sentinel {
  return { __arcStatus: true, status, payload };
}

function isSentinel(value: unknown): value is Sentinel {
  return typeof value === 'object' && value !== null && (value as Sentinel).__arcStatus === true;
}

function matchPattern(
  pattern: readonly string[],
  segments: readonly string[],
): Record<string, string> | undefined {
  if (pattern.length !== segments.length) return undefined;

  const params: Record<string, string> = {};
  for (const [index, part] of pattern.entries()) {
    const segment = segments[index]!;
    if (part.startsWith(':')) {
      params[part.slice(1)] = decodeURIComponent(segment);
      continue;
    }
    if (part !== segment) return undefined;
  }
  return params;
}

async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > MAX_BODY_BYTES) {
      throw new ArcError('invalid_request', `request body exceeds ${MAX_BODY_BYTES} bytes`);
    }
    chunks.push(buffer);
  }

  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {} as T;

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ArcError('invalid_request', 'request body is not valid JSON');
  }
}

function readBearer(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return undefined;
  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) return undefined;
  return token;
}

function send(response: ServerResponse, status: number, payload: unknown): void {
  if (payload === undefined) {
    response.writeHead(status);
    response.end();
    return;
  }

  const body = JSON.stringify(payload, null, 2);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}
