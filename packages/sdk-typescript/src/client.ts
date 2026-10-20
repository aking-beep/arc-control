import { ArcError, type ActionRequest, type ActionResult, type ArcErrorCode } from '@arc-control/schemas';

export interface ArcControlClientOptions {
  /** Base URL of the ARC Control API, e.g. `https://control.example.com`. */
  readonly baseUrl: string;
  /** Agent API key. Required for the agent surface. */
  readonly apiKey?: string;
  /** Operator token. Required for the operator surface. */
  readonly operatorToken?: string;
  /** Identity recorded against operator actions such as approvals. */
  readonly operatorIdentity?: string;
  readonly operatorRoles?: readonly string[];
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * Client for the ARC Control API.
 *
 * The agent and operator surfaces are separate methods with separate
 * credentials, mirroring the API: an agent integration constructs this with
 * `apiKey` alone and gets exactly one capability — submitting an action for a
 * decision.
 */
export class ArcControlClient {
  readonly #baseUrl: string;
  readonly #apiKey: string | undefined;
  readonly #operatorToken: string | undefined;
  readonly #operatorIdentity: string | undefined;
  readonly #operatorRoles: readonly string[];
  readonly #timeoutMs: number;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: ArcControlClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#apiKey = options.apiKey;
    this.#operatorToken = options.operatorToken;
    this.#operatorIdentity = options.operatorIdentity;
    this.#operatorRoles = options.operatorRoles ?? [];
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  // --- the agent surface --------------------------------------------------

  /**
   * Submits an action for a decision.
   *
   * A denial is a successful call that returns `outcome: 'denied'`, not a
   * thrown error: the agent asked, policy answered, and the answer was no.
   * Treating that as an exception encourages callers to swallow it.
   */
  async act(request: ActionRequest): Promise<ActionResult> {
    return this.#request<ActionResult>('POST', '/v1/actions', request, 'agent');
  }

  /** Asks what policy would do, without recording or executing anything. */
  async explain(request: Pick<ActionRequest, 'tool' | 'parameters'>): Promise<{
    effect: 'ALLOW' | 'REQUIRE_APPROVAL' | 'DENY';
    policyId?: string;
    ruleId?: string;
    reason: string;
  }> {
    return this.#request('POST', '/v1/actions/explain', request, 'agent');
  }

  // --- the operator surface -----------------------------------------------

  async health(): Promise<Record<string, unknown>> {
    return this.#request('GET', '/health', undefined, 'none');
  }

  async listAgents(): Promise<{ agents: readonly Record<string, unknown>[] }> {
    return this.#request('GET', '/v1/agents', undefined, 'operator');
  }

  async listTools(): Promise<{ tools: readonly Record<string, unknown>[] }> {
    return this.#request('GET', '/v1/tools', undefined, 'operator');
  }

  async listPolicies(): Promise<{ policies: readonly Record<string, unknown>[] }> {
    return this.#request('GET', '/v1/policies', undefined, 'operator');
  }

  async setPolicyEnabled(policyId: string, enabled: boolean): Promise<Record<string, unknown>> {
    return this.#request('POST', `/v1/policies/${policyId}/${enabled ? 'enable' : 'disable'}`, {}, 'operator');
  }

  async listApprovals(options: { mine?: boolean } = {}): Promise<{ approvals: readonly Record<string, unknown>[] }> {
    return this.#request('GET', `/v1/approvals${options.mine ? '?mine=true' : ''}`, undefined, 'operator');
  }

  async vote(approvalId: string, vote: 'approve' | 'reject', comment?: string): Promise<Record<string, unknown>> {
    return this.#request('POST', `/v1/approvals/${approvalId}/vote`, { vote, comment }, 'operator');
  }

  /** Executes an approved action. */
  async executeApproved(approvalId: string): Promise<ActionResult> {
    return this.#request('POST', `/v1/approvals/${approvalId}/execute`, {}, 'operator');
  }

