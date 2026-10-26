/**
 * An action is a single thing an agent asked to do. It is recorded before any
 * decision is made, so a denied action is as durable as an executed one — the
 * attempt is itself the security signal.
 */
export interface ActionRequest {
  /** Tool name, e.g. `stripe.refund`. */
  readonly tool: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  /** Caller-supplied idempotency key. Repeats return the original outcome. */
  readonly idempotencyKey?: string;
  /** Free-text intent from the agent. Advisory only: never used in policy decisions. */
  readonly intent?: string;
  /** Ties the action to an agent run or upstream trace. */
  readonly correlationId?: string;
}

export interface Action {
  readonly id: string;
  readonly agentId: string;
  readonly agentName: string;
  readonly organizationId: string;
  readonly environment: string;
  readonly tool: string;
  readonly toolId: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  /** Digest of the parameters as submitted, before any redaction. */
  readonly parametersDigest: string;
  readonly idempotencyKey?: string;
  readonly intent?: string;
  readonly correlationId?: string;
  /**
   * How the action reached ARC: `api`, `mcp`, `cli`, `sdk` or `internal`.
   *
   * Recorded, never used to decide — but recorded so that *re-deciding* is
   * faithful. A rule reading `$.context.source` is evaluated again when a held
   * action is released and when a policy change is replayed against past
   * traffic, and without this the re-evaluation would see no source and a rule
   * naming one would stop matching. Optional because actions written before
   * 2.2 do not carry it; such a rule still does not match for those.
   */
  readonly source?: string;
  readonly requestedAt: string;
}

export type ActionOutcome =
  | 'allowed'
  | 'denied'
  | 'pending_approval'
  | 'approved'
  | 'rejected'
  | 'expired'
  | 'executed'
  | 'failed';

export interface ExecutionAttempt {
  readonly id: string;
  readonly actionId: string;
  readonly connector: string;
  readonly status: 'succeeded' | 'failed';
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  /** Connector response, redacted according to the tool's sensitive parameters. */
  readonly result?: unknown;
  readonly resultDigest?: string;
  readonly error?: { readonly code: string; readonly message: string };
  readonly attempt: number;
}

/** What the gateway returns to the calling agent. */
export interface ActionResult {
  readonly actionId: string;
  readonly outcome: ActionOutcome;
  readonly decision: {
    readonly effect: 'ALLOW' | 'REQUIRE_APPROVAL' | 'DENY';
    readonly policyId?: string;
    readonly ruleId?: string;
    readonly reason: string;
  };
  readonly evidenceId: string;
  /** Present when the action executed. */
  readonly result?: unknown;
  /** Present when the action is waiting on a human. */
  readonly approvalId?: string;
  readonly error?: { readonly code: string; readonly message: string };
  readonly completedAt: string;
}
