import { ArcError, type Budget, type BudgetEffect, type BudgetPeriod } from '@arc-control/schemas';

/** Largest single spend record or budget limit accepted, in USD. A typo guard, not a policy. */
export const MAX_USD = 1_000_000_000;

const PERIODS: readonly BudgetPeriod[] = ['day', 'month'];
const EFFECTS: readonly BudgetEffect[] = ['DENY', 'REQUIRE_APPROVAL'];
const TOOL_EFFECTS = ['read', 'write', 'irreversible'] as const;

/** What an operator supplies to create or replace a budget. */
export interface BudgetInput {
  readonly name: string;
  readonly agentId?: string;
  readonly period: BudgetPeriod;
  readonly limitUsd: number;
  readonly onExceeded: BudgetEffect;
  readonly approvers?: readonly string[];
  readonly effects?: readonly ('read' | 'write' | 'irreversible')[];
  readonly warnAtPercent?: number;
  readonly enabled?: boolean;
}

/**
 * Validates a budget document and returns it typed.
 *
 * Strict in the directions that would otherwise loosen something: a budget
 * that holds actions for approval must name somebody who can approve them,
 * and an unknown field is refused rather than ignored, so a misspelt
 * `efects: ['write']` cannot silently become a budget that gates every
 * action — or, worse, read as one that gates none.
 */
export function validateBudgetInput(value: unknown): BudgetInput {
  const problems: string[] = [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ArcError('invalid_request', 'a budget must be a JSON object');
  }
  const input = value as Record<string, unknown>;
  const known = new Set(['name', 'agentId', 'period', 'limitUsd', 'onExceeded', 'approvers', 'effects', 'warnAtPercent', 'enabled']);
  for (const key of Object.keys(input)) if (!known.has(key)) problems.push(`unknown field "${key}"`);

  if (typeof input.name !== 'string' || input.name.trim().length === 0 || input.name.length > 120) {
    problems.push('name must be a non-empty string of at most 120 characters');
  }
  if (input.agentId !== undefined && (typeof input.agentId !== 'string' || input.agentId.length === 0)) {
    problems.push('agentId, when present, must be a non-empty string');
  }
  if (!PERIODS.includes(input.period as BudgetPeriod)) problems.push(`period must be one of ${PERIODS.join(', ')}`);
  if (!isAmount(input.limitUsd) || input.limitUsd === 0) {
    problems.push(`limitUsd must be a finite number above 0 and at most ${MAX_USD}`);
  }
  if (!EFFECTS.includes(input.onExceeded as BudgetEffect)) problems.push(`onExceeded must be one of ${EFFECTS.join(', ')}`);
  if (input.approvers !== undefined && !isStringList(input.approvers)) {
    problems.push('approvers must be a list of non-empty strings');
  }
  if (input.onExceeded === 'REQUIRE_APPROVAL' && (!isStringList(input.approvers) || input.approvers.length === 0)) {
    problems.push('a budget that requires approval must name at least one approver');
  }
  if (input.effects !== undefined) {
    if (!Array.isArray(input.effects) || input.effects.length === 0) {
      problems.push('effects, when present, must be a non-empty list');
    } else {
      for (const effect of input.effects) {
        if (!(TOOL_EFFECTS as readonly unknown[]).includes(effect)) problems.push(`effects contains "${String(effect)}"`);
      }
    }
  }
  if (
    input.warnAtPercent !== undefined &&
    (typeof input.warnAtPercent !== 'number' || !Number.isFinite(input.warnAtPercent) || input.warnAtPercent <= 0 || input.warnAtPercent > 100)
  ) {
    problems.push('warnAtPercent must be a number above 0 and at most 100');
  }
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') problems.push('enabled must be a boolean');

  if (problems.length > 0) {
    throw new ArcError('invalid_request', `invalid budget: ${problems.join('; ')}`, { details: { problems } });
  }
  return input as unknown as BudgetInput;
}

/** A spend amount: a finite, non-negative number of dollars. Negative would loosen a budget. */
export function isAmount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_USD;
}

function isStringList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry.trim().length > 0);
}

/** Everything about a budget except what the store assigns. */
export type BudgetDocument = Omit<Budget, 'id' | 'version' | 'createdAt' | 'updatedAt'>;
