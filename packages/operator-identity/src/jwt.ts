import { webcrypto } from 'node:crypto';
import type { webcrypto as WebCrypto } from 'node:crypto';
import { ArcError } from '@arc-control/schemas';

/**
 * Just enough JWT to verify an OpenID Connect ID token, on Node builtins.
 *
 * Written out rather than taken from a library because this is the code that
 * decides whether a person is who the token says, in a control plane whose
 * supply chain is part of its threat model. A reviewer can read all of it.
 *
 * The verification is deliberately narrow. Every check below exists because
 * omitting it is a known, exploited way to accept a token you should not:
 *
 *   - **The algorithm comes from our allowlist, not the token.** A token that
 *     names its own algorithm can name `none`, or name `HS256` and invite us
 *     to verify an RSA public key as an HMAC secret — a public value the
 *     attacker also has. We pick the family from the key and refuse anything
 *     outside the allowlist.
 *   - **Symmetric algorithms are refused outright.** There is no shared secret
 *     in this flow, so an `HS*` token is either a confusion attack or a
 *     misconfiguration, and neither should authenticate anyone.
 *   - **Issuer and audience are compared exactly.** A token minted for another
 *     relying party by the same provider is a valid token and the wrong one.
 *   - **Expiry and issued-at are checked with a bounded skew**, so a stale
 *     token is refused and a slightly fast clock does not lock anyone out.
 */

/** Signature algorithms ARC will verify. Asymmetric only, and named by us. */
const ALGORITHMS: Readonly<Record<string, { readonly importParams: object; readonly verifyParams: object }>> = {
  RS256: {
    importParams: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    verifyParams: { name: 'RSASSA-PKCS1-v1_5' },
  },
  RS384: {
    importParams: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-384' },
    verifyParams: { name: 'RSASSA-PKCS1-v1_5' },
  },
  RS512: {
    importParams: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-512' },
    verifyParams: { name: 'RSASSA-PKCS1-v1_5' },
  },
  PS256: {
    importParams: { name: 'RSA-PSS', hash: 'SHA-256' },
    verifyParams: { name: 'RSA-PSS', saltLength: 32 },
  },
  ES256: {
    importParams: { name: 'ECDSA', namedCurve: 'P-256' },
    verifyParams: { name: 'ECDSA', hash: 'SHA-256' },
  },
  ES384: {
    importParams: { name: 'ECDSA', namedCurve: 'P-384' },
    verifyParams: { name: 'ECDSA', hash: 'SHA-384' },
  },
};

export type JsonWebKey = Readonly<Record<string, unknown>>;

export interface JwtHeader {
  readonly alg: string;
  readonly kid?: string;
  readonly typ?: string;
}

/** The claims ARC reads. A provider may send many more; unknown claims are kept. */
export interface IdTokenClaims extends Readonly<Record<string, unknown>> {
  readonly iss: string;
  readonly sub: string;
  readonly aud: string | readonly string[];
  readonly exp: number;
  readonly iat: number;
  readonly nonce?: string;
  readonly email?: string;
  readonly email_verified?: boolean;
  readonly name?: string;
}

export function decodeBase64Url(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}

export function encodeBase64Url(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url');
}

function parseSegment<T>(segment: string, what: string): T {
  let text: string;
  try {
    text = decodeBase64Url(segment).toString('utf8');
  } catch {
    throw new ArcError('unauthenticated', `the ID token's ${what} is not valid base64url`);
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ArcError('unauthenticated', `the ID token's ${what} is not valid JSON`);
  }
}

export interface VerifyOptions {
  /** The exact issuer ARC expects. Compared literally. */
  readonly issuer: string;
  /** This deployment's client id, which must be the token's audience. */
  readonly audience: string;
  /** The nonce ARC sent with the authorization request, if one was sent. */
  readonly nonce?: string;
  /** Tolerated clock difference in seconds. */
  readonly clockSkewSeconds?: number;
  readonly now?: number;
}

/**
 * Verifies an ID token's signature and claims against a set of provider keys.
 *
 * Returns the claims only if every check passes. Throws `unauthenticated`
 * otherwise, with a message naming the check that failed — detailed because
 * the alternative is an operator who cannot tell a misconfigured issuer from a
 * clock problem, and vague auth errors cost hours.
 */
