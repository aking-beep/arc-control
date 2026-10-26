import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { ArcError } from '@arc-control/schemas';
import { encodeBase64Url, verifyIdToken, type IdTokenClaims, type JsonWebKey } from './jwt.js';

/**
 * An OpenID Connect relying party, on Node builtins.
 *
 * Authorization code flow with PKCE, which is the flow to use even for a
 * confidential client: it binds the code to the browser that started the
 * sign-in, so a code intercepted in a redirect or a log cannot be redeemed by
 * anyone else.
 */

export interface OidcProviderMetadata {
  readonly issuer: string;
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly jwks_uri: string;
  readonly end_session_endpoint?: string;
}

export interface OidcOptions {
  /** The provider's issuer URL, exactly as it appears in its ID tokens. */
  readonly issuer: string;
  readonly clientId: string;
  /** Omit for a public client, which PKCE already protects. */
  readonly clientSecret?: string;
  /** Must match a redirect URI registered with the provider, exactly. */
  readonly redirectUri: string;
  readonly scopes?: readonly string[];
  /** Provider metadata, to skip discovery. Useful in tests and air-gapped installs. */
  readonly metadata?: OidcProviderMetadata;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => Date;
  /** Shortest interval between JWKS refetches, in milliseconds. */
  readonly jwksMinRefreshMs?: number;
  readonly clockSkewSeconds?: number;
}

export interface StartedLogin {
  /** Where to send the browser. */
  readonly authorizationUrl: string;
  /** Must be returned on the callback and then discarded. */
  readonly state: string;
  /** Held by the browser, never sent to the provider until the code exchange. */
  readonly codeVerifier: string;
  readonly nonce: string;
}

/** A PKCE verifier: 32 random bytes, base64url, which is 43 characters. */
function newVerifier(): string {
  return encodeBase64Url(randomBytes(32));
}

function challengeFor(verifier: string): string {
  return encodeBase64Url(createHash('sha256').update(verifier, 'ascii').digest());
}

export class OidcClient {
  readonly #options: OidcOptions;
  readonly #fetch: typeof globalThis.fetch;
  readonly #now: () => Date;
  #metadata: OidcProviderMetadata | undefined;
  #keys: readonly JsonWebKey[] = [];
  #keysFetchedAt = 0;

  constructor(options: OidcOptions) {
    if (!options.issuer) throw new ArcError('invalid_request', 'an OIDC issuer is required');
    if (!options.clientId) throw new ArcError('invalid_request', 'an OIDC client id is required');
    if (!options.redirectUri) throw new ArcError('invalid_request', 'an OIDC redirect URI is required');

    this.#options = options;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? (() => new Date());
    this.#metadata = options.metadata;
  }

  get issuer(): string {
    return this.#options.issuer;
  }

