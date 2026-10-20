import type { ArcControlClient } from '@arc-control/sdk-typescript';
import {
  effectBadge,
  emptyState,
  html,
  jsonBlock,
  layout,
  outcomeBadge,
  raw,
  riskBadge,
  timestamp,
} from './render.js';

export interface PageContext {
  readonly client: ArcControlClient;
  readonly apiBase: string;
  readonly query: URLSearchParams;
  readonly banner?: string;
}

function page(context: PageContext, active: string, title: string, body: string): string {
  return layout({
    title,
    active,
    body,
    apiBase: context.apiBase,
    ...(context.banner ? { banner: context.banner } : {}),
  });
}

function table(headers: readonly string[], rows: readonly string[]): string {
  if (rows.length === 0) return '';
  return html`<div class="table-wrap">
    <table>
      <thead>
        <tr>
          ${headers.map((header) => raw(html`<th>${header}</th>`))}
        </tr>
      </thead>
      <tbody>
        ${rows.map((row) => raw(row))}
      </tbody>
    </table>
  </div>`;
}

// --- overview -------------------------------------------------------------

export async function overviewPage(context: PageContext): Promise<string> {
  const [health, evidence, approvals, verification] = await Promise.all([
    context.client.health(),
    context.client.listEvidence({ limit: 12 }),
    context.client.listApprovals(),
    context.client.verifyAudit(),
  ]);

  const counts = (health.counts ?? {}) as Record<string, number>;

  const rows = evidence.evidence.map((record) => {
    const decision = (record.decision ?? {}) as Record<string, unknown>;
    const agent = (record.agent ?? {}) as Record<string, unknown>;
    const tool = (record.tool ?? {}) as Record<string, unknown>;
    return html`<tr>
      <td class="mono">${timestamp(record.createdAt as string)}</td>
      <td>${agent.name}</td>
      <td class="mono">${tool.name}</td>
      <td>${effectBadge(String(decision.effect ?? ''))}</td>
      <td>${outcomeBadge(String(record.outcome ?? ''))}</td>
      <td class="mono">${decision.policyId ?? '—'}</td>
      <td><a href="/evidence/${record.id}" class="mono">${String(record.id).slice(0, 14)}…</a></td>
    </tr>`;
  });

  const body = html`<h1>Overview</h1>
    <p class="lede">
      Every action an agent attempted, whether it was allowed, held for a human or refused. A denial is recorded as
      durably as an execution: the attempt is itself the signal.
    </p>

    <div class="stats">
      <div class="stat"><div class="value">${counts.agents ?? 0}</div><div class="label">Agents</div></div>
      <div class="stat"><div class="value">${counts.tools ?? 0}</div><div class="label">Tools</div></div>
      <div class="stat"><div class="value">${counts.policies ?? 0}</div><div class="label">Policies</div></div>
      <div class="stat">
        <div class="value">${approvals.approvals.length}</div>
        <div class="label">Awaiting approval</div>
      </div>
      <div class="stat">
        <div class="value">${counts.auditRecords ?? 0}</div>
        <div class="label">Audit records</div>
      </div>
      <div class="stat">
        <div class="value ${verification.valid ? 'chain-ok' : 'chain-bad'}">
          ${verification.valid ? 'intact' : 'BROKEN'}
        </div>
        <div class="label">Audit chain</div>
      </div>
    </div>

    <h2>Recent activity</h2>
    ${rows.length === 0
      ? emptyState('No actions have reached the gateway yet.')
      : raw(table(['When', 'Agent', 'Tool', 'Decision', 'Outcome', 'Policy', 'Evidence'], rows))}`;

  return page(context, '/', 'Overview', body);
}

// --- agents ---------------------------------------------------------------

