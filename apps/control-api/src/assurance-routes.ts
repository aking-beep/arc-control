/**
 * The ARC Assurance API.
 *
 * Every route here is operator-only, and that is a security boundary rather
 * than a convenience. An agent that could read its own control results would
 * learn which of its actions go unexamined; an agent that could write them
 * would be marking its own homework. So nothing in this file calls
 * `gateway.agents.authenticate` — the only credential it accepts is the
 * operator token, and there is a test that presents a valid agent API key to
 * every single route and asserts a 401.
 *
 * The second rule: assurance reads enforcement and never writes it. There is
 * no route here that can change an agent's status, a policy, or a decision.
 * That is what makes an assurance outage harmless to authorization — there is
 * no path from this module into the gateway's decision, so the worst a broken
 * assurance layer can do is fail to report.
 */
import { ArcError, type RiskBand, type RiskTreatment } from '@arc-control/schemas';
import type { Gateway } from '@arc-control/gateway';
import { simulateAgainstHistory, simulateHypothetical } from '@arc-control/gateway';
import { AssuranceEngine, buildCoverageReport, FRAMEWORKS, frameworkCoverage } from '@arc-control/assurance';
import { buildBundle } from '@arc-control/evidence';
import { withStatus, type Router } from './http.js';
import type { OperatorAuth } from './operator.js';

export interface AssuranceRouteOptions {
  readonly gateway: Gateway;
  readonly assurance: AssuranceEngine;
  readonly operators: OperatorAuth;
  readonly version: string;
}

