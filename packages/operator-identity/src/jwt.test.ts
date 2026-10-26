import assert from 'node:assert/strict';
import { createHmac, createPublicKey, createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { describe, it } from 'node:test';
import type { ArcError } from '@arc-control/schemas';
import { encodeBase64Url, verifyIdToken, type JsonWebKey } from './jwt.js';

/**
 * These are the tests that decide whether a stranger can be anybody.
 *
 * Signed with real keys rather than fixtures, because a fixture only proves
 * the parser accepts bytes somebody once produced. Each refusal below has a
 * name in the literature and a history of being shipped by accident.
 */

const ISSUER = 'https://login.example.com';
const AUDIENCE = 'arc-control-console';
const NOW = Date.parse('2026-06-15T12:00:00.000Z');

function rsaKeys(kid = 'rsa-1'): { readonly privateKey: KeyObject; readonly jwk: JsonWebKey } {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...(publicKey.export({ format: 'jwk' }) as Record<string, unknown>), kid, alg: 'RS256', use: 'sig' };
  return { privateKey, jwk };
}

function ecKeys(kid = 'ec-1'): { readonly privateKey: KeyObject; readonly jwk: JsonWebKey } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = { ...(publicKey.export({ format: 'jwk' }) as Record<string, unknown>), kid, alg: 'ES256', use: 'sig' };
  return { privateKey, jwk };
}

function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: ISSUER,
    sub: 'provider-subject-1',
    aud: AUDIENCE,
    exp: Math.floor(NOW / 1000) + 300,
    iat: Math.floor(NOW / 1000) - 10,
    email: 'cfo@example.com',
    email_verified: true,
    ...overrides,
  };
}

/** Signs a token the way a provider would. */
function sign(
  privateKey: KeyObject,
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  algorithm = 'RSA-SHA256',
): string {
  const signingInput = `${encodeBase64Url(JSON.stringify(header))}.${encodeBase64Url(JSON.stringify(payload))}`;
  const signature = createSign(algorithm).update(signingInput, 'ascii').sign(
    algorithm === 'RSA-SHA256' ? privateKey : { key: privateKey, dsaEncoding: 'ieee-p1363' },
  );
  return `${signingInput}.${encodeBase64Url(signature)}`;
}

const options = { issuer: ISSUER, audience: AUDIENCE, now: NOW };