export async function agentsPage(context: PageContext): Promise<string> {
  const [agents, tools] = await Promise.all([context.client.listAgents(), context.client.listTools()]);

  const agentRows = agents.agents.map((agent) => {
    const suspended = agent.status === 'suspended';
    return html`<tr>
      <td><strong>${agent.name}</strong><br /><span class="reason">${agent.description ?? ''}</span></td>
      <td>
        ${suspended ? raw(html`<span class="badge deny">suspended</span>`) : raw(html`<span class="badge allow">active</span>`)}
      </td>
      <td>${agent.owner}</td>
      <td class="mono">${(agent.roles as string[] | undefined)?.join(', ') || '—'}</td>
      <td class="mono">${agent.environment}</td>
      <td>
        <form class="inline" method="post" action="/agents/${agent.id}/${suspended ? 'resume' : 'suspend'}">
          <button type="submit" class="${suspended ? 'primary' : 'danger'}">
            ${suspended ? 'Resume' : 'Suspend'}
          </button>
        </form>
      </td>
    </tr>`;
  });

  const toolRows = tools.tools.map(
    (tool) => html`<tr>
      <td class="mono"><strong>${tool.name}</strong><br /><span class="reason">${tool.description}</span></td>
      <td>${tool.effect}</td>
      <td>${riskBadge(String(tool.riskTier ?? ''))}</td>
      <td class="mono">${tool.connector}</td>
      <td class="mono">
        ${((tool.parameters ?? []) as { name: string }[]).map((spec) => spec.name).join(', ') || '—'}
      </td>
    </tr>`,
  );

  const body = html`<h1>Agents and tools</h1>
    <p class="lede">
      An agent is the principal ARC Control authorizes; a tool is a capability it may ask to use. Suspending an agent
      stops it at authentication, before any policy is consulted.
    </p>

    <h2>Agents</h2>
    ${agentRows.length === 0
      ? emptyState('No agents are registered.')
      : raw(table(['Agent', 'Status', 'Owner', 'Roles', 'Environment', ''], agentRows))}

    <h2>Tools</h2>
    ${toolRows.length === 0
      ? emptyState('No tools are registered. An action naming an unregistered tool is refused before policy runs.')
      : raw(table(['Tool', 'Effect', 'Risk', 'Connector', 'Parameters'], toolRows))}`;

  return page(context, '/agents', 'Agents', body);
}

// --- policies -------------------------------------------------------------

export async function policiesPage(context: PageContext): Promise<string> {
  const { policies } = await context.client.listPolicies();

  const cards = policies.map((policy) => {
    const rules = ((policy.rules ?? []) as Record<string, unknown>[]).map(
      (rule) => html`<tr>
        <td class="mono">${rule.id}</td>
        <td>${effectBadge(String(rule.effect ?? ''))}</td>
        <td class="reason">${rule.reason}</td>
        <td class="mono">${JSON.stringify(rule.when)}</td>
      </tr>`,
    );

    const match = (policy.match ?? {}) as Record<string, unknown>;
    const fallback = (policy.fallback ?? {}) as Record<string, unknown>;

    return html`<div class="card">
      <h2 style="margin-top:0">
        <span class="mono">${policy.id}</span> v${policy.version} — ${policy.name}
        ${policy.enabled
          ? raw(html`<span class="badge allow">enabled</span>`)
          : raw(html`<span class="badge muted">disabled</span>`)}
      </h2>
      <p class="reason">${policy.description ?? ''}</p>
      <p class="mono" style="font-size:12.5px">
        applies to: ${Object.keys(match).length === 0 ? 'every action' : JSON.stringify(match)}
      </p>
      ${raw(table(['Rule', 'Effect', 'Reason', 'Condition'], rules))}
      <p class="reason" style="margin-bottom:0">
        If no rule matches: ${effectBadge(String(fallback.effect ?? ''))} — ${fallback.reason}
      </p>
      <form class="inline" method="post" action="/policies/${policy.id}/${policy.enabled ? 'disable' : 'enable'}" style="margin-top:12px">
        <button type="submit" class="${policy.enabled ? 'danger' : 'primary'}">
          ${policy.enabled ? 'Disable' : 'Enable'}
        </button>
      </form>
    </div>`;
  });

  const body = html`<h1>Policies</h1>
    <p class="lede">
      Every matching policy is evaluated and the strictest effect wins, so adding a policy can only tighten
      authorization, never loosen it. A policy that matches but whose rules do not fire falls through to its own
      fallback — there is no path on which no policy decides.
    </p>
    ${cards.length === 0 ? emptyState('No policies are published. With no policy, every action is denied.') : raw(cards.join(''))}`;

  return page(context, '/policies', 'Policies', body);
}

