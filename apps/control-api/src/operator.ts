import { timingSafeEqual } from 'node:crypto';
import { ArcError, type IdentityAssurance, type OperatorIdentity } from '@arc-control/schemas';
import type { SessionManager } from '@arc-control/operator-identity';
import type { RequestContext } from './http.js';

/**
 * Resolving the human behind a request.
 *
 * 2.0 had one answer: a shared token, with the name taken from a header. This
 * has three, and the difference between them is recorded rather than smoothed
 * over, because a deployment in the middle of a migration runs more than one
 * at once and an approval record has to say which it was.
 *
 *   1. **A console session.** ARC verified an ID token against the provider's
 *      keys and opened a session. `authenticated`.
 *   2. **A trusted proxy.** An identity-aware proxy in front of ARC asserted
 *      the identity, and this deployment names that proxy. `asserted_by_proxy`.
 *   3. **The shared token.** The caller said who they were.  `claimed`, and
 *      refused altogether unless the deployment opts in.
 *
 * The ordering matters: a request carrying both a session and a token resolves
 * as the session, so an operator cannot downgrade their own attribution by
 * also presenting a token.
 */

export type { OperatorIdentity };

/** Retained for callers that only need a name and roles. */
export type Operator = OperatorIdentity;

export const SESSION_COOKIE = 'arc_operator_session';

export interface TrustedProxyOptions {
  /** Header the proxy sets. Conventionally `x-forwarded-email` or similar. */
  readonly identityHeader: string;
  /** Header carrying group membership, if the proxy provides one. */
  readonly rolesHeader?: string;
  /**
   * A shared secret the proxy must also send, proving the request came through
   * it rather than straight to ARC.
   *
   * Required, because an identity header is only worth anything if nothing
   * else can set it. Without this, any client that can reach ARC directly
   * names itself whatever it likes — which is the 2.0 weakness wearing a
   * different hat.
   */
  readonly sharedSecret: string;
  readonly secretHeader?: string;
  /** Maps a proxy-supplied group to ARC roles. Unmapped groups grant nothing. */
  readonly roleMap?: Readonly<Record<string, readonly string[]>>;
}

export interface OperatorAuthOptions {
  /** Sign-in sessions. Present when OIDC is configured. */
  readonly sessions?: SessionManager;
  /** Identity-aware proxy in front of ARC. */
  readonly proxy?: TrustedProxyOptions;
  /** The legacy shared token. */
  readonly token?: string;
  /**
   * Whether the shared token may authenticate operators.
   *
   * Defaults to "only if it is the sole means configured", which makes the
   * token a fallback rather than a bypass:
   *
   *   - A 2.0 deployment that upgrades keeps working. Breaking every operator
   *     on upgrade would push people to stay on the weaker release, which
   *     helps nobody's security.
   *   - A deployment that configures single sign-on or a trusted proxy stops
   *     accepting the token, so nobody can leave the old back door open by
   *     forgetting to unset a variable. Keeping it needs an explicit `true`.
   */
  readonly allowSharedToken?: boolean;
  /** Identity used for the shared token when the request names none. */
  readonly defaultIdentifier?: string;
}

export class OperatorAuth {
  readonly #sessions: SessionManager | undefined;
  readonly #proxy: TrustedProxyOptions | undefined;
  readonly #token: string | undefined;
  readonly #allowSharedToken: boolean;
  readonly #defaultIdentifier: string;

  constructor(options: OperatorAuthOptions = {}) {
    this.#sessions = options.sessions;
    this.#proxy = options.proxy;
    this.#token = options.token;
    this.#allowSharedToken =
      options.allowSharedToken ?? (options.sessions === undefined && options.proxy === undefined);
    this.#defaultIdentifier = options.defaultIdentifier ?? 'operator';

    if (this.#proxy !== undefined && !this.#proxy.sharedSecret) {
      throw new ArcError(
        'invalid_request',
        'a trusted proxy must be configured with a shared secret, or anything that can reach ARC directly ' +
          'can set the identity header itself',
      );
    }
  }

  /** Whether any means of authenticating an operator is configured. */
  get configured(): boolean {
    return this.#sessions !== undefined || this.#proxy !== undefined || this.#sharedTokenUsable;
  }

