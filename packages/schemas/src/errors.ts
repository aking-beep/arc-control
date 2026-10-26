/**
 * Error codes ARC Control returns to callers. They are part of the API
 * contract: an SDK or connector may branch on the code, never on the message.
 */
export type ArcErrorCode =
  | 'unauthenticated'
  | 'agent_suspended'
  | 'unknown_tool'
  /** The tool exists but its kill switch is on. */
  | 'tool_disabled'
  /** The agent exceeded a configured action rate limit. */
  | 'rate_limited'
  | 'invalid_parameters'
  | 'policy_denied'
  | 'approval_required'
  | 'approval_expired'
  | 'approval_rejected'
  | 'execution_failed'
  | 'connector_unavailable'
  | 'not_found'
  | 'conflict'
  | 'invalid_request'
  | 'internal';

export interface ArcErrorOptions {
  readonly details?: Record<string, unknown>;
  readonly cause?: unknown;
}

export class ArcError extends Error {
  readonly code: ArcErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: ArcErrorCode, message: string, options: ArcErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ArcError';
    this.code = code;
    this.details = options.details ?? {};
  }

  /** HTTP status the API surface maps this error to. */
  get httpStatus(): number {
    return HTTP_STATUS_BY_CODE[this.code];
  }

  toJSON(): { error: { code: ArcErrorCode; message: string; details: Record<string, unknown> } } {
    return { error: { code: this.code, message: this.message, details: this.details } };
  }
}

const HTTP_STATUS_BY_CODE: Record<ArcErrorCode, number> = {
  unauthenticated: 401,
  agent_suspended: 403,
  unknown_tool: 404,
  // The tool is there; ARC is refusing to run it. 403 rather than 404 so an
  // agent can tell "you may not" from "no such thing", which matters when
  // the operator has just hit the kill switch mid-incident.
  tool_disabled: 403,
  rate_limited: 429,
  invalid_parameters: 400,
  policy_denied: 403,
  // A conflict, not an acceptance. This code is raised when a caller tries to
  // release an action nobody has approved yet — the request was refused, not
  // queued. The 202 that a *held* action returns is set by the submit route
  // from a successful result, never from an error.
  approval_required: 409,
  approval_expired: 409,
  approval_rejected: 403,
  execution_failed: 502,
  connector_unavailable: 503,
  not_found: 404,
  conflict: 409,
  invalid_request: 400,
  internal: 500,
};

export function isArcError(value: unknown): value is ArcError {
  return value instanceof ArcError;
}

/** Wraps anything thrown by untrusted code in a well-formed ArcError. */
export function toArcError(cause: unknown, fallbackCode: ArcErrorCode = 'internal'): ArcError {
  if (isArcError(cause)) return cause;
  const message = cause instanceof Error ? cause.message : String(cause);
  return new ArcError(fallbackCode, message, { cause });
}
