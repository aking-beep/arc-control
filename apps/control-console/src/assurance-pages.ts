/**
 * The 2.0 assurance sections of the console.
 *
 * Separate from `pages.ts` because that file already carries ten sections, and
 * a file nobody wants to open is how a console stops being maintained. The
 * scaffolding — the shell, the chrome read, the tolerant accessors — is shared
 * rather than duplicated.
 *
 * One rule runs through every page here, and it is why the module exists at
 * all: **no page invents a figure.** There is no coverage percentage, no
 * compliance score, and no status rendered for a control nobody assessed.
 * Where there is nothing to show, the page says what is missing and how to
 * produce it. A governance dashboard that fills its empty states with
 * plausible numbers is worse than no dashboard, because somebody will
 * screenshot it.
 */
import { count, shortId, timestamp } from './format.js';
import {
  backLink,
  badge,
  controlStatusBadge,
  countLine,
  definitions,
  effectBadge,
  emptyState,
  filterLinks,
  html,
  jsonBlock,
  NOTHING,
  pageHeader,
  raw,
  riskSeverityBadge,
  sectionTitle,
  severityBadge,
  table,
  type Trusted,
} from './render.js';
import { chrome, list, page, rec, strings, type PageContext } from './pages.js';

/** Statuses in the order an operator should read them: problems first. */
const STATUS_ORDER = ['fail', 'not_assessable', 'attested', 'pass', 'not_applicable'] as const;

function statusRank(status: unknown): number {
  const index = (STATUS_ORDER as readonly string[]).indexOf(String(status));
  return index === -1 ? STATUS_ORDER.length : index;
}

function row(...cells: readonly (Trusted | string)[]): Trusted {
  return raw(html`<tr>
    ${cells.map((cell) => raw(html`<td>${cell}</td>`))}
  </tr>`);
}

function muted(text: string): Trusted {
  return raw(html`<span class="muted">${text}</span>`);
}

function mono(text: unknown): Trusted {
  return raw(html`<span class="mono">${String(text ?? '')}</span>`);
}

function when(iso: unknown): Trusted {
  return raw(html`<span class="tnum">${timestamp(iso)}</span>`);
}

function links(ids: readonly string[], href: (id: string) => string, separator = ' '): Trusted {
  if (ids.length === 0) return muted('—');
  return raw(ids.map((id) => html`<a href="${href(id)}">${raw(mono(shortId(id)).value)}</a>`).join(separator));
}

/**
 * The data window, rendered on anything carrying an assessment figure.
 *
 * Mandatory rather than decorative: "6 controls passing" means nothing without
 * it, and a reader shown the number without the window will assume "always".
 */
function windowLine(windowValue: unknown): Trusted {
  const w = rec(windowValue);
  if (!w.from || !w.to) {
    return raw(html`<p class="note">No data window is recorded for these figures, so they cannot be interpreted.</p>`);
  }

  return raw(html`<p class="note">
    Covering <strong>${timestamp(w.from)}</strong> to <strong>${timestamp(w.to)}</strong> — ${count(w.actionsConsidered)}
    action(s) and ${count(w.evidenceConsidered)} evidence record(s) fell in that window. Every status below describes
    that period and nothing outside it.
  </p>`);
}

function limitationList(items: readonly string[]): Trusted {
  if (items.length === 0) return emptyState('No limitations are recorded.');
  return raw(html`<ul class="bullets">
    ${items.map((item) => raw(html`<li>${item}</li>`))}
  </ul>`);
}

// --- Assurance: the control library ---------------------------------------

/**
 * The control library with each control's latest result.
 *
 * A control that has never been assessed shows as exactly that, with no status
 * badge — not a grey "pending" that reads as benign.
 */
