import type { ActionRiskAssessment } from './classification.js';

/**
 * Evidence is the durable answer to "what did this agent try to do, who or
 * what authorized it, and what actually happened?". One evidence record per
 * action, written whether the action was allowed, denied or abandoned waiting
 * on a human.
 *
 * Evidence is self-contained on purpose: it can be exported to an auditor
 * without granting access to ARC Control itself.
 */
import type { IdentityAssurance } from './operator.js';

/**
 * What ARC re-checked immediately before a released action reached its
 * connector.
 *
 * An approval is a statement about the past: a human agreed to an action under
 * the rules that were in force when they were asked. Between that moment and
 * the connector call an operator can publish a deny policy, hit a tool's kill
 * switch or retire the agent, and until 2.2 none of those reached a release
 * that was already approved — the stored decision executed unchanged. This
 * block is the record of the second look, written whether it let the action
 * through or stopped it, so an auditor can see that current policy was
 * consulted rather than take it on trust.
 *
 * Absent on records written before 2.2, and on the submit path, where the
 * decision and the connector call sit microseconds apart inside one call.
 */
export interface EvidenceRevalidation {
  readonly performedAt: string;
  /** Effect the policies in force at release time produced. */
  readonly effect: 'ALLOW' | 'REQUIRE_APPROVAL' | 'DENY';
  /** What ARC did about it. */
  readonly verdict: 'proceeded' | 'denied' | 'reapproval_required';
  /** The fresh decision recorded at release time. The original is untouched. */
  readonly decisionId?: string;
  readonly policyId?: string;
  readonly policyVersion?: number;
  readonly ruleId?: string;
  readonly reason: string;
  /**
   * Agent lifecycle status as read immediately before execution.
   *
   * Always `active` on a record that exists, because a release by an agent
   * that is anything else is refused before policy is consulted. It is
   * recorded rather than implied so a reader can see the check happened.
   */
  readonly agentStatus: string;
  /** Whether the tool's kill switch was on at release time. Always false, for the same reason. */
  readonly toolDisabled: boolean;
  /** Whether the approval still named this action and the decision it was granted against. */
  readonly approvalBound: boolean;
  /** The approval that was consumed to authorize the release. */
  readonly approvalId?: string;
  /** Approval opened because current policy demands authority the held one did not carry. */
  readonly supersedingApprovalId?: string;
  /** Digest of the re-evaluation trace, so the rule-by-rule path is checkable. */
  readonly traceDigest?: string;
}

export interface EvidenceRecord {
  /** `arc_ev_...` — the identifier quoted in a denial message or a compliance export. */
  readonly id: string;
  readonly schemaVersion: 1;
  readonly actionId: string;
  readonly organizationId: string;
  readonly environment: string;

  readonly agent: {
    readonly id: string;
    readonly name: string;
    readonly owner: string;
    readonly roles: readonly string[];
    readonly credentialId: string;
  };

  readonly tool: {
    readonly name: string;
    readonly system: string;
    readonly effect: string;
    readonly riskTier: string;
    readonly connector: string;
  };

  readonly request: {
    readonly parameters: Readonly<Record<string, unknown>>;
    readonly parametersDigest: string;
    readonly intent?: string;
    readonly correlationId?: string;
    readonly requestedAt: string;
  };

  readonly decision: {
    readonly id: string;
    readonly effect: 'ALLOW' | 'REQUIRE_APPROVAL' | 'DENY';
    readonly policyId?: string;
    readonly policyVersion?: number;
    readonly ruleId?: string;
    readonly reason: string;
    readonly decidedAt: string;
    readonly evaluationMs: number;
    readonly traceDigest: string;
  };

  readonly approval?: {
    readonly id: string;
    readonly status: string;
    readonly approvers: readonly string[];
    readonly minApprovals: number;
    readonly votes: readonly {
      readonly approver: string;
      readonly vote: string;
      readonly votedAt: string;
      /**
       * How the approver's identity was established, copied from the vote.
       *
       * Here as well as on the approval record because evidence is what gets
       * exported to an auditor, and an exported approval that does not say
       * whether the name was verified invites the reader to assume it was.
       */
      readonly assurance?: IdentityAssurance;
      readonly issuer?: string;
    }[];
    readonly resolvedAt?: string;
  };

  readonly execution?: {
    readonly id: string;
    readonly connector: string;
    readonly status: 'succeeded' | 'failed';
    readonly startedAt: string;
    readonly finishedAt: string;
    readonly durationMs: number;
    readonly resultDigest?: string;
    readonly error?: { readonly code: string; readonly message: string };
  };

  /**
   * How ARC classified the action's risk at decision time.
   *
   * Recorded so an auditor can see why an action was treated as sensitive
   * without re-deriving it from a tool definition that may since have
   * changed. Optional because records written before 2.0 have none, and
   * because the classification is advisory: it informed policy, it did not
   * decide.
   */
  readonly risk?: ActionRiskAssessment;

  /**
   * The pre-execution revalidation, when the action took the release path.
   *
   * See `EvidenceRevalidation`. Optional because an action decided and
   * executed in one call has no second look to report, and because records
   * written before 2.2 have none.
   */
  readonly revalidation?: EvidenceRevalidation;

  readonly outcome: string;
  readonly obligations: readonly string[];
  readonly createdAt: string;
  /** Digest over every field above. Changing any of them invalidates the record. */
  readonly integrityDigest: string;
}
