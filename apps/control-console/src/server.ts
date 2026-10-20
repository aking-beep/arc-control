import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { ArcControlClient } from '@arc-control/sdk-typescript';
import {
  agentsPage,
  approvalsPage,
  auditPage,
  errorPage,
  evidenceDetailPage,
  evidencePage,
  overviewPage,
  policiesPage,
  type PageContext,
} from './pages.js';

export interface ConsoleOptions {
  readonly apiBase: string;
  readonly operatorToken: string;
  readonly operatorIdentity: string;
  readonly operatorRoles: readonly string[];
}

export interface ConsoleApp {
  readonly server: Server;
  listen(port: number, host?: string): Promise<{ port: number; host: string }>;
  close(): Promise<void>;
}

/** Largest form body the console will read. */
const MAX_FORM_BYTES = 64 * 1024;

/**
 * The enterprise console.
 *
 * It holds no state and no database connection of its own: everything it shows
 * it reads from the control API, with the operator's own credential. That means
 * the console cannot show an operator anything the API would not have given
 * them, and an operator action taken here is audited identically to one taken
 * through the API.
 */
export function createConsole(options: ConsoleOptions): ConsoleApp {
  const client = new ArcControlClient({
    baseUrl: options.apiBase,
    operatorToken: options.operatorToken,
    operatorIdentity: options.operatorIdentity,
    operatorRoles: options.operatorRoles,
  });

  const server = createServer((request, response) => {
    void route(request, response, client, options).catch((cause: unknown) => {
      process.stderr.write(`arc-console: ${String(cause)}\n`);
      if (!response.headersSent) {
        response.writeHead(500, { 'content-type': 'text/html; charset=utf-8' });
      }
      response.end('<h1>500</h1>');
    });
  });

  return {
    server,
    listen: (port, host = '127.0.0.1') =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          const address = server.address();
          resolve({ port: typeof address === 'object' && address ? address.port : port, host });
        });
      }),
    close: () =>
      new Promise((resolve, reject) => {
        server.close((cause) => (cause ? reject(cause) : resolve()));
      }),
  };
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  client: ArcControlClient,
  options: ConsoleOptions,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method ?? 'GET';

  const context: PageContext = {
    client,
    apiBase: options.apiBase,
    query: url.searchParams,
    ...(url.searchParams.get('notice') ? { banner: url.searchParams.get('notice')! } : {}),
  };

  // Mutations arrive as HTML form posts and redirect afterwards, so a reload
  // never repeats a vote.
  if (method === 'POST') {
    await handleMutation(request, response, client, path);
    return;
  }

  if (method !== 'GET') {
    sendHtml(response, 405, errorPage(context, 405, `${method} is not supported.`));
    return;
  }

  try {
    const evidenceMatch = /^\/evidence\/(arc_ev_[0-9a-f]+)$/.exec(path);
    if (evidenceMatch) {
      sendHtml(response, 200, await evidenceDetailPage(context, evidenceMatch[1]!));
      return;
    }

    switch (path) {
      case '/':
        sendHtml(response, 200, await overviewPage(context));
        return;
      case '/agents':
        sendHtml(response, 200, await agentsPage(context));
        return;
      case '/policies':
        sendHtml(response, 200, await policiesPage(context));
        return;
      case '/approvals':
        sendHtml(response, 200, await approvalsPage(context));
        return;
      case '/evidence':
        sendHtml(response, 200, await evidencePage(context));
        return;
      case '/audit':
        sendHtml(response, 200, await auditPage(context));
        return;
      case '/healthz':
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ status: 'ok', apiBase: options.apiBase }));
        return;
      default:
        sendHtml(response, 404, errorPage(context, 404, `There is no page at ${path}.`));
        return;
    }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    sendHtml(response, 502, errorPage(context, 502, `The control API could not be reached: ${message}`));
  }
}

async function handleMutation(
  request: IncomingMessage,
  response: ServerResponse,
  client: ArcControlClient,
  path: string,
): Promise<void> {
  const form = await readForm(request);

  try {
    const vote = /^\/approvals\/(arc_apr_[0-9a-f]+)\/vote$/.exec(path);
    if (vote) {
      const choice = form.get('vote') === 'reject' ? 'reject' : 'approve';
      const comment = form.get('comment') ?? undefined;
      const result = await client.vote(vote[1]!, choice, comment || undefined);

      // Approving is not itself the act. Only once the request is approved is
      // the action released, and that is a separate, audited call.
      if (choice === 'approve' && result.status === 'approved') {
        const executed = await client.executeApproved(vote[1]!);
        redirect(response, `/approvals?notice=${encodeURIComponent(`Action ${String(executed.outcome)}.`)}`);
        return;
      }

      redirect(response, `/approvals?notice=${encodeURIComponent(`Recorded: ${choice}.`)}`);
      return;
    }

    const agent = /^\/agents\/(arc_ag_[0-9a-f]+)\/(suspend|resume)$/.exec(path);
    if (agent) {
      if (agent[2] === 'suspend') await client.suspendAgent(agent[1]!);
      else await client.resumeAgent(agent[1]!);
      redirect(response, `/agents?notice=${encodeURIComponent(`Agent ${agent[2]}ed.`)}`);
      return;
    }

    const policy = /^\/policies\/([A-Za-z0-9._-]+)\/(enable|disable)$/.exec(path);
    if (policy) {
      await client.setPolicyEnabled(policy[1]!, policy[2] === 'enable');
      redirect(response, `/policies?notice=${encodeURIComponent(`Policy ${policy[2]}d.`)}`);
      return;
    }

    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('no such action');
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    redirect(response, `${path.split('/').slice(0, 2).join('/')}?notice=${encodeURIComponent(message)}`);
  }
}

async function readForm(request: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > MAX_FORM_BYTES) break;
    chunks.push(buffer);
  }

  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

function sendHtml(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    // The console renders no third-party resources and no inline scripts, so
    // the policy can be this strict.
    'content-security-policy':
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
  });
  response.end(body);
}

function redirect(response: ServerResponse, location: string): void {
  response.writeHead(303, { location, 'cache-control': 'no-store' });
  response.end();
}
