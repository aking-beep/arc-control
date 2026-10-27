import {
  ArcError,
  newId,
  type AgentSpendInput,
  type Budget,
  type BudgetStanding,
  type PolicyEvaluation,
  type SpendRecord,
  type SpendSource,
} from '@arc-control/schemas';
import type { ControlStore } from '@arc-control/store';
import { periodStart, roundUsd } from './periods.js';
import { isAmount, validateBudgetInput, type BudgetInput } from './validate.js';

/** A spend figure to record. */
export interface SpendInput {
  readonly organizationId: string;
  readonly agentId?: string;
  readonly provider: string;
  readonly amountUsd: number;
  readonly occurredAt: string;
  readonly reference?: string;
  readonly model?: string;
}

export interface SpendLedgerOptions {
  readonly now?: () => Date;
}

/** Provider names: lowercase, short, no spaces. They are cited in reports and references. */
const PROVIDER = /^[a-z0-9][a-z0-9._-]{0,62}$/;
/** How far ahead of the clock a record may be dated. Provider buckets can start slightly ahead of a skewed clock. */
const FUTURE_TOLERANCE_MS = 24 * 60 * 60 * 1000;

/**
 * What agents have cost, and what that means for their budgets.
 *
 * The ledger is deliberately unable to make anything cheaper. Amounts are
 * never negative, a self-reported record never replaces another, and a
 * replaced provider record is replaced only by a newer fetch of the same
 * provider row. The one way spend goes down is time passing into a new period.
 */
export class SpendLedger {
  readonly #store: ControlStore;
  readonly #now: () => Date;

