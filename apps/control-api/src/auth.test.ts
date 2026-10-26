import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { encodeBase64Url } from '@arc-control/operator-identity';
import { SimulationConnector } from '@arc-control/connector-simulation';
import { MemoryStore } from '@arc-control/store';
import { createControlApi, type ControlApi } from './server.js';
import { consoleOrigin, returnToUrl, safeReturnTo } from './auth-routes.js';

/**
 * Signing in, end to end, against a stub identity provider on loopback.
 *
 * The whole point of 2.1 is that an approval can be attributed to a person, so
 * the test that matters is not "the OIDC client parses a token" — covered in
 * the operator-identity package — but "a vote cast through the real HTTP API
 * after a real sign-in is recorded as authenticated, and the shared-token back
 * door is shut".
 */

const CLIENT_ID = 'arc-control-console';
const SESSION_SECRET = 's'.repeat(64);
const LEGACY_TOKEN = 'legacy-shared-operator-token';

/** A stub provider: discovery, keys, and a token endpoint that mints real ID tokens. */
function identityProvider(): {
  server: Server;
  listen: () => Promise<number>;
  issuer: () => string;
  /** Claims the next token exchange will carry, beyond the required ones. */
  claims: Record<string, unknown>;
  exchanges: number;
} {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...(publicKey.export({ format: 'jwk' }) as Record<string, unknown>), kid: 'stub-1', alg: 'RS256', use: 'sig' };

  const state = {
    claims: { email: 'cfo@example.com', email_verified: true, groups: ['arc-finance'] } as Record<string, unknown>,
    exchanges: 0,
  };
  let issuer = '';

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', issuer);
    const json = (body: unknown): void => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };

    if (url.pathname === '/.well-known/openid-configuration') {
      json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
      });
      return;
    }

    if (url.pathname === '/jwks') {
      json({ keys: [jwk] });
      return;
    }

    if (url.pathname === '/token') {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        state.exchanges += 1;
        const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
        // The nonce ARC sent travelled in the authorization request; a real
        // provider echoes it into the token, and so does this one.
        const nonce = form.get('nonce_for_test') ?? nonceByCode.get(form.get('code') ?? '') ?? '';

        const now = Math.floor(Date.now() / 1000);
        const header = { alg: 'RS256', kid: 'stub-1', typ: 'JWT' };
        const payload = {
          iss: issuer,
          sub: 'provider-subject-cfo',
          aud: CLIENT_ID,
          exp: now + 300,
          iat: now,
          nonce,
          ...state.claims,
        };

        const signingInput = `${encodeBase64Url(JSON.stringify(header))}.${encodeBase64Url(JSON.stringify(payload))}`;
        const signature = createSign('RSA-SHA256').update(signingInput, 'ascii').sign(privateKey);
        json({ id_token: `${signingInput}.${encodeBase64Url(signature)}`, token_type: 'Bearer' });
      });
      return;
    }

    response.writeHead(404);
    response.end();
  });

  return {
    server,
    claims: state.claims,
    get exchanges() {
      return state.exchanges;
    },
    issuer: () => issuer,
    listen: () =>
      new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          const address = server.address();
          const port = typeof address === 'object' && address ? address.port : 0;
          issuer = `http://127.0.0.1:${String(port)}`;
          resolve(port);
        });
      }),
  };
}

/** Maps an authorization code to the nonce it was issued against. */
const nonceByCode = new Map<string, string>();

/**
 * Where sign-in sends somebody afterwards.
 *
 * The sign-in page is the most valuable place in this product to have an open
 * redirect: the attacker gets a victim who has just authenticated and is
 * expecting to land somewhere that looks like ARC.
 *
 * The first version of this code checked the *input* — one leading slash, no
 * second slash, no backslash — and that was not enough. The URL parser strips
 * tab, carriage return and line feed before parsing, so `/\t/evil.example.com`
 * passed every check and then resolved to `//evil.example.com`. The lesson is
 * in how these tests are written: the assertion is about the destination, not
 * about which inputs were thought of.
 */
