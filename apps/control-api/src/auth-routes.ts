import { ArcError } from '@arc-control/schemas';
import { identifierFor, rolesFor, type OidcClient, type RoleResolutionOptions, type SessionManager } from '@arc-control/operator-identity';
import type { Gateway } from '@arc-control/gateway';
import { redirect, withStatus, type Router } from './http.js';
import { SESSION_COOKIE, type OperatorAuth } from './operator.js';

/**
 * The sign-in flow.
 *
 * The only browser-facing routes in an otherwise JSON API, which is why the
 * cookie handling is written out here rather than hidden in a helper: these
 * four routes are where a reviewer looks first.
 */

/** Carries PKCE state across the redirect. Short-lived and signed. */
const LOGIN_COOKIE = 'arc_login';

/** A sign-in attempt must complete inside this window. */
const LOGIN_WINDOW_MS = 10 * 60 * 1000;

export interface AuthRouteOptions {
  readonly gateway: Gateway;
  readonly operators: OperatorAuth;
  readonly sessions?: SessionManager;
  readonly oidc?: OidcClient;
  readonly roleOptions?: RoleResolutionOptions;
  /**
   * Whether cookies are marked `Secure`.
   *
   * On unless explicitly disabled for local HTTP development. A `Secure`
   * cookie is simply not sent over plain HTTP, so getting this wrong in
   * production means nobody can sign in — a loud failure, which is the right
   * way round for a flag that otherwise sends session cookies in clear text.
   */
  readonly secureCookies?: boolean;
  /**
   * Where the console lives, when it is not this origin.
   *
   * The sign-in flow is entered from the console and must end back at it. The
   * API serves JSON, so landing an operator here at the end of it means
   * landing them on a 404 or a blob of JSON — which is what happened before
   * this existed, on the default deployment, where the console and the API are
   * two services on two ports.
   */
  readonly consoleUrl?: string;
}

interface LoginState {
  readonly state: string;
  readonly codeVerifier: string;
  readonly nonce: string;
  readonly returnTo: string;
  readonly startedAt: number;
}

function cookie(
  name: string,
  value: string,
  options: { readonly maxAgeSeconds: number; readonly secure: boolean },
): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    // Lax rather than Strict: the provider redirects the browser back to the
    // callback as a top-level navigation, and Strict would withhold the cookie
    // on exactly that request, so sign-in could never complete. Lax still
    // withholds it from cross-site subrequests, which is the case that matters.
    'SameSite=Lax',
    `Max-Age=${String(options.maxAgeSeconds)}`,
  ];
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

function clearCookie(name: string, secure: boolean): string {
  return cookie(name, '', { maxAgeSeconds: 0, secure });
}

/**
 * Where to send the browser after sign-in.
 *
 * Only a path on this deployment is allowed. A `returnTo` taken from the query
 * string and echoed into a redirect is an open redirect, and the sign-in page
 * is the most useful place in the product to have one: an attacker sends a
 * link that authenticates the victim and then bounces them somewhere that
 * looks like ARC and asks for something.
 *
 * A protocol-relative `//evil.example.com` is a URL to a browser and a path to
 * a naive check, so it is rejected explicitly.
 *
 * So are control characters, and that one is not hypothetical: the URL parser
 * strips tab, carriage return and line feed *before* parsing, so
 * `/\t/evil.example.com` passes every prefix check above and then resolves to
 * `//evil.example.com` — a working open redirect through a value that reads
 * like a path. Nothing legitimate needs them: a real `returnTo` is a path the
 * console itself generated, where anything of the sort would be
 * percent-encoded. Rejecting the whole C0 range and DEL is cheaper than
 * reasoning about which characters a parser discards.
 */
export function safeReturnTo(value: string | null): string {
  if (value === null || value === '') return '/';
  if (!value.startsWith('/')) return '/';
  if (value.startsWith('//')) return '/';
  if (value.includes('\\')) return '/';
  // eslint-disable-next-line no-control-regex -- the point is to match them
  if (/[\u0000-\u001f\u007f]/.test(value)) return '/';
  return value;
}

/**
 * The absolute address to send an operator to when the flow is finished.
 *
 * `safeReturnTo` has already reduced the request's value to something that
 * looks like a path on this deployment, but this does not rely on that. The
 * first version did, and it was wrong: a tab in the middle of the path was
 * enough to turn the resolved URL into `//evil.example.com`, because the
 * checks there are about the *input* while what matters is the *destination*.
 *
 * So the destination is what gets checked. Resolve, then assert the result
 * lands on the console's own origin, and send somebody to the console root if
 * it does not. That holds whatever the parser does with the input, which is
 * the property worth having here — the sign-in page is the most valuable place
 * in the product to have an open redirect, since the attacker gets a victim
 * who has just authenticated and is expecting to land somewhere that looks
 * like ARC.
 *
 * With no console configured this returns the path unchanged, which is correct
 * for a single-origin deployment and the long-standing behaviour.
 */
