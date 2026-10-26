/**
 * The policy model.
 *
 * A policy is a document an auditor can read. It matches a set of agents and
 * tools, then evaluates ordered rules against the requested action. The first
 * rule whose condition holds decides; if none holds, the policy's fallback
 * effect applies. Conditions are a small, closed expression language — there
 * is no embedded code, so evaluation is total, side-effect free and the same
 * every time.
 */

import type { ActionRiskClass, Reversibility } from './classification.js';

/** The three outcomes ARC Control can produce for an action. */
export type PolicyEffect = 'ALLOW' | 'REQUIRE_APPROVAL' | 'DENY';

/**
 * Severity ordering used to combine the decisions of several policies.
 * The strictest effect across all matching policies wins, always.
 */
export const EFFECT_SEVERITY: Record<PolicyEffect, number> = {
  ALLOW: 0,
  REQUIRE_APPROVAL: 1,
  DENY: 2,
};

/** Operand: either a literal, or a `$.`-prefixed reference into the evaluation input. */
export type Operand = string | number | boolean | null | readonly (string | number | boolean)[];

export type Condition =
  | { readonly always: true }
  | { readonly eq: readonly [Operand, Operand] }
  | { readonly ne: readonly [Operand, Operand] }
  | { readonly gt: readonly [Operand, Operand] }
  | { readonly gte: readonly [Operand, Operand] }
  | { readonly lt: readonly [Operand, Operand] }
  | { readonly lte: readonly [Operand, Operand] }
  | { readonly in: readonly [Operand, Operand] }
  | { readonly nin: readonly [Operand, Operand] }
  | { readonly contains: readonly [Operand, Operand] }
  | { readonly startsWith: readonly [Operand, Operand] }
  | { readonly endsWith: readonly [Operand, Operand] }
  /** JavaScript regular expression syntax. A leading `(?i)` is honoured as a case-insensitive flag. */
  | { readonly matches: readonly [Operand, string] }
  | { readonly exists: Operand }
  | { readonly and: readonly Condition[] }
  | { readonly or: readonly Condition[] }
  | { readonly not: Condition };

/** All supported condition operators, for validation and tooling. */
export const CONDITION_OPERATORS = [
  'always', 'eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'nin',
  'contains', 'startsWith', 'endsWith', 'matches', 'exists', 'and', 'or', 'not',
] as const;

export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];

/**
 * Who must approve, and for how long the request stays open. Attached to a
 * REQUIRE_APPROVAL rule so the policy — not the calling code — decides who
 * holds the authority.
 */
export interface ApprovalRequirement {
  /** Approver selectors: `role:finance-manager`, `user:cfo@example.com`, `owner`. */
  readonly approvers: readonly string[];
  /** Distinct approvals needed before the action may execute. Defaults to 1. */
  readonly minApprovals?: number;
  /** How long the request stays actionable. Defaults to 3600 seconds. */
  readonly expiresInSeconds?: number;
  /** Forbids the agent's own owner from approving when the owner is also an approver. */
  readonly requireSeparationOfDuties?: boolean;
}

export interface PolicyRule {
  /** Stable identifier, cited verbatim in decisions and evidence. */
  readonly id: string;
  readonly description?: string;
  readonly when: Condition;
  readonly effect: PolicyEffect;
  /** The explanation an operator or auditor reads. Required: a decision without a reason is not auditable. */
  readonly reason: string;
  readonly approval?: ApprovalRequirement;
  /** Obligations the gateway must honour when this rule decides, e.g. `redact:pii`. */
  readonly obligations?: readonly string[];
}

/** Narrows which actions a policy applies to. An omitted selector matches everything. */
export interface PolicyMatch {
  /** Agent names or `role:<role>` selectors. */
  readonly agents?: readonly string[];
  /** Tool names; a trailing `*` matches a prefix, e.g. `stripe.*`. */
  readonly tools?: readonly string[];
  readonly systems?: readonly string[];
  readonly environments?: readonly string[];
  readonly effects?: readonly ('read' | 'write' | 'irreversible')[];
}

