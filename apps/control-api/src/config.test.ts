import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ArcError } from '@arc-control/schemas';
import { loadConfig } from './config.js';

/**
 * A control plane that starts in an unsafe configuration is worse than one
 * that will not start: the first failure is silent and arrives later, in
 * production, as an incident rather than a startup error.
 *
 * Each refusal below describes a configuration somebody would plausibly reach
 * for. Each test also checks the message names the variable that resolves it,
 * because a refusal an operator cannot act on is just an outage.
 */

const LOOPBACK = { ARC_HOST: '127.0.0.1' };
const SECRET = 's'.repeat(64);

function refusal(env: Record<string, string | undefined>): ArcError {
  try {
    loadConfig(env);
  } catch (cause) {
    return cause as ArcError;
  }
  throw new Error('expected this configuration to be refused');
}

describe('configurations that are refused', () => {
  it('allows a shared token on loopback, where it is a fair way to try the product', () => {
    const config = loadConfig({ ...LOOPBACK, ARC_OPERATOR_TOKEN: 'token' });
    assert.equal(config.options.operatorToken, 'token');
  });

  it('allows it when exposed and explicitly accepted', () => {
    const config = loadConfig({
      ARC_HOST: '0.0.0.0',
      ARC_OPERATOR_TOKEN: 'token',
      ARC_ALLOW_SHARED_TOKEN: 'true',
    });
    assert.equal(config.options.allowSharedToken, true);
  });

  /**
   * Still a refusal, because here the signal is unambiguous: this sends
   * session cookies in clear text whatever the network turns out to look
   * like, and nobody disables it deliberately outside local development.
   */
  it('refuses insecure cookies on a non-loopback interface', () => {
    const error = refusal({
      ARC_HOST: '0.0.0.0',
      ARC_OPERATOR_TOKEN: 't',
      ARC_ALLOW_SHARED_TOKEN: 'true',
      ARC_SECURE_COOKIES: 'false',
    });
    assert.match(error.message, /plain HTTP/);
    assert.match(error.message, /local development only/);
  });

  /**
   * Caught at startup rather than at the callback, which is the worst moment
   * to discover it: the operator has already left for the identity provider.
   */
  it('refuses single sign-on with no session secret', () => {
    const error = refusal({
      ...LOOPBACK,
      ARC_OIDC_ISSUER: 'https://login.example.com',
      ARC_OIDC_CLIENT_ID: 'arc',
      ARC_OIDC_REDIRECT_URI: 'https://arc.example.com/auth/callback',
    });

    assert.match(error.message, /ARC_SESSION_SECRET/);
    assert.match(error.message, /openssl rand -hex 32/, 'and tells them how to make one');
  });

  it('refuses a session secret too short to be worth signing with', () => {
    const error = refusal({ ...LOOPBACK, ARC_SESSION_SECRET: 'short' });
    assert.match(error.message, /at least 32 characters/);
  });

  it('refuses single sign-on missing its client id or redirect', () => {
    for (const missing of ['ARC_OIDC_CLIENT_ID', 'ARC_OIDC_REDIRECT_URI']) {
      const env: Record<string, string | undefined> = {
        ...LOOPBACK,
        ARC_OIDC_ISSUER: 'https://login.example.com',
        ARC_OIDC_CLIENT_ID: 'arc',
        ARC_OIDC_REDIRECT_URI: 'https://arc.example.com/auth/callback',
        ARC_SESSION_SECRET: SECRET,
      };
      env[missing] = undefined;

      assert.match(refusal(env).message, new RegExp(missing), `${missing} must be named`);
    }
  });

  it('allows insecure cookies on loopback, which is what they are for', () => {
    const config = loadConfig({ ...LOOPBACK, ARC_SECURE_COOKIES: 'false' });
    assert.equal(config.options.secureCookies, false);
  });

  it('refuses a port that is not a port', () => {
    for (const value of ['not-a-number', '-1', '70000', '8787.5']) {
      assert.match(refusal({ ...LOOPBACK, ARC_PORT: value }).message, /is not a port number/, value);
    }
  });

  it('lists every problem at once rather than one per restart', () => {
    const error = refusal({
      ARC_HOST: '0.0.0.0',
      ARC_PORT: 'nonsense',
      ARC_SESSION_SECRET: 'short',
      ARC_SECURE_COOKIES: 'false',
    });

    const listed = (error.details.refusals as readonly string[]).length;
    assert.ok(listed >= 3, `only ${String(listed)} problem(s) reported; fixing them one restart at a time is cruel`);
  });
});

/**
 * Warnings are legal configurations worth knowing about. They are separate
 * from refusals on purpose: a deployment that refuses to start over a warning
 * teaches operators to ignore the mechanism.
 */