  async listEvidence(
    query: { agentId?: string; outcome?: string; limit?: number } = {},
  ): Promise<{ evidence: readonly Record<string, unknown>[] }> {
    const search = new URLSearchParams();
    if (query.agentId) search.set('agentId', query.agentId);
    if (query.outcome) search.set('outcome', query.outcome);
    if (query.limit !== undefined) search.set('limit', String(query.limit));
    const suffix = search.size > 0 ? `?${search.toString()}` : '';
    return this.#request('GET', `/v1/evidence${suffix}`, undefined, 'operator');
  }

  async getEvidence(evidenceId: string): Promise<Record<string, unknown>> {
    return this.#request('GET', `/v1/evidence/${evidenceId}`, undefined, 'operator');
  }

  async getDecision(decisionId: string): Promise<Record<string, unknown>> {
    return this.#request('GET', `/v1/decisions/${decisionId}`, undefined, 'operator');
  }

  async listAudit(
    query: { limit?: number; afterSequence?: number; order?: 'asc' | 'desc' } = {},
  ): Promise<{ records: readonly Record<string, unknown>[]; total: number }> {
    const search = new URLSearchParams();
    if (query.limit !== undefined) search.set('limit', String(query.limit));
    if (query.afterSequence !== undefined) search.set('afterSequence', String(query.afterSequence));
    if (query.order) search.set('order', query.order);
    const suffix = search.size > 0 ? `?${search.toString()}` : '';
    return this.#request('GET', `/v1/audit${suffix}`, undefined, 'operator');
  }

  async verifyAudit(): Promise<{ valid: boolean; recordsChecked: number; failures: readonly unknown[] }> {
    return this.#request('GET', '/v1/audit/verify', undefined, 'operator');
  }

  async suspendAgent(agentId: string): Promise<Record<string, unknown>> {
    return this.#request('POST', `/v1/agents/${agentId}/suspend`, {}, 'operator');
  }

  async resumeAgent(agentId: string): Promise<Record<string, unknown>> {
    return this.#request('POST', `/v1/agents/${agentId}/resume`, {}, 'operator');
  }

  // --- transport ----------------------------------------------------------

  async #request<T>(
    method: string,
    path: string,
    body: unknown,
    credential: 'agent' | 'operator' | 'none',
  ): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };

    if (credential === 'agent') {
      if (!this.#apiKey) throw new ArcError('unauthenticated', 'this client was constructed without an agent apiKey');
      headers.authorization = `Bearer ${this.#apiKey}`;
    } else if (credential === 'operator') {
      if (!this.#operatorToken) {
        throw new ArcError('unauthenticated', 'this client was constructed without an operatorToken');
      }
      headers.authorization = `Bearer ${this.#operatorToken}`;
      if (this.#operatorIdentity) headers['x-arc-operator'] = this.#operatorIdentity;
      if (this.#operatorRoles.length > 0) headers['x-arc-operator-roles'] = this.#operatorRoles.join(',');
    }

    if (body !== undefined) headers['content-type'] = 'application/json';

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);

    try {
      const response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });

      const text = await response.text();
      const payload: unknown = text ? safeParse(text) : undefined;

      if (!response.ok) {
        // A 202 means the action is held for approval, which `act()` returns
        // as a normal result rather than an error.
        if (response.status === 202) return payload as T;
        throw fromErrorBody(payload, response.status);
      }

      return payload as T;
    } catch (cause) {
      if (cause instanceof ArcError) throw cause;
      if (controller.signal.aborted) {
        throw new ArcError('internal', `the ARC Control API did not respond within ${this.#timeoutMs}ms`);
      }
      throw new ArcError('internal', `could not reach the ARC Control API: ${describe(cause)}`, { cause });
    } finally {
      clearTimeout(timer);
    }
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Rebuilds an ArcError from the API's error envelope, so codes survive the wire. */
function fromErrorBody(payload: unknown, status: number): ArcError {
  if (
    typeof payload === 'object' &&
    payload !== null &&
    'error' in payload &&
    typeof (payload as { error: unknown }).error === 'object'
  ) {
    const error = (payload as { error: { code?: string; message?: string; details?: Record<string, unknown> } }).error;
    return new ArcError(
      (error.code ?? 'internal') as ArcErrorCode,
      error.message ?? `the ARC Control API returned HTTP ${status}`,
      error.details ? { details: error.details } : {},
    );
  }
  return new ArcError('internal', `the ARC Control API returned HTTP ${status}`);
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