  constructor(store: ControlStore, options: SpendLedgerOptions = {}) {
    this.#store = store;
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * Records spend.
   *
   * `provider` records are what ARC fetched from a billing API and are marked
   * verified; a second fetch of the same row (`provider` + `reference`)
   * replaces the first, so re-reading a day is idempotent. `reported` records
   * are claims and are never deduplicated against anything: an agent that
   * could re-report a row with a smaller amount could lower its own spend.
   */
  async record(input: SpendInput, source: SpendSource, recordedBy: string): Promise<SpendRecord> {
    this.#check(input, source);
    const recordedAt = this.#now().toISOString();

    // Spend belongs to the organization of the agent it names, whatever the
    // caller said: a budget is enforced in the agent's organization, and spend
    // filed under another would count toward nothing that governs the agent.
    let organizationId = input.organizationId;
    if (input.agentId !== undefined) {
      const agent = await this.#store.agents.get(input.agentId);
      if (!agent) throw new ArcError('invalid_request', `no agent with id ${input.agentId}`);
      organizationId = agent.organizationId;
    }

    return this.#store.spend.transact(async () => {
      const existing =
        source === 'provider' && input.reference !== undefined
          ? await this.#store.spend.find(
              (record) =>
                record.source === 'provider' &&
                record.provider === input.provider &&
                record.reference === input.reference &&
                record.organizationId === organizationId,
            )
          : undefined;

      const record: SpendRecord = {
        id: existing?.id ?? newId('spend'),
        organizationId,
        ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
        provider: input.provider,
        amountUsd: roundUsd(input.amountUsd),
        occurredAt: new Date(input.occurredAt).toISOString(),
        recordedAt,
        source,
        verified: source === 'provider',
        ...(input.reference !== undefined ? { reference: input.reference } : {}),
        ...(input.model !== undefined ? { model: input.model } : {}),
        recordedBy,
      };
      await this.#store.spend.put(record.id, record);
      return record;
    });
  }

  async list(filter: { readonly agentId?: string; readonly since?: Date } = {}): Promise<readonly SpendRecord[]> {
    const since = filter.since?.getTime();
    return this.#store.spend.filter(
      (record) =>
        (filter.agentId === undefined || record.agentId === filter.agentId) &&
        (since === undefined || Date.parse(record.occurredAt) >= since),
    );
  }

  // --- budgets ------------------------------------------------------------

  async budgets(): Promise<readonly Budget[]> {
    return this.#store.budgets.list();
  }

  async budget(id: string): Promise<Budget> {
    const budget = await this.#store.budgets.get(id);
    if (!budget) throw new ArcError('not_found', `no budget with id ${id}`);
    return budget;
  }

  /** Creates a budget, or replaces one when `id` is given. Validates first; the version increments on every replace. */
  async saveBudget(value: unknown, options: { readonly organizationId: string; readonly id?: string }): Promise<Budget> {
    const input: BudgetInput = validateBudgetInput(value);
    // A budget naming an agent lives in that agent's organization. Filing it
    // under the caller's default would show it exhausted in reports while the
    // gateway, deciding in the agent's organization, never applied it.
    const agent = input.agentId === undefined ? undefined : await this.#store.agents.get(input.agentId);
    if (input.agentId !== undefined && !agent) {
      throw new ArcError('invalid_request', `budget names agent ${input.agentId}, which does not exist`);
    }

    return this.#store.budgets.transact(async () => {
      const previous = options.id === undefined ? undefined : await this.budget(options.id);
      const timestamp = this.#now().toISOString();
      const budget: Budget = {
        id: previous?.id ?? newId('budget'),
        name: input.name.trim(),
        organizationId: agent?.organizationId ?? previous?.organizationId ?? options.organizationId,
        ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
        period: input.period,
        limitUsd: roundUsd(input.limitUsd),
        onExceeded: input.onExceeded,
        ...(input.approvers !== undefined ? { approvers: [...input.approvers] } : {}),
        ...(input.effects !== undefined ? { effects: [...input.effects] } : {}),
        ...(input.warnAtPercent !== undefined ? { warnAtPercent: input.warnAtPercent } : {}),
        enabled: input.enabled ?? true,
        version: (previous?.version ?? 0) + 1,
        createdAt: previous?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };
      await this.#store.budgets.put(budget.id, budget);
      return budget;
    });
  }

  // --- standing -----------------------------------------------------------

  /** Where each enabled budget stands in its current period. */
  async standings(options: { readonly agentId?: string; readonly now?: Date } = {}): Promise<readonly BudgetStanding[]> {
    const now = options.now ?? this.#now();
    const [budgets, records] = await Promise.all([this.#store.budgets.list(), this.#store.spend.list()]);
    return budgets
      .filter((budget) => budget.enabled && (options.agentId === undefined || governs(budget, options.agentId)))
      .map((budget) => standing(budget, records, now));
  }

  /**
   * Spend as policy sees it, for one agent: `$.agent.spend.*`.
   */
  async agentInput(agentId: string, organizationId: string, now: Date = this.#now()): Promise<AgentSpendInput> {
    const [budgets, records] = await Promise.all([this.#store.budgets.list(), this.#store.spend.list()]);
    return spendInput(agentId, organizationId, budgets, records, now);
  }

  /**
   * One evaluation per enabled budget that governs this agent and tool, ready
   * to be folded into a decision with `tighten`.
   *
   * An exhausted budget is an applied evaluation carrying its `onExceeded`
   * effect; one with room left is recorded as not applied, so the decision's
   * evidence still shows it was checked.
   */
  async evaluate(args: {
    readonly agentId: string;
    readonly organizationId: string;
    readonly toolEffect: string;
    readonly now?: Date;
  }): Promise<{ readonly evaluations: readonly PolicyEvaluation[]; readonly spend: AgentSpendInput }> {
    const now = args.now ?? this.#now();
    const [budgets, records] = await Promise.all([this.#store.budgets.list(), this.#store.spend.list()]);
    // Only an explicit `enabled: false` switches a budget off, and a budget
    // whose document is malformed refuses rather than silently never
    // applying — it can only have reached the store without validation.
    const evaluations = budgets
      .filter(
        (budget) =>
          budget.enabled !== false &&
          budget.organizationId === args.organizationId &&
          governs(budget, args.agentId) &&
          (!Array.isArray(budget.effects) || budget.effects.length === 0 || (budget.effects as readonly string[]).includes(args.toolEffect)),
      )
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((budget) =>
        malformed(budget) ? malformedEvaluation(budget) : evaluationFor(budget, standing(budget, records, now)),
      );

    return { evaluations, spend: spendInput(args.agentId, args.organizationId, budgets, records, now) };
  }

  #check(input: SpendInput, source: SpendSource): void {
    const problems: string[] = [];
    if (!PROVIDER.test(String(input.provider))) problems.push('provider must be a short lowercase name, e.g. "anthropic"');
    if (!isAmount(input.amountUsd)) problems.push('amountUsd must be a finite number of dollars, zero or more');
    const occurred = Date.parse(String(input.occurredAt));
    if (Number.isNaN(occurred)) problems.push('occurredAt must be an ISO 8601 timestamp');
    else if (occurred > this.#now().getTime() + FUTURE_TOLERANCE_MS) problems.push('occurredAt is more than a day in the future');
    // A claim about the past cannot tighten any current budget, but it can
    // inflate the history a spike is measured against. Reported spend is
    // therefore accepted only for the current month.
    else if (source === 'reported' && occurred < periodStart('month', this.#now()).getTime()) {
      problems.push('reported spend must be dated within the current month');
    }
    if (typeof input.organizationId !== 'string' || input.organizationId.length === 0) problems.push('organizationId is required');
    if (input.reference !== undefined && (typeof input.reference !== 'string' || input.reference.length > 256)) {
      problems.push('reference must be a string of at most 256 characters');
    }
    if (input.model !== undefined && (typeof input.model !== 'string' || input.model.length > 128)) {
      problems.push('model must be a string of at most 128 characters');
    }
    if (problems.length > 0) {
      throw new ArcError('invalid_request', `invalid spend record: ${problems.join('; ')}`, { details: { problems } });
    }
  }
}

/** True when the budget counts this agent's actions: its own budget, or an organization-wide one. */
function governs(budget: Budget, agentId: string): boolean {
  return budget.agentId === undefined || budget.agentId === agentId;
}

/** Spend a budget counts: the agent's own, or everything in the organization. */
function counted(budget: Budget, record: SpendRecord): boolean {
  if (record.organizationId !== budget.organizationId) return false;
  if (budget.agentId !== undefined) return record.agentId === budget.agentId;
  // An agent's report about itself counts toward its own budgets, never the
  // organization's: otherwise any one agent could exhaust a shared budget
  // and stop every other agent in the organization.
  return !selfReported(record);
}

function selfReported(record: SpendRecord): boolean {
  return record.source === 'reported' && record.agentId !== undefined && record.recordedBy === record.agentId;
}

const PERIODS: ReadonlySet<string> = new Set(['day', 'month']);
const EFFECTS: ReadonlySet<string> = new Set(['DENY', 'REQUIRE_APPROVAL']);

/** A stored budget that validation would have refused. */
function malformed(budget: Budget): boolean {
  return (
    typeof budget.enabled !== 'boolean' ||
    !isAmount(budget.limitUsd) ||
    budget.limitUsd <= 0 ||
    !PERIODS.has(budget.period) ||
    !EFFECTS.has(budget.onExceeded) ||
    (budget.effects !== undefined && (!Array.isArray(budget.effects) || budget.effects.length === 0))
  );
}

function malformedEvaluation(budget: Budget): PolicyEvaluation {
  return {
    policyId: `budget:${budget.id}`,
    policyVersion: typeof budget.version === 'number' ? budget.version : 0,
    applied: true,
    effect: 'DENY',
    ruleId: 'malformed',
    reason: `budget ${budget.id} is malformed, so the action is refused rather than decided without it`,
  };
}

export function standing(budget: Budget, records: readonly SpendRecord[], now: Date): BudgetStanding {
  const start = periodStart(budget.period, now);
  let spent = 0;
  let unverified = 0;
  for (const record of records) {
    if (!counted(budget, record) || Date.parse(record.occurredAt) < start.getTime()) continue;
    spent += record.amountUsd;
    if (!record.verified) unverified += record.amountUsd;
  }
  const spentUsd = roundUsd(spent);
  const percentUsed = budget.limitUsd > 0 ? roundUsd((spentUsd / budget.limitUsd) * 100) : 100;
  const state =
    spentUsd >= budget.limitUsd
      ? 'exceeded'
      : budget.warnAtPercent !== undefined && percentUsed >= budget.warnAtPercent
        ? 'warning'
        : 'ok';

  return {
    budgetId: budget.id,
    name: budget.name,
    period: budget.period,
    periodStart: start.toISOString(),
    limitUsd: budget.limitUsd,
    spentUsd,
    unverifiedUsd: roundUsd(unverified),
    percentUsed,
    state,
  };
}

function evaluationFor(budget: Budget, current: BudgetStanding): PolicyEvaluation {
  const base = { policyId: `budget:${budget.id}`, policyVersion: budget.version };
  const position = `$${current.spentUsd.toFixed(2)} of $${budget.limitUsd.toFixed(2)} this ${budget.period}`;

  if (current.state !== 'exceeded') {
    return { ...base, applied: false, ruleId: 'within', reason: `budget "${budget.name}": ${position}` };
  }

  // A hold nobody can release is a refusal. Validation refuses such a budget,
  // but a document written straight into the store does not pass through it.
  const approvers = budget.approvers ?? [];
  if (budget.onExceeded === 'REQUIRE_APPROVAL' && approvers.length > 0) {
    return {
      ...base,
      applied: true,
      effect: 'REQUIRE_APPROVAL',
      ruleId: 'exceeded',
      reason: `budget "${budget.name}" is exhausted (${position}); a human must approve further actions`,
      approval: { approvers, minApprovals: 1, expiresInSeconds: 3600 },
    };
  }

  return {
    ...base,
    applied: true,
    effect: 'DENY',
    ruleId: 'exceeded',
    reason: `budget "${budget.name}" is exhausted (${position})`,
  };
}

function spendInput(
  agentId: string,
  organizationId: string,
  budgets: readonly Budget[],
  records: readonly SpendRecord[],
  now: Date,
): AgentSpendInput {
  const day = periodStart('day', now).getTime();
  const month = periodStart('month', now).getTime();
  let dayUsd = 0;
  let monthUsd = 0;
  let verified = true;
  for (const record of records) {
    if (record.agentId !== agentId || record.organizationId !== organizationId) continue;
    const at = Date.parse(record.occurredAt);
    if (at >= month) {
      monthUsd += record.amountUsd;
      if (!record.verified) verified = false;
    }
    if (at >= day) dayUsd += record.amountUsd;
  }

  const maxBudgetPercent = budgets
    .filter((budget) => budget.enabled && budget.organizationId === organizationId && governs(budget, agentId))
    .reduce((highest, budget) => Math.max(highest, standing(budget, records, now).percentUsed), 0);

  return { dayUsd: roundUsd(dayUsd), monthUsd: roundUsd(monthUsd), maxBudgetPercent, verified };
}
