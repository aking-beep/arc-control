import { compilePattern, PatternError, type Condition } from '@arc-control/schemas';
import { MISSING, resolveOperand, type Resolved } from './reference.js';

/**
 * Condition evaluation.
 *
 * Every operator is total: it returns a boolean or throws a
 * `ConditionError`, and it never has a side effect. A reference that resolves
 * to nothing makes a comparison false rather than throwing, so a policy keeps
 * deciding when an optional parameter is absent — except for comparisons that
 * would otherwise be misleading, where the mismatch is reported instead.
 */
export class ConditionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConditionError';
  }
}

/** Upper bound on the input a regular expression operator will consider. */
const MAX_MATCH_LENGTH = 4096;

export function evaluateCondition(condition: Condition, input: unknown, depth = 0): boolean {
  if (depth > 16) throw new ConditionError('condition nests more than 16 levels deep');
  if (!condition || typeof condition !== 'object' || Array.isArray(condition)) {
    throw new ConditionError('expected a condition object');
  }

  const keys = Object.keys(condition);
  if (keys.length !== 1) {
    throw new ConditionError(`expected exactly one operator, found ${keys.length || 'none'}`);
  }

  const operator = keys[0]!;
  const operand = (condition as Record<string, unknown>)[operator];

  switch (operator) {
    case 'always':
      return operand === true;

    case 'and':
      return asConditions(operand, 'and').every((child) => evaluateCondition(child, input, depth + 1));

    case 'or':
      return asConditions(operand, 'or').some((child) => evaluateCondition(child, input, depth + 1));

    case 'not':
      return !evaluateCondition(operand as Condition, input, depth + 1);

    case 'exists': {
      if (typeof operand !== 'string') throw new ConditionError('exists expects a reference string');
      const value = resolveOperand(operand, input);
      return value !== MISSING && value !== null && value !== undefined;
    }

    default:
      return evaluateComparison(operator, operand, input);
  }
}

function evaluateComparison(operator: string, operand: unknown, input: unknown): boolean {
  if (!Array.isArray(operand) || operand.length !== 2) {
    throw new ConditionError(`${operator} expects an array of exactly two operands`);
  }

  const left = resolveOperand(operand[0], input);
  const right = operator === 'matches' ? operand[1] : resolveOperand(operand[1], input);

  switch (operator) {
    case 'eq':
      return equals(left, right);
    case 'ne':
      return !equals(left, right);

    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
      return compareOrdered(operator, left, right);

    case 'in':
      return asList(right, 'in').some((candidate) => equals(left, candidate));
    case 'nin':
      return !asList(right, 'nin').some((candidate) => equals(left, candidate));

    case 'contains':
      if (Array.isArray(left)) return left.some((item) => equals(item, right));
      return asText(left) !== undefined && asText(right) !== undefined && asText(left)!.includes(asText(right)!);

    case 'startsWith':
      return asText(left) !== undefined && asText(right) !== undefined && asText(left)!.startsWith(asText(right)!);

    case 'endsWith':
      return asText(left) !== undefined && asText(right) !== undefined && asText(left)!.endsWith(asText(right)!);

    case 'matches': {
      const text = asText(left);
      if (text === undefined) return false;
      if (typeof right !== 'string') throw new ConditionError('matches expects a regular expression string');
      if (text.length > MAX_MATCH_LENGTH) {
        throw new ConditionError(`matches refuses input longer than ${MAX_MATCH_LENGTH} characters`);
      }
      try {
        return compilePattern(right).test(text);
      } catch (cause) {
        throw new ConditionError(
          cause instanceof PatternError
            ? `"${right}" is not a usable regular expression: ${cause.message}`
            : String(cause),
        );
      }
    }

    default:
      throw new ConditionError(`unknown operator "${operator}"`);
  }
}

/**
 * Ordered comparison. Mixing types here is a policy bug that would otherwise
 * silently compare a number against a string, so it is reported rather than
 * coerced — a refund limit must never pass because the amount arrived as text.
 */
function compareOrdered(operator: 'gt' | 'gte' | 'lt' | 'lte', left: Resolved, right: Resolved): boolean {
  if (left === MISSING || right === MISSING) return false;

  if (typeof left === 'number' && typeof right === 'number') {
    return applyOrder(operator, left, right);
  }
  if (typeof left === 'string' && typeof right === 'string') {
    return applyOrder(operator, left, right);
  }
  throw new ConditionError(
    `${operator} requires two numbers or two strings, received ${describe(left)} and ${describe(right)}`,
  );
}

function applyOrder<T extends number | string>(operator: 'gt' | 'gte' | 'lt' | 'lte', left: T, right: T): boolean {
  switch (operator) {
    case 'gt':
      return left > right;
    case 'gte':
      return left >= right;
    case 'lt':
      return left < right;
    case 'lte':
      return left <= right;
  }
}

function equals(left: Resolved, right: Resolved): boolean {
  if (left === MISSING || right === MISSING) return false;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => equals(item, right[index]));
  }
  return left === right;
}

function asText(value: Resolved): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asList(value: Resolved, operator: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new ConditionError(`${operator} expects its second operand to be an array`);
  return value;
}

function asConditions(value: unknown, operator: string): readonly Condition[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ConditionError(`${operator} expects a non-empty array of conditions`);
  }
  return value as readonly Condition[];
}

function describe(value: Resolved): string {
  if (value === MISSING) return 'nothing';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}
