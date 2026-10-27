/**
 * Spend: what agents cost, and budgets that act on it.
 *
 * A policy can be correct about every single action and still let an agent
 * run up an unbounded bill — each call authorized, the total nobody's
 * decision. Budgets close that by making cumulative spend something the
 * gateway decides on, and they do it without loosening anything: a budget can
 * only make a decision stricter (ADR-0002).
 *
 * Two facts shape the model.
 *
 * **Spend is learned after the fact.** ARC cannot price an action before it
 * runs, so a budget refuses the *next* action once spend has reached the
 * limit. It is detect-and-cut, as fresh as the spend data, and is documented
 * as such rather than sold as a hard ceiling.
 *
 * **Not all spend is equally trustworthy.** A provider's billing API is a
 * record ARC fetched itself; a number an agent reports about itself is a
 * claim. Both count toward a budget, because over-reporting can only tighten,
 * but the record says which is which.
 */

/** Where a spend figure came from. */
export type SpendSource =
  /** Fetched by ARC from a provider's billing or usage API. */
  | 'provider'
  /** Reported to ARC by an agent or an operator. Unverified. */
  | 'reported';

export interface SpendRecord {
  readonly id: string;
  readonly organizationId: string;
  /**
   * The agent the spend is attributed to. Absent when a provider row could not
   * be attributed to any agent; such spend still counts toward organization
   * budgets.
   */
  readonly agentId?: string;
  /** Provider that incurred the cost, e.g. `anthropic`. */
  readonly provider: string;
  /** Cost in US dollars. Never negative: a credit would loosen a budget. */
  readonly amountUsd: number;
  /** When the cost was incurred, or the start of the provider's bucket. */
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly source: SpendSource;
  /** True only for `provider` records. */
  readonly verified: boolean;
  /**
   * Provider-side identity of the row. A second record with the same provider
   * and reference replaces the first, so re-fetching a day is idempotent.
   */
  readonly reference?: string;
  readonly model?: string;
  /** Who recorded it: an agent id, an operator identifier, or `system:<provider>`. */
  readonly recordedBy: string;
}

export type BudgetPeriod = 'day' | 'month';

/** What happens to an action once a budget is exhausted. */
export type BudgetEffect = 'DENY' | 'REQUIRE_APPROVAL';

export interface Budget {
  readonly id: string;
  readonly name: string;
  readonly organizationId: string;
  /** The agent this budget governs. Absent means all spend in the organization. */
  readonly agentId?: string;
  readonly period: BudgetPeriod;
  readonly limitUsd: number;
  readonly onExceeded: BudgetEffect;
  /** Approver selectors, required when `onExceeded` is `REQUIRE_APPROVAL`. */
  readonly approvers?: readonly string[];
  /**
   * Tool effects the budget gates. Absent means every action. A budget that
   * gates only `write` and `irreversible` lets an agent over budget still read.
   */
  readonly effects?: readonly ('read' | 'write' | 'irreversible')[];
  /** Percent of the limit at which standing is reported as `warning`. */
  readonly warnAtPercent?: number;
  readonly enabled: boolean;
  /** Incremented on every change, and cited in decisions. */
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A budget's position in its current period. */
export interface BudgetStanding {
  readonly budgetId: string;
  readonly name: string;
  readonly period: BudgetPeriod;
  readonly periodStart: string;
  readonly limitUsd: number;
  readonly spentUsd: number;
  /** The part of `spentUsd` that comes from unverified records. */
  readonly unverifiedUsd: number;
  readonly percentUsed: number;
  readonly state: 'ok' | 'warning' | 'exceeded';
}

/** Spend as policy sees it: `$.agent.spend.*`. */
export interface AgentSpendInput {
  /** This agent's spend so far in the current UTC day. */
  readonly dayUsd: number;
  /** This agent's spend so far in the current UTC month. */
  readonly monthUsd: number;
  /** Highest `percentUsed` across enabled budgets that govern this agent; 0 when there are none. */
  readonly maxBudgetPercent: number;
  /** False when any of this agent's spend in the month is self-reported. */
  readonly verified: boolean;
}