  /** Fetches and caches the provider's metadata. */
  async metadata(): Promise<OidcProviderMetadata> {
    if (this.#metadata) return this.#metadata;

    const url = `${this.#options.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
    const response = await this.#fetch(url, { headers: { accept: 'application/json' } });
    if (!response.ok) {
      throw new ArcError('identity_provider_unavailable', `the identity provider's discovery document returned HTTP ${response.status}`, {
        details: { url, status: response.status },
      });
    }

    const metadata = (await response.json()) as OidcProviderMetadata;

    // The discovery document is fetched over the network, so its issuer is
    // checked against the configured one. A document that names a different
    // issuer is either a misconfiguration or a redirect to somebody else's
    // provider, and trusting its endpoints would send credentials there.
    if (metadata.issuer !== this.#options.issuer) {
      throw new ArcError(
        'invalid_request',
        `the discovery document at ${url} names issuer "${String(metadata.issuer)}", not "${this.#options.issuer}"`,
      );
    }

    for (const field of ['authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) {
      if (typeof metadata[field] !== 'string') {
        throw new ArcError('invalid_request', `the discovery document is missing ${field}`);
      }
    }

    this.#metadata = metadata;
    return metadata;
  }

  /**
   * Begins a sign-in.
   *
   * The caller must hold `state`, `codeVerifier` and `nonce` somewhere bound to
   * this browser — a short-lived signed cookie — and present them on callback.
   */
  async startLogin(): Promise<StartedLogin> {
    const metadata = await this.metadata();
    const state = encodeBase64Url(randomBytes(32));
    const nonce = encodeBase64Url(randomBytes(32));
    const codeVerifier = newVerifier();

    const url = new URL(metadata.authorization_endpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.#options.clientId);
    url.searchParams.set('redirect_uri', this.#options.redirectUri);
    url.searchParams.set('scope', (this.#options.scopes ?? ['openid', 'email', 'profile']).join(' '));
    url.searchParams.set('state', state);
    url.searchParams.set('nonce', nonce);
    url.searchParams.set('code_challenge', challengeFor(codeVerifier));
    url.searchParams.set('code_challenge_method', 'S256');

    return { authorizationUrl: url.toString(), state, codeVerifier, nonce };
  }

  /**
   * Exchanges an authorization code for a verified identity.
   *
   * `expectedState` is compared in constant time. A mismatch is a cross-site
   * request forgery against the sign-in itself: an attacker who can make a
   * victim's browser hit the callback with the attacker's code logs the victim
   * into the attacker's account.
   */
  async completeLogin(input: {
    readonly code: string;
    readonly state: string;
    readonly expectedState: string;
    readonly codeVerifier: string;
    readonly nonce: string;
  }): Promise<IdTokenClaims> {
    if (!equalConstantTime(input.state, input.expectedState)) {
      throw new ArcError('unauthenticated', 'the sign-in state does not match, so this callback is not trusted');
    }

    const metadata = await this.metadata();
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: this.#options.redirectUri,
      client_id: this.#options.clientId,
      code_verifier: input.codeVerifier,
    });

    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    };

    // Secret in the Authorization header rather than the form body: it keeps
    // the secret out of any intermediary that logs request bodies, and
    // `client_secret_basic` is the method providers must support.
    if (this.#options.clientSecret !== undefined) {
      const credentials = `${encodeURIComponent(this.#options.clientId)}:${encodeURIComponent(this.#options.clientSecret)}`;
      headers.authorization = `Basic ${Buffer.from(credentials, 'utf8').toString('base64')}`;
    }

    const response = await this.#fetch(metadata.token_endpoint, { method: 'POST', headers, body });
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;

    if (!response.ok) {
      // The provider's error description is useful and is not a secret, but
      // the token response may carry tokens, so only the error fields are
      // repeated.
      throw new ArcError('unauthenticated', `the identity provider refused the code exchange: ${describe(payload)}`, {
        details: { status: response.status, error: payload.error },
      });
    }

    if (typeof payload.id_token !== 'string') {
      throw new ArcError('unauthenticated', 'the identity provider returned no ID token, so nobody was identified');
    }

    return this.verify(payload.id_token, input.nonce);
  }

  /** Verifies an ID token against the provider's current keys. */
  async verify(idToken: string, nonce?: string): Promise<IdTokenClaims> {
    const options = {
      issuer: this.#options.issuer,
      audience: this.#options.clientId,
      ...(nonce === undefined ? {} : { nonce }),
      ...(this.#options.clockSkewSeconds === undefined ? {} : { clockSkewSeconds: this.#options.clockSkewSeconds }),
      now: this.#now().getTime(),
    };

    try {
      return await verifyIdToken(idToken, await this.keys(), options);
    } catch (cause) {
      // A provider rotating its signing keys produces exactly this failure, so
      // one refetch is attempted before giving up. Rate-limited inside
      // `keys`, so a stream of bad tokens cannot turn this into a request
      // amplifier pointed at the provider.
      const refreshed = await this.refreshKeys();
      if (refreshed === undefined) throw cause;
      return verifyIdToken(idToken, refreshed, options);
    }
  }

  /** The provider's signing keys, fetched once and then cached. */
  async keys(): Promise<readonly JsonWebKey[]> {
    if (this.#keys.length > 0) return this.#keys;
    return this.#fetchKeys();
  }

  /**
   * Refetches the provider's keys, or returns undefined if the last fetch was
   * too recent.
   *
   * Undefined says "not refreshed" rather than handing back the same stale set
   * as though it were new, so a caller retrying a verification can tell the
   * difference between "try again with new keys" and "there are no new keys".
   */
  async refreshKeys(): Promise<readonly JsonWebKey[] | undefined> {
    const minInterval = this.#options.jwksMinRefreshMs ?? 60_000;
    if (this.#now().getTime() - this.#keysFetchedAt < minInterval) return undefined;
    return this.#fetchKeys();
  }

  async #fetchKeys(): Promise<readonly JsonWebKey[]> {
    const metadata = await this.metadata();
    const response = await this.#fetch(metadata.jwks_uri, { headers: { accept: 'application/json' } });
    if (!response.ok) {
      throw new ArcError('identity_provider_unavailable', `the identity provider's key set returned HTTP ${response.status}`, {
        details: { status: response.status },
      });
    }

    const document = (await response.json()) as { keys?: readonly JsonWebKey[] };
    if (!Array.isArray(document.keys) || document.keys.length === 0) {
      throw new ArcError('identity_provider_unavailable', 'the identity provider published an empty key set');
    }

    this.#keys = document.keys;
    this.#keysFetchedAt = this.#now().getTime();
    return this.#keys;
  }
}

function equalConstantTime(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function describe(payload: Record<string, unknown>): string {
  const error = typeof payload.error === 'string' ? payload.error : 'no error code';
  const description = typeof payload.error_description === 'string' ? `: ${payload.error_description}` : '';
  return `${error}${description}`;
}