export function addAssuranceRoutes(router: Router, options: AssuranceRouteOptions): Router {
  const { gateway, assurance, operators } = options;

  // --- posture ------------------------------------------------------------

  router.get('/v1/assurance/summary', async (context) => {
    operators.authenticate(context);
    return assurance.summary();
  });

  router.get('/v1/assurance/coverage', async (context) => {
    operators.authenticate(context);
    return buildCoverageReport({
      store: gateway.store,
      ...windowFrom(context.query),
    });
  });

  // --- the control library ------------------------------------------------

  router.get('/v1/assurance/controls', async (context) => {
    operators.authenticate(context);
    const [controls, latest] = await Promise.all([assurance.listControls(), assurance.latestAssessments()]);
    const byControl = new Map(latest.map((assessment) => [assessment.controlId, assessment]));

    return {
      controls: controls.map((control) => ({
        ...control,
        latest: byControl.get(control.id),
      })),
    };
  });

  router.get('/v1/assurance/controls/:id', async (context) => {
    operators.authenticate(context);
    const control = await assurance.getControl(context.params.id!);
    if (!control) throw new ArcError('not_found', `no control with id ${context.params.id}`);

    return {
      control,
      history: await assurance.assessmentHistory(control.id, positiveInt(context.query.get('limit'), 25)),
      attestations: await assurance.attestationHistory(control.id),
    };
  });

  router.post('/v1/assurance/controls/:id/enable', async (context) => {
    const operator = operators.authenticate(context);
    return assurance.setControlEnabled(context.params.id!, true, operator.identifier);
  });

  router.post('/v1/assurance/controls/:id/disable', async (context) => {
    const operator = operators.authenticate(context);
    return assurance.setControlEnabled(context.params.id!, false, operator.identifier);
  });

  /**
   * Records a human attestation for a control ARC cannot decide itself.
   *
   * `statement` is required and free text. A checkbox would be worse than
   * nothing here: the value of an attestation is what the person actually
   * claims to have checked, and that is the sentence an auditor reads.
   */
  router.post('/v1/assurance/controls/:id/attest', async (context) => {
    const operator = operators.authenticate(context);
    const body = await context.body<{ statement?: string; validForDays?: number; reference?: string }>();
    requireFields(body, ['statement']);

    return withStatus(
      201,
      await assurance.recordAttestation({
        controlId: context.params.id!,
        attestedBy: operator.identifier,
        statement: String(body.statement),
        ...(typeof body.validForDays === 'number' ? { validForDays: body.validForDays } : {}),
        ...(body.reference ? { reference: String(body.reference) } : {}),
      }),
    );
  });

  // --- assessment runs ----------------------------------------------------

  router.post('/v1/assurance/runs', async (context) => {
    const operator = operators.authenticate(context);
    const body = await context
      .body<{ from?: string; to?: string; controlIds?: readonly string[] }>()
      .catch(() => ({}) as { from?: string; to?: string; controlIds?: readonly string[] });

    const result = await assurance.run({
      requestedBy: operator.identifier,
      // Validated, not coerced. `new Date('nonsense')` is an Invalid Date:
      // the window filter then matches nothing and the run persists as a
      // completed assessment over a window that cannot exist — a green
      // report built on no data at all.
      ...(body.from ? { from: parseDate(String(body.from), 'from') } : {}),
      ...(body.to ? { to: parseDate(String(body.to), 'to') } : {}),
      ...(Array.isArray(body.controlIds) ? { controlIds: body.controlIds.map(String) } : {}),
    });

    return withStatus(201, result);
  });

  router.get('/v1/assurance/runs', async (context) => {
    operators.authenticate(context);
    return { runs: await assurance.listRuns(positiveInt(context.query.get('limit'), 50)) };
  });

  router.get('/v1/assurance/runs/:id', async (context) => {
    operators.authenticate(context);
    const run = await assurance.getRun(context.params.id!);
    if (!run) throw new ArcError('not_found', `no assessment run with id ${context.params.id}`);
    return { run, assessments: await assurance.assessmentsForRun(run.id) };
  });

  router.get('/v1/assurance/assessments/:id', async (context) => {
    operators.authenticate(context);
    const assessment = await assurance.getAssessment(context.params.id!);
    if (!assessment) throw new ArcError('not_found', `no assessment with id ${context.params.id}`);
    return assessment;
  });

  // --- framework mappings -------------------------------------------------

  router.get('/v1/assurance/frameworks', async (context) => {
    operators.authenticate(context);
    // Built with a loop rather than filter().map(): a `filter` does not narrow
    // the value type, and the `!` that silences it would hide a real undefined
    // the day a framework id is listed without a definition.
    const frameworks: Record<string, unknown>[] = [];
    for (const [id, framework] of Object.entries(FRAMEWORKS)) {
      if (!framework) continue;
      frameworks.push({
        id,
        name: framework.name,
        edition: framework.edition,
        disclaimer: framework.disclaimer,
        mappings: framework.mappings.length,
        reviewed: framework.mappings.filter((mapping) => mapping.review === 'reviewed').length,
      });
    }

    return { frameworks };
  });

  router.get('/v1/assurance/frameworks/:id', async (context) => {
    operators.authenticate(context);
    const framework = FRAMEWORKS[context.params.id! as keyof typeof FRAMEWORKS];
    if (!framework) {
      throw new ArcError('not_found', `no framework mapping for "${context.params.id}" is shipped in this release`);
    }

    return {
      framework: {
        id: framework.id,
        name: framework.name,
        publisher: framework.publisher,
        edition: framework.edition,
        disclaimer: framework.disclaimer,
      },
      rows: frameworkCoverage(framework, await assurance.latestAssessments()),
    };
  });

  // --- the risk register --------------------------------------------------

  router.get('/v1/risks', async (context) => {
    operators.authenticate(context);
    return { risks: await assurance.listRisks() };
  });

  router.post('/v1/risks', async (context) => {
    const operator = operators.authenticate(context);
    const body = await context.body<Record<string, unknown>>();
    requireFields(body, ['reference', 'title', 'description', 'category', 'impact', 'likelihood', 'treatment', 'owner']);

    return withStatus(
      201,
      await assurance.createRisk(
        {
          reference: String(body.reference),
          title: String(body.title),
          description: String(body.description),
          category: String(body.category),
          impact: band(body.impact, 'impact'),
          likelihood: band(body.likelihood, 'likelihood'),
          treatment: treatment(body.treatment),
          owner: String(body.owner),
          ...(Array.isArray(body.controlIds) ? { controlIds: body.controlIds.map(String) } : {}),
          ...(Array.isArray(body.scope) ? { scope: body.scope.map(String) } : {}),
          ...(body.reviewDueAt ? { reviewDueAt: String(body.reviewDueAt) } : {}),
        },
        operator.identifier,
      ),
    );
  });

  router.get('/v1/risks/:id', async (context) => {
    operators.authenticate(context);
    const risk = await assurance.getRisk(context.params.id!);
    if (!risk) throw new ArcError('not_found', `no risk with id ${context.params.id}`);
    return risk;
  });

  /**
   * Records a reviewed residual rating.
   *
   * A separate, explicitly attributed call rather than a field on create,
   * because residual risk is the number that reaches a board and the one thing
   * ARC must never do is compute it from the mere existence of controls.
   */
  router.post('/v1/risks/:id/residual', async (context) => {
    const operator = operators.authenticate(context);
    const body = await context.body<Record<string, unknown>>();
    requireFields(body, ['impact', 'likelihood', 'rationale']);

    return assurance.reviewResidual(context.params.id!, {
      impact: band(body.impact, 'impact'),
      likelihood: band(body.likelihood, 'likelihood'),
      reviewedBy: operator.identifier,
      rationale: String(body.rationale),
    });
  });

  router.post('/v1/risks/:id/accept', async (context) => {
    const operator = operators.authenticate(context);
    const body = await context.body<{ rationale?: string; validForDays?: number }>();
    requireFields(body, ['rationale']);

    return assurance.acceptRisk(context.params.id!, {
      acceptedBy: operator.identifier,
      rationale: String(body.rationale),
      ...(typeof body.validForDays === 'number' ? { validForDays: body.validForDays } : {}),
    });
  });

  router.post('/v1/risks/:id/controls', async (context) => {
    const operator = operators.authenticate(context);
    const body = await context.body<{ controlIds?: readonly unknown[] }>();
    if (!Array.isArray(body.controlIds)) {
      throw new ArcError('invalid_request', 'controlIds must be an array of control ids');
    }
    return assurance.linkControls(context.params.id!, body.controlIds.map(String), operator.identifier);
  });

  // --- findings -----------------------------------------------------------

  router.get('/v1/findings', async (context) => {
    operators.authenticate(context);
    const status = context.query.get('status');
    const controlId = context.query.get('controlId');

    return {
      findings: await assurance.listFindings({
        ...(status ? { status: status as never } : {}),
        ...(controlId ? { controlId } : {}),
      }),
    };
  });

  router.get('/v1/findings/:id', async (context) => {
    operators.authenticate(context);
    const finding = await assurance.getFinding(context.params.id!);
    if (!finding) throw new ArcError('not_found', `no finding with id ${context.params.id}`);
    return finding;
  });

  router.post('/v1/findings/:id', async (context) => {
    const operator = operators.authenticate(context);
    const body = await context.body<Record<string, unknown>>();

    return assurance.updateFinding(
      context.params.id!,
      {
        ...(body.owner !== undefined ? { owner: String(body.owner) } : {}),
        ...(body.dueAt !== undefined ? { dueAt: String(body.dueAt) } : {}),
        ...(body.severity !== undefined ? { severity: String(body.severity) as never } : {}),
        ...(body.status !== undefined ? { status: String(body.status) as never } : {}),
      },
      operator.identifier,
    );
  });

  /**
   * Closes a finding.
   *
   * `resolved`, `accepted` and `false_positive` stay distinct: the first says
   * it was fixed, the second that the organization chose to live with it, the
   * third that it was never true. Collapsing them would make the register
   * useless for arguing about any of the three.
   */
  router.post('/v1/findings/:id/resolve', async (context) => {
    const operator = operators.authenticate(context);
    const body = await context.body<{ status?: string; note?: string }>();
    requireFields(body, ['status', 'note']);

    const status = String(body.status);
    if (status !== 'resolved' && status !== 'accepted' && status !== 'false_positive') {
      throw new ArcError('invalid_request', 'status must be "resolved", "accepted" or "false_positive"');
    }

    return assurance.resolveFinding(context.params.id!, {
      status,
      by: operator.identifier,
      note: String(body.note),
    });
  });

  // --- evidence bundles ---------------------------------------------------

  /**
   * Exports a bundle.
   *
   * An optional `anchor` lets an operator supply the audit head they recorded
   * elsewhere, which is what turns the bundle from internally consistent into
   * genuinely anchored. Without it the bundle still exports, and says in its
   * own limitations what it therefore cannot establish.
   */
  router.post('/v1/evidence/bundles', async (context) => {
    const operator = operators.authenticate(context);
    const body = await context.body<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);

    const bundle = await buildBundle({
      store: gateway.store,
      scope: scopeFrom(body),
      exportedBy: operator.identifier,
      producedBy: `arc-control/${options.version}`,
      ...windowFrom(context.query, body),
      ...(isAnchor(body.anchor) ? { anchor: body.anchor } : {}),
    });

    await gateway.audit.append({
      type: 'bundle.exported',
      organizationId: bundle.manifest.organizationId,
      actor: operator.identifier,
      subject: bundle.manifest.id,
      summary: `${operator.identifier} exported an evidence bundle covering ${bundle.manifest.window.from.slice(0, 10)} to ${bundle.manifest.window.to.slice(0, 10)}`,
      data: {
        bundleId: bundle.manifest.id,
        scope: bundle.manifest.scope,
        counts: bundle.manifest.counts,
        contentDigest: bundle.manifest.contentDigest,
        anchored: bundle.anchor !== undefined,
      },
    });

    return withStatus(201, bundle);
  });

  // --- policy history and simulation --------------------------------------

  router.get('/v1/policies/:id/history', async (context) => {
    operators.authenticate(context);
    await gateway.policies.require(context.params.id!);
    return { versions: await gateway.policies.history(context.params.id!) };
  });

  /**
   * Simulates a candidate policy. Writes nothing and executes nothing.
   *
   * Two modes. With `subject`, one hypothetical action is decided under both
   * the current and the candidate policy set. Without it, recorded traffic in
   * the window is re-decided and only the differences are returned — which is
   * the question an operator actually has before changing a policy.
   */
  router.post('/v1/policies/simulate', async (context) => {
    operators.authenticate(context);
    const body = await context.body<Record<string, unknown>>();
    requireFields(body, ['candidate']);

    const candidate = body.candidate as Parameters<typeof simulateHypothetical>[0]['candidate'];

    if (body.subject) {
      const subject = body.subject as { agentName?: unknown; tool?: unknown; parameters?: unknown };
      requireFields(subject, ['agentName', 'tool']);

      return simulateHypothetical({
        store: gateway.store,
        candidate,
        classification: gateway.classification,
        subject: {
          agentName: String(subject.agentName),
          tool: String(subject.tool),
          parameters: (subject.parameters ?? {}) as Readonly<Record<string, unknown>>,
        },
      });
    }

    return simulateAgainstHistory({
      store: gateway.store,
      candidate,
      classification: gateway.classification,
      ...windowFrom(context.query, body),
      ...(typeof body.limit === 'number' ? { limit: body.limit } : {}),
    });
  });

  return router;
}

