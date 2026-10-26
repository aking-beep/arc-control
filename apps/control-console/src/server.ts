import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { isArcError } from '@arc-control/schemas';
import { ArcControlClient } from '@arc-control/sdk-typescript';
import {
  activityPage,
  assessmentDetailPage,
  assessmentRunPage,
  assurancePage,
  controlDetailPage,
  findingDetailPage,
  findingsPage,
  frameworkPage,
  riskDetailPage,
  risksPage,
  notificationsPage,
  settingsPage,
} from './assurance-pages.js';
import {
  accessPage,
  agentDetailPage,
  agentsPage,
  approvalDetailPage,
  approvalsPage,
  auditPage,
  confirmPage,
  errorPage,
  evidenceDetailPage,
  evidencePage,
  overviewPage,
  policiesPage,
  policyDetailPage,
  reportsPage,
  securityPage,
  toolsPage,
  type ConfirmAction,
  type PageContext,
} from './pages.js';
import type { BannerKind } from './render.js';

export interface ConsoleOptions {
  /**
   * Where the console reaches the API. Usually private: a ClusterIP Service, a
   * Compose service name, a loopback port.
   */
  readonly apiBase: string;
  /**
   * Where a *browser* reaches the API, for the one redirect the console hands
   * to the visitor rather than following itself.
   *
   * These are the same address only in a single-host deployment. Behind a
   * Service or a Compose network, `apiBase` resolves for the console and
   * nowhere else, so sending a browser there sends it nowhere. Defaults to
   * `apiBase`, which is right for the single-host case and wrong silently for
   * every other — hence the configuration check in `main.ts`.
   */
  readonly publicApiBase?: string;
  /**
   * Shared operator token, for a deployment that has not configured single
   * sign-on.
   *
   * Optional since 2.1. When the API has single sign-on configured it refuses
   * this token, so a console that insisted on it could not work at all against
   * the mode this release exists to provide — and forcing the token back on
   * would record every console vote as `claimed` while the Settings page said
   * the deployment was authenticated.
   */
  readonly operatorToken?: string;
  /** Identity for the shared-token path only. A session supplies its own. */
  readonly operatorIdentity?: string;
  readonly operatorRoles?: readonly string[];
}

export interface ConsoleApp {
  readonly server: Server;
  listen(port: number, host?: string): Promise<{ port: number; host: string }>;
  close(): Promise<void>;
}

/**
 * Cookie the API issues a console session under.
 *
 * The console forwards it rather than minting anything of its own.
 */
const SESSION_COOKIE = 'arc_operator_session';