describe('configurations that are allowed with a warning', () => {
  function warnings(env: Record<string, string | undefined>): readonly string[] {
    return loadConfig({ ...LOOPBACK, ...env }).warnings;
  }

  it('warns that an in-memory store loses everything', () => {
    assert.ok(warnings({}).some((line) => /loses every policy/.test(line)));
  });

  it('does not warn about memory when the demo is loaded, which is memory by design', () => {
    const lines = warnings({ ARC_SEED_DEMO: 'true' });
    assert.ok(!lines.some((line) => /loses every policy/.test(line)));
    assert.ok(lines.some((line) => /do not point a real agent at it/i.test(line)));
  });

  it('warns when no operator authentication is configured at all', () => {
    assert.ok(
      warnings({}).some((line) => /refuse every request/.test(line)),
      'agents can still be governed; nobody can administer it',
    );
  });

  /**
   * The quiet failure this catches: single sign-on works, everyone signs in,
   * and nobody can approve anything because no roles were mapped.
   */
  it('warns when single sign-on is configured but no roles are mapped', () => {
    const lines = warnings({
      ARC_OIDC_ISSUER: 'https://login.example.com',
      ARC_OIDC_CLIENT_ID: 'arc',
      ARC_OIDC_REDIRECT_URI: 'https://arc.example.com/auth/callback',
      ARC_SESSION_SECRET: SECRET,
    });

    assert.ok(lines.some((line) => /approve nothing/.test(line)));
    assert.ok(lines.some((line) => /ARC_OIDC_ROLE_MAP/.test(line)));
  });

  it('stops warning once roles are mapped', () => {
    const lines = warnings({
      ARC_OIDC_ISSUER: 'https://login.example.com',
      ARC_OIDC_CLIENT_ID: 'arc',
      ARC_OIDC_REDIRECT_URI: 'https://arc.example.com/auth/callback',
      ARC_SESSION_SECRET: SECRET,
      ARC_OIDC_ROLE_MAP: 'arc-finance=finance-manager',
    });
    assert.ok(!lines.some((line) => /approve nothing/.test(line)));
  });

  /**
   * This was a refusal and it was wrong: a container must bind `0.0.0.0` or
   * nothing outside it can connect, so every containerized deployment tripped
   * it — including this repository's own image, whose smoke test built a
   * working container, ran every test inside it, and then failed because the
   * process would not start.
   *
   * Refusing on a signal that cannot tell `docker run` from an open port
   * teaches people to set the override reflexively, after which the override
   * means nothing.
   */
  it('warns rather than refuses when a token is the only credential on a non-loopback bind', () => {
    const lines = loadConfig({ ARC_HOST: '0.0.0.0', ARC_OPERATOR_TOKEN: 'token' }).warnings;

    assert.ok(lines.some((line) => /cannot be attributed to a person|attributed to a person/.test(line)));
    assert.ok(lines.some((line) => /ARC_OIDC_ISSUER/.test(line)), 'and names the fix');
  });

  it('warns when the scheduler is switched off', () => {
    assert.ok(warnings({ ARC_SCHEDULE: 'false' }).some((line) => /nothing will run unattended/.test(line)));
  });
});

describe('parsing', () => {
  it('reads a group-to-role mapping', () => {
    const config = loadConfig({
      ...LOOPBACK,
      ARC_OIDC_ISSUER: 'https://login.example.com',
      ARC_OIDC_CLIENT_ID: 'arc',
      ARC_OIDC_REDIRECT_URI: 'https://arc.example.com/auth/callback',
      ARC_SESSION_SECRET: SECRET,
      ARC_OIDC_ROLE_CLAIM: 'groups',
      ARC_OIDC_ROLE_MAP: 'arc-finance=finance-manager|approver,arc-admin=admin',
    });

    assert.deepEqual(config.options.roles?.roleMap, {
      'arc-finance': ['finance-manager', 'approver'],
      'arc-admin': ['admin'],
    });
  });

  /** The ten-person case: no groups in the provider, four people named. */
  it('reads a directory of named people', () => {
    const config = loadConfig({ ...LOOPBACK, ARC_OPERATOR_DIRECTORY: 'cfo@example.com=finance-manager' });
    assert.deepEqual(config.options.roles?.directory, { 'cfo@example.com': ['finance-manager'] });
  });

  it('ignores a malformed mapping entry rather than failing to start over it', () => {
    const config = loadConfig({ ...LOOPBACK, ARC_OIDC_ROLE_MAP: 'no-equals-sign,good=role' });
    assert.deepEqual(config.options.roles?.roleMap, { good: ['role'] });
  });

  it('defaults the trusted proxy identity header to a conventional one', () => {
    const config = loadConfig({ ...LOOPBACK, ARC_TRUSTED_PROXY_SECRET: 'proxy-secret' });
    assert.equal(config.options.trustedProxy?.identityHeader, 'x-forwarded-email');
  });
});
