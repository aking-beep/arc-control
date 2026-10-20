import type { ParameterSpec } from './tool.js';
import type { Condition, Policy, PolicyRule } from './policy.js';
import { CONDITION_OPERATORS } from './policy.js';

export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

export interface ValidationResult {
  readonly valid: boolean;
  readonly issues: readonly ValidationIssue[];
}

const ok: ValidationResult = { valid: true, issues: [] };

function fail(issues: ValidationIssue[]): ValidationResult {
  return { valid: issues.length === 0, issues };
}

/**
 * Validates an action's parameters against a tool's declared parameter specs.
 * Unknown parameters are rejected rather than ignored: a tool call carrying
 * fields the tool never declared is exactly the shape of a confused-deputy
 * attempt, and silently dropping them would hide it from policy.
 */
export function validateParameters(
  specs: readonly ParameterSpec[],
  parameters: Readonly<Record<string, unknown>>,
): ValidationResult {
  const issues: ValidationIssue[] = [];
  const declared = new Map(specs.map((spec) => [spec.name, spec]));

  for (const key of Object.keys(parameters)) {
    if (!declared.has(key)) {
      issues.push({ path: key, message: `parameter is not declared by this tool` });
    }
  }

  for (const spec of specs) {
    const present = Object.prototype.hasOwnProperty.call(parameters, spec.name);
    const value = parameters[spec.name];

    if (!present || value === undefined || value === null) {
      if (spec.required) issues.push({ path: spec.name, message: 'parameter is required' });
      continue;
    }

    issues.push(...checkValue(spec, value));
  }

  return fail(issues);
}

function checkValue(spec: ParameterSpec, value: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const path = spec.name;

  switch (spec.type) {
    case 'string':
      if (typeof value !== 'string') return [{ path, message: 'expected a string' }];
      if (spec.maxLength !== undefined && value.length > spec.maxLength) {
        issues.push({ path, message: `exceeds maxLength of ${spec.maxLength}` });
      }
      if (spec.pattern !== undefined && !safeTest(spec.pattern, value)) {
        issues.push({ path, message: `does not match pattern ${spec.pattern}` });
      }
      break;
    case 'number':
    case 'integer':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return [{ path, message: 'expected a finite number' }];
      }
      if (spec.type === 'integer' && !Number.isInteger(value)) {
        issues.push({ path, message: 'expected an integer' });
      }
      if (spec.minimum !== undefined && value < spec.minimum) {
        issues.push({ path, message: `is below minimum of ${spec.minimum}` });
      }
      if (spec.maximum !== undefined && value > spec.maximum) {
        issues.push({ path, message: `is above maximum of ${spec.maximum}` });
      }
      break;
    case 'boolean':
      if (typeof value !== 'boolean') return [{ path, message: 'expected a boolean' }];
      break;
    case 'array':
      if (!Array.isArray(value)) return [{ path, message: 'expected an array' }];
      break;
    case 'object':
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return [{ path, message: 'expected an object' }];
      }
      break;
  }

  if (spec.enum && !spec.enum.includes(value as string | number | boolean)) {
    issues.push({ path, message: `must be one of: ${spec.enum.join(', ')}` });
  }

  return issues;
}

/**
 * Tests a pattern from a tool definition. Tool definitions are operator-supplied
 * configuration rather than agent input, but a pathological pattern should
 * still fail the parameter rather than hang the gateway, so a bad pattern is
 * reported as a non-match.
 */
function safeTest(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern).test(value);
  } catch {
    return false;
  }
}

/** Validates a policy document before it is stored. */
export function validatePolicy(policy: Policy): ValidationResult {
  const issues: ValidationIssue[] = [];

  if (!policy.id || !/^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/.test(policy.id)) {
    issues.push({ path: 'id', message: 'must be 2-64 characters of letters, digits, dot, dash or underscore' });
  }
  if (!Number.isInteger(policy.version) || policy.version < 1) {
    issues.push({ path: 'version', message: 'must be an integer of 1 or more' });
  }
  if (!policy.name) issues.push({ path: 'name', message: 'is required' });
  if (!policy.fallback || !policy.fallback.effect) {
    issues.push({ path: 'fallback.effect', message: 'is required so a matching policy always decides' });
  } else if (!policy.fallback.reason) {
    issues.push({ path: 'fallback.reason', message: 'is required: a decision without a reason is not auditable' });
  }
  if (!Array.isArray(policy.rules) || policy.rules.length === 0) {
    issues.push({ path: 'rules', message: 'must contain at least one rule' });
  }

  const seen = new Set<string>();
  policy.rules?.forEach((rule, index) => {
    issues.push(...validateRule(rule, `rules[${index}]`, seen));
  });

  return fail(issues);
}