export async function assurancePage(context: PageContext): Promise<string> {
  const [shell, controls, runs, summary] = await Promise.all([
    chrome(context),
    context.client.listControls().catch(() => ({ controls: [] })),
    context.client.listAssessmentRuns(10).catch(() => ({ runs: [] })),
    context.client.assuranceSummary().catch(() => ({})),
  ]);

  const library = list(controls.controls);
  const history = list(runs.runs);
  const posture = rec(summary);
  const totals = rec(posture.totals);
  const neverAssessed = library.filter((control) => rec(control.latest).status === undefined);

  const controlRows = library
    .slice()
    .sort(
      (left, right) =>
        statusRank(rec(left.latest).status) - statusRank(rec(right.latest).status) ||
        String(left.id).localeCompare(String(right.id)),
    )
    .map((control) => {
      const latest = rec(control.latest);
      return row(
        raw(
          html`<a href="/assurance/${String(control.id)}">${raw(mono(control.id).value)}</a>
            ${control.enabled === false ? raw(badge('muted', 'disabled').value) : NOTHING}`,
        ),
        latest.status === undefined ? muted('never assessed') : controlStatusBadge(latest.status),
        control.assurance === 'automated' ? muted('automated') : badge('info', String(control.assurance ?? '')),
        latest.evaluatedAt ? when(latest.evaluatedAt) : muted('—'),
        raw(html`${String(latest.summary ?? control.title ?? '')}`),
      );
    });

  const runRows = history.map((run) => {
    const w = rec(run.window);
    const runTotals = rec(run.totals);
    return row(
      raw(html`<a href="/assurance/runs/${String(run.id)}">${raw(mono(shortId(run.id)).value)}</a>`),
      raw(html`${String(run.requestedBy ?? '')}`),
      when(run.finishedAt),
      raw(html`<span class="tnum muted">${timestamp(w.from)} → ${timestamp(w.to)}</span>`),
      raw(
        html`${STATUS_ORDER.filter((status) => Number(runTotals[status] ?? 0) > 0)
          .map((status) => `${count(runTotals[status])} ${status.replace('_', ' ')}`)
          .join(', ')}`,
      ),
    );
  });

  const body = html`${pageHeader({
    title: 'Assurance',
    lede:
      'The control library, and what the last assessment of each one actually established. A control ARC cannot decide for itself says so rather than passing.',
  })}

  ${
    library.length === 0
      ? emptyState(
          'No controls are installed. The baseline library installs on API start, so an empty library means the API has not completed a start against this store.',
        )
      : raw(html`${
          history.length === 0
            ? raw(html`<p class="note">
                <strong>No assessment has been run.</strong> Every control below is unassessed, which is not the same
                as passing. Run one with <span class="mono">arc assurance evaluate --data &lt;dir&gt;</span>, or
                <span class="mono">POST /v1/assurance/runs</span>.
              </p>`)
            : raw(html`${windowLine(posture.window)}
                ${countLine(
                  STATUS_ORDER.map((status) => ({ value: totals[status], label: status.replace('_', ' ') })),
                )}`)
        }

      ${sectionTitle('Controls')}
      ${table(
        'Control library',
        ['Control', 'Status', 'Assurance', 'Last assessed', 'What it establishes'],
        controlRows,
      )}

      ${
        neverAssessed.length > 0 && history.length > 0
          ? raw(html`<p class="note">
              ${count(neverAssessed.length)} control(s) have never been assessed. They are shown without a status
              rather than as passing.
            </p>`)
          : NOTHING
      }

      ${sectionTitle('Recent runs')}
      ${
        history.length === 0
          ? emptyState('No assessment runs are recorded.')
          : table('Assessment runs', ['Run', 'Requested by', 'Finished', 'Window', 'Result'], runRows)
      }`)
  }`;

  return page(context, '/assurance', 'Assurance', raw(body), shell);
}

/**
 * One control: what it checks, what it cannot tell you, and its history.
 *
 * The limitations sit above the history rather than below it. They are the part
 * a reader most needs and least wants, so they do not go at the bottom.
 */
export async function controlDetailPage(context: PageContext, controlId: string): Promise<string> {
  const [shell, detail] = await Promise.all([chrome(context), context.client.getControl(controlId)]);

  const payload = rec(detail);
  const control = rec(payload.control);
  const history = list(payload.history);
  const attestations = list(payload.attestations);
  const latest = history[0] ? rec(history[0]) : undefined;

  const attestationRows = attestations.map((attestation) =>
    row(
      raw(html`${String(attestation.attestedBy ?? '')}`),
      when(attestation.attestedAt),
      when(attestation.expiresAt),
      raw(html`${String(attestation.statement ?? '')}`),
      raw(html`<span class="mono muted">${String(attestation.reference ?? '—')}</span>`),
    ),
  );

  const historyRows = history.map((assessment) =>
    row(
      raw(html`<a href="/assurance/assessments/${String(assessment.id)}">${raw(mono(shortId(assessment.id)).value)}</a>`),
      controlStatusBadge(assessment.status),
      when(assessment.evaluatedAt),
      raw(html`${String(assessment.summary ?? '')}`),
    ),
  );

  const body = html`${backLink('/assurance', 'Assurance')}
  ${pageHeader({
    title: String(control.id ?? controlId),
    lede: String(control.title ?? ''),
    display: true,
    ...(latest ? { actions: controlStatusBadge(latest.status) } : {}),
  })}

  ${definitions([
    ['Objective', raw(html`${String(control.objective ?? '')}`)],
    ['Assurance', control.assurance === 'automated' ? muted('automated — ARC decides this from its own records') : badge('info', String(control.assurance ?? ''))],
    ['Frequency', raw(html`${String(control.frequency ?? '')}`)],
    ['Severity if it fails', severityBadge(control.failureSeverity)],
    ['Enabled', control.enabled === false ? badge('deny', 'No') : badge('allow', 'Yes')],
    ['Category', raw(html`${String(control.category ?? '')}`)],
  ])}

  ${sectionTitle('Procedure')}
  <p>${String(control.procedure ?? '')}</p>

  ${sectionTitle('What a pass does not tell you')}
  ${limitationList(strings(control.limitations))}

  ${
    latest
      ? raw(html`${sectionTitle('Latest result')}
          ${definitions([
            ['Status', controlStatusBadge(latest.status)],
            ['Summary', raw(html`${String(latest.summary ?? '')}`)],
            ['Evaluated', when(latest.evaluatedAt)],
            [
              'Assessment',
              raw(html`<a href="/assurance/assessments/${String(latest.id)}">${raw(mono(shortId(latest.id)).value)}</a>`),
            ],
          ])}
          ${windowLine(latest.window)}`)
      : emptyState('This control has never been assessed. That is not a pass.')
  }

  ${
    attestations.length > 0
      ? raw(html`${sectionTitle('Attestations')}
          <p class="note">
            A human statement, not a test ARC performed. Each one expires; when the newest expires the control reverts
            to not assessable rather than carrying the old answer forward.
          </p>
          ${table('Attestations', ['Attested by', 'On', 'Valid until', 'Statement', 'Reference'], attestationRows)}`)
      : NOTHING
  }

  ${sectionTitle('History')}
  ${
    history.length === 0
      ? emptyState('No assessments of this control are recorded.')
      : table('Assessment history', ['Assessment', 'Status', 'Evaluated', 'Summary'], historyRows)
  }`;

  return page(context, '/assurance', String(control.id ?? controlId), raw(body), shell);
}