export async function verifyIdToken(
  token: string,
  keys: readonly JsonWebKey[],
  options: VerifyOptions,
): Promise<IdTokenClaims> {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new ArcError('unauthenticated', 'the ID token is not a three-part JWS');
  }

  const [headerSegment, payloadSegment, signatureSegment] = parts as [string, string, string];
  const header = parseSegment<JwtHeader>(headerSegment, 'header');

  const algorithm = ALGORITHMS[header.alg];
  if (!algorithm) {
    throw new ArcError(
      'unauthenticated',
      `the ID token is signed with "${header.alg}", which ARC does not accept; ` +
        `accepted algorithms are ${Object.keys(ALGORITHMS).join(', ')}`,
      { details: { alg: header.alg } },
    );
  }

  // A `kid` narrows to one key. Without one, every key of the right type is
  // tried, which is correct rather than lax: the signature still has to verify.
  const candidates = header.kid === undefined ? keys : keys.filter((key) => key.kid === header.kid);
  if (candidates.length === 0) {
    throw new ArcError('unauthenticated', `the provider published no key matching kid "${String(header.kid)}"`, {
      details: { kid: header.kid },
    });
  }

  const signed = Buffer.from(`${headerSegment}.${payloadSegment}`, 'ascii');
  const signature = decodeBase64Url(signatureSegment);

  let verified = false;
  for (const key of candidates) {
    if (await verifyWith(key, algorithm, signature, signed)) {
      verified = true;
      break;
    }
  }

  if (!verified) {
    throw new ArcError('unauthenticated', "the ID token's signature does not verify against the provider's keys");
  }

  const claims = parseSegment<IdTokenClaims>(payloadSegment, 'payload');
  assertClaims(claims, options);
  return claims;
}

async function verifyWith(
  key: JsonWebKey,
  algorithm: { readonly importParams: object; readonly verifyParams: object },
  signature: Buffer,
  signed: Buffer,
): Promise<boolean> {
  // A key whose `use` or `key_ops` excludes verification is skipped rather
  // than coerced: the provider published the restriction for a reason.
  if (key.use !== undefined && key.use !== 'sig') return false;
  if (Array.isArray(key.key_ops) && !key.key_ops.includes('verify')) return false;

  try {
    const imported = await webcrypto.subtle.importKey(
      'jwk',
      key as WebCrypto.JsonWebKey,
      algorithm.importParams as WebCrypto.AlgorithmIdentifier,
      false,
      ['verify'],
    );
    return await webcrypto.subtle.verify(
      algorithm.verifyParams as WebCrypto.AlgorithmIdentifier,
      imported,
      signature,
      signed,
    );
  } catch {
    // A key of the wrong type for this algorithm fails to import. That is a
    // non-match, not an error worth propagating — another key may verify.
    return false;
  }
}

function assertClaims(claims: IdTokenClaims, options: VerifyOptions): void {
  const skew = options.clockSkewSeconds ?? 60;
  const now = Math.floor((options.now ?? Date.now()) / 1000);

  if (claims.iss !== options.issuer) {
    throw new ArcError(
      'unauthenticated',
      `the ID token was issued by "${String(claims.iss)}" but this deployment trusts "${options.issuer}"`,
      { details: { issuer: claims.iss } },
    );
  }

  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(options.audience)) {
    throw new ArcError('unauthenticated', 'the ID token was issued for a different client than this deployment', {
      details: { audience: claims.aud },
    });
  }

  if (typeof claims.sub !== 'string' || claims.sub.length === 0) {
    throw new ArcError('unauthenticated', 'the ID token carries no subject, so it identifies nobody');
  }

  if (typeof claims.exp !== 'number' || claims.exp + skew < now) {
    throw new ArcError('unauthenticated', 'the ID token has expired');
  }

  if (typeof claims.iat === 'number' && claims.iat - skew > now) {
    throw new ArcError('unauthenticated', 'the ID token was issued in the future, which means a clock is wrong');
  }

  // The nonce binds this token to the authorization request ARC started. A
  // token that arrives without the nonce we sent is a replay or a token minted
  // for some other flow.
  if (options.nonce !== undefined && claims.nonce !== options.nonce) {
    throw new ArcError('unauthenticated', 'the ID token does not carry the nonce ARC sent, so it may be a replay');
  }
}
