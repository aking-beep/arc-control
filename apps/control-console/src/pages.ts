import type { ArcControlClient } from '@arc-control/sdk-typescript';
import {
  accessMatrix,
  cellScope,
  chainVerdict,
  conditionInline,
  connectorTable,
  credentialTable,
  evidenceTable,
  evidenceTimeline,
  findingsTable,
  labelTags,
  parameterTable,
  requirementLine,
  ruleLadder,
  scopeChips,
  traceTable,
  voteList,
} from './components.js';
import {
  actionHeadline,
  count,
  eventFamily,
  expiresIn,
  outcomeLabel,
  shortDigest,
  shortId,
  timestamp,
} from './format.js';
import {
  backLink,
  badge,
  countLine,
  definitions,
  digestBlock,
  effectBadge,
  effectLetter,
  emptyState,
  filterLinks,
  healthIndicator,
  html,
  jsonBlock,
  layout,
  NOTHING,
  outcomeBadge,
  pageHeader,
  raw,
  rawJson,
  riskBadge,
  sectionTitle,
  severityBadge,
  stackedBar,
  statusDot,
  table,
  type Banner,
  type Segment,
  type Trusted,
} from './render.js';

export interface PageContext {
  readonly client: ArcControlClient;
  readonly apiBase: string;
  readonly operatorIdentity: string;
  readonly operatorRoles: readonly string[];
  readonly query: URLSearchParams;
  readonly banner?: Banner;
}

export type Rec = Record<string, unknown>;

export function rec(value: unknown): Rec {
  return (value ?? {}) as Rec;
}

export function list(value: unknown): readonly Rec[] {
  return Array.isArray(value) ? (value as Rec[]) : [];
}

