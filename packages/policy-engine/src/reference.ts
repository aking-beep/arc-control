/**
 * Operand resolution.
 *
 * An operand is either a literal or a reference: a string beginning with `$.`
 * that names a path into the policy input, such as
 * `$.action.parameters.amount`. The path language is intentionally tiny — dot
 * segments and numeric array indices, no wildcards, no filters, no functions.
 * A policy author can read it, and an auditor can confirm what it points at.
 */

export const REFERENCE_PREFIX = '$.';

export function isReference(operand: unknown): operand is string {
  return typeof operand === 'string' && operand.startsWith(REFERENCE_PREFIX);
}

/** Marks a reference that resolved to nothing, distinct from one that resolved to `undefined`. */
export const MISSING = Symbol('arc.missing');

export type Resolved = unknown | typeof MISSING;

/**
 * Resolves an operand against the input. Literals pass through unchanged;
 * references are looked up and yield MISSING when any segment is absent.
 */
export function resolveOperand(operand: unknown, input: unknown): Resolved {
  if (!isReference(operand)) return operand;
  return resolvePath(operand.slice(REFERENCE_PREFIX.length), input);
}

export function resolvePath(path: string, input: unknown): Resolved {
  if (path === '') return input;

  let current: unknown = input;
  for (const segment of path.split('.')) {
    if (segment === '') return MISSING;
    if (current === null || current === undefined) return MISSING;

    if (Array.isArray(current)) {
      if (segment === 'length') {
        current = current.length;
        continue;
      }
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return MISSING;
      current = current[index];
      continue;
    }

    if (typeof current !== 'object') return MISSING;

    // Own properties only: a reference must never reach `constructor`,
    // `__proto__` or anything else inherited from Object.prototype.
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return MISSING;
    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}