/** One assessment, with every observation and a link to each record it rests on. */
export async function assessmentDetailPage(context: PageContext, assessmentId: string): Promise<string> {
  const [shell, assessment] = await Promise.all([chrome(context), context.client.getAssessment(assessmentId)]);
  const record = rec(assessment);
  const observations = list(record.observations);
  const failing = observations.filter((observation) => observation.ok !== true);
  const attestation = rec(record.attestation);

  const observationRows = observations
    .slice()
    .sort((left, right) => Number(left.ok === true) - Number(right.ok === true))
    .map((observation) =>
      row(
        observation.ok === true ? badge('allow', 'ok') : badge('deny', 'fail'),
        mono(observation.subject),
        muted(String(observation.subjectKind ?? '')),
        raw(html`${String(observation.detail ?? '')}`),
        // The evidence explorer link: from an assessment straight to the
        // primary record, so a reader never has to take a summary's word.
        links(strings(observation.evidenceIds), (id) => `/evidence/${id}`),
      ),
    );

  const body = html`${backLink('/assurance', 'Assurance')}
  ${pageHeader({
    title: `${String(record.controlId ?? '')} assessment`,
    lede: String(record.summary ?? ''),
    actions: controlStatusBadge(record.status),
  })}

  ${windowLine(record.window)}

  ${definitions([
    [
      'Control',
      raw(
        html`<a href="/assurance/${String(record.controlId)}">${raw(mono(record.controlId).value)}</a> (version
          ${String(record.controlVersion ?? '')})`,
      ),
    ],
    ['Assurance', record.assurance === 'automated' ? muted('automated') : badge('info', String(record.assurance ?? ''))],
    ['Evaluated', when(record.evaluatedAt)],
    ['Run', raw(html`<a href="/assurance/runs/${String(record.runId)}">${raw(mono(shortId(record.runId)).value)}</a>`)],
    ['Integrity digest', raw(html`<span class="mono muted">${String(record.integrityDigest ?? '')}</span>`)],
  ])}

  ${
    strings(record.limitations).length > 0
      ? raw(html`${sectionTitle('What this result does not establish')}
          ${limitationList(strings(record.limitations))}`)
      : NOTHING
  }

  ${
    attestation.attestedBy
      ? raw(html`${sectionTitle('The attestation this rests on')}
          ${definitions([
            ['Attested by', raw(html`${String(attestation.attestedBy)}`)],
            ['Statement', raw(html`${String(attestation.statement ?? '')}`)],
            ['Valid until', when(attestation.expiresAt)],
          ])}`)
      : NOTHING
  }

  ${sectionTitle('Observations', raw(html`${count(observations.length)} examined, ${count(failing.length)} failing`))}
  ${
    observations.length === 0
      ? emptyState('This assessment examined nothing. Its summary says why.')
      : table(
          'Observations',
          [{ label: 'Result', hidden: true }, 'Subject', 'Kind', 'What was observed', 'Evidence'],
          observationRows,
        )
  }

  ${
    strings(record.findingIds).length > 0
      ? raw(html`${sectionTitle('Findings raised')}
          <p>${links(strings(record.findingIds), (id) => `/findings/${id}`, ' · ')}</p>`)
      : NOTHING
  }

  ${jsonBlock(record)}`;

  return page(context, '/assurance', 'Assessment', raw(body), shell);
}

