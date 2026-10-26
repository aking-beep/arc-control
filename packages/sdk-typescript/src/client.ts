import { ArcError, type ActionRequest, type ActionResult, type ArcErrorCode } from '@arc-control/schemas';

/**
 * Cookie the API reads a console session from.
 *
 * Duplicated from the API rather than imported, because the SDK is published
 * for third parties and must not drag the server in. Pinned by a test that
 * compares the two.
 */
const SESSION_COOKIE = 'arc_operator_session';

export interface ArcControlClientOptions {
  /** Base URL of the ARC Control API, e.g. `https://control.example.com`. */
  readonly baseUrl: string;
  /** Agent API key. Required for the agent surface. */
  readonly apiKey?: string;
  /**
   * Shared operator token. One of two ways to reach the operator surface, and
   * the weaker one: the identity travels beside it as a header, so the API
   * records whatever is claimed.
   */
  readonly operatorToken?: string;
  /**
   * A signed console session, as issued by `/auth/callback`.
   *
   * The stronger way, and the one a console must use once single sign-on is
   * configured: the API resolves the identity and the roles from the session
   * itself, so neither can be asserted by the caller. Takes precedence over
   * `operatorToken` when both are present.
   */
  readonly operatorSession?: string;
  /**
   * Identity recorded against operator actions such as approvals.
   *
   * Only consulted on the shared-token path, where there is nowhere better for
   * it to come from. With a session the API uses the session's identity and
   * ignores this.
   */
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
  readonly #operatorSession: string | undefined;
  readonly #operatorIdentity: string | undefined;
  readonly #operatorRoles: readonly string[];
  readonly #timeoutMs: number;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: ArcControlClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#apiKey = options.apiKey;
    this.#operatorToken = options.operatorToken;
    this.#operatorSession = options.operatorSession;
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
  // --- the assurance surface ----------------------------------------------
  //
  // Operator-only, every one of them. An agent integration constructing this
  // client with `apiKey` alone cannot reach any of it, and the API refuses the
  // credential even if it tries.

  async assuranceSummary(): Promise<Record<string, unknown>> {
    return this.#request('GET', '/v1/assurance/summary', undefined, 'operator');
  }

  async coverage(window: { from?: string; to?: string } = {}): Promise<Record<string, unknown>> {
    return this.#request('GET', `/v1/assurance/coverage${query(window)}`, undefined, 'operator');
  }

  async listControls(): Promise<{ controls: readonly Record<string, unknown>[] }> {
    return this.#request('GET', '/v1/assurance/controls', undefined, 'operator');
  }

  async getControl(controlId: string): Promise<Record<string, unknown>> {
    return this.#request('GET', `/v1/assurance/controls/${encodeURIComponent(controlId)}`, undefined, 'operator');
  }

