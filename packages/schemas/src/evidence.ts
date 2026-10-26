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

  readonly outcome: string;
  readonly obligations: readonly string[];
  readonly createdAt: string;
  /** Digest over every field above. Changing any of them invalidates the record. */
  readonly integrityDigest: string;
}