/** One run, with every control it evaluated. */
export async function assessmentRunPage(context: PageContext, runId: string): Promise<string> {
  const [shell, payload] = await Promise.all([chrome(context), context.client.getAssessmentRun(runId)]);
  const result = rec(payload);
  const run = rec(result.run);
  const assessments = list(result.assessments);
  const totals = rec(run.totals);
  const head = rec(run.auditHead);

  const rows = assessments
    .slice()
    .sort((left, right) => statusRank(left.status) - statusRank(right.status))
    .map((assessment) =>
      row(
        raw(html`<a href="/assurance/${String(assessment.controlId)}">${raw(mono(assessment.controlId).value)}</a>`),
        controlStatusBadge(assessment.status),
        raw(html`${String(assessment.summary ?? '')}`),
        raw(html`<a href="/assurance/assessments/${String(assessment.id)}">observations</a>`),
      ),
    );

  const body = html`${backLink('/assurance', 'Assurance')}
  ${pageHeader({
    title: 'Assessment run',
    lede: `Requested by ${String(run.requestedBy ?? 'unknown')}, finished ${timestamp(run.finishedAt)}.`,
  })}

  ${windowLine(run.window)}
  ${countLine(STATUS_ORDER.map((status) => ({ value: totals[status], label: status.replace('_', ' ') })))}

  ${
    head.digest
      ? definitions([
          [
            'Audit head at run time',
            raw(
              html`<span class="mono muted">${String(head.digest)}</span> at sequence
                <span class="tnum">${count(head.sequence)}</span>`,
            ),
          ],
        ])
      : NOTHING
  }

  ${sectionTitle('Controls evaluated')}
  ${table('Controls evaluated in this run', ['Control', 'Status', 'Summary', ''], rows)}`;

  return page(context, '/assurance', 'Assessment run', raw(body), shell);
}

// --- Risks -----------------------------------------------------------------

/**
 * The risk register.
 *
 * Inherent and residual sit side by side, and a risk with no reviewed residual
 * shows an explicit "not reviewed" rather than repeating the inherent figure.
 * Repeating it would read as "controls reduced this to the same number";
 * leaving it blank reads as "nobody has looked", which is the truth.
 */
export async function risksPage(context: PageContext): Promise<string> {
  const [shell, risks] = await Promise.all([chrome(context), context.client.listRisks().catch(() => ({ risks: [] }))]);
  const register = list(risks.risks);

  const rows = register.map((risk) => {
    const inherent = rec(risk.inherent);
    const residual = rec(risk.residual);
    return row(
      raw(html`<a href="/risks/${String(risk.id)}">${raw(mono(risk.reference).value)}</a>`),
      raw(html`${String(risk.title ?? '')}`),
      raw(html`${riskSeverityBadge(inherent.severity)} <span class="tnum muted">${count(inherent.score)}</span>`),
      residual.reviewedBy === undefined
        ? muted('not reviewed')
        : raw(html`${riskSeverityBadge(residual.severity)} <span class="tnum muted">${count(residual.score)}</span>`),
      muted(String(risk.treatment ?? '')),
      raw(html`${String(risk.owner ?? '')}`),
      strings(risk.controlIds).length === 0
        ? muted('none linked')
        : raw(
            strings(risk.controlIds)
              .map((id) => html`<a href="/assurance/${id}">${raw(mono(id).value)}</a>`)
              .join(' '),
          ),
    );
  });

  const body = html`${pageHeader({
    title: 'Risk register',
    lede:
      'Inherent risk is the position before ARC’s controls are credited. Residual is what a named reviewer concluded remains — ARC never computes it, because crediting a control automatically would mean grading our own homework.',
  })}

  ${
    register.length === 0
      ? emptyState(
          'No risks are recorded. ARC ships no starter register on purpose: the risks that matter are the ones this organization actually faces, and a generic list invites somebody to adopt it unread.',
        )
      : raw(html`${countLine([
          { value: register.length, label: 'recorded' },
          {
            value: register.filter((risk) => rec(risk.residual).reviewedBy !== undefined).length,
            label: 'residual reviewed',
          },
          { value: register.filter((risk) => risk.status === 'accepted').length, label: 'accepted' },
        ])}
        ${table(
          'Risk register',
          ['Reference', 'Risk', 'Inherent', 'Residual', 'Treatment', 'Owner', 'Controls'],
          rows,
        )}`)
  }`;

  return page(context, '/risks', 'Risks', raw(body), shell);
}