describe('where sign-in returns an operator to', () => {
  const CONSOLE = 'http://console.internal:8788';

  /**
   * Each of these looks like a path to a prefix check and is a different
   * origin to a browser.
   */
  const hostile: ReadonlyArray<readonly [string, string]> = [
    ['a tab mid-path, which the URL parser strips', '/\t/evil.example.com'],
    ['a line feed', '/\n/evil.example.com'],
    ['a carriage return', '/\r/evil.example.com'],
    ['two tabs and a real protocol-relative path', '/\t\t//evil.example.com'],
    ['a NUL', '/\u0000/evil.example.com'],
    ['a DEL', '/\u007f/evil.example.com'],
    ['a plain protocol-relative path', '//evil.example.com'],
    ['an absolute URL', 'https://evil.example.com/steal'],
    ['a backslash, which some parsers treat as a slash', '/\\evil.example.com'],
    ['an absolute URL with no scheme separator', 'https:evil.example.com'],
  ];

  for (const [description, value] of hostile) {
    it(`sends an operator to the console despite ${description}`, () => {
      const destination = returnToUrl(safeReturnTo(value), CONSOLE);

      assert.ok(
        destination.startsWith(CONSOLE),
        `${JSON.stringify(value)} would have sent a signed-in operator to ${destination}`,
      );
      assert.equal(new URL(destination).origin, new URL(CONSOLE).origin);
    });
  }

  it('keeps the page the operator actually asked for', () => {
    assert.equal(
      returnToUrl(safeReturnTo('/approvals?status=pending'), CONSOLE),
      `${CONSOLE}/approvals?status=pending`,
    );
    assert.equal(returnToUrl(safeReturnTo('/assurance/ARC-AI-004'), CONSOLE), `${CONSOLE}/assurance/ARC-AI-004`);
  });

  /** A single-origin deployment has no console address, and needs none. */
  it('returns a bare path when no console is configured', () => {
    assert.equal(returnToUrl(safeReturnTo('/approvals'), undefined), '/approvals');
    assert.equal(returnToUrl(safeReturnTo('//evil.example.com'), undefined), '/');
  });

  /**
   * A console URL this code cannot build a destination from must not strand
   * somebody mid-sign-in.
   *
   * `'not a url'` was the only case here before, and it was the easy one: it
   * throws on parse. The ones that matter are the values `new URL` accepts
   * without complaint. `localhost:8788` is wrong only by a missing scheme and
   * parses as a URL whose *scheme* is `localhost`, with origin `"null"` —
   * which an earlier version of this function put straight into the `Location`
   * header, so sign-in redirected the operator to the literal string `null`.
   */
  for (const unusable of ['not a url', '', 'localhost:8788', 'console.internal:8788', 'ftp://console.example.com']) {
    it(`falls back to a path when the console URL is ${JSON.stringify(unusable)}`, () => {
      const destination = returnToUrl(safeReturnTo('/approvals'), unusable);

      assert.equal(destination, '/approvals');
      assert.ok(!destination.includes('null'), 'a redirect to "null" is worse than no redirect');
    });
  }

  it('accepts only http and https for the console', () => {
    assert.notEqual(consoleOrigin('http://console:8788'), undefined);
    assert.notEqual(consoleOrigin('https://arc.example.com'), undefined);
    assert.equal(consoleOrigin('ftp://console:8788'), undefined);
    assert.equal(consoleOrigin('javascript:alert(1)'), undefined);
    assert.equal(consoleOrigin('localhost:8788'), undefined);
  });

  it('discards any path on the configured console URL', () => {
    assert.equal(returnToUrl(safeReturnTo('/approvals'), `${CONSOLE}/some/prefix`), `${CONSOLE}/approvals`);
  });
});

