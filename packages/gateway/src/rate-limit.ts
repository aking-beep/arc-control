/**
 * Action rate limiting.
 *
 * An agent in a retry loop against an irreversible tool is the failure mode
 * that turns a bug into an incident: a hundred refunds in four seconds, each
 * one individually authorized by a policy that was perfectly correct about
 * every single call. Policy answers "may this action happen?"; nothing in 1.0
 * answered "may this action happen *again*, ninety times, right now?".
 *
 * Design constraints, all three of which rule out the easy implementation:
 *
 *  1. **It must fail closed.** A limiter that cannot read its own counter has
 *     to refuse, not wave the action through. So the count comes from the
 *     action store — the same durable record the rest of the system relies on
 *     — and a read failure propagates as a refusal rather than being caught.
 *
 *  2. **It must survive a restart.** An in-memory counter resets on deploy,
 *     which is precisely when a stuck agent is most likely to be hammering.
 *     Counting recorded actions costs a list and a filter, and gets this for
 *     free.
 *
 *  3. **It is a safety valve, not a quota.** It exists to stop a runaway, so
 *     the limits are deliberately loose and per-agent, and exceeding one is
 *     reported as `rate_limited` with the window stated. It is not metering
 *     and must not be sold as such.
 */
import { ArcError, type Action, type AgentPrincipal, type Tool } from '@arc-control/schemas';
import type { ControlStore } from '@arc-control/store';

export interface RateLimitRule {
  /** Length of the sliding window. */
  readonly windowSeconds: number;
  /** Most actions an agent may submit inside the window. */
  readonly maxActions: number;
  /**
   * A tighter ceiling applied only to actions on irreversible tools. Omitted
   * means the general limit applies to them too.
   */
  readonly maxIrreversibleActions?: number;
}

export interface RateLimitOptions {
  /** Applied to every agent without a more specific rule. */
  readonly default?: RateLimitRule;
  /** Per-agent overrides, keyed by agent name. */
  readonly byAgent?: Readonly<Record<string, RateLimitRule>>;
  readonly now?: () => Date;
}

export interface RateLimitVerdict {
  readonly allowed: boolean;
  readonly rule?: RateLimitRule;
  /** Actions already recorded inside the window. */
  readonly used: number;
  readonly limit?: number;
  /** Which ceiling was reached, when one was. */
  readonly kind?: 'overall' | 'irreversible';
}

/**
 * The limiter.
 *
 * Disabled by default: `new RateLimiter({})` permits everything. A limit
 * nobody configured should not start refusing an existing deployment's traffic
 * on upgrade, and a surprising 429 in production is a worse first impression
 * of 2.0 than no limiter at all.
 */
export class RateLimiter {
  readonly #store: ControlStore;
  readonly #default: RateLimitRule | undefined;
  readonly #byAgent: Readonly<Record<string, RateLimitRule>>;
  readonly #now: () => Date;

  constructor(store: ControlStore, options: RateLimitOptions = {}) {
    this.#store = store;
    this.#default = options.default;
    this.#byAgent = options.byAgent ?? {};
    this.#now = options.now ?? (() => new Date());
  }

  /** True when any limit is configured. Lets the gateway skip the count entirely. */
  get configured(): boolean {
    return this.#default !== undefined || Object.keys(this.#byAgent).length > 0;
  }

  ruleFor(agentName: string): RateLimitRule | undefined {
    return this.#byAgent[agentName] ?? this.#default;
  }

  /**
   * Checks an agent against its rule.
   *
   * Counts the agent's own recorded actions in the window. Deliberately
   * counts *submitted* actions rather than executed ones: an agent generating
   * a hundred denials a second is also a runaway, and the denials are the
   * signal that something is wrong.
   */
  async check(principal: AgentPrincipal, tool: Tool): Promise<RateLimitVerdict> {
    const rule = this.ruleFor(principal.agentName);
    if (!rule) return { allowed: true, used: 0 };

    const since = this.#now().getTime() - rule.windowSeconds * 1000;
    const recent = await this.#store.actions.filter(
      (action) => action.agentId === principal.agentId && Date.parse(action.requestedAt) >= since,
    );

    if (recent.length >= rule.maxActions) {
      return { allowed: false, rule, used: recent.length, limit: rule.maxActions, kind: 'overall' };
    }

    if (rule.maxIrreversibleActions !== undefined && tool.effect === 'irreversible') {
      const irreversible = await countIrreversible(this.#store, recent);
      if (irreversible >= rule.maxIrreversibleActions) {
        return {
          allowed: false,
          rule,
          used: irreversible,
          limit: rule.maxIrreversibleActions,
          kind: 'irreversible',
        };
      }
    }

    return { allowed: true, rule, used: recent.length };
  }

  /** Throws the refusal a verdict implies. */
  static refuse(principal: AgentPrincipal, verdict: RateLimitVerdict): never {
    const window = verdict.rule?.windowSeconds ?? 0;
    const what = verdict.kind === 'irreversible' ? 'irreversible actions' : 'actions';

    throw new ArcError(
      'rate_limited',
      `agent "${principal.agentName}" has submitted ${verdict.used} ${what} in the last ${window} seconds, at or above its limit of ${verdict.limit}`,
      {
        details: {
          agentId: principal.agentId,
          windowSeconds: window,
          limit: verdict.limit,
          used: verdict.used,
          kind: verdict.kind,
        },
      },
    );
  }
}

/** How many of these actions used an irreversible tool. */
async function countIrreversible(store: ControlStore, actions: readonly Action[]): Promise<number> {
  const tools = await store.tools.list();
  const irreversible = new Set(tools.filter((tool) => tool.effect === 'irreversible').map((tool) => tool.id));
  return actions.filter((action) => irreversible.has(action.toolId)).length;
}
