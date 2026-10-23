/**
 * Composite rendering helpers: the parts of a page that are a shape rather
 * than a paragraph.
 *
 * These are ported from the Magic Patterns prototype's components, each of
 * which names the server-side helper it was meant to become in
 * `design-reference/magic-patterns/arc-control-prototype/src/data/mapping.ts`.
 * Nothing here fetches anything; a caller passes in what the API returned.
 */

import { matchSelectors } from '@arc-control/policy-engine';
import type { PolicyEffect, PolicyInput, PolicyMatch } from '@arc-control/schemas';
import {
  badge,
  definitions,
  digestBlock,
  effectBadge,
  effectLetter,
  html,
  join,
  jsonBlock,
  NOTHING,
  outcomeBadge,
  raw,
  riskBadge,
  severityBadge,
  statusDot,
  table,
  type Trusted,
} from './render.js';
import {
  conditionToText,
  count,
  describeApprover,
  formatValue,
  shortDigest,
  shortId,
  timeMs,
  timestamp,
} from './format.js';

/** The API returns JSON, so every helper takes the loose shape and narrows. */
type Rec = Record<string, unknown>;

function rec(value: unknown): Rec {
  return (value ?? {}) as Rec;
}

function list(value: unknown): readonly Rec[] {
  return Array.isArray(value) ? (value as Rec[]) : [];
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

// --- conditions and policy shape ------------------------------------------

/** The condition as a sentence, with the exact JSON kept in `title`. */
export function conditionInline(condition: unknown): Trusted {
  return raw(html`<code class="cond" title="${JSON.stringify(condition) ?? ''}">${conditionToText(condition)}</code>`);
}

/** `scopeChips(match)` — an omitted selector matches everything, and says so. */
export function scopeChips(match: unknown): Trusted {
  const entries = Object.entries(rec(match)).filter(
    ([, value]) => Array.isArray(value) && value.length > 0,
  ) as [string, unknown[]][];

  if (entries.length === 0) return raw(html`<span class="muted">Applies to every action</span>`);

  return raw(html`<span class="chips">
    ${entries.flatMap(([key, values]) =>
      values.map((value) =>
        raw(html`<span class="scope-chip"><span class="k">${key}:</span><span class="v">${value}</span></span>`),
      ),
    )}
  </span>`);
}

/** `labelTags(labels)` — `control: SOX-302` reads as the control it cites. */
export function labelTags(labels: unknown): Trusted {
  const entries = Object.entries(rec(labels));
  if (entries.length === 0) return NOTHING;
  return raw(html`<span class="chips">
    ${entries.map(([key, value]) =>
      key === 'control'
        ? raw(html`<span class="label-tag control">${value}</span>`)
        : raw(html`<span class="label-tag">${key}=${value}</span>`),
    )}
  </span>`);
}

/**
 * `requirementLine(requirement)` — who must approve and for how long.
 *
 * The requirement comes from the policy rule, never from the caller that
 * submitted the action, which is why it is worth printing in full next to the
 * vote buttons.
 */
export function requirementLine(requirement: unknown, options: { compact?: boolean } = {}): Trusted {
  const spec = rec(requirement);
  const approvers = strings(spec.approvers);
  const minApprovals = Number(spec.minApprovals ?? 1);
  const expiresInSeconds = spec.expiresInSeconds === undefined ? undefined : Number(spec.expiresInSeconds);
  const sod = spec.requireSeparationOfDuties === true;

  if (options.compact) {
    return raw(html`<span class="muted"
      ><span class="tnum">${count(minApprovals)}</span> of <span class="mono">${approvers.join(', ') || '—'}</span
      >${sod ? ' · SoD' : ''}${expiresInSeconds === undefined
        ? ''
        : ` · expires after ${Math.round(expiresInSeconds / 60)} min`}</span
    >`);
  }

  const entries: (readonly [string, Trusted | string])[] = [
    [
      'Required',
      raw(html`<span class="tnum"><strong>${count(minApprovals)}</strong></span> approval${minApprovals === 1 ? '' : 's'}
      from ${approvers.map(describeApprover).join(' or ') || '—'}`),
    ],
    [
      'Separation of duties',
      sod ? 'On: the agent owner may not approve' : 'Off',
    ],
  ];
  if (expiresInSeconds !== undefined) {
    entries.push(['Window', raw(html`<span class="tnum">${Math.round(expiresInSeconds / 60)} min from request</span>`)]);
  }
  return definitions(entries);
}

/**
 * `ruleLadder(policy)` — rules in evaluation order.
 *
 * Within a policy the first rule whose condition holds decides, and the
 * fallback is the last rung. Across policies the strictest effect wins, which
 * the page says in prose rather than trying to draw.
 *
 * `narrow` stacks the rungs for a side panel, where the four-column grid
 * collapses to one word per line and the effect badge lands on top of the
 * condition.
 */
export function ruleLadder(
  policy: unknown,
  options: { highlightRule?: string; narrow?: boolean } = {},
): Trusted {
  const document = rec(policy);
  const rules = list(document.rules);
  const fallback = rec(document.fallback);

  const rungs = rules.map((rule, index) => {
    const approval = rule.approval ? rec(rule.approval) : undefined;
    const obligations = strings(rule.obligations);
    return html`<li class="${options.highlightRule === rule.id ? 'on' : ''}">
      <span class="rung" aria-label="Rule ${count(index + 1)}">${count(index + 1)}</span>
      <span class="rule-id">${rule.id}</span>
      <div class="rule-body">
        <p><span class="muted">when</span> ${conditionInline(rule.when)}</p>
        <p class="muted">${rule.reason}</p>
        ${rule.description ? raw(html`<p class="muted">${rule.description}</p>`) : NOTHING}
        ${approval
          ? raw(html`<p><span class="muted">needs </span>${requirementLine(approval, { compact: true })}</p>`)
          : NOTHING}
        ${obligations.length > 0
          ? raw(html`<p class="mono muted">obligations: ${obligations.join(', ')}</p>`)
          : NOTHING}
      </div>
      ${effectBadge(rule.effect)}
    </li>`;
  });

  return raw(html`<ol class="ladder ${options.narrow ? 'narrow' : ''}">
    ${rungs.map((rung) => raw(rung))}
    <li>
      <span class="rung" aria-hidden="true">↳</span>
      <span class="rule-id">Fallback</span>
      <div class="rule-body"><p class="muted">if no rule matched: ${fallback.reason}</p></div>
      ${effectBadge(fallback.effect)}
    </li>
  </ol>`);
}

// --- parameters, votes, credentials ---------------------------------------

/**
 * `parameterTable(params, spec)` — values exactly as recorded.
 *
 * The gateway has already redacted anything the tool declared sensitive, so
 * what arrives here is safe to render. A sensitive parameter is *marked* so an
 * approver knows the value they are seeing is the redacted one, and is never
 * un-redacted: the console has nothing to un-redact it from.
 */
export function parameterTable(parameters: unknown, caption: string, spec?: unknown): Trusted {
  const entries = Object.entries(rec(parameters));
  if (entries.length === 0) return raw(html`<p class="muted">No parameters.</p>`);

  const specs = list(spec);
  const rows = entries.map(([name, value]) => {
    const sensitive = specs.find((item) => item.name === name)?.sensitive === true;
    return html`<tr>
      <th scope="row">
        ${name}${sensitive ? raw(html` <span class="badge approval">sensitive</span>`) : NOTHING}
      </th>
      <td class="mono tnum">${formatValue(value)}</td>
    </tr>`;
  });

  return raw(html`<div class="table-wrap" role="region" aria-label="${caption}" tabindex="0">
    <table class="dt compact">
      <caption class="sr-only">${caption}</caption>
      <tbody>
        ${rows.map((row) => raw(row))}
      </tbody>
    </table>
  </div>`);
}

/** `voteList(votes)` */
export function voteList(votes: unknown): Trusted {
  const cast = list(votes);
  if (cast.length === 0) return raw(html`<p class="muted">Votes: none yet</p>`);

  return raw(html`<ul class="stack" style="list-style:none;margin:0;padding:0">
    ${cast.map(
      (vote) => raw(html`<li style="margin-top:8px">
        <span class="chips">
          <strong>${vote.approver}</strong>
          ${badge(vote.vote === 'approve' ? 'allow' : 'deny', String(vote.vote ?? ''))}
          <span class="mono muted">${timestamp(vote.votedAt)}</span>
        </span>
        ${vote.comment
          ? raw(html`<p class="muted" style="margin:4px 0 0;border-left:2px solid var(--border-strong);padding-left:12px">
              “${vote.comment}”
            </p>`)
          : NOTHING}
      </li>`),
    )}
  </ul>`);
}

/**
 * `credentialTable(credentials)` — metadata only.
 *
 * `AgentCredential` carries a salt and a secret hash as well as the display
 * prefix. Neither is rendered: there is no operator question they answer, and
 * a hash on a screenshot is a hash in an audit report.
 */
export function credentialTable(credentials: unknown): Trusted {
  const keys = list(credentials);
  const rows = keys.map(
    (key) => html`<tr>
      <td class="mono">${key.displayPrefix}…</td>
      <td>${statusDot(!key.revokedAt, key.revokedAt ? 'revoked' : 'valid')}</td>
      <td class="mono muted">${timestamp(key.createdAt)}</td>
      <td class="muted">
        ${key.expiresAt ? raw(html`<span class="mono">${timestamp(key.expiresAt)}</span>`) : 'no expiry set'}
      </td>
      <td class="mono muted">${timestamp(key.revokedAt)}</td>
      <td class="mono muted">${timestamp(key.lastUsedAt)}</td>
    </tr>`,
  );

  return table('Agent credentials', ['Prefix', 'State', 'Created', 'Expires', 'Revoked', 'Last used'], rows);
}

// --- evidence -------------------------------------------------------------

/**
 * Evidence rows, used on Overview, Evidence and Agent detail.
 *
 * Every identifier in a row is a link to its own page. The row itself is not
 * clickable: a clickable row needs JavaScript, and a link is better for a
 * keyboard and a screen reader anyway.
 */
export function evidenceTable(
  records: readonly unknown[],
  caption: string,
  options: { hideAgent?: boolean } = {},
): Trusted {
  const rows = records.map((entry) => {
    const record = rec(entry);
    const decision = rec(record.decision);
    const agent = rec(record.agent);
    const tool = rec(record.tool);
    const execution = record.execution ? rec(record.execution) : undefined;

    return html`<tr>
      <td class="mono tnum nowrap muted">${timestamp(record.createdAt)}</td>
      ${options.hideAgent
        ? NOTHING
        : raw(html`<td><a href="/agents/${agent.id}">${agent.name}</a></td>`)}
      <td class="mono nowrap">${tool.name}</td>
      <td>${effectBadge(decision.effect)}</td>
      <td>${outcomeBadge(record.outcome)}</td>
      <td class="tnum nowrap">
        ${execution
          ? raw(html`<span class="${execution.status === 'failed' ? 'deny-text' : ''}"
              >${execution.status === 'succeeded' ? 'ok' : 'failed'} · ${count(execution.durationMs)} ms</span
            >`)
          : raw(html`<span class="muted">not executed</span>`)}
      </td>
      <td class="mono nowrap">
        ${decision.policyId
          ? raw(html`<a href="/policies/${encodeURIComponent(String(decision.policyId))}"
              >${decision.policyId}<span class="muted"> · ${decision.ruleId}</span></a
            >`)
          : raw(html`<span class="muted">engine default</span>`)}
      </td>
      <td class="mono nowrap">
        <a href="/evidence/${record.id}" title="${record.id}">${shortId(record.id)}</a>
      </td>
    </tr>`;
  });

  const columns = [
    'When (UTC)',
    ...(options.hideAgent ? [] : ['Agent']),
    'Tool',
    'Decision',
    'Outcome',
    'Execution',
    'Policy · rule',
    'Evidence',
  ];

  return table(caption, columns, rows);
}

/**
 * `evidenceTimeline(record)` — REQUESTED → DECIDED → APPROVED → EXECUTED.
 *
 * A stage is drawn filled only when the record carries the fields for it.
 * Every other stage is hollow and labelled with why it is empty, so the
 * timeline never implies a step that did not happen: an action denied at
 * policy has no execution, and saying "not executed: denied" is the finding.
 */
export function evidenceTimeline(record: unknown): Trusted {
  const evidence = rec(record);
  const decision = rec(evidence.decision);
  const approval = evidence.approval ? rec(evidence.approval) : undefined;
  const execution = evidence.execution ? rec(evidence.execution) : undefined;
  const request = rec(evidence.request);
  const agent = rec(evidence.agent);
  const tool = rec(evidence.tool);
  const outcome = String(evidence.outcome ?? '');

  const notExecuted =
    outcome === 'denied'
      ? 'not executed: denied'
      : outcome === 'pending_approval'
        ? 'not executed: waiting on approval'
        : outcome === 'rejected'
          ? 'not executed: rejected'
          : outcome === 'expired'
            ? 'not executed: approval expired'
            : 'not executed';

  interface Stage {
    readonly title: string;
    readonly filled: boolean;
    readonly tone: 'allow' | 'deny' | 'approval' | 'plain';
    readonly time?: string;
    readonly body: Trusted;
  }

  const effect = String(decision.effect ?? '');
  const stages: Stage[] = [
    {
      title: 'Requested',
      filled: true,
      tone: 'plain',
      time: timeMs(request.requestedAt),
      body: raw(html`${agent.name} → <span class="mono">${tool.name}</span>
      ${request.correlationId
        ? raw(html`<div class="mono muted">correlation ${request.correlationId}</div>`)
        : NOTHING}`),
    },
    {
      title: 'Decided',
      filled: true,
      tone: effect === 'DENY' ? 'deny' : effect === 'ALLOW' ? 'allow' : 'approval',
      time: `+${count(decision.evaluationMs)} ms`,
      body: raw(html`${effectBadge(effect)}
      ${decision.policyId
        ? raw(html`<span class="mono">${decision.policyId} v${decision.policyVersion} · ${decision.ruleId}</span>`)
        : raw(html`<span class="muted">engine default</span>`)}
      <div class="muted">${decision.reason}</div>`),
    },
    approval
      ? {
          title: 'Approval',
          filled: approval.status !== 'pending',
          tone:
            approval.status === 'approved' ? 'allow' : approval.status === 'pending' ? 'approval' : 'deny',
          ...(approval.resolvedAt ? { time: timeMs(approval.resolvedAt) } : {}),
          body: raw(html`${approval.status} · ${count(list(approval.votes).length)} of
          ${count(approval.minApprovals)} required vote(s)
          ${list(approval.votes).map(
            (vote) => raw(html`<div class="muted">${vote.approver} voted ${vote.vote}</div>`),
          )}`),
        }
      : {
          title: 'Approval',
          filled: false,
          tone: 'plain',
          body: raw(html`<span class="muted">not required</span>`),
        },
    execution
      ? {
          title: 'Executed',
          filled: true,
          tone: execution.status === 'failed' ? 'deny' : 'allow',
          time: timeMs(execution.finishedAt),
          body: raw(html`<span class="tnum">${count(execution.durationMs)} ms</span> ·
          ${execution.status === 'succeeded' ? 'ok' : 'failed'} via <span class="mono">${execution.connector}</span>
          ${execution.error
            ? raw(html`<div class="failed-text">${rec(execution.error).code}: ${rec(execution.error).message}</div>`)
            : NOTHING}`),
        }
      : {
          title: 'Executed',
          filled: false,
          tone: 'plain',
          body: raw(html`<span class="muted">${notExecuted}</span>`),
        },
  ];

  return raw(html`<ol class="timeline" aria-label="Timeline">
    ${stages.map(
      (stage, index) => raw(html`<li>
        ${index < stages.length - 1 ? raw('<span class="spine" aria-hidden="true"></span>') : NOTHING}
        <span class="node ${stage.filled ? stage.tone : ''}" aria-hidden="true"></span>
        <div class="stage">
          <div class="stage-head">
            <span class="name ${stage.filled ? '' : 'hollow'}"
              >${stage.title}${stage.filled ? NOTHING : raw('<span class="sr-only"> (no data)</span>')}</span
            >
            ${stage.time ? raw(html`<span class="mono tnum muted">${stage.time}</span>`) : NOTHING}
          </div>
          <div>${stage.body}</div>
        </div>
      </li>`),
    )}
  </ol>`);
}

/** `traceTable(trace)` — every rule the engine examined, in order. */
export function traceTable(trace: unknown): Trusted {
  const rows = list(trace);
  if (rows.length === 0) {
    return raw(html`<p class="muted">
      No policy matched this action, so no rule was examined. The engine default decided.
    </p>`);
  }

  return table(
    'Decision trace: every rule the engine examined, in order',
    ['Policy', 'Rule', 'Result', 'Effect'],
    rows.map(
      (row) => html`<tr class="${row.matched ? '' : 'muted'}">
        <td class="mono">
          <a href="/policies/${encodeURIComponent(String(row.policyId))}">${row.policyId}</a>
          <span class="muted">v${row.policyVersion}</span>
        </td>
        <td class="mono">${row.ruleId}</td>
        <td>
          ${row.error
            ? raw(html`<span class="failed-text">error: ${row.error}</span>`)
            : row.matched
              ? raw(html`<strong>matched</strong>`)
              : 'not matched'}
        </td>
        <td>${row.effect ? effectBadge(row.effect) : raw('—')}</td>
      </tr>`,
    ),
    { compact: true },
  );
}

// --- audit ----------------------------------------------------------------

/**
 * The chain verdict.
 *
 * The caveat below is a trust commitment, documented in `docs/TRUST_MODEL.md`.
 * It is restyled here and never shortened: both branches keep their full text,
 * because the difference between "verified against an anchor" and "verified
 * against itself" is the difference between detecting truncation and not.
 */
export function chainVerdict(verification: unknown, options: { compact?: boolean } = {}): Trusted {
  const result = rec(verification);
  const valid = result.valid === true;
  const failures = list(result.failures);
  const checked = count(result.recordsChecked);

  const failureTable = valid
    ? NOTHING
    : table(
        'Chain verification failures',
        ['Sequence', 'Problem', 'Detail'],
        failures.map(
          (failure) => html`<tr>
            <td class="mono tnum">${failure.sequence}</td>
            <td class="mono"><strong class="deny-text">${failure.problem}</strong></td>
            <td>${failure.detail}</td>
          </tr>`,
        ),
        { compact: true },
      );

  return raw(html`<div class="card ${valid ? '' : 'broken'}">
    <p style="font-size:18px;font-weight:650;margin:0">
      Chain ${valid ? raw('<span class="allow-text">intact</span>') : raw('<span class="deny-text">BROKEN</span>')}
      <span class="muted" style="font-size:14px;font-weight:400;margin-left:8px">
        ${valid
          ? `${checked} record(s) verified`
          : `${count(failures.length)} problem(s) in ${checked} record(s)`}
      </span>
    </p>
    ${failureTable === NOTHING ? NOTHING : raw(html`<div style="margin-top:12px">${failureTable}</div>`)}
    ${result.headDigest
      ? raw(html`<div style="margin-top:12px">
          ${digestBlock(
            'head digest',
            result.headDigest,
            result.headSequence === undefined ? undefined : `sequence ${String(result.headSequence)}`,
          )}
        </div>`)
      : NOTHING}
    ${options.compact
      ? NOTHING
      : raw(html`<p class="note">
          ${result.checkedAgainstExpectation
            ? 'Checked against a recorded head, so truncation of the log would have been detected. '
            : 'Checked against itself only. This detects an edited record and a record missing from the middle, but not truncation: removing entries from the end leaves a shorter chain that still verifies. '}
          This is tamper evidence, not tamper proofing — an attacker who controls the storage can rewrite the whole chain
          and recompute every digest. Recording the head digest above somewhere ARC Control cannot reach is what closes
          both gaps.
        </p>`)}
  </div>`);
}

// --- connectors and scanning ----------------------------------------------

/** `connectorTable(connectors)` — the health detail reported, verbatim. */
export function connectorTable(connectors: unknown): Trusted {
  const rows = list(connectors);
  if (rows.length === 0) {
    return raw(html`<p class="empty">No connector is registered, so no tool can be executed.</p>`);
  }

  return table(
    'Connector health',
    ['Connector', 'Health', 'Detail (as reported)'],
    rows.map((connector) => {
      const healthy = connector.healthy !== false;
      return html`<tr class="${healthy ? '' : 'flagged'}">
        <td class="mono"><strong>${connector.name}</strong></td>
        <td>${statusDot(healthy, healthy ? 'healthy' : 'unhealthy')}</td>
        <td class="${healthy ? 'muted' : 'deny-text'}">
          ${connector.detail ?? 'No health check; reported healthy by default'}
        </td>
      </tr>`;
    }),
  );
}

/** `findingsTable(report)` — severity, finding, remediation, tool. */
export function findingsTable(report: unknown): Trusted {
  const scan = rec(report);
  const findings = list(scan.findings);

  if (findings.length === 0) {
    return raw(html`<p class="empty">
      No findings. ${count(scan.toolsScanned)} tool(s) scanned against every check the scanner implements.
    </p>`);
  }

  return table(
    'MCP scan findings',
    ['Severity', 'Finding', 'Tool'],
    findings.map(
      (finding) => html`<tr>
        <td>${severityBadge(finding.severity)}</td>
        <td>
          <div><span class="mono muted">${finding.id}</span> <strong>${finding.title}</strong></div>
          <span class="sub">${finding.detail}</span>
          ${finding.remediation
            ? raw(html`<p style="margin:4px 0 0;font-size:13px"><strong>Remediation:</strong> ${finding.remediation}</p>`)
            : NOTHING}
        </td>
        <td class="mono">${finding.tool ?? '—'}</td>
      </tr>`,
    ),
  );
}

// --- the access matrix ----------------------------------------------------

export interface CellScope {
  /** The agent lists this tool in `declaredTools`. Not a grant. */
  readonly declared: boolean;
  readonly enabled: readonly Rec[];
  readonly disabled: readonly Rec[];
  /** Effects the enabled in-scope policies' rules and fallbacks can produce. */
  readonly effects: readonly PolicyEffect[];
}

const EFFECT_ORDER: readonly PolicyEffect[] = ['ALLOW', 'REQUIRE_APPROVAL', 'DENY'];

/**
 * Builds the evaluation input a policy's selectors are matched against.
 *
 * Only the fields `matchSelectors` reads are meaningful here. The action
 * parameters are deliberately empty: this answers "which policies govern this
 * pair?", which is a question about selectors, and never evaluates a rule
 * condition. Giving it invented parameters would let it answer a question it
 * has no business answering.
 */
function scopeInput(agent: Rec, tool: Rec): PolicyInput {
  return {
    agent: {
      id: String(agent.id ?? ''),
      name: String(agent.name ?? ''),
      kind: String(agent.kind ?? ''),
      environment: String(agent.environment ?? ''),
      owner: String(agent.owner ?? ''),
      roles: strings(agent.roles),
      labels: rec(agent.labels) as Record<string, string>,
    },
    tool: {
      name: String(tool.name ?? ''),
      system: String(tool.system ?? ''),
      effect: String(tool.effect ?? ''),
      riskTier: String(tool.riskTier ?? ''),
      labels: rec(tool.labels) as Record<string, string>,
    },
    action: { id: '', parameters: {} },
    context: {
      environment: String(agent.environment ?? ''),
      requestedAt: new Date(0).toISOString(),
      hourUtc: 0,
      dayOfWeekUtc: 0,
    },
  };
}

/** Effects a policy's rules and fallback can produce, in ladder order. */
export function possibleEffects(policy: Rec): readonly PolicyEffect[] {
  const produced = new Set<string>([
    ...list(policy.rules).map((rule) => String(rule.effect ?? '')),
    String(rec(policy.fallback).effect ?? ''),
  ]);
  return EFFECT_ORDER.filter((effect) => produced.has(effect));
}

/**
 * Which policies govern one agent-and-tool pair.
 *
 * Uses the policy engine's own `matchSelectors`, imported read-only, so the
 * matrix cannot drift from what the engine actually matches. A second
 * implementation here would eventually disagree with the engine, and a
 * disagreeing access matrix is worse than none.
 */
export function cellScope(agent: unknown, tool: unknown, policies: readonly unknown[]): CellScope {
  const a = rec(agent);
  const t = rec(tool);
  const input = scopeInput(a, t);

  const inScope = policies
    .map((policy) => rec(policy))
    .filter((policy) => matchSelectors(rec(policy.match) as PolicyMatch, input));
  const enabled = inScope.filter((policy) => policy.enabled !== false);
  const produced = new Set<PolicyEffect>(enabled.flatMap((policy) => possibleEffects(policy)));

  return {
    declared: strings(a.declaredTools).includes(String(t.name ?? '')),
    enabled,
    disabled: inScope.filter((policy) => policy.enabled === false),
    effects: EFFECT_ORDER.filter((effect) => produced.has(effect)),
  };
}

/**
 * The access matrix: agents down, tools across.
 *
 * A cell says which enabled policies are *in scope* and which effects their
 * rules *can* produce. It never says a pair is allowed, because scope is not
 * permission: which rung of a policy fires depends on the parameters of a real
 * request, and the strictest effect across every matching policy wins. A cell
 * with no policy in scope says so rather than reading as permissive.
 */
export function accessMatrix(
  agents: readonly unknown[],
  tools: readonly unknown[],
  policies: readonly unknown[],
  selected: { agentId?: string; tool?: string } = {},
): Trusted {
  const toolHeads = tools.map((entry) => {
    const tool = rec(entry);
    return html`<th scope="col" class="tool">
      <div class="name">${tool.name}</div>
      <div class="meta">${tool.effect} ${riskBadge(tool.riskTier)}</div>
    </th>`;
  });

  const rows = agents.map((entry) => {
    const agent = rec(entry);
    const suspended = agent.status === 'suspended';

    const cells = tools.map((toolEntry) => {
      const tool = rec(toolEntry);
      const scope = cellScope(agent, tool, policies);
      const isSelected = selected.agentId === agent.id && selected.tool === tool.name;
      const href = `/access?agent=${encodeURIComponent(String(agent.id ?? ''))}&tool=${encodeURIComponent(
        String(tool.name ?? ''),
      )}`;

      return html`<td class="cell ${isSelected ? 'on' : ''}">
        <a href="${href}" ${raw(isSelected ? 'aria-current="true"' : '')}>
          <span class="sr-only">${agent.name}, ${tool.name}: </span>
          <div class="${scope.declared ? 'cell-declared' : 'cell-undeclared'}">
            ${scope.declared ? '◆ declared' : 'not declared'}
          </div>
          ${scope.enabled.length > 0
            ? raw(html`<div class="cell-policies">${scope.enabled.map((policy) => String(policy.id)).join(', ')}</div>
                <div class="cell-effects">${scope.effects.map((effect) => effectLetter(effect))}</div>`)
            : raw(html`<div class="cell-none">No policy in scope</div>`)}
          ${scope.disabled.length > 0
            ? raw(html`<div class="cell-none">+${count(scope.disabled.length)} disabled</div>`)
            : NOTHING}
        </a>
      </td>`;
    });

    return html`<tr class="${suspended ? 'suspended' : ''}">
      <th scope="row" class="agent">
        <a href="/agents/${agent.id}"><strong>${agent.name}</strong></a>
        <div class="chips" style="margin-top:2px">
          ${statusDot(!suspended, String(agent.status ?? ''))}
          <span class="mono muted">${strings(agent.roles).join(', ')}</span>
        </div>
        ${suspended
          ? raw(html`<p class="deny-text" style="margin:4px 0 0;font-size:12px">
              Refused at authentication, before policy
            </p>`)
          : NOTHING}
      </th>
      ${cells.map((cell) => raw(cell))}
    </tr>`;
  });

  return raw(html`<div
    class="matrix-wrap"
    role="region"
    aria-label="Access matrix: agents by tools, showing policies in scope"
    tabindex="0"
  >
    <table class="matrix">
      <caption class="sr-only">Access matrix: agents by tools, showing policies in scope</caption>
      <thead>
        <tr>
          <th scope="col" class="corner">Agent</th>
          ${toolHeads.map((head) => raw(head))}
        </tr>
      </thead>
      <tbody>
        ${rows.map((row) => raw(row))}
      </tbody>
    </table>
  </div>`);
}

export { jsonBlock, join, shortDigest };
