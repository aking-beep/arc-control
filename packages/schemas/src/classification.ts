/**
 * Action risk classification.
 *
 * Two questions decide how much ceremony an action deserves: how bad is it if
 * this is wrong, and can it be undone. 1.0 carried both on the tool —
 * `effect` for reversibility and `riskTier` for impact — but left every
 * policy author to combine them by hand, which meant each policy did it
 * slightly differently and none of them explained itself.
 *
 * This module does it once, deterministically, and shows its working.
 *
 * Two rules govern how the result may be used, and they are the reason this
 * is a separate module rather than a field on the decision:
 *
 *  1. **Classification never authorizes.** It produces a label and the
 *     reasons for it. Policy decides. The classification is exposed to policy
 *     as `$.action.risk.*` so a rule can say "require approval when the class
 *     is severe", but nothing in the gateway consults it to permit anything.
 *     A classifier that could allow would be a second authorization path, and
 *     the product's whole claim is that there is exactly one.
 *
 *  2. **It is a pure function of recorded facts.** No model, no heuristic
 *     that changes between releases without a version bump, no network call.
 *     The same action classifies the same way forever, which is what makes it
 *     safe to cite in evidence.
 */
import type { ToolEffect, ToolRiskTier } from './tool.js';

/** Whether the effect of an action can be undone, and at what cost. */
export type Reversibility =
  /** Fully undoable with no trace and no cost, e.g. a read. */
  | 'reversible'
  /** Undoable by a compensating action, e.g. a transfer that can be refunded. */
  | 'compensable'
  /** Not undoable by any action ARC could take, e.g. a deletion or a sent email. */
  | 'irreversible';

/**
 * The ceremony an action deserves. Ordered, and the order is load-bearing:
 * policy conditions compare against it.
 */
export type ActionRiskClass = 'routine' | 'elevated' | 'sensitive' | 'severe';

export const ACTION_RISK_ORDER: Readonly<Record<ActionRiskClass, number>> = {
  routine: 0,
  elevated: 1,
  sensitive: 2,
  severe: 3,
};

/** A single reason contributing to a classification, for the explanation. */
export interface RiskFactor {
  readonly code:
    | 'tool_effect'
    | 'tool_risk_tier'
    | 'monetary_amount'
    | 'privileged_target'
    | 'bulk_scope'
    | 'production_environment';
  readonly detail: string;
  /** How many steps this factor pushed the class up. */
  readonly escalation: number;
}

export interface ActionRiskAssessment {
  readonly class: ActionRiskClass;
  readonly reversibility: Reversibility;
  /**
   * True when the action is of a kind the spec calls out for additional
   * protection: moving money, destroying data, or changing privilege.
   * Advisory — policy still decides what to do about it.
   */
  readonly sensitive: boolean;
  readonly factors: readonly RiskFactor[];
  /** Version of this classifier, recorded so an old evidence record stays interpretable. */
  readonly classifierVersion: 1;
}

/** Reversibility follows directly from the tool's declared effect. */
export function reversibilityOf(effect: ToolEffect): Reversibility {
  switch (effect) {
    case 'read':
      return 'reversible';
    case 'write':
      return 'compensable';
    case 'irreversible':
      return 'irreversible';
  }
}

const BASE_BY_TIER: Readonly<Record<ToolRiskTier, ActionRiskClass>> = {
  low: 'routine',
  medium: 'elevated',
  high: 'sensitive',
  critical: 'severe',
};

/** Parameter names that, when they carry a number, are treated as money. */
const MONETARY_KEYS = ['amount', 'amountcents', 'amount_cents', 'value', 'total', 'sum', 'price'];

/**
 * Parameter names that indicate the action targets privilege or identity
 * rather than ordinary data.
 */
const PRIVILEGED_KEYS = ['role', 'roles', 'permission', 'permissions', 'policy', 'grant', 'scope', 'scopes', 'admin'];

/** Parameter names whose presence means "many records at once". */
const BULK_KEYS = ['all', 'bulk', 'filter', 'query', 'where', 'ids', 'batch'];