// --- helpers ---------------------------------------------------------------

function windowFrom(
  query: URLSearchParams,
  body: Record<string, unknown> = {},
): { from?: Date; to?: Date } {
  const from = (body.from as string | undefined) ?? query.get('from') ?? undefined;
  const to = (body.to as string | undefined) ?? query.get('to') ?? undefined;

  return {
    ...(from ? { from: parseDate(from, 'from') } : {}),
    ...(to ? { to: parseDate(to, 'to') } : {}),
  };
}

function parseDate(value: string, field: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new ArcError('invalid_request', `${field} is not a valid ISO timestamp`, { details: { [field]: value } });
  }
  return parsed;
}

function scopeFrom(body: Record<string, unknown>): Parameters<typeof buildBundle>[0]['scope'] {
  const scope = body.scope as { kind?: unknown; runId?: unknown; controlId?: unknown; evidenceIds?: unknown } | undefined;
  if (!scope || scope.kind === undefined || scope.kind === 'window') return { kind: 'window' };

  switch (String(scope.kind)) {
    case 'run':
      requireFields(scope, ['runId']);
      return { kind: 'run', runId: String(scope.runId) };
    case 'control':
      requireFields(scope, ['controlId']);
      return { kind: 'control', controlId: String(scope.controlId) };
    case 'evidence':
      if (!Array.isArray(scope.evidenceIds)) {
        throw new ArcError('invalid_request', 'an evidence scope needs evidenceIds as an array');
      }
      return { kind: 'evidence', evidenceIds: scope.evidenceIds.map(String) };
    default:
      throw new ArcError('invalid_request', `unknown bundle scope "${String(scope.kind)}"`, {
        details: { supported: ['window', 'run', 'control', 'evidence'] },
      });
  }
}