/** One risk, its ratings and the controls credited against it. */
export async function riskDetailPage(context: PageContext, riskId: string): Promise<string> {
  const [shell, risk] = await Promise.all([chrome(context), context.client.getRisk(riskId)]);
  const record = rec(risk);
  const inherent = rec(record.inherent);
  const residual = rec(record.residual);
  const acceptance = rec(record.acceptance);

  const body = html`${backLink('/risks', 'Risk register')}
  ${pageHeader({
    title: String(record.reference ?? riskId),
    lede: String(record.title ?? ''),
    display: true,
    actions: riskSeverityBadge(inherent.severity),
  })}

  <p>${String(record.description ?? '')}</p>

  ${definitions([
    ['Status', badge('muted', String(record.status ?? ''))],
    ['Category', raw(html`${String(record.category ?? '')}`)],
    ['Owner', raw(html`${String(record.owner ?? '')}`)],
    ['Treatment', raw(html`${String(record.treatment ?? '')}`)],
    [
      'Inherent',
      raw(
        html`${riskSeverityBadge(inherent.severity)} impact ${count(inherent.impact)} × likelihood
          ${count(inherent.likelihood)} = <span class="tnum">${count(inherent.score)}</span>`,
      ),
    ],
    [
      'Residual',
      residual.reviewedBy === undefined
        ? muted(
            'Not reviewed. ARC does not compute this: it needs a named reviewer and their rationale, or it does not exist.',
          )
        : raw(
            html`${riskSeverityBadge(residual.severity)} impact ${count(residual.impact)} × likelihood
              ${count(residual.likelihood)} = <span class="tnum">${count(residual.score)}</span><br />
              reviewed by <strong>${String(residual.reviewedBy)}</strong> on ${raw(when(residual.reviewedAt).value)}`,
          ),
    ],
    ...(residual.rationale
      ? ([['Reviewer’s rationale', raw(html`${String(residual.rationale)}`)]] as const)
      : []),
    ['Review due', record.reviewDueAt ? when(record.reviewDueAt) : muted('not set')],
  ])}

  ${
    acceptance.acceptedBy
      ? raw(html`${sectionTitle('Acceptance')}
          ${definitions([
            ['Accepted by', raw(html`${String(acceptance.acceptedBy)}`)],
            ['On', when(acceptance.acceptedAt)],
            ['Expires', when(acceptance.expiresAt)],
            ['Rationale', raw(html`${String(acceptance.rationale ?? '')}`)],
          ])}
          <p class="note">Every acceptance expires. An acceptance with no end date is a decision nobody revisits.</p>`)
      : NOTHING
  }

  ${sectionTitle('Controls addressing this risk')}
  ${
    strings(record.controlIds).length === 0
      ? emptyState('No controls are linked. The register records the risk; nothing yet claims to address it.')
      : raw(
          html`<p>
            ${raw(
              strings(record.controlIds)
                .map((id) => html`<a href="/assurance/${id}">${raw(mono(id).value)}</a>`)
                .join(' · '),
            )}
          </p>`,
        )
  }

  ${
    strings(record.scope).length > 0
      ? raw(html`${sectionTitle('Scope')}
          <p>${strings(record.scope).join(', ')}</p>`)
      : NOTHING
  }`;

  return page(context, '/risks', String(record.reference ?? 'Risk'), raw(body), shell);
}

// --- Findings --------------------------------------------------------------

/** The remediation queue, ranked by severity then recency. */
export async function findingsPage(context: PageContext): Promise<string> {
  const status = context.query.get('status') ?? 'open';
  const [shell, findings] = await Promise.all([
    chrome(context),
    context.client.listFindings(status === 'all' ? {} : { status }).catch(() => ({ findings: [] })),
  ]);

  const queue = list(findings.findings);

  const rows = queue.map((finding) =>
    row(
      severityBadge(finding.severity),
      raw(html`<a href="/assurance/${String(finding.controlId)}">${raw(mono(finding.controlId).value)}</a>`),
      raw(html`<a href="/findings/${String(finding.id)}">${raw(mono(shortId(finding.subject, 22)).value)}</a>`),
      raw(html`${String(finding.detail ?? '')}`),
      raw(html`<span class="tnum">${count(finding.occurrences)}×</span> ${raw(when(finding.lastSeenAt).value)}`),
      finding.owner ? raw(html`${String(finding.owner)}`) : muted('unassigned'),
      badge(
        finding.status === 'open' ? 'deny' : finding.status === 'in_progress' ? 'approval' : 'muted',
        String(finding.status ?? ''),
      ),
    ),
  );

  const body = html`${pageHeader({
    title: 'Findings',
    lede:
      'Raised by control assessments and reconciled across runs: a repeat increments its occurrence count rather than creating a duplicate, and a subject that stops failing is resolved with the assessment that cleared it named.',
  })}

  ${filterLinks(
    'Status',
    [
      { value: 'open', label: 'Open' },
      { value: 'in_progress', label: 'In progress' },
      { value: 'resolved', label: 'Resolved' },
      { value: 'accepted', label: 'Accepted' },
      { value: 'false_positive', label: 'False positive' },
      { value: 'all', label: 'All' },
    ],
    status,
    (value) => `/findings?status=${encodeURIComponent(value)}`,
  )}

  ${
    queue.length === 0
      ? emptyState(
          status === 'open'
            ? 'No open findings. That means the last assessment raised none — check Assurance for when it ran and what it could not assess.'
            : `No findings with status "${status}".`,
        )
      : table(
          'Findings',
          ['Severity', 'Control', 'Subject', 'What was observed', 'Seen', 'Owner', 'Status'],
          rows,
        )
  }`;

  return page(context, '/findings', 'Findings', raw(body), shell);
}

