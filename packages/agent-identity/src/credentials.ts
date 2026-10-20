import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { newId, type AgentCredential } from '@arc-control/schemas';

/**
 * Agent API keys.
 *
 * A key is `arck_<credentialRef>_<secret>`: a public reference that locates
 * the credential record in one lookup, and 256 bits of secret that are never
 * stored. Because the secret is high-entropy and machine-generated, a salted
 * SHA-256 is the right verifier — a slow KDF defends against guessing
 * low-entropy human passwords, which these are not, and would add latency to
 * the hot path of every single agent action.
 */
export const KEY_PREFIX = 'arck';

const REF_BYTES = 8;
const SECRET_BYTES = 32;
const SALT_BYTES = 16;

export interface IssuedCredential {
  readonly credential: AgentCredential;
  /** Returned exactly once, at issue time. ARC Control cannot recover it afterwards. */
  readonly apiKey: string;
}

export function issueCredential(agentId: string, options: { expiresAt?: string } = {}): IssuedCredential {
  const reference = randomBytes(REF_BYTES).toString('hex');
  const secret = randomBytes(SECRET_BYTES).toString('hex');
  const salt = randomBytes(SALT_BYTES).toString('hex');

  const credential: AgentCredential = {
    id: newId('credential'),
    agentId,
    displayPrefix: `${KEY_PREFIX}_${reference}`,
    algorithm: 'sha256',
    salt,
    secretHash: hashSecret(secret, salt),
    createdAt: new Date().toISOString(),
    ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
  };

  return { credential, apiKey: `${KEY_PREFIX}_${reference}_${secret}` };
}

export function hashSecret(secret: string, salt: string): string {
  return createHash('sha256').update(`${salt}:${secret}`, 'utf8').digest('hex');
}

export interface ParsedKey {
  readonly reference: string;
  readonly secret: string;
  /** The `displayPrefix` of the credential this key claims to be. */
  readonly displayPrefix: string;
}

/** Parses a presented key. Returns undefined for anything malformed. */
export function parseApiKey(apiKey: string): ParsedKey | undefined {
  const parts = apiKey.split('_');
  if (parts.length !== 3) return undefined;

  const [prefix, reference, secret] = parts as [string, string, string];
  if (prefix !== KEY_PREFIX) return undefined;
  if (!isHex(reference, REF_BYTES * 2)) return undefined;
  if (!isHex(secret, SECRET_BYTES * 2)) return undefined;

  return { reference, secret, displayPrefix: `${KEY_PREFIX}_${reference}` };
}

/** Constant-time comparison of a presented secret against a stored hash. */
export function verifySecret(secret: string, credential: AgentCredential): boolean {
  const expected = Buffer.from(credential.secretHash, 'hex');
  const actual = Buffer.from(hashSecret(secret, credential.salt), 'hex');
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

function isHex(value: string, length: number): boolean {
  return value.length === length && /^[0-9a-f]+$/.test(value);
}
