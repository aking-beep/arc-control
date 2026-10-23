import type { Condition, Operand } from '../data/types';

/**
 * `conditionToText(condition)` — plan §6. Renders a policy Condition as a
 * sentence without changing its meaning. Covers all 17 operators in
 * packages/schemas/src/policy.ts. Paths are shortened for reading only
 * (`$.action.parameters.amount` → `amount`); the raw JSON stays one click away.
 */
export function conditionToText(condition: Condition): string {
  if ('always' in condition) return 'always';
  if ('and' in condition) return condition.and.map(wrap).join(' and ');
  if ('or' in condition) return condition.or.map(wrap).join(' or ');
  if ('not' in condition) return `not (${conditionToText(condition.not)})`;
  if ('exists' in condition) return `${operand(condition.exists)} is present`;

  const [op, pair] = Object.entries(condition)[0] as [string, [Operand, Operand]];
  const [left, right] = pair;
  const l = operand(left);
  const r = operand(right);
  switch (op) {
    case 'eq':
      return `${l} = ${r}`;
    case 'ne':
      return `${l} ≠ ${r}`;
    case 'gt':
      return `${l} > ${r}`;
    case 'gte':
      return `${l} ≥ ${r}`;
    case 'lt':
      return `${l} < ${r}`;
    case 'lte':
      return `${l} ≤ ${r}`;
    case 'in':
      return `${l} is one of ${r}`;
    case 'nin':
      return `${l} is none of ${r}`;
    case 'contains':
      return `${l} contains ${r}`;
    case 'startsWith':
      return `${l} starts with ${r}`;
    case 'endsWith':
      return `${l} ends with ${r}`;
    case 'matches':
      return `${l} matches /${String(right)}/`;
    default:
      return JSON.stringify(condition);
  }
}

function wrap(condition: Condition): string {
  const text = conditionToText(condition);
  return 'and' in condition || 'or' in condition ? `(${text})` : text;
}

function operand(value: Operand): string {
  if (Array.isArray(value)) return `[${value.map((v) => operand(v)).join(', ')}]`;
  if (typeof value === 'string') {
    if (value.startsWith('$.')) return shortPath(value);
    return `"${value}"`;
  }
  return String(value);
}

function shortPath(path: string): string {
  return path.replace(/^\$\.action\.parameters\./, '').replace(/^\$\./, '');
}
