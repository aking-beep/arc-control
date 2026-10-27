import {
  EFFECT_SEVERITY,
  type Decision,
  type PolicyEffect,
  type PolicyEvaluation,
  type RuleTrace,
} from '@arc-control/schemas';

/**
 * Folds evaluations from outside policy — budgets, today — into a decision
 * the policy engine has already made, **without ever loosening it**.
 *
 * This is the mechanism ADR-0002 chose over synthesizing a policy per budget.
 * A synthesized policy needs a fallback, and an ALLOW fallback would authorize
 * actions the engine's default DENY refuses: adding a budget would widen what
 * an agent can do. Folding afterwards cannot, by construction:
 *
 *  - the decision's effect is replaced only by a **strictly** stricter one;
 *  - an extra evaluation whose effect is not one of the three known effects is
 *    read as DENY, so a malformed input fails closed instead of being skipped;
 *  - every extra evaluation, applied or not, is appended to `evaluations` and
 *    `trace`, so the record shows it was consulted.
 *
 * When an extra evaluation wins, it is cited in place of the policy — its id,
 * version, rule, reason and approval requirement — and the allowing policy's
 * obligations are dropped, because they described an action that is no
 * longer going ahead as decided. On a tie the policy's citation stands: a
 * policy that already holds the action names its own approvers.
 */
export function tighten(decision: Decision, extra: readonly PolicyEvaluation[]): Decision {
  if (extra.length === 0) return decision;

  const evaluations = extra.map(normalize);
  const trace: RuleTrace[] = evaluations.map((evaluation) => ({
    policyId: evaluation.policyId,
    policyVersion: evaluation.policyVersion,
    ruleId: evaluation.ruleId ?? '(not applied)',
    matched: evaluation.applied,
    ...(evaluation.applied && evaluation.effect ? { effect: evaluation.effect } : {}),
    ...(evaluation.reason ? { reason: evaluation.reason } : {}),
  }));

  let winner: PolicyEvaluation | undefined;
  for (const evaluation of evaluations) {
    if (!evaluation.applied || !evaluation.effect) continue;
    if (!winner) {
      winner = evaluation;
      continue;
    }
    const current = EFFECT_SEVERITY[evaluation.effect];
    const best = EFFECT_SEVERITY[winner.effect!];
    if (current > best || (current === best && evaluation.policyId < winner.policyId)) winner = evaluation;
  }

  const combined = {
    ...decision,
    evaluations: [...decision.evaluations, ...evaluations],
    trace: [...decision.trace, ...trace],
  };

  if (!winner || EFFECT_SEVERITY[winner.effect!] <= EFFECT_SEVERITY[decision.effect]) return combined;

  const { approval: _approval, ...rest } = combined;
  return {
    ...rest,
    effect: winner.effect!,
    policyId: winner.policyId,
    policyVersion: winner.policyVersion,
    ...(winner.ruleId ? { ruleId: winner.ruleId } : {}),
    reason: winner.reason ?? `${winner.policyId} refused this action`,
    ...(winner.effect === 'REQUIRE_APPROVAL' && winner.approval ? { approval: winner.approval } : {}),
    obligations: [],
  };
}

const KNOWN: ReadonlySet<string> = new Set<PolicyEffect>(['ALLOW', 'REQUIRE_APPROVAL', 'DENY']);

/** An applied evaluation with an effect nobody recognises is a refusal. */
function normalize(evaluation: PolicyEvaluation): PolicyEvaluation {
  if (!evaluation.applied) return evaluation;
  if (evaluation.effect !== undefined && KNOWN.has(evaluation.effect)) return evaluation;
  return {
    ...evaluation,
    effect: 'DENY',
    reason: `${evaluation.policyId} returned an unrecognised effect, refused`,
  };
}
