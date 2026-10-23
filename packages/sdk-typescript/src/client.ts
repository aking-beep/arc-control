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

  async getAgent(agentId: string): Promise<Record<string, unknown>> {
    return this.#request('GET', `/v1/agents/${encodeURIComponent(agentId)}`, undefined, 'operator');
  }

  /**
   * Credential metadata for one agent.
   *
   * Metadata only, and that is a property of the contract rather than of this
   * method: ARC Control keeps a salted hash of each key and returns the
   * plaintext once, at issue. There is no secret here to leak.
   */
  async listAgentKeys(agentId: string): Promise<{ credentials: readonly Record<string, unknown>[] }> {
    return this.#request('GET', `/v1/agents/${encodeURIComponent(agentId)}/keys`, undefined, 'operator');
  }

  async listTools(): Promise<{ tools: readonly Record<string, unknown>[] }> {
    return this.#request('GET', '/v1/tools', undefined, 'operator');
  }

  async listPolicies(): Promise<{ policies: readonly Record<string, unknown>[] }> {
    return this.#request('GET', '/v1/policies', undefined, 'operator');
  }

  async getPolicy(policyId: string): Promise<Record<string, unknown>> {
    return this.#request('GET', `/v1/policies/${encodeURIComponent(policyId)}`, undefined, 'operator');
  }

  async setPolicyEnabled(policyId: string, enabled: boolean): Promise<Record<string, unknown>> {
    return this.#request('POST', `/v1/policies/${policyId}/${enabled ? 'enable' : 'disable'}`, {}, 'operator');
  }

  /**
   * Approval requests awaiting a human.
   *
   * The API lists *pending* requests only. A resolved request stays reachable
   * by id through `getApproval`, and its outcome is in evidence and the audit
   * log; there is no endpoint that lists approval history.
   */
  async listApprovals(options: { mine?: boolean } = {}): Promise<{ approvals: readonly Record<string, unknown>[] }> {
    return this.#request('GET', `/v1/approvals${options.mine ? '?mine=true' : ''}`, undefined, 'operator');
  }

  async getApproval(approvalId: string): Promise<Record<string, unknown>> {
    return this.#request('GET', `/v1/approvals/${encodeURIComponent(approvalId)}`, undefined, 'operator');
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

  /**
   * Verifies the audit chain.
   *
   * `checkedAgainstExpectation` says whether the chain was compared with a
   * recorded head. When it is false the result means only that the records
   * present are self-consistent — truncation would not have been detected.
   * Pass a head anchored outside ARC Control to check for that.
   */
  async verifyAudit(
    expectation: { headDigest?: string; headSequence?: number } = {},
  ): Promise<{
    valid: boolean;
    recordsChecked: number;
    failures: readonly {
      readonly sequence: number;
      readonly id: string;
      readonly problem: string;
      readonly detail: string;
    }[];
    headDigest?: string;
    headSequence?: number;
    checkedAgainstExpectation: boolean;
    notice?: string;
  }> {
    const search = new URLSearchParams();
    if (expectation.headDigest) search.set('headDigest', expectation.headDigest);
    if (expectation.headSequence !== undefined) search.set('headSequence', String(expectation.headSequence));
    const suffix = search.size > 0 ? `?${search.toString()}` : '';

    // The API answers 409 when the chain does not verify. That is the
    // verification succeeding and reporting "broken", not a failed call: the
    // body is a full ChainVerification naming every problem. Throwing here
    // would leave a caller unable to tell a broken chain from an unreachable
    // API — and the broken chain is the thing an operator most needs to see.
    return this.#request('GET', `/v1/audit/verify${suffix}`, undefined, 'operator', [409]);
  }

  /**
   * Scans an MCP server manifest. Stateless: nothing is registered and no
   * result is persisted, so a report exists only in the response.
   */
  async scanMcp(manifest: {
    name: string;
    endpoint: string;
    tools?: readonly Record<string, unknown>[];
  }): Promise<Record<string, unknown>> {
    return this.#request('POST', '/v1/mcp/scan', { tools: [], ...manifest }, 'operator');
  }

  async suspendAgent(agentId: string): Promise<Record<string, unknown>> {
    return this.#request('POST', `/v1/agents/${agentId}/suspend`, {}, 'operator');
  }

  async resumeAgent(agentId: string): Promise<Record<string, unknown>> {
    return this.#request('POST', `/v1/agents/${agentId}/resume`, {}, 'operator');
  }

  // --- transport ----------------------------------------------------------

  /**
   * @param alsoAccept statuses that are not 2xx but still carry a result the
   *   caller asked for, rather than an error envelope. `GET /v1/audit/verify`
   *   is the case this exists for: it answers 409 with a full verification
   *   report when the chain is broken.
   */
  async #request<T>(
    method: string,
    path: string,
    body: unknown,
    credential: 'agent' | 'operator' | 'none',
    alsoAccept: readonly number[] = [],
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
        if (alsoAccept.includes(response.status)) return payload as T;
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