function isAnchor(value: unknown): value is Parameters<typeof buildBundle>[0]['anchor'] {
  if (typeof value !== 'object' || value === null) return false;
  const anchor = value as Record<string, unknown>;
  return (
    typeof anchor.headDigest === 'string' &&
    typeof anchor.headSequence === 'number' &&
    typeof anchor.recordedAt === 'string' &&
    typeof anchor.recordedBy === 'string'
  );
}

function band(value: unknown, field: string): RiskBand {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 5) {
    throw new ArcError('invalid_request', `${field} must be an integer from 1 to 5`, { details: { [field]: value } });
  }
  return parsed as RiskBand;
}

function treatment(value: unknown): RiskTreatment {
  const parsed = String(value);
  if (parsed !== 'mitigate' && parsed !== 'transfer' && parsed !== 'avoid' && parsed !== 'accept') {
    throw new ArcError('invalid_request', 'treatment must be mitigate, transfer, avoid or accept');
  }
  return parsed;
}

function requireFields(body: unknown, fields: readonly string[]): void {
  const record = (body ?? {}) as Record<string, unknown>;
  const missing = fields.filter((field) => record[field] === undefined || record[field] === null);
  if (missing.length > 0) {
    throw new ArcError('invalid_request', `missing required field(s): ${missing.join(', ')}`, { details: { missing } });
  }
}

function positiveInt(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}