/** Largest form body the console will read. */
export const MAX_FORM_BYTES = 64 * 1024;

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
  const server = createServer((request, response) => {
    void route(request, response, options).catch((cause: unknown) => {
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

/** `arc_ev_…`, `arc_ag_…`, `arc_apr_…` — the id shapes the API issues. */
const EVIDENCE_ID = /^\/evidence\/(arc_ev_[0-9a-f]+)$/;
const AGENT_ID = /^\/agents\/(arc_ag_[0-9a-f]+)$/;
const APPROVAL_ID = /^\/approvals\/(arc_apr_[0-9a-f]+)$/;
const POLICY_ID = /^\/policies\/([A-Za-z0-9._-]+)$/;
const CONFIRM = /^\/confirm\/(reject|suspend|disable)\/([A-Za-z0-9._-]+)$/;

// 2.0 governance routes. Each id shape is pinned, so a path that looks like an
// id but is not one falls through to the 404 rather than reaching the API.
const ASSESSMENT_ID = /^\/assurance\/assessments\/(arc_asm_[0-9a-f]+)$/;
const RUN_ID = /^\/assurance\/runs\/(arc_run_[0-9a-f]+)$/;
const RISK_ID = /^\/risks\/(arc_rsk_[0-9a-f]+)$/;
const FINDING_ID = /^\/findings\/(arc_fnd_[0-9a-f]+)$/;
const FRAMEWORK_ID = /^\/frameworks\/([a-z0-9-]+)$/;
/** Control ids are operator-facing, like policy ids: `ARC-AI-001`. */
const CONTROL_ID = /^\/assurance\/([A-Za-z0-9._-]+)$/;

const AGENT_MUTATION = /^\/agents\/(arc_ag_[0-9a-f]+)\/(suspend|resume)$/;
const POLICY_MUTATION = /^\/policies\/([A-Za-z0-9._-]+)\/(enable|disable)$/;
const APPROVAL_VOTE = /^\/approvals\/(arc_apr_[0-9a-f]+)\/vote$/;

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  options: ConsoleOptions,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method ?? 'GET';

  const notice = url.searchParams.get('notice');
  const kind = url.searchParams.get('kind');

  /**
   * Liveness, answered before anything else and without reaching the API.
   *
   * This has to come before the `whoami` below, which is a network call. A
   * probe that waits on the API answers the wrong question twice over: the
   * console is alive whether or not the API is, and a brief API outage would
   * otherwise stall the probe past its timeout and have the orchestrator
   * restart a perfectly healthy console — turning one service's blip into two
   * services down. It would also redirect an unauthenticated probe to a
   * sign-in page, which is not a liveness answer in any case.
   */
  if (path === '/healthz') {
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify({ status: 'ok', apiBase: options.apiBase }));
    return;
  }

  // Built per request, because the credential is per request: the browser's
  // own session cookie, forwarded to the API. A client built once at startup
  // could only ever hold the shared token.
  const session = sessionCookie(request);
  const client = new ArcControlClient({
    baseUrl: options.apiBase,
    ...(session ? { operatorSession: session } : {}),
    ...(options.operatorToken ? { operatorToken: options.operatorToken } : {}),
    ...(options.operatorIdentity ? { operatorIdentity: options.operatorIdentity } : {}),
    ...(options.operatorRoles ? { operatorRoles: options.operatorRoles } : {}),
  });

  /**
   * Who the API says this is, rather than what the console was configured
   * with. Asked once per request and cheap; wrong once and the Settings page
   * tells an operator something untrue about their own approval.
   */
  let identity = { identifier: options.operatorIdentity ?? 'operator', roles: options.operatorRoles ?? [] };
  let unauthenticated = false;
  try {
    const who = await client.whoami();
    identity = { identifier: who.identifier, roles: who.roles };
  } catch (cause) {
    if (isArcError(cause) && cause.code === 'unauthenticated') unauthenticated = true;
  }

  /**
   * Nobody is signed in, so send them to sign in rather than rendering a
   * console full of error panels. The API owns the flow; the console only
   * knows where it starts.
   */
  if (unauthenticated) {
    const returnTo = `${path}${url.search}`;
    // The browser's address for the API, not the console's.
    const signIn = options.publicApiBase ?? options.apiBase;
    response.writeHead(302, {
      location: `${signIn}/auth/login?returnTo=${encodeURIComponent(returnTo)}`,
      'cache-control': 'no-store',
    });
    response.end();
    return;
  }

  const context: PageContext = {
    client,
    apiBase: options.apiBase,
    operatorIdentity: identity.identifier,
    operatorRoles: identity.roles,
    query: url.searchParams,
    ...(notice ? { banner: { kind: bannerKind(kind), message: notice } } : {}),
  };

  if (method === 'POST') {
    await handleMutation(request, response, client, context, path);
    return;
  }

  if (method !== 'GET' && method !== 'HEAD') {
    sendHtml(response, 405, errorPage(context, 405, `${method} is not supported.`));
    return;
  }

  try {
    const evidence = EVIDENCE_ID.exec(path);
    if (evidence) {
      sendHtml(response, 200, await evidenceDetailPage(context, evidence[1]!));
      return;
    }

    const agent = AGENT_ID.exec(path);
    if (agent) {
      sendHtml(response, 200, await agentDetailPage(context, agent[1]!));
      return;
    }

    const approval = APPROVAL_ID.exec(path);
    if (approval) {
      sendHtml(response, 200, await approvalDetailPage(context, approval[1]!));
      return;
    }

    // Matched before the looser CONTROL_ID pattern below, which would
    // otherwise swallow `/assurance/runs` and `/assurance/assessments`.
    const assessment = ASSESSMENT_ID.exec(path);
    if (assessment) {
      sendHtml(response, 200, await assessmentDetailPage(context, assessment[1]!));
      return;
    }

    const run = RUN_ID.exec(path);
    if (run) {
      sendHtml(response, 200, await assessmentRunPage(context, run[1]!));
      return;
    }

    const risk = RISK_ID.exec(path);
    if (risk) {
      sendHtml(response, 200, await riskDetailPage(context, risk[1]!));
      return;
    }

    const finding = FINDING_ID.exec(path);
    if (finding) {
      sendHtml(response, 200, await findingDetailPage(context, finding[1]!));
      return;
    }

    const confirm = CONFIRM.exec(path);
    if (confirm) {
      sendHtml(response, 200, await confirmPage(context, confirm[1] as ConfirmAction, confirm[2]!));
      return;
    }

    switch (path) {
      case '/':
        sendHtml(response, 200, await overviewPage(context));
        return;
      case '/approvals':
        sendHtml(response, 200, await approvalsPage(context));
        return;
      case '/agents':
        sendHtml(response, 200, await agentsPage(context));
        return;
      case '/tools':
        sendHtml(response, 200, await toolsPage(context));
        return;
      case '/policies':
        sendHtml(response, 200, await policiesPage(context));
        return;
      case '/access':
        sendHtml(response, 200, await accessPage(context));
        return;
      case '/evidence':
        sendHtml(response, 200, await evidencePage(context));
        return;
      case '/audit':
        sendHtml(response, 200, await auditPage(context));
        return;
      case '/security':
        sendHtml(response, 200, await securityPage(context));
        return;
      case '/reports':
        sendHtml(response, 200, await reportsPage(context));
        return;
      case '/assurance':
        sendHtml(response, 200, await assurancePage(context));
        return;
      case '/risks':
        sendHtml(response, 200, await risksPage(context));
        return;
      case '/findings':
        sendHtml(response, 200, await findingsPage(context));
        return;
      case '/activity':
        sendHtml(response, 200, await activityPage(context));
        return;
      case '/notifications':
        sendHtml(response, 200, await notificationsPage(context));
        return;
      case '/settings':
        sendHtml(response, 200, await settingsPage(context));
        return;
      default:
        break;
    }

    const framework = FRAMEWORK_ID.exec(path);
    if (framework) {
      sendHtml(response, 200, await frameworkPage(context, framework[1]!));
      return;
    }

    // The two loose id patterns are matched last: both are permissive enough
    // to shadow a literal section name, so every known route gets first
    // refusal before either of them is tried.
    const control = CONTROL_ID.exec(path);
    if (control) {
      sendHtml(response, 200, await controlDetailPage(context, control[1]!));
      return;
    }

    const policy = POLICY_ID.exec(path);
    if (policy) {
      sendHtml(response, 200, await policyDetailPage(context, policy[1]!));
      return;
    }

    sendHtml(response, 404, errorPage(context, 404, `There is no page at ${path}.`));
  } catch (cause) {
    // A 404 from the API is not an outage, and saying so sends an operator to
    // look at the wrong thing. The same mistake as reporting a broken audit
    // chain as an unreachable API, which is why both are now distinguished:
    // 404 means the object is not there, 403 means they may not see it, and
    // only a genuine transport failure is a 502.
    const code = isArcError(cause) ? cause.code : undefined;
    const message = cause instanceof Error ? cause.message : String(cause);

    if (code === 'not_found') {
      sendHtml(response, 404, errorPage(context, 404, message));
      return;
    }

    if (code === 'unauthenticated' || code === 'policy_denied') {
      sendHtml(response, 403, errorPage(context, 403, message));
      return;
    }

    sendHtml(response, 502, errorPage(context, 502, `The control API could not be reached: ${message}`));
  }
}

async function handleMutation(
  request: IncomingMessage,
  response: ServerResponse,
  client: ArcControlClient,
  context: PageContext,
  path: string,
): Promise<void> {
  const form = await readForm(request);

  // The scan changes nothing — it registers no tool and stores no result — so
  // it answers with the report rather than redirecting to a record that does
  // not exist.
  if (path === '/security/scan') {
    await renderScan(response, context, form);
    return;
  }

  try {
    const vote = APPROVAL_VOTE.exec(path);
    if (vote) {
      const choice = form.get('vote') === 'reject' ? 'reject' : 'approve';
      const comment = form.get('comment')?.trim() || undefined;
      const result = await client.vote(vote[1]!, choice, comment);

      // Approving is not itself the act. Only once the request is approved is
      // the action released, and that is a separate, audited call.
      if (choice === 'approve' && result.status === 'approved') {
        const executed = await client.executeApproved(vote[1]!);
        const outcome = String(executed.outcome ?? '');
        redirect(
          response,
          '/approvals',
          `Approved, and the action ${outcome}.`,
          outcome === 'executed' ? 'success' : 'info',
        );
        return;
      }

      if (choice === 'approve') {
        redirect(
          response,
          '/approvals',
          `Approval recorded. The request is ${String(result.status ?? 'still pending')}: the approvals engine has not released the action.`,
          'info',
        );
        return;
      }

      redirect(response, '/approvals', 'Rejected. The action will not run.', 'success');
      return;
    }

    const agent = AGENT_MUTATION.exec(path);
    if (agent) {
      if (agent[2] === 'suspend') await client.suspendAgent(agent[1]!);
      else await client.resumeAgent(agent[1]!);
      redirect(response, '/agents', `Agent ${agent[2]}ed.`, 'success');
      return;
    }

    const policy = POLICY_MUTATION.exec(path);
    if (policy) {
      await client.setPolicyEnabled(policy[1]!, policy[2] === 'enable');
      redirect(response, '/policies', `Policy ${policy[1]} ${policy[2]}d.`, 'success');
      return;
    }

    response.writeHead(404, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
    response.end('no such action');
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    redirect(response, `/${path.split('/')[1] ?? ''}`, message, 'error');
  }
}

/**
 * Runs an MCP manifest scan and renders the report.
 *
 * The tools field is operator-supplied JSON, so a parse failure is an ordinary
 * outcome rather than a server error: the form comes back with what was typed
 * and the reason it could not be read.
 */
async function renderScan(
  response: ServerResponse,
  context: PageContext,
  form: URLSearchParams,
): Promise<void> {
  const name = form.get('name')?.trim() ?? '';
  const endpoint = form.get('endpoint')?.trim() ?? '';
  const toolsText = form.get('tools') ?? '';
  const state = { name, endpoint, tools: toolsText };

  if (!name || !endpoint) {
    sendHtml(
      response,
      200,
      await securityPage(context, { error: 'A server name and an endpoint are both required.', form: state }),
    );
    return;
  }

  let tools: Record<string, unknown>[];
  try {
    const parsed: unknown = toolsText.trim() ? JSON.parse(toolsText) : [];
    if (!Array.isArray(parsed)) throw new Error('tools must be a JSON array');
    tools = parsed as Record<string, unknown>[];
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    sendHtml(response, 200, await securityPage(context, { error: `invalid_request: ${message}`, form: state }));
    return;
  }

  try {
    const report = await context.client.scanMcp({ name, endpoint, tools });
    sendHtml(response, 200, await securityPage(context, { report, form: state }));
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    sendHtml(response, 200, await securityPage(context, { error: message, form: state }));
  }
}

/**
 * Reads a form body.
 *
 * A body over the limit is rejected rather than truncated: a silently
 * truncated manifest would be scanned, and would pass, having never been
 * looked at in full.
 */
async function readForm(request: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > MAX_FORM_BYTES) {
      request.destroy();
      throw new Error(`the submitted form is larger than the ${MAX_FORM_BYTES / 1024} KB limit`);
    }
    chunks.push(buffer);
  }

  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

function bannerKind(value: string | null): BannerKind {
  return value === 'success' || value === 'error' ? value : 'info';
}

function sendHtml(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    // The console renders no third-party resources and no inline scripts, so
    // the policy can be this strict. Ten sections changed nothing about that:
    // every interaction is a link, a query parameter or a form post.
    //
    // `img-src data:` exists for one thing: the inline SVG favicon. It admits
    // no origin, makes no network request, and an SVG referenced this way
    // cannot execute script. There is still no script source of any kind.
    'content-security-policy':
      "default-src 'none'; img-src data:; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
  });
  response.end(body);
}

/** Mutations redirect afterwards, so a reload never repeats a vote. */
function redirect(response: ServerResponse, to: string, notice: string, kind: BannerKind): void {
  const query = new URLSearchParams({ notice, kind });
  response.writeHead(303, { location: `${to}?${query.toString()}`, 'cache-control': 'no-store' });
  response.end();
}

/**
 * The operator's session cookie, as the browser sent it.
 *
 * Forwarded to the API verbatim: the console is a server-rendered proxy and
 * holds no credential of its own, so the operator's session is the operator's
 * session all the way through. A duplicated name keeps the first value, since
 * taking the last would let anything able to append a header shadow a real
 * session.
 */
function sessionCookie(request: IncomingMessage): string | undefined {
  const header = request.headers.cookie;
  if (typeof header !== 'string') return undefined;

  for (const pair of header.split(';')) {
    const index = pair.indexOf('=');
    if (index <= 0) continue;
    if (pair.slice(0, index).trim() !== SESSION_COOKIE) continue;

    try {
      return decodeURIComponent(pair.slice(index + 1).trim()) || undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}