export interface Policy {
  /** Operator-facing identifier cited in decisions, e.g. `FINANCE-004`. */
  readonly id: string;
  readonly version: number;
  readonly name: string;
  readonly description?: string;
  readonly enabled: boolean;
  readonly match: PolicyMatch;
  readonly rules: readonly PolicyRule[];
  /** Applied when the policy matches but no rule condition holds. */
  readonly fallback: { readonly effect: PolicyEffect; readonly reason: string };
  readonly labels?: Readonly<Record<string, string>>;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

/** The input a condition is evaluated against. Referenced as `$.agent.name`, `$.action.parameters.amount`, and so on. */
export interface PolicyInput {
  readonly agent: {
    readonly id: string;
    readonly name: string;
    readonly kind: string;
    readonly environment: string;
    readonly owner: string;
    readonly roles: readonly string[];
    readonly labels: Readonly<Record<string, string>>;
  };
  readonly tool: {
    readonly name: string;
    readonly system: string;
    readonly effect: string;
    readonly riskTier: string;
    readonly labels: Readonly<Record<string, string>>;
  };
  readonly action: {
    readonly id: string;
    readonly parameters: Readonly<Record<string, unknown>>;
    /**
     * Deterministic risk classification of this action, available to rules as
     * `$.action.risk.class`, `$.action.risk.reversibility` and
     * `$.action.risk.sensitive`.
     *
     * Optional because a 1.0 caller building its own input does not supply
     * it, and a rule referencing an absent value simply does not match —
     * which fails closed for an ALLOW rule and is therefore the safe way for
     * the field to be missing.
     */
    readonly risk?: {
      readonly class: ActionRiskClass;
      readonly reversibility: Reversibility;
      readonly sensitive: boolean;
    };
  };
  readonly context: {
    readonly environment: string;
    readonly requestedAt: string;
    /** Hour of day, UTC, 0-23. Lets policy express business-hours constraints. */
    readonly hourUtc: number;
    readonly dayOfWeekUtc: number;
    readonly source?: string;
    readonly correlationId?: string;
  };
}

/** Why a single rule did or did not decide. Together these form the decision trace. */
export interface RuleTrace {
  readonly policyId: string;
  readonly policyVersion: number;
  readonly ruleId: string;
  readonly matched: boolean;
  readonly effect?: PolicyEffect;
  readonly reason?: string;
  /** Present when the condition could not be evaluated; the rule is then treated as not matching. */
  readonly error?: string;
}

export interface PolicyEvaluation {
  readonly policyId: string;
  readonly policyVersion: number;
  readonly applied: boolean;
  readonly effect?: PolicyEffect;
  readonly reason?: string;
  readonly ruleId?: string;
  readonly approval?: ApprovalRequirement;
  readonly obligations?: readonly string[];
}

/** The gateway's authorization decision for one action. */
export interface Decision {
  readonly id: string;
  readonly actionId: string;
  readonly effect: PolicyEffect;
  /** Policy that produced the winning effect; absent only when no policy matched. */
  readonly policyId?: string;
  readonly policyVersion?: number;
  readonly ruleId?: string;
  readonly reason: string;
  readonly approval?: ApprovalRequirement;
  readonly obligations: readonly string[];
  /** Every policy considered, in priority order. */
  readonly evaluations: readonly PolicyEvaluation[];
  /** Every rule examined. The auditable record of how the decision was reached. */
  readonly trace: readonly RuleTrace[];
  readonly decidedAt: string;
  readonly evaluationMs: number;
}


/**
 * One entry in a policy's version history.
 *
 * 1.0 stored the current policy and bumped `version` on publish, which
 * answered "what does policy say now" but not "who changed it, when, and
 * from what" — the question an auditor actually asks, and the one that makes
 * a permission change defensible. Each publish now appends the full previous
 * document alongside the new one, so any two versions can be diffed and every
 * change has a name against it.
 *
 * History is append-only and never pruned by ARC: a retention decision about
 * who authorized a permission change belongs to the customer, not to us.
 */
export interface PolicyVersionRecord {
  readonly id: string;
  readonly policyId: string;
  readonly version: number;
  /** The document as published at this version. */
  readonly document: Policy;
  /** The document this replaced. Absent for the first version. */
  readonly previous?: Policy;
  /** Operator who published it. */
  readonly publishedBy: string;
  /** How it was published: `api`, `console`, `cli` or `system` for a seed. */
  readonly via: string;
  readonly publishedAt: string;
  /** Digest over `document`, so a history entry can be checked against an export. */
  readonly documentDigest: string;
  /** Summary of what changed, computed at publish time. */
  readonly changes: readonly PolicyChange[];
}

export interface PolicyChange {
  readonly kind:
    | 'enabled'
    | 'disabled'
    | 'rule_added'
    | 'rule_removed'
    | 'rule_changed'
    | 'match_changed'
    | 'fallback_changed'
    | 'metadata_changed';
  readonly detail: string;
  /** Rule id, when the change concerns one rule. */
  readonly ruleId?: string;
}