// --- approvals ------------------------------------------------------------

export async function approvalsPage(context: PageContext): Promise<string> {
  const { approvals } = await context.client.listApprovals();

  const cards = approvals.map((request) => {
    const requirement = (request.requirement ?? {}) as Record<string, unknown>;
    const votes = (request.votes ?? []) as Record<string, unknown>[];

    return html`<div class="card">
      <h2 style="margin-top:0">
        <span class="mono">${request.tool}</span> requested by <strong>${request.agentName}</strong>
      </h2>
      <p class="reason">
        ${request.reason} — policy <span class="mono">${request.policyId ?? '—'}</span>, rule
        <span class="mono">${request.ruleId ?? '—'}</span>
      </p>
      ${jsonBlock(request.parameters)}
      <p class="reason">
        Approvers: <span class="mono">${(requirement.approvers as string[] | undefined)?.join(', ')}</span> ·
        needs ${requirement.minApprovals} · expires ${timestamp(request.expiresAt as string)}
        ${requirement.requireSeparationOfDuties ? ' · the agent owner may not approve' : ''}
      </p>
      ${votes.length > 0
        ? raw(
            html`<p class="reason">
              Votes:
              ${votes.map((vote) => raw(html`<span class="mono">${vote.approver} → ${vote.vote}</span>; `))}
            </p>`,
          )
        : ''}
      <form class="inline" method="post" action="/approvals/${request.id}/vote">
        <input type="text" name="comment" placeholder="Reason (recorded in evidence)" />
        <button type="submit" name="vote" value="approve" class="primary">Approve</button>
        <button type="submit" name="vote" value="reject" class="danger">Reject</button>
      </form>
    </div>`;
  });

  const body = html`<h1>Approvals</h1>
    <p class="lede">
      Actions a policy will not authorize on its own. Approving does not execute the action — execution is a separate
      step, and a granted approval is consumed when it is used, so it can never authorize a second execution.
    </p>
    ${cards.length === 0 ? emptyState('Nothing is waiting for a human.') : raw(cards.join(''))}`;

  return page(context, '/approvals', 'Approvals', body);
}

// --- evidence -------------------------------------------------------------

export async function evidencePage(context: PageContext): Promise<string> {
  const outcome = context.query.get('outcome') ?? undefined;
  const { evidence } = await context.client.listEvidence({
    ...(outcome ? { outcome } : {}),
    limit: 100,
  });

  const rows = evidence.map((record) => {
    const decision = (record.decision ?? {}) as Record<string, unknown>;
    const agent = (record.agent ?? {}) as Record<string, unknown>;
    const tool = (record.tool ?? {}) as Record<string, unknown>;
    return html`<tr>
      <td class="mono">${timestamp(record.createdAt as string)}</td>
      <td>${agent.name}</td>
      <td class="mono">${tool.name}</td>
      <td>${effectBadge(String(decision.effect ?? ''))}</td>
      <td>${outcomeBadge(String(record.outcome ?? ''))}</td>
      <td class="reason">${decision.reason}</td>
      <td><a href="/evidence/${record.id}" class="mono">${String(record.id).slice(0, 14)}…</a></td>
    </tr>`;
  });

  const filters = ['', 'executed', 'denied', 'pending_approval', 'failed'].map(
    (value) =>
      html`<a
        href="${value ? `/evidence?outcome=${value}` : '/evidence'}"
        class="${(outcome ?? '') === value ? 'nav-item active' : 'nav-item'}"
        >${value === '' ? 'All' : value.replace(/_/g, ' ')}</a
      >`,
  );

  const body = html`<h1>Evidence</h1>
    <p class="lede">
      One record per action, binding what was requested to who or what authorized it and what actually happened. Each
      record carries a digest over its own contents, so it can be exported to an auditor and verified without trusting
      the system that produced it.
    </p>
    <nav style="margin-bottom:16px">${filters}</nav>
    ${rows.length === 0
      ? emptyState('No evidence records match.')
      : raw(table(['When', 'Agent', 'Tool', 'Decision', 'Outcome', 'Reason', 'Evidence'], rows))}`;

  return page(context, '/evidence', 'Evidence', body);
}