describe('verifyIdToken', () => {
  it('accepts a correctly signed RS256 token and returns its claims', async () => {
    const { privateKey, jwk } = rsaKeys();
    const token = sign(privateKey, { alg: 'RS256', kid: 'rsa-1', typ: 'JWT' }, claims());

    const verified = await verifyIdToken(token, [jwk], options);
    assert.equal(verified.sub, 'provider-subject-1');
    assert.equal(verified.email, 'cfo@example.com');
  });

  it('accepts ES256, since providers do issue elliptic-curve tokens', async () => {
    const { privateKey, jwk } = ecKeys();
    const token = sign(privateKey, { alg: 'ES256', kid: 'ec-1' }, claims(), 'SHA256');

    assert.equal((await verifyIdToken(token, [jwk], options)).sub, 'provider-subject-1');
  });

  /**
   * The oldest JWT vulnerability there is: a token that declares no signature
   * and asks to be taken at its word.
   */
  it('refuses alg "none"', async () => {
    const { jwk } = rsaKeys();
    const header = encodeBase64Url(JSON.stringify({ alg: 'none' }));
    const payload = encodeBase64Url(JSON.stringify(claims()));

    await assert.rejects(
      () => verifyIdToken(`${header}.${payload}.`, [jwk], options),
      (error: ArcError) => error.code === 'unauthenticated' && /does not accept/.test(error.message),
    );
  });

  /**
   * Algorithm confusion. The attacker re-signs the token as HMAC using the
   * provider's *public* key as the shared secret — a value they also have. A
   * verifier that takes the algorithm from the token verifies it happily.
   */
  it('refuses an HMAC token signed with the public key as the secret', async () => {
    const { jwk } = rsaKeys();
    const publicPem = createPublicKey({ key: jwk as never, format: 'jwk' })
      .export({ type: 'spki', format: 'pem' })
      .toString();

    const header = encodeBase64Url(JSON.stringify({ alg: 'HS256', kid: 'rsa-1' }));
    const payload = encodeBase64Url(JSON.stringify(claims()));
    const mac = createHmac('sha256', publicPem).update(`${header}.${payload}`, 'ascii').digest();
    const forged = `${header}.${payload}.${encodeBase64Url(mac)}`;

    await assert.rejects(
      () => verifyIdToken(forged, [jwk], options),
      (error: ArcError) => /does not accept/.test(error.message),
    );
  });

  it('refuses a token whose payload was edited after signing', async () => {
    const { privateKey, jwk } = rsaKeys();
    const token = sign(privateKey, { alg: 'RS256', kid: 'rsa-1' }, claims());

    const [header, , signature] = token.split('.') as [string, string, string];
    const swapped = encodeBase64Url(JSON.stringify(claims({ email: 'attacker@example.com' })));

    await assert.rejects(
      () => verifyIdToken(`${header}.${swapped}.${signature}`, [jwk], options),
      (error: ArcError) => /signature does not verify/.test(error.message),
    );
  });

  it('refuses a token signed by a key the provider does not publish', async () => {
    const attacker = rsaKeys('rsa-1');
    const provider = rsaKeys('rsa-1');
    const token = sign(attacker.privateKey, { alg: 'RS256', kid: 'rsa-1' }, claims());

    await assert.rejects(
      () => verifyIdToken(token, [provider.jwk], options),
      (error: ArcError) => /signature does not verify/.test(error.message),
    );
  });

  it('refuses a token naming a key id the provider never published', async () => {
    const { privateKey, jwk } = rsaKeys('rsa-1');
    const token = sign(privateKey, { alg: 'RS256', kid: 'rotated-away' }, claims());

    await assert.rejects(
      () => verifyIdToken(token, [jwk], options),
      (error: ArcError) => /no key matching kid/.test(error.message),
    );
  });

  /** A valid token for another relying party is still the wrong token. */
  it('refuses a token issued for a different client', async () => {
    const { privateKey, jwk } = rsaKeys();
    const token = sign(privateKey, { alg: 'RS256', kid: 'rsa-1' }, claims({ aud: 'someone-elses-app' }));

    await assert.rejects(
      () => verifyIdToken(token, [jwk], options),
      (error: ArcError) => /different client/.test(error.message),
    );
  });

  it('accepts an audience array that contains this client', async () => {
    const { privateKey, jwk } = rsaKeys();
    const token = sign(privateKey, { alg: 'RS256', kid: 'rsa-1' }, claims({ aud: ['other', AUDIENCE] }));

    assert.equal((await verifyIdToken(token, [jwk], options)).sub, 'provider-subject-1');
  });

  it('refuses a token from an issuer this deployment does not trust', async () => {
    const { privateKey, jwk } = rsaKeys();
    const token = sign(privateKey, { alg: 'RS256', kid: 'rsa-1' }, claims({ iss: 'https://evil.example.com' }));

    await assert.rejects(
      () => verifyIdToken(token, [jwk], options),
      (error: ArcError) => /this deployment trusts/.test(error.message),
    );
  });

  it('refuses an expired token, and allows a small clock skew', async () => {
    const { privateKey, jwk } = rsaKeys();
    const stale = sign(privateKey, { alg: 'RS256', kid: 'rsa-1' }, claims({ exp: Math.floor(NOW / 1000) - 600 }));
    await assert.rejects(() => verifyIdToken(stale, [jwk], options), (error: ArcError) => /expired/.test(error.message));

    const barely = sign(privateKey, { alg: 'RS256', kid: 'rsa-1' }, claims({ exp: Math.floor(NOW / 1000) - 30 }));
    assert.ok(await verifyIdToken(barely, [jwk], options), 'thirty seconds past expiry is within the default skew');
  });

  it('refuses a token issued in the future, which means a clock is wrong', async () => {
    const { privateKey, jwk } = rsaKeys();
    const token = sign(privateKey, { alg: 'RS256', kid: 'rsa-1' }, claims({ iat: Math.floor(NOW / 1000) + 600 }));

    await assert.rejects(
      () => verifyIdToken(token, [jwk], options),
      (error: ArcError) => /a clock is wrong/.test(error.message),
    );
  });

  it('refuses a token carrying no subject, since it identifies nobody', async () => {
    const { privateKey, jwk } = rsaKeys();
    const token = sign(privateKey, { alg: 'RS256', kid: 'rsa-1' }, claims({ sub: '' }));

    await assert.rejects(
      () => verifyIdToken(token, [jwk], options),
      (error: ArcError) => /identifies nobody/.test(error.message),
    );
  });

  /** The nonce binds the token to the sign-in ARC actually started. */
  it('refuses a token that does not carry the nonce ARC sent', async () => {
    const { privateKey, jwk } = rsaKeys();
    const token = sign(privateKey, { alg: 'RS256', kid: 'rsa-1' }, claims({ nonce: 'a-different-nonce' }));

    await assert.rejects(
      () => verifyIdToken(token, [jwk], { ...options, nonce: 'the-one-we-sent' }),
      (error: ArcError) => /may be a replay/.test(error.message),
    );
  });

  it('accepts the matching nonce', async () => {
    const { privateKey, jwk } = rsaKeys();
    const token = sign(privateKey, { alg: 'RS256', kid: 'rsa-1' }, claims({ nonce: 'the-one-we-sent' }));

    assert.ok(await verifyIdToken(token, [jwk], { ...options, nonce: 'the-one-we-sent' }));
  });

  /**
   * A provider that publishes an encryption key alongside its signing key has
   * said what each is for, and using the wrong one is our mistake to avoid.
   */
  it('skips a key the provider marked for encryption rather than signing', async () => {
    const { privateKey, jwk } = rsaKeys();
    const token = sign(privateKey, { alg: 'RS256', kid: 'rsa-1' }, claims());

    await assert.rejects(
      () => verifyIdToken(token, [{ ...jwk, use: 'enc' }], options),
      (error: ArcError) => /signature does not verify/.test(error.message),
    );
  });

  it('skips a key whose declared operations exclude verification', async () => {
    const { privateKey, jwk } = rsaKeys();
    const token = sign(privateKey, { alg: 'RS256', kid: 'rsa-1' }, claims());

    await assert.rejects(() => verifyIdToken(token, [{ ...jwk, use: undefined, key_ops: ['wrapKey'] }], options));
  });

  it('refuses something that is not a JWS at all', async () => {
    const { jwk } = rsaKeys();
    for (const malformed of ['', 'not-a-token', 'a.b', 'a.b.c.d']) {
      await assert.rejects(
        () => verifyIdToken(malformed, [jwk], options),
        (error: ArcError) => error.code === 'unauthenticated',
        `"${malformed}" must be refused`,
      );
    }
  });

  it('tries every published key when the token names no kid', async () => {
    const other = rsaKeys('other');
    const { privateKey, jwk } = rsaKeys('signing');
    const token = sign(privateKey, { alg: 'RS256' }, claims());

    assert.ok(await verifyIdToken(token, [other.jwk, jwk], options), 'the second key verifies it');
  });
});