/** One finding, with everything needed to act on it. */
export async function findingDetailPage(context: PageContext, findingId: string): Promise<string> {
  const [shell, finding] = await Promise.all([chrome(context), context.client.getFinding(findingId)]);
  const record = rec(finding);
  const resolution = rec(record.resolution);

  const body = html`${backLink('/findings', 'Findings')}
  ${pageHeader({
    title: String(record.title ?? findingId),
    lede: String(record.detail ?? ''),
    actions: severityBadge(record.severity),
  })}

  ${definitions([
    ['Status', badge(record.status === 'open' ? 'deny' : 'muted', String(record.status ?? ''))],
    [
      'Control',
      raw(html`<a href="/assurance/${String(record.controlId)}">${raw(mono(record.controlId).value)}</a>`),
    ],
    [
      'Raised by',
      raw(
        html`<a href="/assurance/assessments/${String(record.assessmentId)}"
          >${raw(mono(shortId(record.assessmentId)).value)}</a
        >`,
      ),
    ],
    ['Subject', raw(html`${raw(mono(record.subject).value)} ${raw(muted(`(${String(record.subjectKind ?? '')})`).value)}`)],
    ['Owner', record.owner ? raw(html`${String(record.owner)}`) : muted('unassigned')],
    ['Due', record.dueAt ? when(record.dueAt) : muted('no deadline set')],
    ['First seen', when(record.firstSeenAt)],
    ['Last seen', when(record.lastSeenAt)],
    ['Occurrences', raw(html`<span class="tnum">${count(record.occurrences)}</span>`)],
  ])}

  ${
    strings(record.evidenceIds).length > 0
      ? raw(html`${sectionTitle('Evidence')}
          <p>${links(strings(record.evidenceIds), (id) => `/evidence/${id}`, ' · ')}</p>`)
      : NOTHING
  }

  ${
    resolution.by
      ? raw(html`${sectionTitle('Resolution')}
          ${definitions([
            ['By', raw(html`${String(resolution.by)}`)],
            ['On', when(resolution.at)],
            ['Note', raw(html`${String(resolution.note ?? '')}`)],
          ])}`)
      : NOTHING
  }`;

  return page(context, '/findings', 'Finding', raw(body), shell);
}

// --- Activity --------------------------------------------------------------

/**
 * The action timeline.
 *
 * Distinct from Evidence, which is the record-and-export view. This answers
 * "what have the agents been doing?" in the order it happened, with the
 * decision that governed each one.
 */
export async function activityPage(context: PageContext): Promise<string> {
  const outcome = context.query.get('outcome') ?? '';
  const agentId = context.query.get('agentId') ?? '';

  const [shell, evidence, agents] = await Promise.all([
    chrome(context),
    context.client
      .listEvidence({ limit: 100, ...(outcome ? { outcome } : {}), ...(agentId ? { agentId } : {}) })
      .catch(() => ({ evidence: [] })),
    context.client.listAgents().catch(() => ({ agents: [] })),
  ]);

  const timeline = list(evidence.evidence);
  const roster = list(agents.agents);

  const hrefFor = (nextOutcome: string, nextAgent: string): string => {
    const params = new URLSearchParams();
    if (nextOutcome) params.set('outcome', nextOutcome);
    if (nextAgent) params.set('agentId', nextAgent);
    const text = params.toString();
    return text ? `/activity?${text}` : '/activity';
  };

  const rows = timeline.map((record) => {
    const decision = rec(record.decision);
    const tool = rec(record.tool);
    const agent = rec(record.agent);
    const risk = rec(record.risk);
    return row(
      when(record.createdAt),
      raw(html`<a href="/agents/${String(agent.id)}">${String(agent.name ?? '')}</a>`),
      mono(tool.name),
      raw(
        html`${effectBadge(decision.effect)}
          ${decision.policyId
            ? raw(
                html`<a href="/policies/${String(decision.policyId)}"
                  ><span class="mono muted">${String(decision.policyId)}</span></a
                >`,
              )
            : NOTHING}`,
      ),
      risk.class === undefined
        ? muted('—')
        : badge(risk.class === 'severe' ? 'deny' : risk.class === 'sensitive' ? 'approval' : 'muted', String(risk.class)),
      muted(String(record.outcome ?? '')),
      raw(html`<a href="/evidence/${String(record.id)}">evidence</a>`),
    );
  });

  const body = html`${pageHeader({
    title: 'Activity',
    lede:
      'Every action that reached the gateway, newest first, with the decision that governed it. An action that never reached ARC is not here and cannot be — closing that gap is what ARC-AI-009 is about.',
  })}

  ${filterLinks(
    'Outcome',
    [
      { value: '', label: 'All' },
      { value: 'executed', label: 'Executed' },
      { value: 'denied', label: 'Denied' },
      { value: 'pending_approval', label: 'Awaiting approval' },
      { value: 'failed', label: 'Failed' },
    ],
    outcome,
    (value) => hrefFor(value, agentId),
  )}

  ${
    roster.length > 1
      ? filterLinks(
          'Agent',
          [{ value: '', label: 'All' }, ...roster.map((agent) => ({ value: String(agent.id), label: String(agent.name) }))],
          agentId,
          (value) => hrefFor(outcome, value),
        )
      : NOTHING
  }

  ${
    timeline.length === 0
      ? emptyState(
          outcome || agentId
            ? 'No activity matches that filter.'
            : 'No actions have reached the gateway yet. Nothing on this page is synthesised, so an empty timeline means exactly that.',
        )
      : raw(html`<p class="note">
            Showing the ${count(timeline.length)} most recent action(s). This is a live read rather than a report, so
            it has no fixed window — the figures on Assurance do.
          </p>
          ${table('Activity', ['When', 'Agent', 'Tool', 'Decision', 'Risk', 'Outcome', ''], rows)}`)
  }`;

  return page(context, '/activity', 'Activity', raw(body), shell);
}