export async function evidenceDetailPage(context: PageContext, evidenceId: string): Promise<string> {
  const record = await context.client.getEvidence(evidenceId);
  const decision = (record.decision ?? {}) as Record<string, unknown>;

  let trace: unknown;
  if (typeof decision.id === 'string') {
    try {
      const full = await context.client.getDecision(decision.id);
      trace = full.trace;
    } catch {
      // The decision may have aged out of the store; the evidence record
      // still carries its digest, which is what verification depends on.
      trace = undefined;
    }
  }

  const body = html`<h1>Evidence <span class="mono">${record.id}</span></h1>
    <p class="lede">
      ${outcomeBadge(String(record.outcome ?? ''))} ${effectBadge(String(decision.effect ?? ''))} — ${decision.reason}
    </p>

    <div class="card">
      <h2 style="margin-top:0">The record</h2>
      ${jsonBlock(record)}
    </div>

    ${trace
      ? raw(html`<div class="card">
          <h2 style="margin-top:0">Decision trace</h2>
          <p class="reason">
            Every rule the engine examined, in order. The evidence record stores a digest of this trace, so a tampered
            trace is detectable without duplicating it.
          </p>
          ${jsonBlock(trace)}
        </div>`)
      : ''}

    <p><a href="/evidence">← All evidence</a></p>`;

  return page(context, '/evidence', 'Evidence detail', body);
}

// --- audit ----------------------------------------------------------------

export async function auditPage(context: PageContext): Promise<string> {
  const [audit, verification] = await Promise.all([
    context.client.listAudit({ limit: 150, order: 'desc' }),
    context.client.verifyAudit(),
  ]);

  const rows = audit.records.map(
    (record) => html`<tr>
      <td class="mono">${record.sequence}</td>
      <td class="mono">${timestamp(record.occurredAt as string)}</td>
      <td class="mono">${record.type}</td>
      <td>${record.actor}</td>
      <td class="reason">${record.summary}</td>
      <td class="mono">${String(record.digest ?? '').slice(7, 19)}…</td>
    </tr>`,
  );

  const body = html`<h1>Audit</h1>
    <p class="lede">
      Append-only and hash-chained: each record carries the digest of its predecessor, so editing one breaks every link
      after it and removing one leaves a sequence gap. Verification recomputes the chain from the records alone.
    </p>

    <div class="card">
      <strong>Chain status:</strong>
      ${verification.valid
        ? raw(html`<span class="chain-ok">intact</span> — ${verification.recordsChecked} record(s) verified`)
        : raw(
            html`<span class="chain-bad">BROKEN</span> — ${verification.failures.length} problem(s) in
            ${verification.recordsChecked} record(s)`,
          )}
      ${verification.valid ? '' : jsonBlock(verification.failures)}
      <p class="reason" style="margin-bottom:0">
        This is tamper evidence, not tamper proofing: an attacker who controls the storage can rewrite the whole chain.
        Anchoring the head digest outside ARC Control is what closes that gap.
      </p>
    </div>

    ${rows.length === 0
      ? emptyState('The audit log is empty.')
      : raw(table(['#', 'When', 'Event', 'Actor', 'Summary', 'Digest'], rows))}`;

  return page(context, '/audit', 'Audit', body);
}

export function errorPage(context: PageContext, status: number, message: string): string {
  const body = html`<h1>${status}</h1>
    <p class="lede">${message}</p>
    <p><a href="/">← Overview</a></p>`;
  return page(context, '/', String(status), body);
}
