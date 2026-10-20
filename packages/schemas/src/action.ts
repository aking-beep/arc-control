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
