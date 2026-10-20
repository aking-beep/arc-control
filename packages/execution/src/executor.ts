import {
  digest,
  newId,
  redactDeep,
  type Action,
  type AgentPrincipal,
  type ExecutionAttempt,
  type Tool,
} from '@arc-control/schemas';
import { ConnectorError, type Connector } from './connector.js';

export interface ExecutorOptions {
  /** Wall-clock budget for a single attempt. */
  readonly timeoutMs?: number;
  /**
   * Attempts for a retryable failure on a `read` tool. Writes and irreversible
   * actions are never retried automatically: one authorization, one effect.
   */
  readonly maxReadAttempts?: number;
  readonly now?: () => Date;
}

/**
 * Runs an authorized action against its connector and records what happened.
 *
 * The executor is the last link in the chain and deliberately the dumbest. It
 * does not consult policy, does not decide whether an action is permitted and
 * cannot be reached except through the gateway. Its only jobs are to apply a
 * deadline, to be truthful about the outcome, and to never retry something
 * that might take effect twice.
 */
export class Executor {
  readonly #timeoutMs: number;
  readonly #maxReadAttempts: number;
  readonly #now: () => Date;

  constructor(options: ExecutorOptions = {}) {
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#maxReadAttempts = Math.max(1, options.maxReadAttempts ?? 2);
    this.#now = options.now ?? (() => new Date());
  }

  async execute(args: {
    readonly connector: Connector;
    readonly action: Action;
    readonly tool: Tool;
    readonly principal: AgentPrincipal;
  }): Promise<{ readonly attempt: ExecutionAttempt; readonly output?: unknown }> {
    const maxAttempts = args.tool.effect === 'read' ? this.#maxReadAttempts : 1;
    let last!: Outcome;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      last = await this.#attempt(args, attempt);
      if (last.attempt.status === 'succeeded') return last;
      if (!last.retryable || attempt >= maxAttempts) return last;
    }

    return last;
  }

  async #attempt(
    args: {
      readonly connector: Connector;
      readonly action: Action;
      readonly tool: Tool;
      readonly principal: AgentPrincipal;
    },
    attempt: number,
  ): Promise<Outcome> {
    const startedAt = this.#now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('execution timed out')), this.#timeoutMs);

    const base = {
      id: newId('execution'),
      actionId: args.action.id,
      connector: args.connector.name,
      startedAt: startedAt.toISOString(),
      attempt,
    };

    try {
      const result = await args.connector.execute({
        action: args.action,
        tool: args.tool,
        principal: args.principal,
        signal: controller.signal,
        attempt,
      });

      const finishedAt = this.#now();
      const redacted = redactDeep(result.output);

      return {
        attempt: {
          ...base,
          status: 'succeeded',
          finishedAt: finishedAt.toISOString(),
          durationMs: finishedAt.getTime() - startedAt.getTime(),
          result: redacted,
          resultDigest: digest(result.output),
        },
        output: result.output,
      };
    } catch (cause) {
      const finishedAt = this.#now();
      const failure = describeFailure(cause, controller.signal);
      return {
        attempt: {
          ...base,
          status: 'failed',
          finishedAt: finishedAt.toISOString(),
          durationMs: finishedAt.getTime() - startedAt.getTime(),
          error: { code: failure.code, message: failure.message },
        },
        retryable: failure.retryable,
      };
    } finally {
      clearTimeout(timer);
    }
  }

}

interface Outcome {
  readonly attempt: ExecutionAttempt;
  readonly output?: unknown;
  /** Whether the connector said this failure is safe to try again. */
  readonly retryable?: boolean;
}

/**
 * Normalizes whatever a connector threw. A `ConnectorError` keeps its own code
 * in the evidence record and reports its retryability separately; a timeout is
 * reported as such and is never retried, because a request that timed out may
 * well have taken effect. Anything else becomes an opaque `connector_error`,
 * since a stray exception message is not a contract.
 */
function describeFailure(
  cause: unknown,
  signal: AbortSignal,
): { code: string; message: string; retryable: boolean } {
  if (signal.aborted) {
    return {
      code: 'timeout',
      message: 'the connector did not respond within the execution budget',
      retryable: false,
    };
  }
  if (cause instanceof ConnectorError) {
    return { code: cause.code, message: cause.message, retryable: cause.retryable };
  }
  if (cause instanceof Error) {
    return { code: 'connector_error', message: cause.message, retryable: false };
  }
  return { code: 'connector_error', message: String(cause), retryable: false };
}