export function returnToUrl(path: string, consoleUrl: string | undefined): string {
  if (consoleUrl === undefined || consoleUrl === '') return path;

  const base = consoleOrigin(consoleUrl);
  if (base === undefined) {
    // A console URL this code cannot build a destination from is a
    // configuration error, not a reason to strand somebody mid-sign-in. The
    // startup check refuses it, so reaching here means something constructed
    // the API directly.
    return path;
  }

  try {
    const resolved = new URL(path, base);
    // The one question that matters, asked of the answer rather than of the
    // question: is this still the console?
    if (resolved.origin !== base.origin) return base.origin;
    return resolved.toString();
  } catch {
    return base.origin;
  }
}

/**
 * The console's URL, if it is one a browser can be sent to.
 *
 * Stricter than `new URL` on purpose, because `new URL` is more permissive
 * than it looks. `localhost:8788` — the obvious thing to write, and wrong only
 * by a missing scheme — parses happily as a URL whose *scheme* is `localhost`
 * and whose path is opaque. Its origin is the string `"null"`, and resolving a
 * path against it throws. An earlier version of this function took that at
 * face value and emitted `null` as the `Location` header, which is a worse
 * failure than the one it replaced.
 *
 * So: an absolute http or https URL with a real origin, or nothing.
 */
