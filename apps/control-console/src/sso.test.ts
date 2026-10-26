import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { createControlApi, type ControlApi } from '@arc-control/control-api';
import { SimulationConnector } from '@arc-control/connector-simulation';
import { MemoryStore } from '@arc-control/store';
import { createConsole, type ConsoleApp } from './server.js';

/**
 * The console, against an API with single sign-on configured.
 *
 * This is the test that was missing. 2.1 added real operator authentication to
 * the API and left the console unable to use it: the SDK required the shared
 * token, and a deployment with single sign-on refuses that token — so every
 * console page returned 401. Forcing the token back on was worse than broken,
 * because the console would then record votes as `claimed` while its own
 * Settings page reported the deployment as authenticated.
 *
 * So the assertions here are not "a page renders". They are: the console works
 * at all under the mode this release exists to provide, it shows the identity
 * the API resolved rather than one from its own configuration, and a vote cast
 * through it is attributable.
 */

const CLIENT_ID = 'arc-control-console';
const SESSION_SECRET = 'c'.repeat(64);
const LEGACY_TOKEN = 'legacy-shared-token';

/** A stub provider that mints real, verifiable ID tokens. */
function identityProvider(): { server: Server; listen: () => Promise<void>; issuer: () => string } {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = {
    ...(publicKey.export({ format: 'jwk' }) as Record<string, unknown>),
    kid: 'stub',
    alg: 'RS256',
    use: 'sig',
  };
  let issuer = '';

  const base64url = (value: Buffer | string): string => Buffer.from(value).toString('base64url');

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
        const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
        const now = Math.floor(Date.now() / 1000);
        const header = { alg: 'RS256', kid: 'stub', typ: 'JWT' };
        const payload = {
          iss: issuer,
          sub: 'provider-subject-cfo',
          aud: CLIENT_ID,
          exp: now + 300,
          iat: now,
          nonce: nonces.get(form.get('code') ?? '') ?? '',
          email: 'cfo@example.com',
          email_verified: true,
          groups: ['arc-finance'],
        };

        const signing = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
        const signature = createSign('RSA-SHA256').update(signing, 'ascii').sign(privateKey);
        json({ id_token: `${signing}.${base64url(signature)}`, token_type: 'Bearer' });
      });
      return;
    }

    response.writeHead(404);
    response.end();
  });

  return {
    server,
    issuer: () => issuer,
    listen: () =>
      new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          const address = server.address();
          issuer = `http://127.0.0.1:${String(typeof address === 'object' && address ? address.port : 0)}`;
          resolve();
        });
      }),
  };
}

/** Authorization code to the nonce it was issued against. */
const nonces = new Map<string, string>();