  async setControlEnabled(controlId: string, enabled: boolean): Promise<Record<string, unknown>> {
    return this.#request(
      'POST',
      `/v1/assurance/controls/${encodeURIComponent(controlId)}/${enabled ? 'enable' : 'disable'}`,
      undefined,
      'operator',
    );
  }

  /**
   * Records a human attestation for a control ARC cannot decide itself.
   *
   * `statement` is what the attester claims to have checked, and it is
   * required: the value of an attestation is the sentence an auditor reads,
   * not the fact that a box was ticked.
   */
  async attestControl(
    controlId: string,
    attestation: { statement: string; validForDays?: number; reference?: string },
  ): Promise<Record<string, unknown>> {
    return this.#request(
      'POST',
      `/v1/assurance/controls/${encodeURIComponent(controlId)}/attest`,
      attestation,
      'operator',
    );
  }

  /** Runs the control library over a window and persists the result. */
  async runAssessment(
    options: { from?: string; to?: string; controlIds?: readonly string[] } = {},
  ): Promise<{ run: Record<string, unknown>; assessments: readonly Record<string, unknown>[] }> {
    return this.#request('POST', '/v1/assurance/runs', options, 'operator');
  }

  async listAssessmentRuns(limit?: number): Promise<{ runs: readonly Record<string, unknown>[] }> {
    return this.#request('GET', `/v1/assurance/runs${query({ limit })}`, undefined, 'operator');
  }

  async getAssessmentRun(
    runId: string,
  ): Promise<{ run: Record<string, unknown>; assessments: readonly Record<string, unknown>[] }> {
    return this.#request('GET', `/v1/assurance/runs/${encodeURIComponent(runId)}`, undefined, 'operator');
  }

  async getAssessment(assessmentId: string): Promise<Record<string, unknown>> {
    return this.#request('GET', `/v1/assurance/assessments/${encodeURIComponent(assessmentId)}`, undefined, 'operator');
  }

  async listFrameworks(): Promise<{ frameworks: readonly Record<string, unknown>[] }> {
    return this.#request('GET', '/v1/assurance/frameworks', undefined, 'operator');
  }

  async getFramework(frameworkId: string): Promise<Record<string, unknown>> {
    return this.#request('GET', `/v1/assurance/frameworks/${encodeURIComponent(frameworkId)}`, undefined, 'operator');
  }

  // --- risks ---------------------------------------------------------------

  async listRisks(): Promise<{ risks: readonly Record<string, unknown>[] }> {
    return this.#request('GET', '/v1/risks', undefined, 'operator');
  }

  async getRisk(riskId: string): Promise<Record<string, unknown>> {
    return this.#request('GET', `/v1/risks/${encodeURIComponent(riskId)}`, undefined, 'operator');
  }

  async createRisk(risk: {
    reference: string;
    title: string;
    description: string;
    category: string;
    impact: 1 | 2 | 3 | 4 | 5;
    likelihood: 1 | 2 | 3 | 4 | 5;
    treatment: 'mitigate' | 'transfer' | 'avoid' | 'accept';
    owner: string;
    controlIds?: readonly string[];
    scope?: readonly string[];
    reviewDueAt?: string;
  }): Promise<Record<string, unknown>> {
    return this.#request('POST', '/v1/risks', risk, 'operator');
  }

  /**
   * Records a reviewed residual rating.
   *
   * Separate from `createRisk` on purpose. Residual risk is the number that
   * reaches a board, and ARC will not compute it from the existence of
   * controls — it takes a named reviewer and their rationale or it does not
   * exist.
   */
  async reviewResidualRisk(
    riskId: string,
    review: { impact: 1 | 2 | 3 | 4 | 5; likelihood: 1 | 2 | 3 | 4 | 5; rationale: string },
  ): Promise<Record<string, unknown>> {
    return this.#request('POST', `/v1/risks/${encodeURIComponent(riskId)}/residual`, review, 'operator');
  }

  async acceptRisk(
    riskId: string,
    acceptance: { rationale: string; validForDays?: number },
  ): Promise<Record<string, unknown>> {
    return this.#request('POST', `/v1/risks/${encodeURIComponent(riskId)}/accept`, acceptance, 'operator');
  }

  async linkRiskControls(riskId: string, controlIds: readonly string[]): Promise<Record<string, unknown>> {
    return this.#request('POST', `/v1/risks/${encodeURIComponent(riskId)}/controls`, { controlIds }, 'operator');
  }

  // --- findings ------------------------------------------------------------

  /**
   * Findings. `overdue: true` narrows to open findings past their deadline,
   * whatever `status` says — a resolved finding that missed its date is
   * history rather than work.
   */
  async listFindings(
    filter: { status?: string; controlId?: string; overdue?: boolean } = {},
  ): Promise<{ findings: readonly Record<string, unknown>[] }> {
    return this.#request('GET', `/v1/findings${query(filter)}`, undefined, 'operator');
  }

  /**
   * Who the API thinks this client is.
   *
   * The console asks this rather than being told at startup: with a session,
   * the identity and the roles are the session's, and anything the console
   * believed from its own configuration would be a guess it then displays as
   * fact.
   */
  async whoami(): Promise<{
    identifier: string;
    roles: readonly string[];
    assurance: string;
    issuer?: string;
    sessionId?: string;
  }> {
    return this.#request('GET', '/v1/whoami', undefined, 'operator');
  }

  /**
   * Notification channels and what was delivered.
   *
   * The delivery list is the point rather than an extra: a product that sends
   * webhooks and cannot tell you which ones failed has moved the problem
   * rather than solved it.
   */
  async notifications(): Promise<Record<string, unknown>> {
    return this.#request('GET', '/v1/notifications', undefined, 'operator');
  }

  async getFinding(findingId: string): Promise<Record<string, unknown>> {
    return this.#request('GET', `/v1/findings/${encodeURIComponent(findingId)}`, undefined, 'operator');
  }

  async updateFinding(
    findingId: string,
    patch: { owner?: string; dueAt?: string; severity?: string; status?: string },
  ): Promise<Record<string, unknown>> {
    return this.#request('POST', `/v1/findings/${encodeURIComponent(findingId)}`, patch, 'operator');
  }

  async resolveFinding(
    findingId: string,
    resolution: { status: 'resolved' | 'accepted' | 'false_positive'; note: string },
  ): Promise<Record<string, unknown>> {
    return this.#request('POST', `/v1/findings/${encodeURIComponent(findingId)}/resolve`, resolution, 'operator');
  }

  // --- evidence bundles ----------------------------------------------------

  /**
   * Exports an evidence bundle.
   *
   * Supplying `anchor` — an audit head the operator recorded outside ARC — is
   * what turns the bundle from internally consistent into genuinely anchored.
   * Without it the bundle still exports and states in its own limitations what
   * it therefore cannot establish.
   */
  async exportBundle(options: {
    scope?:
      | { kind: 'window' }
      | { kind: 'run'; runId: string }
      | { kind: 'control'; controlId: string }
      | { kind: 'evidence'; evidenceIds: readonly string[] };
    from?: string;
    to?: string;
    anchor?: { headDigest: string; headSequence: number; recordedAt: string; recordedBy: string };
  } = {}): Promise<Record<string, unknown>> {
    return this.#request('POST', '/v1/evidence/bundles', options, 'operator');
  }

  // --- policy history and simulation ---------------------------------------

  async policyHistory(policyId: string): Promise<{ versions: readonly Record<string, unknown>[] }> {
    return this.#request('GET', `/v1/policies/${encodeURIComponent(policyId)}/history`, undefined, 'operator');
  }

  /**
   * Simulates a candidate policy. Writes nothing and executes nothing.
   *
   * With `subject`, one hypothetical action is decided under both the current
   * and candidate policy sets. Without it, recorded traffic in the window is
   * re-decided and only the differences come back.
   */
  async simulatePolicy(options: {
    candidate: Record<string, unknown>;
    subject?: { agentName: string; tool: string; parameters?: Record<string, unknown> };
    from?: string;
    to?: string;
    limit?: number;
  }): Promise<Record<string, unknown>> {
    return this.#request('POST', '/v1/policies/simulate', options, 'operator');
  }

  // --- agent governance, credentials and kill switches ---------------------

  async setAgentGovernance(
    agentId: string,
    governance: {
      purpose: string;
      criticality: 'low' | 'medium' | 'high' | 'business_critical';
      department?: string;
      deploymentRef?: string;
      dataClassification?: readonly string[];
      reviewIntervalDays?: number;
      lastReviewedAt?: string;
      lastReviewedBy?: string;
      reviewDueAt?: string;
      reviewNote?: string;
    },
  ): Promise<Record<string, unknown>> {
    return this.#request('POST', `/v1/agents/${encodeURIComponent(agentId)}/governance`, governance, 'operator');
  }

  async activateAgent(agentId: string): Promise<Record<string, unknown>> {
    return this.#request('POST', `/v1/agents/${encodeURIComponent(agentId)}/activate`, undefined, 'operator');
  }

  /** Retires an agent and revokes its credentials. Not reversible. */
  async retireAgent(agentId: string): Promise<Record<string, unknown>> {
    return this.#request('POST', `/v1/agents/${encodeURIComponent(agentId)}/retire`, undefined, 'operator');
  }

  async credentialInventory(
    options: { expiringWithinDays?: number } = {},
  ): Promise<{ credentials: readonly Record<string, unknown>[] }> {
    return this.#request('GET', `/v1/credentials${query(options)}`, undefined, 'operator');
  }

  /** Issues a replacement credential and revokes the old one. The key is returned once. */
  async rotateCredential(
    credentialId: string,
    options: { expiresAt?: string } = {},
  ): Promise<{ credential: Record<string, unknown>; apiKey: string; notice: string }> {
    return this.#request('POST', `/v1/credentials/${encodeURIComponent(credentialId)}/rotate`, options, 'operator');
  }

  async setToolDisabled(toolId: string, disabled: boolean, reason?: string): Promise<Record<string, unknown>> {
    return this.#request(
      'POST',
      `/v1/tools/${encodeURIComponent(toolId)}/${disabled ? 'disable' : 'enable'}`,
      disabled && reason ? { reason } : undefined,
      'operator',
    );
  }

  async setConnectorDisabled(
    connector: string,
    disabled: boolean,
    reason?: string,
  ): Promise<Record<string, unknown>> {
    return this.#request(
      'POST',
      `/v1/connectors/${encodeURIComponent(connector)}/${disabled ? 'disable' : 'enable'}`,
      disabled && reason ? { reason } : undefined,
      'operator',
    );
  }

  /** Enforcement health alone, with nothing read from the assurance layer. */
  async enforcementHealth(): Promise<Record<string, unknown>> {
    return this.#request('GET', '/health/enforcement', undefined, 'none', [503]);
  }

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
      // A session first, so a client holding both does not downgrade its own
      // attribution — and because a deployment with single sign-on configured
      // refuses the shared token outright.
      if (this.#operatorSession) {
        headers.cookie = `${SESSION_COOKIE}=${encodeURIComponent(this.#operatorSession)}`;
      } else if (this.#operatorToken) {
        headers.authorization = `Bearer ${this.#operatorToken}`;
        if (this.#operatorIdentity) headers['x-arc-operator'] = this.#operatorIdentity;
        if (this.#operatorRoles.length > 0) headers['x-arc-operator-roles'] = this.#operatorRoles.join(',');
      } else {
        throw new ArcError(
          'unauthenticated',
          'this client was constructed without an operatorSession or an operatorToken',
        );
      }
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

/** Builds a query string from defined values only, or an empty string. */
function query(values: Readonly<Record<string, unknown>>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}