  get #sharedTokenUsable(): boolean {
    return this.#allowSharedToken && this.#token !== undefined && this.#token.length > 0;
  }

  /** The strongest assurance this deployment can produce, for the console to state. */
  get strongestAssurance(): IdentityAssurance | undefined {
    if (this.#sessions !== undefined) return 'authenticated';
    if (this.#proxy !== undefined) return 'asserted_by_proxy';
    if (this.#sharedTokenUsable) return 'claimed';
    return undefined;
  }

  /** Modes this deployment accepts, for the settings page and `/health`. */
  get modes(): readonly IdentityAssurance[] {
    const modes: IdentityAssurance[] = [];
    if (this.#sessions !== undefined) modes.push('authenticated');
    if (this.#proxy !== undefined) modes.push('asserted_by_proxy');
    if (this.#sharedTokenUsable) modes.push('claimed');
    return modes;
  }

  /** Authenticates an operator request, or throws. */
  async authenticate(context: RequestContext): Promise<OperatorIdentity> {
    if (!this.configured) {
      throw new ArcError(
        'unauthenticated',
        'operator access is disabled because no means of authenticating an operator is configured; ' +
          'configure ARC_OIDC_ISSUER for single sign-on, or ARC_TRUSTED_PROXY_SECRET for an identity-aware proxy',
      );
    }

    // A session first, so presenting a token alongside one cannot weaken the
    // attribution of what follows.
    const cookie = context.cookies[SESSION_COOKIE];
    if (this.#sessions !== undefined && cookie !== undefined) {
      return this.#sessions.resolve(cookie);
    }

    if (this.#proxy !== undefined) {
      const asserted = this.#fromProxy(context, this.#proxy);
      if (asserted) return asserted;
    }

    if (this.#sharedTokenUsable) {
      return this.#fromSharedToken(context);
    }

    throw new ArcError(
      'unauthenticated',
      this.#sessions === undefined
        ? 'this request carried no trusted operator identity'
        : 'no operator session; sign in at /auth/login',
    );
  }

  #fromProxy(context: RequestContext, proxy: TrustedProxyOptions): OperatorIdentity | undefined {
    const presented = header(context, proxy.secretHeader ?? 'x-arc-proxy-secret');
    if (presented === undefined) return undefined;

    if (!equalConstantTime(presented, proxy.sharedSecret)) {
      throw new ArcError(
        'unauthenticated',
        'a proxy identity was presented with the wrong shared secret, so it was not trusted',
      );
    }

    const identifier = header(context, proxy.identityHeader);
    if (identifier === undefined) {
      throw new ArcError(
        'unauthenticated',
        `the trusted proxy sent its secret but no ${proxy.identityHeader} header, so nobody was identified`,
      );
    }

    // Groups go through the same mapping rule as OIDC claims: an unmapped
    // group grants nothing, so the proxy cannot invent ARC roles.
    const roles = new Set<string>();
    if (proxy.rolesHeader !== undefined) {
      for (const group of (header(context, proxy.rolesHeader) ?? '').split(/[\s,]+/).filter(Boolean)) {
        for (const role of proxy.roleMap?.[group] ?? []) roles.add(role);
      }
    }

    return {
      identifier: identifier.toLowerCase(),
      roles: [...roles].sort(),
      assurance: 'asserted_by_proxy',
    };
  }

  #fromSharedToken(context: RequestContext): OperatorIdentity {
    const presented = context.bearer ?? '';
    if (!equalConstantTime(presented, this.#token!)) {
      throw new ArcError('unauthenticated', 'the presented operator token is not valid');
    }

    // Roles still come from a header here, because with a shared token there
    // is nowhere better for them to come from. That is precisely why this mode
    // is recorded as `claimed` and why it is off by default.
    const roles = (header(context, 'x-arc-operator-roles') ?? '')
      .split(',')
      .map((role) => role.trim())
      .filter(Boolean);

    return {
      identifier: header(context, 'x-arc-operator') ?? this.#defaultIdentifier,
      roles,
      assurance: 'claimed',
    };
  }
}

function header(context: RequestContext, name: string): string | undefined {
  const value = context.headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function equalConstantTime(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