function validateRule(rule: PolicyRule, path: string, seen: Set<string>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!rule.id) {
    issues.push({ path: `${path}.id`, message: 'is required' });
  } else if (seen.has(rule.id)) {
    issues.push({ path: `${path}.id`, message: `duplicate rule id "${rule.id}"` });
  } else {
    seen.add(rule.id);
  }

  if (rule.effect !== 'ALLOW' && rule.effect !== 'REQUIRE_APPROVAL' && rule.effect !== 'DENY') {
    issues.push({ path: `${path}.effect`, message: 'must be ALLOW, REQUIRE_APPROVAL or DENY' });
  }
  if (!rule.reason) {
    issues.push({ path: `${path}.reason`, message: 'is required: a decision without a reason is not auditable' });
  }
  if (rule.effect === 'REQUIRE_APPROVAL') {
    if (!rule.approval || rule.approval.approvers.length === 0) {
      issues.push({ path: `${path}.approval.approvers`, message: 'a REQUIRE_APPROVAL rule must name at least one approver' });
    } else if ((rule.approval.minApprovals ?? 1) > rule.approval.approvers.length) {
      issues.push({ path: `${path}.approval.minApprovals`, message: 'cannot exceed the number of approvers' });
    }
  }
  if (rule.approval && rule.effect !== 'REQUIRE_APPROVAL') {
    issues.push({ path: `${path}.approval`, message: 'only a REQUIRE_APPROVAL rule may carry an approval requirement' });
  }

  issues.push(...validateCondition(rule.when, `${path}.when`));
  return issues;
}

/** Validates a condition's shape and, where it matters, its depth. */
export function validateCondition(condition: Condition, path: string, depth = 0): ValidationIssue[] {
  if (depth > 16) return [{ path, message: 'condition nests more than 16 levels deep' }];
  if (!condition || typeof condition !== 'object' || Array.isArray(condition)) {
    return [{ path, message: 'expected a condition object' }];
  }

  const keys = Object.keys(condition);
  if (keys.length !== 1) {
    return [{ path, message: `expected exactly one operator, found ${keys.length || 'none'}` }];
  }

  const operator = keys[0]!;
  if (!(CONDITION_OPERATORS as readonly string[]).includes(operator)) {
    return [{ path, message: `unknown operator "${operator}"` }];
  }

  const operand = (condition as Record<string, unknown>)[operator];

  if (operator === 'and' || operator === 'or') {
    if (!Array.isArray(operand) || operand.length === 0) {
      return [{ path: `${path}.${operator}`, message: 'expected a non-empty array of conditions' }];
    }
    return operand.flatMap((child, i) =>
      validateCondition(child as Condition, `${path}.${operator}[${i}]`, depth + 1),
    );
  }

  if (operator === 'not') {
    return validateCondition(operand as Condition, `${path}.not`, depth + 1);
  }

  if (operator === 'always') {
    return operand === true ? [] : [{ path: `${path}.always`, message: 'expected true' }];
  }

  if (operator === 'exists') {
    return typeof operand === 'string'
      ? []
      : [{ path: `${path}.exists`, message: 'expected a reference string such as "$.action.parameters.amount"' }];
  }

  if (!Array.isArray(operand) || operand.length !== 2) {
    return [{ path: `${path}.${operator}`, message: 'expected an array of exactly two operands' }];
  }

  if (operator === 'matches') {
    if (typeof operand[1] !== 'string') {
      return [{ path: `${path}.matches[1]`, message: 'expected a regular expression string' }];
    }
    try {
      new RegExp(operand[1]);
    } catch {
      return [{ path: `${path}.matches[1]`, message: 'is not a valid regular expression' }];
    }
  }

  return [];
}

export { ok as VALID };
