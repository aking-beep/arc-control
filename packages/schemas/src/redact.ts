import type { ParameterSpec } from './tool.js';

export const REDACTED = '[redacted]';

/**
 * Parameter names that are redacted wherever they appear, regardless of what
 * the tool definition says. A tool author who forgets to mark a field
 * `sensitive` should not be able to write credentials into the audit log.
 */
const ALWAYS_SENSITIVE = [
  'password', 'passwd', 'secret', 'token', 'api_key', 'apikey', 'access_key',
  'secret_key', 'private_key', 'authorization', 'auth', 'credential',
  'credentials', 'session_token', 'refresh_token', 'client_secret', 'ssn',
  'card_number', 'cvv', 'pin',
];

function isSensitiveName(name: string): boolean {
  const normalized = name.toLowerCase().replace(/[-\s]/g, '_');
  return ALWAYS_SENSITIVE.some((candidate) => normalized === candidate || normalized.endsWith(`_${candidate}`));
}

/**
 * Produces a copy of a parameter map safe to store in evidence, audit records
 * and the console. Sensitive values are replaced, never hashed into something
 * guessable and never merely truncated.
 */
export function redactParameters(
  parameters: Readonly<Record<string, unknown>>,
  specs: readonly ParameterSpec[] = [],
): Record<string, unknown> {
  const sensitive = new Set(specs.filter((spec) => spec.sensitive).map((spec) => spec.name));
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(parameters)) {
    out[key] = sensitive.has(key) || isSensitiveName(key) ? REDACTED : redactDeep(value, 0);
  }
  return out;
}

/** Recursively redacts sensitively-named keys inside nested structures. */
export function redactDeep(value: unknown, depth = 0): unknown {
  if (depth > 12) return '[truncated]';
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, depth + 1));
  if (value === null || typeof value !== 'object') return value;

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSensitiveName(key) ? REDACTED : redactDeep(child, depth + 1);
  }
  return out;
}