export function consoleOrigin(consoleUrl: string): URL | undefined {
  let parsed: URL;
  try {
    parsed = new URL(consoleUrl);
  } catch {
    return undefined;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
  // Belt and braces: every http(s) URL has a real origin, but this is the
  // property actually depended on below, so it is the property checked.
  if (parsed.origin === 'null' || parsed.origin === '') return undefined;

  return parsed;
}

export function addAuthRoutes(router: Router, options: AuthRouteOptions): Router {
  const { gateway, operators, sessions, oidc } = options;
  const secure = options.secureCookies !== false;

  /** States how this deployment authenticates operators. Unauthenticated on purpose. */
  router.get('/auth/mode', async () => {
    return {
      modes: operators.modes,
      strongest: operators.strongestAssurance ?? null,
      signInUrl: oidc === undefined ? null : '/auth/login',
      issuer: oidc?.issuer ?? null,
      /**
       * Said plainly so the console never has to infer it, and so an operator
       * reading an approval record knows what it can support.
       */
      notice:
        operators.strongestAssurance === 'claimed'
          ? 'This deployment authenticates operators with a shared token and takes their name from a request ' +
            'header. Approvals record that the workflow ran, not who ran it. Configure ARC_OIDC_ISSUER to change that.'
          : null,
    };
  });

  /**
   * Who the caller is, as this deployment resolved them.
   *
   * Available on every mode, because the console needs it on every mode: with
   * a session the identity and roles are the session's, and a console that
   * displayed what its own configuration said would be presenting a guess as
   * a fact — on the page where an operator checks exactly this.
   */
  router.get('/v1/whoami', async (context) => {
    const operator = await operators.authenticate(context);
    return {
      identifier: operator.identifier,
      roles: operator.roles,
      assurance: operator.assurance,
      ...(operator.issuer === undefined ? {} : { issuer: operator.issuer }),
      ...(operator.subject === undefined ? {} : { subject: operator.subject }),
      ...(operator.sessionId === undefined ? {} : { sessionId: operator.sessionId }),
    };
  });

  if (sessions === undefined || oidc === undefined) return router;

  router.get('/auth/login', async (context) => {
    const started = await oidc.startLogin();
    const state: LoginState = {
      state: started.state,
      codeVerifier: started.codeVerifier,
      nonce: started.nonce,
      returnTo: safeReturnTo(context.query.get('returnTo')),
      startedAt: Date.now(),
    };

    return redirect(started.authorizationUrl, {
      'set-cookie': cookie(LOGIN_COOKIE, sessions.sign(JSON.stringify(state)), {
        maxAgeSeconds: LOGIN_WINDOW_MS / 1000,
        secure,
      }),
    });
  });

  router.get('/auth/callback', async (context) => {
    // The provider reports a refused sign-in here rather than at the token
    // endpoint, so it has to be read before anything else is attempted.
    const providerError = context.query.get('error');
    if (providerError !== null) {
      throw new ArcError('unauthenticated', `the identity provider refused the sign-in: ${providerError}`, {
        details: { error: providerError, description: context.query.get('error_description') },
      });
    }

    const signed = context.cookies[LOGIN_COOKIE];
    if (signed === undefined) {
      throw new ArcError(
        'unauthenticated',
        'this callback carries no sign-in cookie, so it did not start here; begin again at /auth/login',
      );
    }

    const raw = sessions.unsign(signed);
    if (raw === null || raw === undefined) {
      throw new ArcError('unauthenticated', 'the sign-in cookie is not signed by this deployment');
    }

    let pending: LoginState;
    try {
      pending = JSON.parse(raw) as LoginState;
    } catch {
      throw new ArcError('unauthenticated', 'the sign-in cookie is malformed');
    }

    if (Date.now() - pending.startedAt > LOGIN_WINDOW_MS) {
      throw new ArcError('unauthenticated', 'this sign-in took too long; begin again at /auth/login');
    }

    const code = context.query.get('code');
    const state = context.query.get('state');
    if (code === null || state === null) {
      throw new ArcError('unauthenticated', 'the callback is missing its code or state');
    }

    const claims = await oidc.completeLogin({
      code,
      state,
      expectedState: pending.state,
      codeVerifier: pending.codeVerifier,
      nonce: pending.nonce,
    });

    const identifier = identifierFor(claims);
    const roles = rolesFor(claims, options.roleOptions ?? {});

    const { session, cookie: sessionCookie } = await sessions.open({
      identifier,
      subject: claims.sub,
      issuer: claims.iss,
      roles,
    });

    // A sign-in is a governance event: it is how somebody came to be able to
    // approve things, and an audit of an approval is incomplete without it.
    await gateway.audit.append({
      type: 'operator.signed_in',
      organizationId: 'default',
      actor: identifier,
      subject: session.id,
      summary:
        roles.length === 0
          ? `${identifier} signed in with no roles, so they can read but approve nothing`
          : `${identifier} signed in with roles ${roles.join(', ')}`,
      data: { sessionId: session.id, issuer: claims.iss, subject: claims.sub, roles, assurance: 'authenticated' },
    });

    return redirect(returnToUrl(pending.returnTo, options.consoleUrl), {
      'set-cookie': [
        cookie(SESSION_COOKIE, sessionCookie, { maxAgeSeconds: 12 * 60 * 60, secure }),
        clearCookie(LOGIN_COOKIE, secure),
      ],
    });
  });

  router.post('/auth/logout', async (context) => {
    const operator = await operators.authenticate(context);

    if (operator.sessionId !== undefined) {
      await sessions.revoke(operator.sessionId, operator.identifier, 'signed out');
      await gateway.audit.append({
        type: 'operator.signed_out',
        organizationId: 'default',
        actor: operator.identifier,
        subject: operator.sessionId,
        summary: `${operator.identifier} signed out`,
        data: { sessionId: operator.sessionId },
      });
    }

    return withStatus(200, { signedOut: true }, { 'set-cookie': clearCookie(SESSION_COOKIE, secure) });
  });

  /** Live sessions, so an administrator can see who is signed in. */
  router.get('/v1/operator-sessions', async (context) => {
    await operators.authenticate(context);
    return { sessions: await sessions.live() };
  });

  /**
   * Ends every session for a person.
   *
   * Keyed on the provider's subject rather than the email, because offboarding
   * has to catch the person who left and not whoever is given their address
   * next. The console shows the subject beside each session for this reason.
   */
  router.post('/v1/operator-sessions/revoke', async (context) => {
    const operator = await operators.authenticate(context);
    const body = await context.body<{ subject?: string; reason?: string }>();

    if (typeof body.subject !== 'string' || body.subject.length === 0) {
      throw new ArcError('invalid_request', 'subject is required: the provider subject whose sessions to end');
    }

    const reason = typeof body.reason === 'string' && body.reason ? body.reason : 'revoked by an administrator';
    const ended = await sessions.revokeAllFor(body.subject, operator.identifier, reason);

    await gateway.audit.append({
      type: 'operator.sessions_revoked',
      organizationId: 'default',
      actor: operator.identifier,
      subject: body.subject,
      summary: `${operator.identifier} ended ${String(ended)} session(s) for subject ${body.subject}: ${reason}`,
      data: { subject: body.subject, ended, reason },
    });

    return { subject: body.subject, ended, reason };
  });

  return router;
}
