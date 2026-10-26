import { createServer, type Server } from 'node:http';
import { Gateway, type RateLimitOptions } from '@arc-control/gateway';
import { AssuranceEngine } from '@arc-control/assurance';
import type { ControlStore } from '@arc-control/store';
import { addAssuranceRoutes } from './assurance-routes.js';
import { buildRoutes } from './routes.js';
import { OperatorAuth, type TrustedProxyOptions } from './operator.js';
import { addAuthRoutes } from './auth-routes.js';
import { ArcError } from '@arc-control/schemas';
import {
  OidcClient,
  SessionManager,
  type OidcOptions,
  type RoleResolutionOptions,
} from '@arc-control/operator-identity';

export const API_VERSION = '2.1.0';

export interface ControlApiOptions {
  readonly store: ControlStore;
  readonly operatorToken?: string;
  readonly defaultOrganizationId?: string;
  readonly defaultEnvironment?: string;
  /**
   * True when this API was started with the worked example loaded. Reported on
   * `/health` so the console can label the environment as a demonstration
   * rather than leaving an operator to guess whether the records in front of
   * them describe their own systems.
   */
  readonly demoSeed?: boolean;
  /** Runaway protection. Off unless configured. */
  readonly rateLimit?: RateLimitOptions;
  /** Amount at or above which a monetary action escalates its risk class. */
  readonly monetaryEscalationThreshold?: number;

  // --- 2.1: operator identity -------------------------------------------

  /**
   * Single sign-on. When present, operators sign in against this provider and
   * their approvals are recorded as authenticated.
   */
  readonly oidc?: OidcOptions;
  /**
   * Signs session cookies. Required with `oidc`, at least 32 characters, and
   * stable across restarts or every operator is signed out on each deploy.
   */
  readonly sessionSecret?: string;
  readonly sessionLifetimeMs?: number;
  readonly sessionIdleTimeoutMs?: number;
  /** How verified claims become ARC roles. */
  readonly roles?: RoleResolutionOptions;
  /** An identity-aware proxy in front of ARC, as an alternative to OIDC. */
  readonly trustedProxy?: TrustedProxyOptions;
  /**
   * Whether the shared token may still authenticate operators. Defaults to
   * "only when it is the only mode configured", so it is a fallback rather
   * than a bypass.
   */
  readonly allowSharedToken?: boolean;
  /** Set false only for local HTTP development; session cookies are Secure otherwise. */
  readonly secureCookies?: boolean;
}

export interface ControlApi {
  readonly gateway: Gateway;
  readonly assurance: AssuranceEngine;
  readonly server: Server;
  listen(port: number, host?: string): Promise<{ port: number; host: string }>;
  close(): Promise<void>;
}

/**
 * Builds the control API around a gateway. Exposed as a function rather than
 * only a binary so tests and examples can drive the real HTTP surface in
 * process, against the real gateway.
 */
export function createControlApi(options: ControlApiOptions): ControlApi {
  const gateway = new Gateway({
    store: options.store,
    ...(options.defaultOrganizationId ? { defaultOrganizationId: options.defaultOrganizationId } : {}),
    ...(options.defaultEnvironment ? { defaultEnvironment: options.defaultEnvironment } : {}),
    ...(options.rateLimit ? { rateLimit: options.rateLimit } : {}),
    ...(options.monetaryEscalationThreshold !== undefined
      ? { classification: { monetaryEscalationThreshold: options.monetaryEscalationThreshold } }
      : {}),
  });

  /**
   * The assurance engine reads the same store the gateway writes.
   *
   * It is given the audit log's `append` and a chain verifier, and nothing
   * else that can write: there is no path from assurance into a decision, so
   * a broken assurance layer can fail to report but can never fail open.
   *
   * `verifyChain` asks the store for its recorded head where it has one, which
   * is what lets ARC-AI-006 distinguish a chain checked against an external
   * anchor from one checked only against itself. A FileStore's head marker is
   * ARC's own copy, so it counts as internal: `externallyAnchored` stays false
   * unless an operator supplies a head from outside, which is the honest
   * reading and the reason that control reports not_assessable by default.
   */
  const assurance = new AssuranceEngine({
    store: options.store,
    audit: (event) => gateway.audit.append(event),
    organizationId: options.defaultOrganizationId ?? 'default',
    fallbackEffect: 'DENY',
    verifyChain: async () => {
      const expectation = await options.store.recordedAuditHead?.();
      const verification = await gateway.audit.verify(expectation);
      return { verification, externallyAnchored: false };
    },
  });

  // Sign-in is only wired when both a provider and a cookie secret are
  // present. Half-configured single sign-on would otherwise look available and
  // fail at the callback, which is the worst moment to discover it.
  const sessions =
    options.oidc !== undefined && options.sessionSecret !== undefined
      ? new SessionManager({
          store: options.store,
          signingSecret: options.sessionSecret,
          ...(options.sessionLifetimeMs !== undefined ? { lifetimeMs: options.sessionLifetimeMs } : {}),
          ...(options.sessionIdleTimeoutMs !== undefined ? { idleTimeoutMs: options.sessionIdleTimeoutMs } : {}),
        })
      : undefined;

  if (options.oidc !== undefined && options.sessionSecret === undefined) {
    throw new ArcError(
      'invalid_request',
      'an OIDC issuer is configured but no session secret is; set ARC_SESSION_SECRET to at least 32 characters ' +
        '(`openssl rand -hex 32`), or single sign-on would fail at the callback rather than at startup',
    );
  }

  const oidc = options.oidc === undefined ? undefined : new OidcClient(options.oidc);

  const operators = new OperatorAuth({
    ...(sessions ? { sessions } : {}),
    ...(options.trustedProxy ? { proxy: options.trustedProxy } : {}),
    ...(options.operatorToken ? { token: options.operatorToken } : {}),
    ...(options.allowSharedToken !== undefined ? { allowSharedToken: options.allowSharedToken } : {}),
  });

  const router = buildRoutes({
    gateway,
    assurance,
    operators,
    version: API_VERSION,
    demoSeed: options.demoSeed === true,
  });

  addAssuranceRoutes(router, { gateway, assurance, operators, version: API_VERSION });
  addAuthRoutes(router, {
    gateway,
    operators,
    ...(sessions ? { sessions } : {}),
    ...(oidc ? { oidc } : {}),
    ...(options.roles ? { roleOptions: options.roles } : {}),
    ...(options.secureCookies !== undefined ? { secureCookies: options.secureCookies } : {}),
  });

  const server = createServer((request, response) => {
    void router.handle(request, response).catch((cause: unknown) => {
      // The router handles its own errors; reaching here means the response
      // itself failed, so there is nothing left to tell the client.
      process.stderr.write(`arc-control: unrecoverable request failure: ${String(cause)}\n`);
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });

  return {
    gateway,
    assurance,
    server,
    listen: (port, host = '127.0.0.1') =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          const address = server.address();
          const actual = typeof address === 'object' && address ? address.port : port;
          resolve({ port: actual, host });
        });
      }),
    close: () =>
      new Promise((resolve, reject) => {
        server.close((cause) => (cause ? reject(cause) : resolve()));
      }),
  };
}
