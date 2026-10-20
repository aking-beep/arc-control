import type { Action, AgentPrincipal, Tool } from '@arc-control/schemas';

/**
 * What a connector is told about an execution it has been cleared to perform.
 * Note what is absent: the connector never sees the policy, the decision or
 * the approval. By the time it is called, authorization has already happened,
 * and a connector cannot second-guess, re-interpret or bypass it.
 */
export interface ExecutionContext {
  readonly action: Action;
  readonly tool: Tool;
  readonly principal: AgentPrincipal;
  /** Deadline after which the gateway abandons the attempt. */
  readonly signal: AbortSignal;
  /** Attempt number, starting at 1. */
  readonly attempt: number;
}

export interface ConnectorResult {
  /** Payload returned to the agent. Redacted before it reaches evidence. */
  readonly output: unknown;
  /** Connector-specific detail for traces, e.g. an HTTP status. */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * A connector turns an authorized action into a real effect on a real system.
 *
 * Implementations must be honest about failure: a connector that swallows an
 * error and returns success writes a false evidence record, which is worse
 * than no evidence at all.
 */
export interface Connector {
  /** Identifier referenced by `Tool.connector`. */
  readonly name: string;
  /** Whether this connector can execute the given tool, checked at registration. */
  supports(tool: Tool): boolean;
  execute(context: ExecutionContext): Promise<ConnectorResult>;
  /** Optional readiness probe surfaced on the API's health endpoint. */
  health?(): Promise<{ readonly healthy: boolean; readonly detail?: string }>;
}

/**
 * Thrown by a connector to describe a failure precisely. Anything else a
 * connector throws is still caught and recorded, but loses this detail.
 */
export class ConnectorError extends Error {
  readonly code: string;
  /** Whether the gateway may safely try again. Defaults to false: retrying a write is not safe by default. */
  readonly retryable: boolean;
  readonly metadata: Readonly<Record<string, unknown>>;

  constructor(
    code: string,
    message: string,
    options: { retryable?: boolean; metadata?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ConnectorError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.metadata = options.metadata ?? {};
  }
}