describe('the console under single sign-on', () => {
  let provider: ReturnType<typeof identityProvider>;
  let api: ApiUnderTest;
  let app: ConsoleApp;
  let store: MemoryStore;
  let apiBase: string;
  let consoleBase: string;

  type ApiUnderTest = ControlApi;

  before(async () => {
    provider = identityProvider();
    await provider.listen();

    store = new MemoryStore();
    api = createControlApi({
      store,
      // Present deliberately: with single sign-on configured it must stop
      // working, and the test below proves it does.
      operatorToken: LEGACY_TOKEN,
      sessionSecret: SESSION_SECRET,
      secureCookies: false,
      schedule: false,
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
    await api.gateway.admin.publishPolicy(
      {
        id: 'HOLD-SSO',
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
    await api.assurance.seedBaseline();

    const address = await api.listen(0);
    apiBase = `http://${address.host}:${address.port}`;

    // No operator token: the console must work on the session alone.
    app = createConsole({ apiBase });
    const consoleAddress = await app.listen(0);
    consoleBase = `http://${consoleAddress.host}:${consoleAddress.port}`;
  });

  after(async () => {
    const close = async (fn: () => Promise<unknown> | unknown): Promise<void> => {
      try {
        await fn();
      } catch {
        /* a half-built fixture must still release its handles */
      }
    };
    await close(() => app?.close());
    await close(() => api?.close());
    await close(() => store?.close());
    await close(async () => {
      if (provider?.server.listening) await new Promise<void>((r) => provider.server.close(() => r()));
    });
  });

  /** Signs in against the API and returns the session cookie. */
  async function signIn(): Promise<string> {
    const login = await fetch(`${apiBase}/auth/login`, { redirect: 'manual' });
    const authorize = new URL(login.headers.get('location') ?? '');
    const loginCookie = (login.headers.getSetCookie?.() ?? [])[0]?.split(';')[0] ?? '';

    const state = authorize.searchParams.get('state') ?? '';
    const code = `code-${state}`;
    nonces.set(code, authorize.searchParams.get('nonce') ?? '');

    const callback = await fetch(`${apiBase}/auth/callback?code=${code}&state=${encodeURIComponent(state)}`, {
      redirect: 'manual',
      headers: { cookie: loginCookie },
    });

    const cookie = (callback.headers.getSetCookie?.() ?? []).find((value) =>
      value.startsWith('arc_operator_session='),
    );
    assert.ok(cookie, 'the callback must set a session cookie');
    return cookie.split(';')[0]!;
  }

  /**
   * The headline. Before this fix every one of these returned 401, because the
   * console could only present a token the API had stopped accepting.
   */
  it('renders every section on a session alone, with no shared token', async () => {
    const cookie = await signIn();

    for (const path of ['/', '/approvals', '/assurance', '/findings', '/notifications', '/settings']) {
      const response = await fetch(`${consoleBase}${path}`, { headers: { cookie } });
      assert.equal(response.status, 200, `${path} returned ${String(response.status)}`);
      assert.match(await response.text(), /<\/html>/, `${path} rendered a partial document`);
    }
  });

  /**
   * The console used to display the identity it was configured with. With a
   * session there is no such configuration, and displaying a guess on the page
   * where an operator checks their own attribution is the specific dishonesty
   * this release exists to remove.
   */
  it('shows the identity the API resolved, not one of its own', async () => {
    const cookie = await signIn();
    const page = await (await fetch(`${consoleBase}/settings`, { headers: { cookie } })).text();

    assert.match(page, /cfo@example\.com/, 'the verified identity is shown');
    assert.match(page, /finance-manager/, 'with the roles the provider granted');
    assert.ok(!page.includes('(configured header)'), 'and not described as a configured header');
  });

  it('states that this deployment authenticates operators', async () => {
    const cookie = await signIn();
    const page = await (await fetch(`${consoleBase}/settings`, { headers: { cookie } })).text();

    assert.match(page, /verified by this deployment/);
    assert.match(page, /attributable to you individually/);
    assert.ok(!page.includes('not who ran it'), 'the shared-token caveat must not appear');
  });

  /** Nobody signed in: send them to sign in, rather than a page of errors. */
  it('redirects an unauthenticated visitor to the sign-in flow', async () => {
    const response = await fetch(`${consoleBase}/approvals?status=pending`, { redirect: 'manual' });

    assert.equal(response.status, 302);
    const location = response.headers.get('location') ?? '';
    assert.ok(location.startsWith(`${apiBase}/auth/login`), `unexpected redirect to ${location}`);
    assert.match(location, /returnTo=%2Fapprovals%3Fstatus%3Dpending/, 'and comes back to where they were going');
  });

  it('refuses a forged session rather than rendering anything', async () => {
    const response = await fetch(`${consoleBase}/`, {
      headers: { cookie: 'arc_operator_session=arc_ses_0000.not-a-signature' },
      redirect: 'manual',
    });
    assert.equal(response.status, 302, 'a bad cookie is treated as not signed in');
  });

  /**
   * The point of all of it: a vote cast through the console is attributable to
   * the person who signed in.
   */
  it('records a vote cast through the console as authenticated', async () => {
    const cookie = await signIn();

    const agent = await api.gateway.agents.register({ name: 'support-agent', owner: 'lead@example.com' });
    const { apiKey } = await api.gateway.agents.issueKey(agent.id);
    const held = await api.gateway.handle(apiKey, { tool: 'stripe.refund', parameters: { amount: 100 } });
    assert.equal(held.outcome, 'pending_approval');

    const vote = await fetch(`${consoleBase}/approvals/${String(held.approvalId)}/vote`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ vote: 'approve', comment: 'reviewed' }).toString(),
      redirect: 'manual',
    });
    assert.equal(vote.status, 303, await vote.text());

    const request = await api.gateway.approvals.require(String(held.approvalId));
    const cast = request.votes.at(-1);
    assert.equal(cast?.approver, 'cfo@example.com');
    assert.equal(cast?.assurance, 'authenticated', 'a console vote must be attributable');
    assert.equal(cast?.issuer, provider.issuer());
  });

  /**
   * An unreachable API must not look like an expired session. If it did, an
   * outage would bounce every operator to a sign-in page that also cannot
   * load — a redirect loop in place of an error, during the incident when the
   * approval queue matters most.
   */
  it('reports an unreachable API rather than redirecting to sign in', async () => {
    const cookie = await signIn();
    const stranded = createConsole({ apiBase: 'http://127.0.0.1:1' });
    const address = await stranded.listen(0);

    try {
      const response = await fetch(`http://${address.host}:${address.port}/`, {
        headers: { cookie },
        redirect: 'manual',
      });
      assert.notEqual(response.status, 302, 'an outage was reported as a missing session');
      assert.match(await response.text(), /<\/html>/, 'and it still renders a page an operator can read');
    } finally {
      await stranded.close();
    }
  });

  /**
   * The browser's address for the API is not the console's. Everywhere but a
   * single host — a ClusterIP Service, a Compose network — sending a visitor
   * to the address the console uses sends them nowhere.
   */
  it('sends the browser to the public API address, not its own', async () => {
    const split = createConsole({ apiBase, publicApiBase: 'https://arc.example.com' });
    const address = await split.listen(0);

    try {
      const response = await fetch(`http://${address.host}:${address.port}/`, { redirect: 'manual' });
      assert.equal(response.status, 302);
      assert.ok(
        (response.headers.get('location') ?? '').startsWith('https://arc.example.com/auth/login'),
        `redirected to ${String(response.headers.get('location'))}`,
      );
    } finally {
      await split.close();
    }
  });

  it('does not accept the shared token the API was also given', async () => {
    const response = await fetch(`${apiBase}/v1/assurance/summary`, {
      headers: { authorization: `Bearer ${LEGACY_TOKEN}`, 'x-arc-operator': 'anyone@example.com' },
    });
    assert.equal(response.status, 401, 'the token is a fallback, never a bypass');
  });
});