// --- Settings --------------------------------------------------------------

/**
 * Configuration, read from the API rather than guessed.
 *
 * The section exists largely to be honest about two things an operator must
 * not discover later: that the identity in the masthead is a configured header
 * rather than an authenticated user, and that enforcement does not depend on
 * the assurance layer. Both are stated plainly, with no softening.
 */
export async function settingsPage(context: PageContext): Promise<string> {
  const [shell, health, frameworks] = await Promise.all([
    chrome(context),
    context.client.health().catch(() => ({})),
    context.client.listFrameworks().catch(() => ({ frameworks: [] })),
  ]);

  const report = rec(health);
  const enforcement = rec(report.enforcement);
  const assurance = rec(report.assurance);
  const connectors = list(enforcement.connectors ?? report.connectors);
  const mappings = list(frameworks.frameworks);
  const lastRun = rec(assurance.lastRun);

  const connectorRows = connectors.map((connector) =>
    row(
      mono(connector.name),
      connector.healthy === true ? badge('allow', 'healthy') : badge('deny', 'unhealthy'),
      muted(String(connector.detail ?? '')),
    ),
  );

  const frameworkRows = mappings.map((framework) =>
    row(
      raw(html`${String(framework.name ?? '')}`),
      muted(String(framework.edition ?? '')),
      raw(html`<span class="tnum">${count(framework.mappings)}</span>`),
      Number(framework.reviewed ?? 0) === 0 ? muted('none') : raw(html`<span class="tnum">${count(framework.reviewed)}</span>`),
      raw(html`<a href="/frameworks/${String(framework.id)}">open</a>`),
    ),
  );

  const body = html`${pageHeader({
    title: 'Settings',
    lede: 'What this deployment is configured to do, read from the control API rather than assumed.',
  })}

  ${sectionTitle('Identity and access')}
  <p class="note">
    <strong>Operator identity is not authenticated in this release.</strong> You are acting as
    <strong>${context.operatorIdentity}</strong> because a request header says so, behind a single shared operator
    token. Anyone holding that token can claim any identity, so an approval recorded here establishes that the
    workflow ran — not who ran it. Single sign-on and role-based access control are the next release; until then put
    this console behind an identity-aware proxy and treat the token as a production secret.
  </p>
  ${definitions([
    ['Acting as', raw(html`<strong>${context.operatorIdentity}</strong> ${raw(muted('(configured header)').value)}`)],
    [
      'Roles claimed',
      context.operatorRoles.length === 0 ? muted('none') : raw(html`${context.operatorRoles.join(', ')}`),
    ],
    [
      'Operator token',
      report.operatorAuthConfigured === true
        ? badge('allow', 'configured')
        : badge('deny', 'not configured — operator endpoints refuse every request'),
    ],
    ['API', mono(context.apiBase)],
    ['Version', raw(html`<span class="tnum">${String(report.version ?? 'unknown')}</span>`)],
  ])}

  ${sectionTitle('Enforcement')}
  ${definitions([
    ['Status', badge(enforcement.status === 'ok' ? 'allow' : 'deny', String(enforcement.status ?? 'unknown'))],
    ['Failure mode', badge('allow', String(enforcement.failureMode ?? 'closed'))],
    ['Effect when no policy matches', effectBadge(enforcement.policyFallbackEffect ?? 'DENY')],
    [
      'Rate limiting',
      badge(enforcement.rateLimiting === 'configured' ? 'allow' : 'muted', String(enforcement.rateLimiting ?? 'off')),
    ],
    [
      'Disabled tools',
      strings(enforcement.disabledTools).length === 0
        ? muted('none')
        : raw(
            strings(enforcement.disabledTools)
              .map((name) => mono(name).value)
              .join(', '),
          ),
    ],
  ])}
  <p class="note">
    Enforcement does not depend on the assurance layer. An assurance outage can stop ARC reporting on itself; it
    cannot stop ARC deciding, and it cannot open the gateway.
  </p>

  ${sectionTitle('Assurance')}
  ${definitions([
    ['Status', badge(assurance.status === 'ok' ? 'allow' : 'deny', String(assurance.status ?? 'unknown'))],
    ['Controls installed', raw(html`<span class="tnum">${count(assurance.controls)}</span>`)],
    ['Controls enabled', raw(html`<span class="tnum">${count(assurance.controlsEnabled)}</span>`)],
    [
      'Resting on a human statement, or unprovable',
      raw(
        html`<span class="tnum">${count(assurance.attestedOrUnassessable)}</span>
          ${raw(muted(`of ${count(assurance.controls)} — read their summaries rather than counting statuses`).value)}`,
      ),
    ],
    [
      'Last run',
      lastRun.id
        ? raw(
            html`<a href="/assurance/runs/${String(lastRun.id)}">${raw(mono(shortId(lastRun.id)).value)}</a>
              ${raw(when(lastRun.finishedAt).value)}`,
          )
        : muted('never'),
    ],
  ])}

  ${sectionTitle('Connectors')}
  ${
    connectors.length === 0
      ? emptyState('No connectors are registered.')
      : table('Connectors', ['Connector', 'Health', 'Detail'], connectorRows)
  }

  ${sectionTitle('Framework mappings')}
  ${
    mappings.length === 0
      ? emptyState('No framework mappings are shipped in this release.')
      : raw(html`${table('Framework mappings', ['Framework', 'Edition', 'References', 'Reviewed', ''], frameworkRows)}
          <p class="note">
            Mappings ship as proposed, not reviewed. ARC’s engineers can draft one; only someone accountable for
            this organization’s compliance programme can accept it, and coverage counts only reviewed mappings —
            so the figure starts at zero and rises as real review happens.
          </p>`)
  }`;

  return page(context, '/settings', 'Settings', raw(body), shell);
}

