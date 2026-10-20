import {
  digest,
  EFFECT_SEVERITY,
  newId,
  type Decision,
  type Policy,
  type PolicyEffect,
  type PolicyEvaluation,
  type PolicyInput,
  type RuleTrace,
} from '@arc-control/schemas';
import { ConditionError, evaluateCondition } from './condition.js';
import { policyApplies } from './match.js';

export interface PolicyEngineOptions {
  /**
   * Effect applied when no policy matches the action. Defaults to DENY:
   * a control plane that allows what it has no policy for is not a control
   * plane. Set to ALLOW only for a monitor-only rollout.
   */
  readonly defaultEffect?: PolicyEffect;
  readonly defaultReason?: string;
  /** Clock seam, for deterministic tests and evals. */
  readonly now?: () => Date;
}

/**
 * Evaluates an action against a set of policies.
 *
 * Two properties matter more than anything else here:
 *
 *  1. **Strictest wins.** Every matching policy is evaluated, and the harshest
 *     effect decides. Adding a policy can therefore only ever tighten
 *     authorization, never loosen it — so a new policy is safe to roll out.
 *  2. **Fail closed.** A malformed condition, a missing parameter or a thrown
 *     error never produces an ALLOW. The rule is recorded as not matching, the
 *     error is kept in the trace, and the policy falls through to its fallback.
 */
export class PolicyEngine {
  readonly #defaultEffect: PolicyEffect;
  readonly #defaultReason: string;
  readonly #now: () => Date;

  constructor(options: PolicyEngineOptions = {}) {
    this.#defaultEffect = options.defaultEffect ?? 'DENY';
    this.#defaultReason = options.defaultReason ?? 'no policy authorizes this action';
    this.#now = options.now ?? (() => new Date());
  }

  evaluate(policies: readonly Policy[], input: PolicyInput): Decision {
    const startedAt = process.hrtime.bigint();

    const applicable = policies
      .filter((policy) => policy.enabled && policyApplies(policy, input))
      .slice()
      .sort(comparePolicies);

    const evaluations: PolicyEvaluation[] = [];
    const trace: RuleTrace[] = [];

    for (const policy of applicable) {
      evaluations.push(this.#evaluatePolicy(policy, input, trace));
    }

    const winner = selectStrictest(evaluations);
    const decidedAt = this.#now().toISOString();
    const evaluationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

    if (!winner) {
      return {
        id: newId('decision'),
        actionId: input.action.id,
        effect: this.#defaultEffect,
        reason: this.#defaultReason,
        obligations: [],
        evaluations,
        trace,
        decidedAt,
        evaluationMs,
      };
    }

    return {
      id: newId('decision'),
      actionId: input.action.id,
      effect: winner.effect!,
      policyId: winner.policyId,
      policyVersion: winner.policyVersion,
      ruleId: winner.ruleId,
      reason: winner.reason ?? this.#defaultReason,
      ...(winner.approval ? { approval: winner.approval } : {}),
      obligations: winner.obligations ?? [],
      evaluations,
      trace,
      decidedAt,
      evaluationMs,
    };
  }

  /** Evaluates one policy's rules in order; the first match decides. */
  #evaluatePolicy(policy: Policy, input: PolicyInput, trace: RuleTrace[]): PolicyEvaluation {
    for (const rule of policy.rules) {
      let matched = false;
      let error: string | undefined;

      try {
        matched = evaluateCondition(rule.when, input);
      } catch (cause) {
        // A rule that cannot be evaluated is treated as not matching. It can
        // never authorize an action, and the reason is preserved for the
        // operator who has to fix the policy.
        error = cause instanceof ConditionError ? cause.message : String(cause);
      }

      trace.push({
        policyId: policy.id,
        policyVersion: policy.version,
        ruleId: rule.id,
        matched,
        ...(matched ? { effect: rule.effect, reason: rule.reason } : {}),
        ...(error ? { error } : {}),
      });

      if (!matched) continue;

      return {
        policyId: policy.id,
        policyVersion: policy.version,
        applied: true,
        effect: rule.effect,
        reason: rule.reason,
        ruleId: rule.id,
        ...(rule.approval ? { approval: normalizeApproval(rule.approval) } : {}),
        ...(rule.obligations ? { obligations: rule.obligations } : {}),
      };
    }

    trace.push({
      policyId: policy.id,
      policyVersion: policy.version,
      ruleId: '(fallback)',
      matched: true,
      effect: policy.fallback.effect,
      reason: policy.fallback.reason,
    });

    return {
      policyId: policy.id,
      policyVersion: policy.version,
      applied: true,
      effect: policy.fallback.effect,
      reason: policy.fallback.reason,
      ruleId: '(fallback)',
    };
  }
}

/** Fills in the defaults a REQUIRE_APPROVAL rule may omit. */
function normalizeApproval(approval: NonNullable<Policy['rules'][number]['approval']>) {
  return {
    ...approval,
    minApprovals: approval.minApprovals ?? 1,
    expiresInSeconds: approval.expiresInSeconds ?? 3600,
  };
}

/**
 * Picks the winning evaluation: strictest effect first, then the policy that
 * declared it. Ties are broken by policy id so the same inputs always name the
 * same policy in the decision — an auditor comparing two runs should see the
 * same citation.
 */
function selectStrictest(evaluations: readonly PolicyEvaluation[]): PolicyEvaluation | undefined {
  let winner: PolicyEvaluation | undefined;

  for (const evaluation of evaluations) {
    if (!evaluation.applied || !evaluation.effect) continue;
    if (!winner) {
      winner = evaluation;
      continue;
    }
    const current = EFFECT_SEVERITY[evaluation.effect];
    const best = EFFECT_SEVERITY[winner.effect!];
    if (current > best || (current === best && evaluation.policyId < winner.policyId)) {
      winner = evaluation;
    }
  }

  return winner;
}

function comparePolicies(left: Policy, right: Policy): number {
  return left.id.localeCompare(right.id);
}

/**
 * Digest over the decision trace. Evidence stores this rather than the whole
 * trace, so a tampered trace is detectable without duplicating it.
 */
export function traceDigest(trace: readonly RuleTrace[]): string {
  return digest(trace);
}