describe('signing an operator in', () => {
  let provider: ReturnType<typeof identityProvider>;
  let api: ControlApi;
  let store: MemoryStore;
  let base: string;

  before(async () => {
    provider = identityProvider();
    await provider.listen();

    store = new MemoryStore();
    api = createControlApi({
      store,
      operatorToken: LEGACY_TOKEN,
      sessionSecret: SESSION_SECRET,
      secureCookies: false,
      oidc: {
        issuer: provider.issuer(),
        clientId: CLIENT_ID,
        clientSecret: 'stub-secret',
        redirectUri: 'http://127.0.0.1:1/auth/callback',
      },
      roles: { roleClaim: 'groups', roleMap: { 'arc-finance': ['finance-manager'] } },
    });

    api.gateway.addConnector(new SimulationConnector({ handlers: { 'stripe.refund': () => ({ ok: true }) } }));
    await api.gateway.tools.register({
      name: 'stripe.refund',
      description: 'Refund a charge.',
      effect: 'irreversible',
      riskTier: 'critical',
      connector: 'simulation',
      parameters: [{ name: 'amount', type: 'number', required: true, minimum: 0 }],
    });

    const address = await api.listen(0);
    base = `http://${address.host}:${address.port}`;
  });

  after(async () => {
    const close = async (fn: () => Promise<unknown> | unknown): Promise<void> => {
      try {
        await fn();
      } catch {
        /* a half-built fixture must still release its handles */
      }
    };
    await close(() => api?.close());
    await close(() => store?.close());
    await close(async () => {
      if (provider?.server.listening) await new Promise<void>((resolve) => provider.server.close(() => resolve()));
    });
  });

  /** Drives the whole flow and returns the session cookie. */
  async function signIn(returnTo?: string): Promise<{ cookie: string; location: string }> {
    const login = await fetch(`${base}/auth/login${returnTo === undefined ? '' : `?returnTo=${encodeURIComponent(returnTo)}`}`, {
      redirect: 'manual',
    });
    assert.equal(login.status, 302, 'login redirects to the provider');

    const authorize = new URL(login.headers.get('location') ?? '');
    const loginCookie = (login.headers.getSetCookie?.() ?? [])[0] ?? '';

    const state = authorize.searchParams.get('state') ?? '';
    const nonce = authorize.searchParams.get('nonce') ?? '';
    const code = `code-for-${state}`;
    nonceByCode.set(code, nonce);

    const callback = await fetch(`${base}/auth/callback?code=${code}&state=${encodeURIComponent(state)}`, {
      redirect: 'manual',
      headers: { cookie: loginCookie.split(';')[0] ?? '' },
    });

    assert.equal(callback.status, 302, await callback.text());
    const session = (callback.headers.getSetCookie?.() ?? []).find((value) => value.startsWith('arc_operator_session='));
    assert.ok(session, 'the callback sets a session cookie');

    return { cookie: session.split(';')[0] ?? '', location: callback.headers.get('location') ?? '' };
  }

  it('sends the browser to the provider with PKCE and a nonce', async () => {
    const login = await fetch(`${base}/auth/login`, { redirect: 'manual' });
    const authorize = new URL(login.headers.get('location') ?? '');

    assert.equal(authorize.searchParams.get('response_type'), 'code');
    assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(authorize.searchParams.get('code_challenge'), 'a PKCE challenge is sent');
    assert.ok(authorize.searchParams.get('nonce'), 'and a nonce');
    assert.equal(authorize.searchParams.get('client_id'), CLIENT_ID);
  });

  it('marks the sign-in cookie HttpOnly and SameSite=Lax', async () => {
    const login = await fetch(`${base}/auth/login`, { redirect: 'manual' });
    const cookie = (login.headers.getSetCookie?.() ?? [])[0] ?? '';

    assert.match(cookie, /HttpOnly/, 'script must not be able to read it');
    // Lax, not Strict: the provider's redirect back is a top-level navigation,
    // and Strict would withhold the cookie on exactly that request.
    assert.match(cookie, /SameSite=Lax/);
  });

  it('opens a session whose roles come from the provider claims', async () => {
    const { cookie } = await signIn();

    const response = await fetch(`${base}/v1/assurance/summary`, { headers: { cookie } });
    assert.equal(response.status, 200, 'the session authenticates a governance route');

    const sessions = (await (await fetch(`${base}/v1/operator-sessions`, { headers: { cookie } })).json()) as {
      sessions: readonly { identifier: string; roles: readonly string[]; subject: string }[];
    };
    const mine = sessions.sessions.at(-1);
    assert.equal(mine?.identifier, 'cfo@example.com');
    assert.deepEqual(mine?.roles, ['finance-manager'], 'mapped from the groups claim');
    assert.equal(mine?.subject, 'provider-subject-cfo');
  });

  /**
   * The point of the release. A vote cast after a real sign-in has to be
   * recorded as attributable, or none of the above bought anything.
   */
  it('records a vote cast in that session as authenticated', async () => {
    const { cookie } = await signIn();

    await api.gateway.admin.publishPolicy(
      {
        id: 'HOLD-AUTH',
        version: 1,
        name: 'Hold refunds',
        enabled: true,
        match: { tools: ['stripe.refund'] },
        rules: [
          {
            id: 'hold',
            when: { always: true },
            effect: 'REQUIRE_APPROVAL',
            reason: 'needs a human',
            approval: { approvers: ['role:finance-manager'], minApprovals: 1 },
          },
        ],
        fallback: { effect: 'DENY', reason: 'no rule matched' },
      },
      { identifier: 'ops@example.com', via: 'api' },
    );

    const agent = await api.gateway.agents.register({ name: 'support-agent', owner: 'lead@example.com' });
    const { apiKey } = await api.gateway.agents.issueKey(agent.id);

    const held = (await (
      await fetch(`${base}/v1/actions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ tool: 'stripe.refund', parameters: { amount: 100 } }),
      })
    ).json()) as { approvalId?: string };

    const vote = await fetch(`${base}/v1/approvals/${String(held.approvalId)}/vote`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ vote: 'approve' }),
    });
    assert.equal(vote.status, 200, await vote.text());

    const request = await api.gateway.approvals.require(String(held.approvalId));
    const cast = request.votes.at(-1);
    assert.equal(cast?.approver, 'cfo@example.com');
    assert.equal(cast?.assurance, 'authenticated', 'the vote is attributable to a verified person');
    assert.equal(cast?.issuer, provider.issuer());
    assert.equal(cast?.subject, 'provider-subject-cfo');
  });

  /**
   * The back door. With single sign-on configured the shared token must stop
   * working, or everything above is optional.
   */
  it('refuses the shared token once single sign-on is configured', async () => {
    const response = await fetch(`${base}/v1/assurance/summary`, {
      headers: { authorization: `Bearer ${LEGACY_TOKEN}`, 'x-arc-operator': 'anyone@example.com' },
    });

    assert.equal(response.status, 401, 'the legacy token is no longer a way in');
    assert.match(JSON.stringify(await response.json()), /sign in at \/auth\/login/);
  });

  it('refuses a forged session cookie', async () => {
    const response = await fetch(`${base}/v1/assurance/summary`, {
      headers: { cookie: 'arc_operator_session=arc_ses_0000.not-a-real-signature' },
    });
    assert.equal(response.status, 401);
  });

  it('refuses a callback that did not start here', async () => {
    const response = await fetch(`${base}/auth/callback?code=x&state=y`, { redirect: 'manual' });
    assert.equal(response.status, 401);
    assert.match(JSON.stringify(await response.json()), /did not start here/);
  });

  it('reports a sign-in the provider refused, rather than failing obscurely', async () => {
    const response = await fetch(`${base}/auth/callback?error=access_denied`, { redirect: 'manual' });
    assert.equal(response.status, 401);
    assert.match(JSON.stringify(await response.json()), /access_denied/);
  });

  /**
   * An open redirect on a sign-in page is worth more to an attacker than
   * almost anywhere else: the link authenticates the victim first.
   */
  it('refuses to bounce the browser off this deployment after sign-in', async () => {
    for (const hostile of ['https://evil.example.com/', '//evil.example.com/', '/\\evil.example.com']) {
      const { location } = await signIn(hostile);
      assert.equal(location, '/', `returnTo "${hostile}" must not be honoured`);
    }
  });

  it('honours a relative returnTo', async () => {
    const { location } = await signIn('/approvals?status=pending');
    assert.equal(location, '/approvals?status=pending');
  });

  it('ends the session on sign-out', async () => {
    const { cookie } = await signIn();
    assert.equal((await fetch(`${base}/v1/assurance/summary`, { headers: { cookie } })).status, 200);

    const out = await fetch(`${base}/auth/logout`, { method: 'POST', headers: { cookie } });
    assert.equal(out.status, 200);

    assert.equal(
      (await fetch(`${base}/v1/assurance/summary`, { headers: { cookie } })).status,
      401,
      'the cookie is dead the moment the session is',
    );
  });

  it('ends every session for a person who has left', async () => {
    const laptop = await signIn();
    const phone = await signIn();

    const revoked = await fetch(`${base}/v1/operator-sessions/revoke`, {
      method: 'POST',
      headers: { cookie: laptop.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ subject: 'provider-subject-cfo', reason: 'left the company' }),
    });
    assert.equal(revoked.status, 200, await revoked.text());

    for (const cookie of [laptop.cookie, phone.cookie]) {
      assert.equal((await fetch(`${base}/v1/assurance/summary`, { headers: { cookie } })).status, 401);
    }
  });

  it('records the sign-in in the audit chain, since it is how someone became able to approve', async () => {
    await signIn();
    const records = await api.gateway.audit.read({ limit: 200 });

    const signIn_ = records.filter((record) => record.type === 'operator.signed_in').at(-1);
    assert.ok(signIn_, 'the sign-in is in the chain');
    assert.equal(signIn_.actor, 'cfo@example.com');
    assert.match(signIn_.summary, /signed in with roles finance-manager/);
  });

  it('states how this deployment authenticates operators, without requiring a session', async () => {
    const body = (await (await fetch(`${base}/auth/mode`)).json()) as {
      modes: readonly string[];
      strongest: string;
      signInUrl: string;
    };

    assert.deepEqual(body.modes, ['authenticated'], 'the shared token is not among them');
    assert.equal(body.strongest, 'authenticated');
    assert.equal(body.signInUrl, '/auth/login');
  });
});