/** One framework's references against the latest control results. */
export async function frameworkPage(context: PageContext, frameworkId: string): Promise<string> {
  const [shell, payload] = await Promise.all([chrome(context), context.client.getFramework(frameworkId)]);
  const result = rec(payload);
  const framework = rec(result.framework);
  const rows = list(result.rows);

  const tableRows = rows.map((item) => {
    const mapping = rec(item.mapping);
    const controls = list(item.controls);
    return row(
      raw(html`${raw(mono(mapping.reference).value)}<br />${raw(muted(String(mapping.title ?? '')).value)}`),
      mapping.review === 'reviewed' ? badge('allow', 'reviewed') : badge('info', 'proposed'),
      controls.length === 0
        ? muted('none mapped')
        : raw(
            controls
              .map((control) =>
                // A mapped control that is not installed in this deployment is
                // shown as plain text rather than a link. The mappings are
                // shipped data and the library is customer-owned, so a mapping
                // can legitimately name a control nobody installed — and a
                // link to a page that cannot exist is a dead link, which the
                // showcase crawler is right to refuse to publish.
                control.status === undefined && control.evaluatedAt === undefined
                  ? html`${raw(mono(control.controlId).value)} ${raw(muted('(not installed)').value)}`
                  : html`<a href="/assurance/${String(control.controlId)}">${raw(mono(control.controlId).value)}</a>${
                      control.status ? html` ${raw(controlStatusBadge(control.status).value)}` : ''
                    }`,
              )
              .join('<br>'),
          ),
      item.evidenced === true ? badge('allow', 'yes') : badge('muted', 'no'),
      raw(
        html`${String(mapping.note ?? '')}${
          item.gap ? raw(html`<br />${raw(muted(`Gap: ${String(item.gap)}`).value)}`) : NOTHING
        }`,
      ),
    );
  });

  const body = html`${backLink('/settings', 'Settings')}
  ${pageHeader({ title: String(framework.name ?? frameworkId), lede: String(framework.edition ?? '') })}

  <p class="note"><strong>This is not an assessment.</strong> ${String(framework.disclaimer ?? '')}</p>

  ${countLine([
    { value: rows.length, label: 'references mapped' },
    { value: rows.filter((item) => rec(item.mapping).review === 'reviewed').length, label: 'reviewed' },
    { value: rows.filter((item) => item.evidenced === true).length, label: 'evidenced' },
  ])}

  ${
    rows.length === 0
      ? emptyState('No mappings are recorded for this framework.')
      : table(
          'Framework references',
          ['Reference', 'Review', 'Controls', 'Evidenced', 'What ARC does and does not evidence'],
          tableRows,
        )
  }`;

  return page(context, '/settings', String(framework.name ?? 'Framework'), raw(body), shell);
}