export function strings(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

/** All eight `ActionOutcome` values, in the order an operator reads them. */
const OUTCOMES = [
  'allowed',
  'executed',
  'pending_approval',
  'approved',
  'rejected',
  'expired',
  'denied',
  'failed',
] as const;

const AUDIT_FAMILIES = ['agent', 'credential', 'tool', 'policy', 'action', 'approval', 'evidence'] as const;

// --- the shell ------------------------------------------------------------

export interface Chrome {
  readonly health: Rec;
  readonly pendingApprovals: number;
}

/**
 * The data every page's shell needs: health for the masthead, pending
 * approvals for the rail.
 *
 * Both are read tolerantly. A page about evidence should still render if the
 * health endpoint is having a bad day, and a rail without a count is a smaller
 * failure than a blank page.
 */
export async function chrome(context: PageContext): Promise<Chrome> {
  const [health, approvals] = await Promise.all([
    context.client.health().catch(() => ({}) as Rec),
    context.client
      .listApprovals()
      .then((result) => result.approvals)
      .catch(() => []),
  ]);

  return { health: rec(health), pendingApprovals: approvals.length };
}

export function page(
  context: PageContext,
  active: string,
  title: string,
  body: Trusted | string,
  shell: Chrome,
): string {
  return layout({
    title,
    active,
    body: typeof body === 'string' ? body : body.value,
    apiBase: context.apiBase,
    operatorIdentity: context.operatorIdentity,
    pendingApprovals: shell.pendingApprovals,
    ...(shell.health.status ? { health: String(shell.health.status) } : {}),
    ...(shell.health.version ? { version: String(shell.health.version) } : {}),
    demo: shell.health.demoSeed === true,
    ...(context.banner ? { banner: context.banner } : {}),
  });
}

// --- 1. overview ----------------------------------------------------------

/**
 * The operational command centre.
 *
 * Ordered by what needs an operator, not by what is easiest to count: a broken
 * audit chain first, then approvals waiting on a human, then an unhealthy
 * connector. Inventory counts come after, as a quiet line, because an operator
 * opening this page is asking "does anything need me?" and a row of large
 * numbers answers a different question.
 */
export async function overviewPage(context: PageContext): Promise<string> {
  const [health, evidence, approvals, verification] = await Promise.all([
    context.client.health(),
    context.client.listEvidence({ limit: 12 }),
    context.client.listApprovals(),
    context.client.verifyAudit(),
  ]);

  const shell: Chrome = { health: rec(health), pendingApprovals: approvals.approvals.length };
  const counts = rec(rec(health).counts);
  const connectors = list(rec(health).connectors);
  const unhealthy = connectors.filter((connector) => connector.healthy === false);
  const pending = approvals.approvals.map((request) => rec(request));
  const failures = verification.failures;

  const items: Trusted[] = [];

  if (!verification.valid) {
    const first = rec(failures[0]);
    items.push(
      raw(html`<li>
        <span class="tone deny" aria-hidden="true"></span>
        <p class="deny">
          <strong>Audit chain BROKEN</strong> · ${count(failures.length)} problem(s) in
          ${count(verification.recordsChecked)} records, first at sequence
          <span class="tnum">${first.sequence ?? '—'}</span> (${first.problem ?? 'unknown'})
        </p>
        <a class="cta" href="/audit">Audit →</a>
      </li>`),
    );
  }

  if (pending.length > 0) {
    const oldest = pending
      .map((request) => String(request.expiresAt ?? ''))
      .filter(Boolean)
      .sort()[0];
    items.push(
      raw(html`<li>
        <span class="tone approval" aria-hidden="true"></span>
        <p>
          <strong class="tnum">${count(pending.length)}</strong> approval${pending.length === 1 ? '' : 's'} pending ·
          oldest expires <span class="mono">${timestamp(oldest)}</span>
        </p>
        <a class="cta" href="/approvals">Review approvals →</a>
      </li>`),
    );
  }

  for (const connector of unhealthy) {
    items.push(
      raw(html`<li>
        <span class="tone deny" aria-hidden="true"></span>
        <p class="deny">
          Connector <span class="mono"><strong>${connector.name}</strong></span> unhealthy: “${connector.detail}”
        </p>
        <a class="cta" href="/security">Security →</a>
      </li>`),
    );
  }

  const body = html`${pageHeader({
    title: 'Overview',
    lede: 'Every action an agent attempted, whether it was allowed, held for a human or refused. A denial is recorded as durably as an execution: the attempt is itself the signal.',
  })}

  <section aria-labelledby="attention-heading">
    <h2 id="attention-heading">Needs attention</h2>
    ${items.length === 0
      ? raw(html`<p class="calm">Nothing is waiting on you.</p>`)
      : raw(html`<ul class="attention">
          ${items}
        </ul>`)}
    ${verification.valid
      ? raw(html`<p class="note">
          Audit chain <span class="allow-text">intact</span> · ${count(verification.recordsChecked)} records · head
          <span class="mono" title="${verification.headDigest ?? ''}">${shortDigest(verification.headDigest)}</span> ·
          ${verification.checkedAgainstExpectation
            ? 'checked against a recorded head'
            : 'checked against itself only'}, see <a href="/audit">Audit</a>
        </p>`)
      : NOTHING}
  </section>

  <div class="count-row">
    ${countLine([
      { value: counts.agents ?? 0, label: 'agents', href: '/agents' },
      { value: counts.tools ?? 0, label: 'tools', href: '/tools' },
      { value: counts.policies ?? 0, label: 'policies', href: '/policies' },
      { value: counts.auditRecords ?? 0, label: 'audit records', href: '/audit' },
    ])}
    <span class="muted" style="display:inline-flex;align-items:center;gap:8px">
      API ${healthIndicator(rec(health).status)}
    </span>
  </div>

  ${sectionTitle('Recent activity', raw(html`<a href="/evidence">All evidence →</a>`))}
  ${evidence.evidence.length === 0
    ? emptyState('No actions have reached the gateway yet.')
    : evidenceTable(evidence.evidence, 'The 12 most recent evidence records')}`;

  return page(context, '/', 'Overview', raw(body), shell);
}

// --- 2. approvals ---------------------------------------------------------

/**
 * The human-in-the-loop queue, and the console's primary work surface.
 *
 * Approving is not the act. The vote is recorded, the approvals engine decides
 * whether it counts, and only a request the engine has resolved to `approved`
 * releases the action — as a separate, audited call. The page says this next to
 * the buttons rather than only in the documentation.
 */
export async function approvalsPage(context: PageContext): Promise<string> {
  const mine = context.query.get('mine') === 'true';
  const shell = await chrome(context);

  const [all, assigned] = await Promise.all([
    context.client.listApprovals(),
    context.client.listApprovals({ mine: true }),
  ]);

  const shown = (mine ? assigned.approvals : all.approvals).map((request) => rec(request));
  const [tools, policies] = await Promise.all([
    context.client.listTools().then((result) => result.tools).catch(() => []),
    context.client.listPolicies().then((result) => result.policies).catch(() => []),
  ]);

  const cards = shown.map((request) => approvalCard(request, tools, policies));

  const body = html`${pageHeader({
    title: 'Approvals',
    display: true,
    lede: 'Actions a policy will not authorize on its own. Approving does not execute the action — execution is a separate step, and a granted approval is consumed when it is used, so it can never authorize a second execution.',
  })}
  <div style="margin-bottom:20px">
    ${filterLinks(
      'Show',
      [
        { value: '', label: 'All pending', count: all.approvals.length },
        { value: 'true', label: 'Assigned to me', count: assigned.approvals.length },
      ],
      mine ? 'true' : '',
      (value) => (value ? '/approvals?mine=true' : '/approvals'),
    )}
  </div>
  ${cards.length === 0
    ? emptyState(
        mine
          ? 'Nothing pending names you as an approver. The policy decides who may approve, not the console.'
          : 'Nothing is waiting for a human.',
      )
    : raw(cards.map((card) => card.value).join(''))}
  <p class="note">
    The queue lists pending requests only. A resolved request stays readable at its own address, and its outcome is in
    <a href="/evidence">Evidence</a> and the <a href="/audit">audit log</a>.
  </p>`;

  return page(context, '/approvals', 'Approvals', raw(body), shell);
}

function approvalCard(
  request: Rec,
  tools: readonly unknown[],
  policies: readonly unknown[],
): Trusted {
  const tool = tools.map((item) => rec(item)).find((item) => item.name === request.tool);
  const policy = policies.map((item) => rec(item)).find((item) => item.id === request.policyId);
  const rule = policy ? list(policy.rules).find((item) => item.id === request.ruleId) : undefined;
  const headline = actionHeadline(request.tool, request.parameters);
  const id = String(request.id ?? '');

  return raw(html`<article class="card" style="padding:0;overflow:hidden">
    <header
      style="display:flex;align-items:flex-start;justify-content:space-between;gap:24px;flex-wrap:wrap;padding:16px 20px;border-bottom:1px solid var(--border)"
    >
      <div style="min-width:0">
        <h2 class="display" style="font-size:22px;margin:0">
          ${headline.verb} ${headline.strong ? raw(html`<span class="tnum">${headline.strong}</span>`) : NOTHING}
          ${headline.rest ?? ''}
        </h2>
        <p class="chips muted" style="margin:6px 0 0;font-size:13px">
          <a href="/agents/${request.agentId}">${request.agentName}</a>
          <span aria-hidden="true">·</span>
          <a class="mono" href="/tools">${request.tool}</a>
          ${tool ? raw(html`<span>(${tool.effect})</span>${riskBadge(tool.riskTier)}`) : NOTHING}
          <span aria-hidden="true">·</span>
          <span>owner ${request.agentOwner}</span>
        </p>
      </div>
      <div style="text-align:right;flex-shrink:0">
        <p class="tnum" style="margin:0;font-weight:600;color:var(--approval)">${expiresIn(request.expiresAt)}</p>
        <a class="mono" href="/approvals/${id}" title="${id}">${shortId(id, 16)}</a>
      </div>
    </header>

    <div class="split" style="gap:0">
      <div style="padding:20px;min-width:0">
        <h3>Parameters (as recorded, redacted)</h3>
        ${parameterTable(request.parameters, 'Requested parameters', tool?.parameters)}
        <h3 style="margin-top:20px">Why it is held</h3>
        <p style="margin:0;font-size:13px">
          Policy
          <a class="mono" href="/policies/${encodeURIComponent(String(request.policyId ?? ''))}"
            >${request.policyId ?? '—'}</a
          >
          · rule <span class="mono">${request.ruleId ?? '—'}</span>
          ${rule ? raw(html` · when ${conditionInline(rule.when)}`) : NOTHING}
        </p>
        <p class="muted" style="margin:4px 0 0;font-size:13px">${request.reason}</p>
      </div>

      <div style="padding:20px;border-left:1px solid var(--border);background:var(--surface-sunk)">
        ${requirementLine(request.requirement)}
        <div style="margin-top:16px">${voteList(request.votes)}</div>
        <form method="post" action="/approvals/${id}/vote" style="margin-top:16px">
          <label class="field" for="comment-${id}">Reason, recorded in evidence</label>
          <textarea id="comment-${id}" name="comment" rows="2"></textarea>
          <div class="field-row" style="margin-top:12px">
            <button type="submit" name="vote" value="approve" class="primary">Approve</button>
            <a class="button danger" href="/confirm/reject/${id}">Reject…</a>
          </div>
        </form>
        <p class="note" style="margin-top:12px">
          Approving does not execute. The action runs only once the request is approved, as a separate audited call.
          The approvals engine decides whether your vote counts.
        </p>
      </div>
    </div>
  </article>`);
}

export async function approvalDetailPage(context: PageContext, approvalId: string): Promise<string> {
  const shell = await chrome(context);
  const request = rec(await context.client.getApproval(approvalId));
  const headline = actionHeadline(request.tool, request.parameters);

  const [tools, evidence] = await Promise.all([
    context.client.listTools().then((result) => result.tools).catch(() => []),
    context.client.listEvidence({ limit: 100 }).then((result) => result.evidence).catch(() => []),
  ]);

  const tool = tools.map((item) => rec(item)).find((item) => item.name === request.tool);
  const related = evidence
    .map((item) => rec(item))
    .filter((item) => rec(item.approval).id === request.id);

  const status = String(request.status ?? '');
  const tone =
    status === 'approved' ? 'allow' : status === 'pending' ? 'approval' : status === 'rejected' ? 'deny' : 'muted';

  const body = html`${backLink('/approvals', 'Approvals')}
  ${pageHeader({
    display: true,
    title: raw(html`${headline.verb} ${headline.strong ?? ''} ${headline.rest ?? ''}`),
    lede: raw(html`Approval <span class="mono">${request.id}</span>`),
    actions: badge(tone, status),
  })}

  <div class="split-wide">
    <div>
      <h2 class="quiet">Parameters (as recorded, redacted)</h2>
      ${parameterTable(request.parameters, 'Parameters', tool?.parameters)}

      ${sectionTitle('Lifecycle')}
      ${definitions([
        ['Created', raw(html`<span class="mono">${timestamp(request.createdAt)}</span>`)],
        ['Expires', raw(html`<span class="mono">${timestamp(request.expiresAt)}</span>`)],
        ['Resolved', raw(html`<span class="mono">${timestamp(request.resolvedAt)}</span>`)],
        [
          'Consumed',
          request.consumedAt
            ? raw(html`<span class="mono">${timestamp(request.consumedAt)}</span>`)
            : raw(html`<span class="muted">not consumed: no execution has used this approval</span>`),
        ],
        [
          'Policy · rule',
          raw(html`<a class="mono" href="/policies/${encodeURIComponent(String(request.policyId ?? ''))}"
              >${request.policyId ?? '—'}</a
            >
            · <span class="mono">${request.ruleId ?? '—'}</span>`),
        ],
        [
          'Agent',
          raw(html`<a href="/agents/${request.agentId}">${request.agentName}</a>
          <span class="muted">owner ${request.agentOwner}</span>`),
        ],
      ])}

      ${sectionTitle('Evidence')}
      ${related.length === 0
        ? emptyState('No evidence record in the loaded window references this approval.')
        : raw(html`<ul style="margin:0;padding-left:18px;font-size:13px">
            ${related.map(
              (record) => raw(html`<li>
                <a class="mono" href="/evidence/${record.id}">${record.id}</a>
                <span class="muted">(${outcomeLabel(record.outcome)})</span>
              </li>`),
            )}
          </ul>`)}

      <div style="margin-top:24px">${rawJson('Raw approval request (JSON)', request)}</div>
    </div>

    <aside class="card stack">
      ${requirementLine(request.requirement)}
      <div>
        <h2 class="quiet">Votes</h2>
        ${voteList(request.votes)}
      </div>
      ${status === 'pending'
        ? raw(html`<p style="margin:0"><a href="/approvals">Vote on this request in the queue →</a></p>`)
        : NOTHING}
    </aside>
  </div>`;

  return page(context, '/approvals', 'Approval detail', raw(body), shell);
}

// --- 3. agents ------------------------------------------------------------

export async function agentsPage(context: PageContext): Promise<string> {
  const shell = await chrome(context);
  const { agents } = await context.client.listAgents();

  const rows = agents.map((entry) => {
    const agent = rec(entry);
    const suspended = agent.status === 'suspended';
    return html`<tr>
      <td>${statusDot(!suspended, String(agent.status ?? ''))}</td>
      <td>
        <a href="/agents/${agent.id}"><strong>${agent.name}</strong></a>
        <span class="sub">${agent.description ?? ''}</span>
      </td>
      <td>${agent.kind}</td>
      <td class="mono">${agent.environment}</td>
      <td>${agent.owner}</td>
      <td class="mono">${strings(agent.roles).join(', ') || '—'}</td>
      <td class="numeric tnum">${count(strings(agent.declaredTools).length)}</td>
      <td class="numeric">
        ${suspended
          ? raw(html`<form method="post" action="/agents/${agent.id}/resume">
              <button type="submit" class="small">Resume</button>
            </form>`)
          : raw(html`<a class="button danger small" href="/confirm/suspend/${agent.id}">Suspend…</a>`)}
      </td>
    </tr>`;
  });

  const body = html`${pageHeader({
    title: 'Agents',
    lede: 'An agent is the principal ARC Control authorizes. Suspending an agent stops it at authentication, before any policy is consulted.',
  })}
  ${rows.length === 0
    ? emptyState('No agents are registered.')
    : table(
        'Registered agents',
        [
          'Status',
          'Agent',
          'Kind',
          'Environment',
          'Owner',
          'Roles',
          { label: 'Declared tools', numeric: true },
          { label: 'Actions', numeric: true, hidden: true },
        ],
        rows,
      )}
  <p class="note">
    Declared tools are what the agent says it uses. They are not a grant: policy decides each request.
    <a href="/access">See which policies govern each pair →</a>
  </p>`;

  return page(context, '/agents', 'Agents', raw(body), shell);
}

export async function agentDetailPage(context: PageContext, agentId: string): Promise<string> {
  const shell = await chrome(context);
  const agent = rec(await context.client.getAgent(agentId));

  const [credentials, evidence, tools, policies] = await Promise.all([
    context.client.listAgentKeys(agentId).then((result) => result.credentials).catch(() => []),
    context.client
      .listEvidence({ agentId, limit: 100 })
      .then((result) => result.evidence)
      .catch(() => []),
    context.client.listTools().then((result) => result.tools).catch(() => []),
    context.client.listPolicies().then((result) => result.policies).catch(() => []),
  ]);

  const suspended = agent.status === 'suspended';

  const declaredRows = strings(agent.declaredTools).map((name) => {
    const tool = tools.map((item) => rec(item)).find((item) => item.name === name);
    const scope = tool ? cellScope(agent, tool, policies) : undefined;
    return html`<tr>
      <td class="mono">${name}</td>
      <td class="mono">
        ${scope && scope.enabled.length > 0
          ? raw(
              scope.enabled
                .map(
                  (policy) =>
                    html`<a href="/policies/${encodeURIComponent(String(policy.id))}" style="margin-right:8px"
                      >${policy.id}</a
                    >`,
                )
                .join(''),
            )
          : raw(html`<span class="muted" style="font-family:var(--sans)">None: engine default applies</span>`)}
      </td>
      <td>
        ${scope && scope.effects.length > 0
          ? raw(html`<span class="cell-effects">${scope.effects.map((effect) => effectLetter(effect))}</span>`)
          : raw(html`<span class="muted">DENY, unless the deployment runs monitor-only</span>`)}
      </td>
    </tr>`;
  });

  const body = html`${backLink('/agents', 'Agents')}
  ${pageHeader({
    title: String(agent.name ?? ''),
    lede: String(agent.description ?? ''),
    actions: suspended
      ? NOTHING
      : raw(html`<a class="button danger" href="/confirm/suspend/${agent.id}">Suspend…</a>`),
  })}
  ${suspended
    ? raw(html`<div class="banner error" role="status">
        <span class="banner-glyph" aria-hidden="true">✕</span>
        <span>Suspended: refused at authentication, before policy. Resume from the Agents list.</span>
      </div>`)
    : NOTHING}

  <div class="split">
    <section>
      <h2>Profile</h2>
      ${definitions([
        ['Status', statusDot(!suspended, String(agent.status ?? ''))],
        ['Id', raw(html`<span class="mono">${agent.id}</span>`)],
        ['Kind', String(agent.kind ?? '')],
        ['Environment', raw(html`<span class="mono">${agent.environment}</span>`)],
        ['Organization', raw(html`<span class="mono">${agent.organizationId}</span>`)],
        ['Owner', String(agent.owner ?? '')],
        ['Roles', raw(html`<span class="mono">${strings(agent.roles).join(', ') || '—'}</span>`)],
        [
          'Labels',
          raw(html`<span class="mono"
            >${Object.entries(rec(agent.labels))
              .map(([key, value]) => `${key}=${String(value)}`)
              .join(', ') || '—'}</span
          >`),
        ],
        ['Registered', raw(html`<span class="mono">${timestamp(agent.createdAt)}</span>`)],
      ])}
    </section>

    <section>
      <h2>Declared tools</h2>
      <p class="note" style="margin:0 0 12px">
        Declared, not a grant. Policies in scope and the effects their rules can produce:
      </p>
      ${declaredRows.length === 0
        ? emptyState('This agent declares no tools.')
        : table('Declared tools and policy scope', ['Tool', 'Policies in scope', 'Possible effects'], declaredRows, {
            compact: true,
          })}
    </section>
  </div>

  ${sectionTitle('Credentials')}
  <p class="note" style="margin:0 0 12px">
    Metadata only. ARC Control stores a salted hash of each key; the secret is shown once, at issue, and never again.
  </p>
  ${credentials.length === 0
    ? emptyState('No credentials have been issued to this agent.')
    : credentialTable(credentials)}

  ${sectionTitle(
    'Activity',
    raw(html`<a href="/evidence?agentId=${encodeURIComponent(String(agent.id ?? ''))}"
      >All evidence for ${agent.name} →</a
    >`),
  )}
  ${evidence.length === 0
    ? emptyState('This agent has not requested any actions.')
    : evidenceTable(evidence, `Evidence for ${String(agent.name ?? '')}`, { hideAgent: true })}`;

  return page(context, '/agents', String(agent.name ?? 'Agent'), raw(body), shell);
}

// --- 4. tools -------------------------------------------------------------

export async function toolsPage(context: PageContext): Promise<string> {
  const shell = await chrome(context);
  const [{ tools }, agentsResult, policiesResult] = await Promise.all([
    context.client.listTools(),
    context.client.listAgents().catch(() => ({ agents: [] })),
    context.client.listPolicies().catch(() => ({ policies: [] })),
  ]);

  const agents = agentsResult.agents.map((entry) => rec(entry));
  const policies = policiesResult.policies.map((entry) => rec(entry));

  const rows = tools.map((entry) => {
    const tool = rec(entry);
    const declaredBy = agents.filter((agent) => strings(agent.declaredTools).includes(String(tool.name ?? '')));
    const governing = policies.filter((policy) =>
      agents.some((agent) => cellScope(agent, tool, [policy]).enabled.length > 0),
    );

    const parameters = list(tool.parameters);
    return html`<tr>
      <td style="width:26%">
        <span class="mono"><strong>${tool.name}</strong></span>
        <span class="sub">${tool.description}</span>
      </td>
      <td>
        <span class="${tool.effect === 'irreversible' ? 'deny-text' : ''}">${tool.effect}</span>
      </td>
      <td>${riskBadge(tool.riskTier)}</td>
      <td class="mono">${tool.system}</td>
      <td class="mono">${tool.connector}</td>
      <td>
        ${parameters.length === 0
          ? raw(html`<span class="muted">none declared</span>`)
          : raw(html`<ul style="margin:0;padding:0;list-style:none">
              ${parameters.map(
                (spec) => raw(html`<li style="font-size:13px">
                  <span class="mono">${spec.name}</span>
                  <span class="muted">
                    ${spec.type}${spec.required ? raw(html` · <strong>required</strong>`) : NOTHING}${spec.minimum ===
                    undefined
                      ? ''
                      : ` · ≥ ${count(spec.minimum)}`}${spec.maxLength === undefined
                      ? ''
                      : ` · max ${count(spec.maxLength)} chars`}</span
                  >
                  ${spec.sensitive
                    ? raw(html`<span class="badge approval">sensitive (redacted)</span>`)
                    : NOTHING}
                </li>`),
              )}
            </ul>`)}
      </td>
      <td>
        ${declaredBy.length === 0
          ? raw(html`<span class="muted">no agent declares this</span>`)
          : raw(
              declaredBy
                .map((agent) => html`<a href="/agents/${agent.id}" style="margin-right:8px">${agent.name}</a>`)
                .join(''),
            )}
      </td>
      <td class="mono">
        ${governing.length === 0
          ? raw(html`<span class="muted" style="font-family:var(--sans)">none in scope</span>`)
          : raw(
              governing
                .map(
                  (policy) =>
                    html`<a href="/policies/${encodeURIComponent(String(policy.id))}" style="margin-right:8px"
                      >${policy.id}</a
                    >`,
                )
                .join(''),
            )}
      </td>
    </tr>`;
  });

  const body = html`${pageHeader({
    title: 'Tools',
    lede: 'A tool is a capability an agent may ask to use. An action naming an unregistered tool is refused before policy runs.',
  })}
  ${rows.length === 0
    ? emptyState('No tools are registered. An action naming an unregistered tool is refused before policy runs.')
    : table(
        'Registered tools',
        ['Tool', 'Effect', 'Risk tier', 'System', 'Connector', 'Parameters', 'Declared by', 'Policies in scope'],
        rows,
      )}
  <p class="note">
    “Declared by” lists the agents that name this tool; “policies in scope” lists the enabled policies whose selectors
    match this tool for at least one registered agent. Both are relationships in the existing data, not grants. Risk is
    the static tier set at registration; there is no computed risk score.
    <a href="/access">Access →</a>
  </p>`;

  return page(context, '/tools', 'Tools', raw(body), shell);
}

// --- 5. policies ----------------------------------------------------------

export async function policiesPage(context: PageContext): Promise<string> {
  const shell = await chrome(context);
  const { policies } = await context.client.listPolicies();

  const cards = policies.map((entry) => {
    const policy = rec(entry);
    const enabled = policy.enabled !== false;
    const id = String(policy.id ?? '');

    return html`<section class="card" style="padding:0" aria-labelledby="policy-${id}">
      <header
        style="display:flex;align-items:flex-start;justify-content:space-between;gap:24px;flex-wrap:wrap;padding:16px 20px;border-bottom:1px solid var(--border)"
      >
        <div style="min-width:0">
          <h2 id="policy-${id}" class="chips" style="margin:0">
            <a class="mono" href="/policies/${encodeURIComponent(id)}">${id}</a>
            <span class="tnum muted" style="font-weight:400;font-size:13px">v${policy.version}</span>
            <span>${policy.name}</span>
            ${enabled ? badge('allow', 'enabled') : badge('muted', 'disabled')}
          </h2>
          ${policy.description ? raw(html`<p class="note" style="margin:4px 0 0">${policy.description}</p>`) : NOTHING}
          <div class="chips" style="margin-top:10px">${scopeChips(policy.match)} ${labelTags(policy.labels)}</div>
        </div>
        ${enabled
          ? raw(html`<a class="button danger" href="/confirm/disable/${encodeURIComponent(id)}">Disable…</a>`)
          : raw(html`<form method="post" action="/policies/${encodeURIComponent(id)}/enable">
              <button type="submit" class="primary">Enable</button>
            </form>`)}
      </header>
      <div style="padding:4px 20px 16px">
        ${ruleLadder(policy)}
        <div style="margin-top:12px">${rawJson('Raw policy (JSON)', policy)}</div>
      </div>
    </section>`;
  });

  const body = html`${pageHeader({
    title: 'Policies',
    lede: 'Every matching policy is evaluated and the strictest effect wins, so adding a policy can only tighten authorization, never loosen it. A policy that matches but whose rules do not fire falls through to its own fallback — there is no path on which no policy decides.',
  })}
  ${cards.length === 0
    ? emptyState('No policies are published. With no policy, every action is denied.')
    : raw(cards.join(''))}`;

  return page(context, '/policies', 'Policies', raw(body), shell);
}

export async function policyDetailPage(context: PageContext, policyId: string): Promise<string> {
  const shell = await chrome(context);
  const policy = rec(await context.client.getPolicy(policyId));

  const [agents, tools, evidence] = await Promise.all([
    context.client.listAgents().then((result) => result.agents).catch(() => []),
    context.client.listTools().then((result) => result.tools).catch(() => []),
    context.client.listEvidence({ limit: 100 }).then((result) => result.evidence).catch(() => []),
  ]);

  const pairs: { agent: Rec; tool: Rec }[] = [];
  for (const agentEntry of agents) {
    const agent = rec(agentEntry);
    for (const toolEntry of tools) {
      const tool = rec(toolEntry);
      const scope = cellScope(agent, tool, [policy]);
      if (scope.enabled.length > 0 || scope.disabled.length > 0) pairs.push({ agent, tool });
    }
  }

  const decided = evidence.map((entry) => rec(entry)).filter((record) => rec(record.decision).policyId === policy.id);
  const perRule = new Map<string, number>();
  for (const record of decided) {
    const key = String(rec(record.decision).ruleId ?? '—');
    perRule.set(key, (perRule.get(key) ?? 0) + 1);
  }

  const enabled = policy.enabled !== false;

  const body = html`${backLink('/policies', 'Policies')}
  ${pageHeader({
    title: raw(html`<span class="chips"><span class="mono">${policy.id}</span> <span>${policy.name}</span></span>`),
    lede: String(policy.description ?? ''),
    actions: raw(html`<span class="tnum muted">version ${policy.version}</span>
    ${enabled ? badge('allow', 'enabled') : badge('muted', 'disabled')}`),
  })}
  <div class="chips">
    <span class="filters-label">Scope</span>${scopeChips(policy.match)} ${labelTags(policy.labels)}
  </div>

  <div class="split-wide" style="margin-top:24px">
    <section>
      <h2>Decision ladder</h2>
      <p class="note" style="margin:0 0 8px">Rules are tried in order and the first match decides for this policy.</p>
      ${ruleLadder(policy)}
      <div style="margin-top:16px">${rawJson('Raw policy (JSON)', policy)}</div>
    </section>

    <aside>
      <h2>In scope today</h2>
      <p class="note" style="margin:0 0 8px">
        Agent and tool pairs this policy’s selectors match. Scope, not permission.
      </p>
      ${pairs.length === 0
        ? emptyState('No registered pair matches these selectors.')
        : table(
            'Agent and tool pairs in scope',
            ['Agent', 'Tool'],
            pairs.map(
              ({ agent, tool }) => html`<tr>
                <td><a href="/agents/${agent.id}">${agent.name}</a></td>
                <td class="mono">${tool.name}</td>
              </tr>`,
            ),
            { compact: true },
          )}

      ${sectionTitle('Decisions in loaded evidence')}
      <p class="note" style="margin:0 0 8px">Most recent ${count(evidence.length)} records only.</p>
      ${table(
        'Decisions per rule within the loaded evidence',
        ['Rule', 'Effect', { label: 'Records', numeric: true }],
        list(policy.rules).map(
          (rule) => html`<tr>
            <td class="mono">${rule.id}</td>
            <td>${effectBadge(rule.effect)}</td>
            <td class="numeric tnum">${count(perRule.get(String(rule.id)) ?? 0)}</td>
          </tr>`,
        ),
        { compact: true },
      )}
      <p class="note"><a href="/evidence">Evidence decided by this policy →</a></p>
    </aside>
  </div>`;

  return page(context, '/policies', String(policy.id ?? 'Policy'), raw(body), shell);
}

// --- 6. access ------------------------------------------------------------

/**
 * The access matrix.
 *
 * Deliberately not an authorization table. A cell reports which enabled
 * policies are in scope for an agent-and-tool pair and which effects those
 * policies' rules can produce; it never reports that an action is permitted,
 * because that depends on the parameters of a real request and on the
 * strictest effect across every matching policy. The matrix calls the policy
 * engine's own `matchSelectors`, so what it shows as "in scope" is exactly
 * what the engine matches.
 */
export async function accessPage(context: PageContext): Promise<string> {
  const shell = await chrome(context);
  const [{ agents }, { tools }, { policies }] = await Promise.all([
    context.client.listAgents(),
    context.client.listTools(),
    context.client.listPolicies(),
  ]);

  const selectedAgentId = context.query.get('agent') ?? '';
  const selectedTool = context.query.get('tool') ?? '';
  const agent = agents.map((entry) => rec(entry)).find((entry) => entry.id === selectedAgentId);
  const tool = tools.map((entry) => rec(entry)).find((entry) => entry.name === selectedTool);
  const scope = agent && tool ? cellScope(agent, tool, policies) : undefined;

  const detail =
    scope && agent && tool
      ? html`<aside class="card" aria-label="Pair detail" style="padding:0">
          <div
            style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:16px 20px;border-bottom:1px solid var(--border)"
          >
            <div>
              <h2 style="margin:0;font-size:15px">${agent.name} → <span class="mono">${tool.name}</span></h2>
              <p class="note" style="margin:2px 0 0;font-size:12px">
                ${scope.declared ? 'Declared by the agent. Not a grant.' : 'Not declared by the agent.'}
              </p>
            </div>
            <a href="/access">Close</a>
          </div>
          <div style="padding:16px 20px">
            ${scope.enabled.length === 0
              ? raw(html`<p style="margin:0;font-size:13px">
                  No enabled policy is in scope, so the engine default applies: <strong>DENY</strong> (“no policy
                  authorizes this action”), or ALLOW if the deployment runs monitor-only. The console cannot read which.
                </p>`)
              : raw(
                  scope.enabled
                    .map(
                      (policy) =>
                        html`<div style="margin-bottom:16px">
                          <div class="chips" style="justify-content:space-between">
                            <a class="mono" href="/policies/${encodeURIComponent(String(policy.id))}"
                              ><strong>${policy.id}</strong></a
                            >
                            <span class="muted" style="font-size:12px">${policy.name}</span>
                          </div>
                          <div style="margin-top:6px">${scopeChips(policy.match)}</div>
                          ${ruleLadder(policy, { narrow: true })}
                        </div>`,
                    )
                    .join(''),
                )}
            ${scope.disabled.length > 0
              ? raw(html`<p class="note">
                  Disabled and not evaluated: ${scope.disabled.map((policy) => String(policy.id)).join(', ')}
                </p>`)
              : NOTHING}
            <p class="note" style="border-top:1px solid var(--border);padding-top:12px">
              Across policies the strictest effect wins. Which rung fires depends on the request’s parameters.
            </p>
          </div>
        </aside>`
      : '';

  const body = html`${pageHeader({
    title: 'Access',
    lede: 'Which enabled policies govern each agent and tool pair, and which effects their rules can produce. This is scope, not permission: the effect for a real request depends on its parameters at request time.',
  })}

  <div class="legend" aria-label="Legend">
    <span class="item"><strong style="color:var(--ink)">◆ declared</strong> agent lists the tool (not enforced)</span>
    <span class="item"
      >${effectLetter('ALLOW')} ALLOW ${effectLetter('REQUIRE_APPROVAL')} REQUIRE_APPROVAL ${effectLetter('DENY')} DENY
      possible</span
    >
    <span class="item">Empty cell: no policy in scope, engine default applies</span>
  </div>

  ${agents.length === 0 || tools.length === 0
    ? emptyState('The matrix needs at least one agent and one tool.')
    : raw(html`<div class="${detail ? 'with-detail' : ''}">
        ${accessMatrix(agents, tools, policies, { agentId: selectedAgentId, tool: selectedTool })}
        ${raw(detail)}
      </div>`)}

  <p class="note">
    A policy in scope does not mean the action is authorized. Scope is decided by the policy’s selectors; the effect is
    decided per request by the rules, and a suspended agent is refused at authentication before any policy is
    consulted.
  </p>`;

  return page(context, '/access', 'Access', raw(body), shell);
}

// --- 7. evidence ----------------------------------------------------------

export async function evidencePage(context: PageContext): Promise<string> {
  const shell = await chrome(context);
  const outcome = context.query.get('outcome') ?? '';
  const agentId = context.query.get('agentId') ?? '';

  const [all, agentsResult] = await Promise.all([
    context.client.listEvidence({ ...(agentId ? { agentId } : {}), limit: 100 }),
    context.client.listAgents().catch(() => ({ agents: [] })),
  ]);

  const loaded = all.evidence.map((entry) => rec(entry));
  const shown = outcome ? loaded.filter((record) => record.outcome === outcome) : loaded;

  const href = (next: { outcome?: string; agentId?: string }): string => {
    const query = new URLSearchParams();
    const nextOutcome = next.outcome ?? outcome;
    const nextAgent = next.agentId ?? agentId;
    if (nextOutcome) query.set('outcome', nextOutcome);
    if (nextAgent) query.set('agentId', nextAgent);
    const suffix = query.toString();
    return suffix ? `/evidence?${suffix}` : '/evidence';
  };

  const body = html`${pageHeader({
    title: 'Evidence',
    lede: 'One record per action, binding what was requested to who or what authorized it and what actually happened. Each record carries a digest over its own contents, so it can be exported to an auditor and verified without trusting the system that produced it.',
  })}
  <div class="stack" style="margin-bottom:20px">
    ${filterLinks(
      'Outcome',
      [
        { value: '', label: 'All', count: loaded.length },
        ...OUTCOMES.map((value) => ({
          value,
          label: outcomeLabel(value),
          count: loaded.filter((record) => record.outcome === value).length,
        })),
      ],
      outcome,
      (value) => href({ outcome: value }),
    )}
    ${filterLinks(
      'Agent',
      [
        { value: '', label: 'All agents' },
        ...agentsResult.agents.map((entry) => {
          const agent = rec(entry);
          return { value: String(agent.id ?? ''), label: String(agent.name ?? '') };
        }),
      ],
      agentId,
      (value) => href({ agentId: value }),
    )}
  </div>
  ${shown.length === 0
    ? emptyState('No evidence records match.')
    : evidenceTable(shown, 'Evidence records, newest first')}
  <p class="note">
    Newest first, up to 100 records. The outcome counts above are counts within these loaded records, not totals.
  </p>`;

  return page(context, '/evidence', 'Evidence', raw(body), shell);
}

export async function evidenceDetailPage(context: PageContext, evidenceId: string): Promise<string> {
  const shell = await chrome(context);
  const record = rec(await context.client.getEvidence(evidenceId));
  const decision = rec(record.decision);
  const agent = rec(record.agent);
  const tool = rec(record.tool);
  const request = rec(record.request);
  const execution = record.execution ? rec(record.execution) : undefined;

  let trace: unknown;
  if (typeof decision.id === 'string') {
    try {
      const full = await context.client.getDecision(decision.id);
      trace = full.trace;
    } catch {
      // The decision may have aged out of the store; the evidence record still
      // carries its digest, which is what verification depends on.
      trace = undefined;
    }
  }

  const tools = await context.client.listTools().then((result) => result.tools).catch(() => []);
  const spec = tools.map((entry) => rec(entry)).find((entry) => entry.name === tool.name)?.parameters;

  const body = html`${backLink('/evidence', 'All evidence')}
  ${pageHeader({
    display: true,
    title: raw(html`Evidence <span class="mono" style="font-weight:400;color:var(--ink-soft)">${record.id}</span>`),
    lede: raw(html`<a href="/agents/${agent.id}">${agent.name}</a> requested
    <span class="mono" style="color:var(--ink)">${tool.name}</span> · ${decision.reason}`),
    actions: raw(html`${outcomeBadge(record.outcome)} ${effectBadge(decision.effect)}`),
  })}

  <div class="split">
    <section aria-labelledby="timeline-heading">
      <h2 id="timeline-heading">What happened</h2>
      ${evidenceTimeline(record)}
      ${record.approval
        ? raw(html`<p style="font-size:13px">
            <a href="/approvals/${rec(record.approval).id}">Approval request →</a>
          </p>`)
        : NOTHING}
      <div style="margin-top:24px;border-top:1px solid var(--border);padding-top:16px">
        ${definitions([
          ['Environment', raw(html`<span class="mono">${record.environment}</span>`)],
          ['Owner', String(agent.owner ?? '')],
          [
            'Tool',
            raw(html`${tool.effect} · ${tool.riskTier} · <span class="mono">${tool.system}</span>`),
          ],
          ['Credential', raw(html`<span class="mono">${agent.credentialId}</span>`)],
        ])}
      </div>
    </section>

    <section aria-label="Detail" class="stack">
      <div>
        <h2>Parameters</h2>
        ${parameterTable(request.parameters, 'Recorded parameters', spec)}
        ${request.intent
          ? raw(html`<p class="note">
              <strong>Agent-stated intent (advisory, not used by policy):</strong> “${request.intent}”
            </p>`)
          : NOTHING}
      </div>

      <div>
        <h2>Decision trace</h2>
        <p class="note" style="margin:0 0 8px">
          Every rule the engine examined, in order. The evidence record stores a digest of this trace, so a tampered
          trace is detectable without duplicating it.
        </p>
        ${trace === undefined
          ? raw(html`<p class="muted" style="font-size:13px">
              The full trace for this decision is no longer held. The trace digest below still binds it.
            </p>`)
          : traceTable(trace)}
      </div>

      <div>
        <h2>Obligations</h2>
        <p style="margin:0;font-size:13px">
          ${strings(record.obligations).length > 0
            ? strings(record.obligations).join(', ')
            : raw(html`<span class="muted">None</span>`)}
        </p>
      </div>

      <div>
        <h2>Integrity</h2>
        ${digestBlock('integrityDigest', record.integrityDigest, 'over every field above')}
        ${digestBlock('parametersDigest', request.parametersDigest)}
        ${digestBlock('traceDigest', decision.traceDigest)}
        ${execution?.resultDigest ? digestBlock('resultDigest', execution.resultDigest) : NOTHING}
      </div>

      <div class="stack">
        ${rawJson('Raw record (JSON)', record)}
        ${trace === undefined ? NOTHING : rawJson('Raw decision trace (JSON)', trace)}
      </div>
    </section>
  </div>`;

  return page(context, '/evidence', 'Evidence detail', raw(body), shell);
}

// --- 8. audit -------------------------------------------------------------

export async function auditPage(context: PageContext): Promise<string> {
  const shell = await chrome(context);

  const headDigest = context.query.get('headDigest') ?? '';
  const headSequenceRaw = context.query.get('headSequence') ?? '';
  const headSequence = headSequenceRaw && Number.isInteger(Number(headSequenceRaw)) ? Number(headSequenceRaw) : undefined;
  const anchored = Boolean(headDigest) || headSequence !== undefined;

  const family = context.query.get('family') ?? '';
  const afterSequence = Number(context.query.get('afterSequence') ?? '');

  const [audit, verification] = await Promise.all([
    context.client.listAudit({
      limit: 150,
      order: 'desc',
      ...(Number.isInteger(afterSequence) && afterSequence > 0 ? { afterSequence } : {}),
    }),
    context.client.verifyAudit({
      ...(headDigest ? { headDigest } : {}),
      ...(headSequence !== undefined ? { headSequence } : {}),
    }),
  ]);

  const records = audit.records.map((entry) => rec(entry));
  const shown = family ? records.filter((record) => eventFamily(record.type) === family) : records;
  const flagged = new Set(verification.failures.map((failure) => `${failure.sequence}:${failure.id}`));

  const rows = shown.map((record) => {
    const isFlagged = flagged.has(`${String(record.sequence)}:${String(record.id)}`);
    // `subject` on an evidence.recorded event is the *action* id; the evidence
    // record's own id is in `data.evidenceId`. Linking the subject produced a
    // 404 on every such row.
    const evidenceId = record.type === 'evidence.recorded' ? rec(record.data).evidenceId : undefined;
    return html`<tr class="${isFlagged ? 'flagged' : ''}">
      <td class="numeric mono tnum">${record.sequence}</td>
      <td class="mono tnum nowrap muted">${timestamp(record.occurredAt)}</td>
      <td class="mono nowrap">${record.type}</td>
      <td class="mono">${record.actor}</td>
      <td style="font-size:13px">
        ${evidenceId
          ? raw(html`<a href="/evidence/${evidenceId}">${record.summary}</a>`)
          : record.summary}
      </td>
      <td class="mono nowrap muted" title="${record.digest ?? ''}">${shortDigest(record.digest)}</td>
    </tr>`;
  });

  const oldest = records[records.length - 1];

  const body = html`${pageHeader({
    title: 'Audit',
    lede: 'Append-only and hash-chained: each record carries the digest of its predecessor, so editing one breaks every link after it and removing one from the middle leaves a sequence gap.',
  })}
  ${anchored
    ? raw(html`<p class="note" style="margin:0 0 8px">
        Verified against the anchored head you supplied. <a href="/audit">Clear</a>
      </p>`)
    : NOTHING}
  ${chainVerdict(verification)}

  <details class="raw" style="margin-top:12px">
    <summary>Verify against an anchored head</summary>
    <form method="get" action="/audit" class="field-row" style="padding:12px 16px;border-top:1px solid var(--border)">
      <label class="field">
        headDigest
        <input class="mono" type="text" name="headDigest" value="${headDigest}" placeholder="sha256:…" />
      </label>
      <label class="field" style="max-width:180px">
        headSequence
        <input class="mono" type="text" inputmode="numeric" name="headSequence" value="${headSequenceRaw}" />
      </label>
      <button type="submit" class="primary">Verify</button>
    </form>
  </details>

  ${sectionTitle(
    'Records',
    raw(html`<span class="muted">Newest first · ${count(shown.length)} of ${count(audit.total)} shown</span>`),
  )}
  <div style="margin-bottom:12px">
    ${filterLinks(
      'Family (within this page of records)',
      [
        { value: '', label: 'All', count: records.length },
        ...AUDIT_FAMILIES.map((value) => ({
          value,
          label: value,
          count: records.filter((record) => eventFamily(record.type) === value).length,
        })),
      ],
      family,
      (value) => (value ? `/audit?family=${value}` : '/audit'),
    )}
  </div>
  ${rows.length === 0
    ? emptyState(records.length === 0 ? 'The audit log is empty.' : 'No record in this page belongs to that family.')
    : table('Audit records', [{ label: '#', numeric: true }, 'When (UTC)', 'Event', 'Actor', 'Summary', 'Digest'], rows, {
        compact: true,
      })}
  ${oldest && audit.total > records.length
    ? raw(html`<p class="note">
        <a href="/audit?afterSequence=${String(oldest.sequence)}">Older records →</a> (from sequence
        ${String(oldest.sequence)} back)
      </p>`)
    : NOTHING}`;

  return page(context, '/audit', 'Audit', raw(body), shell);
}

// --- 9. security ----------------------------------------------------------

const SAMPLE_MANIFEST = `[
  {
    "name": "search",
    "description": "Search the documentation.",
    "inputSchema": { "type": "object", "properties": { "query": { "type": "string" } } }
  }
]`;

/**
 * Integrity of the record, posture of the connectors that carry actions out,
 * and an on-demand check of an MCP server's advertised tools — ordered by
 * consequence.
 *
 * The scan is stateless, and the page says so. `POST /v1/mcp/scan` computes a
 * report and returns it; nothing is registered and no result is stored, so a
 * reload scans again and changes nothing. That is why this page's scan posts
 * and renders its result directly instead of redirecting: there is no record
 * to redirect to.
 */
export async function securityPage(
  context: PageContext,
  scan?: { readonly report?: unknown; readonly error?: string; readonly form?: Rec },
): Promise<string> {
  const [health, verification] = await Promise.all([
    context.client.health(),
    context.client.verifyAudit(),
  ]);

  const shell = await chrome(context);
  const connectors = list(rec(health).connectors);
  const form = scan?.form ?? {};
  const report = scan?.report ? rec(scan.report) : undefined;

  const body = html`${pageHeader({
    title: 'Security',
    lede: 'Integrity of the record, posture of the connectors that carry actions out, and an on-demand check of an MCP server’s advertised tools. Ordered by consequence.',
  })}

  <h2>Audit chain</h2>
  ${chainVerdict(verification, { compact: true })}
  <p class="note"><a href="/audit">Full verification and the records themselves →</a></p>

  ${sectionTitle('Connector posture')}
  ${connectorTable(connectors)}
  <p class="note">
    An MCP connector reports drift when its advertised tool surface no longer matches the pinned manifest. The added,
    removed and modified tools are listed by <span class="mono">arc mcp diff</span>; the API exposes only this message.
  </p>

  ${sectionTitle('MCP manifest scan')}
  <p class="note" style="margin:0 0 16px">
    Results are <strong>not saved</strong>, and scanning registers nothing. The API computes a report and returns it;
    there is no findings store, so a reload scans again and leaves no trace. Run
    <span class="mono">arc mcp scan</span> in CI for a durable record.
  </p>

  <div class="split">
    <form method="post" action="/security/scan">
      <label class="field">
        Server name
        <input class="mono" type="text" name="name" required value="${form.name ?? 'docs'}" />
      </label>
      <label class="field">
        Endpoint
        <input class="mono" type="text" name="endpoint" required value="${form.endpoint ?? 'https://mcp.example.com'}" />
      </label>
      <label class="field">
        Tools (JSON array, as the server advertises them)
        <textarea class="mono" name="tools" rows="12">${form.tools ?? SAMPLE_MANIFEST}</textarea>
      </label>
      <div class="field-row">
        <button type="submit" class="primary">Scan</button>
        <span class="hint">Limit 64 KB — the console’s form body limit</span>
      </div>
      ${scan?.error
        ? raw(html`<p class="banner error" role="alert" style="margin-top:12px">
            <span class="banner-glyph" aria-hidden="true">✕</span><span>${scan.error}</span>
          </p>`)
        : NOTHING}
    </form>

    <div>
      ${report === undefined
        ? emptyState('Findings appear here after a scan. A reload scans again and changes nothing.')
        : raw(html`<section aria-label="Scan result">
            <div class="chips" style="margin-bottom:12px">
              ${report.passed ? badge('allow', 'PASS') : badge('deny', 'FAIL')}
              <span style="font-size:13px">
                <span class="mono">${report.server}</span> · ${count(report.toolsScanned)} tool(s) ·
                ${count(list(report.findings).length)} finding(s) · highest
                ${severityBadge(report.highestSeverity)}
              </span>
            </div>
            <p class="note" style="margin:0 0 12px">
              A scan fails when any finding is high or critical. Scanned
              <span class="mono">${timestamp(report.scannedAt)}</span>; this result exists only in this response.
            </p>
            ${findingsTable(report)}
          </section>`)}
    </div>
  </div>`;

  return page(context, '/security', 'Security', raw(body), shell);
}

// --- 10. reports ----------------------------------------------------------

const OUTCOME_COLOR: Record<string, string> = {
  allowed: 'color-mix(in srgb, var(--allow) 55%, var(--surface))',
  executed: 'var(--allow)',
  pending_approval: 'var(--approval)',
  approved: 'color-mix(in srgb, var(--allow) 30%, var(--surface))',
  rejected: 'var(--ink-soft)',
  expired: 'color-mix(in srgb, var(--ink-soft) 45%, var(--surface))',
  denied: 'var(--deny)',
  failed: 'var(--failed)',
};

/**
 * An operational snapshot over records the console already reads.
 *
 * Every figure here is computed from one bounded window of evidence, and the
 * window is printed at the top: how many records, and the first and last
 * timestamp in them. There is no time axis, no rate and no trend arrow,
 * because no endpoint can support one — inventing one would be the difference
 * between a report and a claim.
 */
export async function reportsPage(context: PageContext): Promise<string> {
  const [health, evidenceResult, approvals, auditResult, agentsResult, toolsResult] = await Promise.all([
    context.client.health(),
    context.client.listEvidence({ limit: 200 }),
    context.client.listApprovals(),
    context.client.listAudit({ limit: 1, order: 'desc' }),
    context.client.listAgents(),
    context.client.listTools(),
  ]);

  const shell: Chrome = { health: rec(health), pendingApprovals: approvals.approvals.length };
  const counts = rec(rec(health).counts);
  const window = evidenceResult.evidence.map((entry) => rec(entry));
  const agents = agentsResult.agents.map((entry) => rec(entry));
  const tools = toolsResult.tools.map((entry) => rec(entry));

  const times = window.map((record) => String(record.createdAt ?? '')).filter(Boolean).sort();
  const total = window.length;

  const segments: Segment[] = OUTCOMES.map((value) => ({
    key: value,
    label: outcomeLabel(value),
    value: window.filter((record) => record.outcome === value).length,
    color: OUTCOME_COLOR[value] ?? 'var(--ink-soft)',
  }));
  const summary = `Of ${total} records: ${
    segments
      .filter((segment) => segment.value > 0)
      .map((segment) => `${segment.value} ${segment.label}`)
      .join(', ') || 'none'
  }.`;

  const perRule = new Map<string, { allow: number; approval: number; deny: number }>();
  for (const record of window) {
    const decision = rec(record.decision);
    const key = decision.policyId ? `${String(decision.policyId)}/${String(decision.ruleId)}` : 'engine default';
    const row = perRule.get(key) ?? { allow: 0, approval: 0, deny: 0 };
    if (decision.effect === 'ALLOW') row.allow += 1;
    else if (decision.effect === 'DENY') row.deny += 1;
    else row.approval += 1;
    perRule.set(key, row);
  }

  const perTool = tools.map((tool) => {
    const runs = window
      .filter((record) => rec(record.tool).name === tool.name && record.execution)
      .map((record) => rec(record.execution));
    const durations = runs.map((run) => Number(run.durationMs ?? 0)).sort((a, b) => a - b);
    const middle = durations.length
      ? durations.length % 2
        ? durations[(durations.length - 1) / 2]
        : ((durations[durations.length / 2 - 1] ?? 0) + (durations[durations.length / 2] ?? 0)) / 2
      : undefined;
    return {
      tool: String(tool.name ?? ''),
      runs: runs.length,
      failures: runs.filter((run) => run.status === 'failed').length,
      median: middle,
      max: durations[durations.length - 1],
    };
  });

  const approvalsPending = approvals.approvals.length;
  const approvalOutcomes = ['approved', 'rejected', 'expired'] as const;

  const body = html`${pageHeader({
    title: 'Reports',
    lede: 'An operational snapshot computed from records the console already reads. It describes a window of recent records, not a trend.',
  })}

  <p class="card" style="font-size:13px">
    <strong>Window:</strong> the most recent <span class="tnum">${count(total)}</span> evidence
    records${times.length > 0
      ? raw(html`, <span class="mono">${timestamp(times[0])}</span> to
        <span class="mono">${timestamp(times[times.length - 1])}</span>`)
      : raw(html` <span class="muted">(none yet)</span>`)}. Up to 200 are read, so a busier deployment’s window
    is shorter in time. Generated <span class="mono">${timestamp(new Date().toISOString())}</span>. Pending approvals
    and the inventory counts below are current, not windowed.
  </p>

  <h2>Decision outcomes</h2>
  ${total === 0
    ? emptyState('No evidence records yet, so there is nothing to report.')
    : raw(html`${stackedBar(segments, summary)}
        ${table(
          'Outcome mix within the window',
          segments.map((segment) => segment.label),
          [
            html`<tr>
              ${segments.map(
                (segment) => raw(html`<td class="tnum ${segment.value ? '' : 'muted'}">
                  ${count(segment.value)}
                  <span class="muted">(${String(Math.round((segment.value / (total || 1)) * 100))}%)</span>
                </td>`),
              )}
            </tr>`,
          ],
          { compact: true },
        )}`)}

  <div class="split-even" style="margin-top:32px">
    <section>
      <h2>Policy activity</h2>
      ${perRule.size === 0
        ? emptyState('No decision in the window cites a policy.')
        : table(
            'Decisions per policy and rule within the window',
            [
              'Policy / rule',
              { label: 'ALLOW', numeric: true },
              { label: 'APPROVAL', numeric: true },
              { label: 'DENY', numeric: true },
            ],
            [...perRule.entries()].map(
              ([key, row]) => html`<tr>
                <td class="mono">
                  ${key === 'engine default'
                    ? raw(html`<span class="muted" style="font-family:var(--sans)">engine default</span>`)
                    : raw(html`<a href="/policies/${encodeURIComponent(key.split('/')[0] ?? '')}">${key}</a>`)}
                </td>
                <td class="numeric tnum">${count(row.allow)}</td>
                <td class="numeric tnum">${count(row.approval)}</td>
                <td class="numeric tnum">${count(row.deny)}</td>
              </tr>`,
            ),
            { compact: true },
          )}
    </section>

    <section>
      <h2>Tool activity and execution</h2>
      ${table(
        'Execution per tool within the window',
        [
          'Tool',
          { label: 'Runs', numeric: true },
          { label: 'Failures', numeric: true },
          { label: 'Median ms', numeric: true },
          { label: 'Max ms', numeric: true },
        ],
        perTool.map(
          (row) => html`<tr>
            <td class="mono">${row.tool}</td>
            <td class="numeric tnum">${count(row.runs)}</td>
            <td class="numeric tnum ${row.failures > 0 ? 'deny-text' : ''}">${count(row.failures)}</td>
            <td class="numeric tnum">${row.median === undefined ? '—' : count(Math.round(row.median))}</td>
            <td class="numeric tnum">${row.max === undefined ? '—' : count(row.max)}</td>
          </tr>`,
        ),
        { compact: true },
      )}
      <p class="note">
        A failed execution is a failed execution, not a denial: the decision allowed it and the connector could not
        carry it out. Both are in <a href="/evidence?outcome=failed">Evidence</a>.
      </p>
    </section>
  </div>

  ${sectionTitle('Approvals')}
  <p class="note" style="margin:0 0 12px">
    Pending is current. The resolved counts are within the evidence window, because the API lists pending requests only
    — there is no approval-history endpoint to count against.
  </p>
  ${countLine([
    { value: approvalsPending, label: 'pending now', href: '/approvals' },
    ...approvalOutcomes.map((value) => ({
      value: window.filter((record) => rec(record.approval).status === value).length,
      label: `${value} in window`,
    })),
    {
      value: window.filter((record) => record.outcome === 'pending_approval').length,
      label: 'held for approval in window',
    },
  ])}

  ${sectionTitle('Inventory (current)')}
  ${countLine([
    { value: counts.agents ?? 0, label: 'agents', href: '/agents' },
    { value: agents.filter((agent) => agent.status === 'suspended').length, label: 'suspended' },
    { value: counts.tools ?? 0, label: 'tools', href: '/tools' },
    { value: tools.filter((tool) => tool.riskTier === 'critical').length, label: 'critical-tier tools' },
    { value: counts.policies ?? 0, label: 'policies', href: '/policies' },
    { value: counts.auditRecords ?? 0, label: 'audit records', href: '/audit' },
  ])}
  <div style="margin-top:16px">${connectorTable(list(rec(health).connectors))}</div>
  <p class="note">
    Audit head sequence <span class="tnum">${count(rec(auditResult.records[0]).sequence ?? 0)}</span>. This page
    computes nothing the records do not already say.
  </p>`;

  return page(context, '/reports', 'Reports', raw(body), shell);
}

// --- confirmation ---------------------------------------------------------

export type ConfirmAction = 'reject' | 'suspend' | 'disable';

/**
 * The confirmation page for an irreversible or disruptive action.
 *
 * Render-only: this is a GET that changes nothing. The form on it posts to the
 * existing POST path with the existing field names, so the mutation contract is
 * untouched and a reload of this page cannot act.
 */
export async function confirmPage(
  context: PageContext,
  action: ConfirmAction,
  targetId: string,
): Promise<string> {
  const shell = await chrome(context);

  if (action === 'reject') {
    const request = rec(await context.client.getApproval(targetId));
    const headline = actionHeadline(request.tool, request.parameters);
    return page(
      context,
      '/approvals',
      'Reject request',
      confirmBody({
        title: 'Reject this request?',
        what: raw(html`${headline.verb} <strong>${headline.strong ?? ''}</strong> ${headline.rest ?? ''}, requested by
        ${request.agentName}.`),
        effect:
          'Rejecting resolves the request immediately. The action will not run. Your vote and reason are recorded in evidence and the audit log.',
        post: `POST /approvals/${String(request.id)}/vote  vote=reject`,
        confirmLabel: 'Reject request',
        cancelHref: '/approvals',
        formAction: `/approvals/${String(request.id)}/vote`,
        hidden: [['vote', 'reject']],
        comment: true,
      }),
      shell,
    );
  }

  if (action === 'suspend') {
    const agent = rec(await context.client.getAgent(targetId));
    return page(
      context,
      '/agents',
      'Suspend agent',
      confirmBody({
        title: `Suspend ${String(agent.name ?? '')}?`,
        what: raw(html`<strong>${agent.name}</strong> (${agent.kind}, ${agent.environment}), owned by
        ${agent.owner}.`),
        effect:
          'Suspended agents are refused at authentication, before any policy runs. This is recorded in the audit log, and the agent can be resumed from the Agents page.',
        post: `POST /agents/${String(agent.id)}/suspend`,
        confirmLabel: 'Suspend agent',
        cancelHref: '/agents',
        formAction: `/agents/${String(agent.id)}/suspend`,
      }),
      shell,
    );
  }

  const policy = rec(await context.client.getPolicy(targetId));
  return page(
    context,
    '/policies',
    'Disable policy',
    confirmBody({
      title: `Disable ${String(policy.id ?? '')}?`,
      what: raw(html`<strong>${policy.name}</strong>, version ${policy.version}, governing
      <span class="mono">${JSON.stringify(policy.match)}</span>.`),
      effect:
        'A disabled policy is no longer evaluated. Actions it governed fall to any other matching policy, or to the engine default (DENY unless the deployment runs monitor-only). This takes effect immediately and is recorded in the audit log.',
      post: `POST /policies/${String(policy.id)}/disable`,
      confirmLabel: 'Disable policy',
      cancelHref: '/policies',
      formAction: `/policies/${encodeURIComponent(String(policy.id))}/disable`,
    }),
    shell,
  );
}

function confirmBody(options: {
  title: string;
  what: Trusted;
  effect: string;
  post: string;
  confirmLabel: string;
  cancelHref: string;
  formAction: string;
  hidden?: readonly (readonly [string, string])[];
  comment?: boolean;
}): Trusted {
  return raw(html`<div style="max-width:640px">
    ${pageHeader({ title: options.title })}
    <p style="font-size:15px;margin:0">${options.what}</p>
    <p class="note">${options.effect}</p>
    <form method="post" action="${options.formAction}" style="margin-top:24px">
      ${(options.hidden ?? []).map(
        ([name, value]) => raw(html`<input type="hidden" name="${name}" value="${value}" />`),
      )}
      ${options.comment
        ? raw(html`<label class="field" for="confirm-comment">Reason, recorded in evidence</label>
          <textarea id="confirm-comment" name="comment" rows="3"></textarea>`)
        : NOTHING}
      <div class="field-row" style="margin-top:16px">
        <button type="submit" class="danger-solid">${options.confirmLabel}</button>
        <a href="${options.cancelHref}">Cancel</a>
      </div>
      <p class="note mono">Submits ${options.post} (unchanged contract)</p>
    </form>
  </div>`);
}

// --- errors ---------------------------------------------------------------

const ERROR_TITLES: Record<number, string> = {
  404: 'Not found',
  405: 'Method not allowed',
  500: 'The console failed',
  502: 'The control API could not be reached',
};

/**
 * The error page.
 *
 * The message is rendered verbatim — escaped, but not reworded. An operator
 * debugging a console that cannot reach its API needs the actual error, and a
 * friendlier sentence would cost them the one thing on the page worth having.
 */
export function errorPage(context: PageContext, status: number, message: string): string {
  const body = html`<div style="max-width:640px;padding-top:24px">
    <p class="mono tnum muted">${String(status)}</p>
    <h1 style="margin-top:4px">${ERROR_TITLES[status] ?? 'Error'}</h1>
    <p class="mono" style="margin-top:12px;background:var(--surface-sunk);padding:8px 12px;border-radius:6px">
      ${message}
    </p>
    <p class="note">API base <span class="mono">${context.apiBase}</span></p>
    <p style="margin-top:20px;display:flex;gap:20px"><a href="/">← Overview</a></p>
  </div>`;

  return layout({
    title: String(status),
    active: '/',
    body,
    apiBase: context.apiBase,
    operatorIdentity: context.operatorIdentity,
    ...(context.banner ? { banner: context.banner } : {}),
  });
}

export { jsonBlock };