export interface ClassifyInput {
  readonly effect: ToolEffect;
  readonly riskTier: ToolRiskTier;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly environment?: string;
  /**
   * Amount above which a monetary action escalates. No default is assumed
   * from thin air: without a configured threshold the amount is recorded as a
   * factor with no escalation, because ARC cannot know whether 500 is a lot
   * for this organization.
   */
  readonly monetaryEscalationThreshold?: number;
  /** Environments treated as production. Defaults to `['production']`. */
  readonly productionEnvironments?: readonly string[];
}

/**
 * Classifies an action.
 *
 * The tool's risk tier sets the floor; an irreversible effect and the
 * parameter signals can only raise it. Nothing lowers it — a tool declared
 * critical stays at least severe whatever its parameters look like, because
 * the person who registered the tool knew something the parameter names do
 * not say.
 */
export function classifyAction(input: ClassifyInput): ActionRiskAssessment {
  const factors: RiskFactor[] = [];
  const reversibility = reversibilityOf(input.effect);

  let level = ACTION_RISK_ORDER[BASE_BY_TIER[input.riskTier]];
  factors.push({
    code: 'tool_risk_tier',
    detail: `the tool is registered at risk tier "${input.riskTier}"`,
    escalation: level,
  });

  if (input.effect === 'irreversible') {
    level += 1;
    factors.push({
      code: 'tool_effect',
      detail: 'the tool declares an irreversible effect, so a wrong call cannot be undone by ARC',
      escalation: 1,
    });
  }

  const keys = Object.keys(input.parameters);
  const lower = new Map(keys.map((key) => [key.toLowerCase().replace(/[^a-z_]/g, ''), key]));

  // Money. Recorded whenever present; escalates only against a configured
  // threshold, because the significance of a number is the organization's to
  // declare and inventing a default would make the classifier wrong by
  // default for everyone whose currency is not dollars.
  for (const monetary of MONETARY_KEYS) {
    const key = lower.get(monetary);
    if (key === undefined) continue;
    const raw = input.parameters[key];
    if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;

    const threshold = input.monetaryEscalationThreshold;
    if (threshold !== undefined && raw >= threshold) {
      level += 1;
      factors.push({
        code: 'monetary_amount',
        detail: `parameter "${key}" is ${raw}, at or above the configured escalation threshold of ${threshold}`,
        escalation: 1,
      });
    } else {
      factors.push({
        code: 'monetary_amount',
        detail:
          threshold === undefined
            ? `parameter "${key}" carries a monetary value of ${raw}; no escalation threshold is configured, so this did not raise the class`
            : `parameter "${key}" is ${raw}, below the configured escalation threshold of ${threshold}`,
        escalation: 0,
      });
    }
    break;
  }

  for (const privileged of PRIVILEGED_KEYS) {
    const key = lower.get(privileged);
    if (key === undefined) continue;
    level += 1;
    factors.push({
      code: 'privileged_target',
      detail: `parameter "${key}" indicates the action changes privilege or policy rather than data`,
      escalation: 1,
    });
    break;
  }

  if (input.effect !== 'read') {
    for (const bulk of BULK_KEYS) {
      const key = lower.get(bulk);
      if (key === undefined) continue;
      level += 1;
      factors.push({
        code: 'bulk_scope',
        detail: `parameter "${key}" selects records by criteria rather than by id, so the action may affect many at once`,
        escalation: 1,
      });
      break;
    }
  }

  const production = input.productionEnvironments ?? ['production'];
  if (input.environment && production.includes(input.environment) && input.effect !== 'read') {
    level += 1;
    factors.push({
      code: 'production_environment',
      detail: `the action targets the "${input.environment}" environment`,
      escalation: 1,
    });
  }

  const classes: readonly ActionRiskClass[] = ['routine', 'elevated', 'sensitive', 'severe'];
  const resolved = classes[Math.min(level, classes.length - 1)]!;

  return {
    class: resolved,
    reversibility,
    sensitive:
      reversibility === 'irreversible' ||
      ACTION_RISK_ORDER[resolved] >= ACTION_RISK_ORDER.sensitive ||
      factors.some((factor) => factor.code === 'privileged_target' || factor.code === 'monetary_amount'),
    factors,
    classifierVersion: 1,
  };
}

/** `true` when `actual` is at least as severe as `minimum`. */
export function atLeast(actual: ActionRiskClass, minimum: ActionRiskClass): boolean {
  return ACTION_RISK_ORDER[actual] >= ACTION_RISK_ORDER[minimum];
}
