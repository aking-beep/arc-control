/**
 * The ARC Assurance engine.
 *
 * It owns four things: the control library, the assessment runs that evaluate
 * it, the findings those runs raise, and the risk register the controls are
 * mapped to. Everything it writes is persisted and audited, because an
 * assessment result that cannot be traced to who ran it and what it looked at
 * is a screenshot, not evidence.
 *
 * Two design decisions are worth stating because they are easy to reverse by
 * accident:
 *
 *  1. **The engine never writes to the enforcement objects.** It reads
 *     agents, tools, policies, actions, evidence, approvals and the audit log,
 *     and writes only to its own collections. Assurance observing enforcement
 *     cannot change what enforcement did, so a bad assessment can never
 *     weaken the gateway. This is also why an assurance outage is harmless to
 *     authorization — there is no path from here into the decision.
 *
 *  2. **Findings are reconciled, not replaced.** A run does not wipe the
 *     findings register and write a new one; it matches what it observes
 *     against what is open, increments occurrences on a repeat, and resolves
 *     one that is no longer observed with a note naming the run that cleared
 *     it. Remediation history is the part customers actually care about, and
 *     replacing the register each run would destroy it.
 */
import {
  digest,
  newId,
  rateRisk,
  type Action,
  type Agent,
  type ApprovalRequest,
  type AssessmentRun,
  type AssessmentWindow,
  type ChainVerification,
  type ControlAssessment,
  type ControlDefinition,
  type ControlObservation,
  type ControlStatus,
  type EvidenceRecord,
  type Finding,
  type FindingSeverity,
  type FindingStatus,
  type HumanAttestation,
  type Policy,
  type PolicyEffect,
  type Risk,
  type RiskBand,
  type RiskTreatment,
} from '@arc-control/schemas';
import type { ControlStore } from '@arc-control/store';
import { baselineControls } from './catalogue.js';
import { EVALUATORS, unimplementedEvaluator, type EvaluationContext, type EvaluationResult } from './evaluate.js';

/**
 * Appends to the audit log.
 *
 * Injected rather than constructed here so the engine depends only on the
 * store: `@arc-control/audit` depends on the store too, and having assurance
 * reach for it directly would make the dependency graph a cycle waiting to
 * happen. The caller owns the audit log and lends the engine one verb.
 */
export type AuditAppend = (event: {
  readonly type: AssuranceAuditEvent;
  readonly organizationId: string;
  readonly actor: string;
  readonly subject: string;
  readonly summary: string;
  readonly data?: Readonly<Record<string, unknown>>;
}) => Promise<unknown>;

/** The audit event types this engine emits. A subset of AuditEventType. */
export type AssuranceAuditEvent =
  | 'risk.created'
  | 'risk.updated'
  | 'risk.accepted'
  | 'risk.closed'
  | 'control.created'
  | 'control.updated'
  | 'control.enabled'
  | 'control.disabled'
  | 'assessment.ran'
  | 'attestation.recorded'
  | 'finding.opened'
  | 'finding.updated'
  | 'finding.resolved';

export interface AssuranceOptions {
  readonly store: ControlStore;
  readonly audit: AuditAppend;
  /** Verifies the audit chain for a run. Supplied by the caller, which owns the expectation. */
  readonly verifyChain?: () => Promise<{ readonly verification: ChainVerification; readonly externallyAnchored: boolean }>;
  readonly organizationId?: string;
  /** The gateway's effect when no policy matches, reported by ARC-AI-002. */
  readonly fallbackEffect?: PolicyEffect;
  readonly now?: () => Date;
}

export interface RunOptions {
  /** Operator identifier, or `schedule` for an unattended run. */
  readonly requestedBy: string;
  /** Window start. Defaults to 30 days before `to`. */
  readonly from?: Date;
  readonly to?: Date;
  /** Restrict the run to these control ids. Defaults to every enabled control. */
  readonly controlIds?: readonly string[];
}

export interface AssuranceSummary {
  readonly window: AssessmentWindow;
  readonly totals: Readonly<Record<ControlStatus, number>>;
  readonly controls: number;
  readonly controlsEnabled: number;
  readonly openFindings: Readonly<Record<FindingSeverity, number>>;
  readonly risks: { readonly total: number; readonly accepted: number; readonly overdueReview: number };
  readonly lastRun?: { readonly id: string; readonly finishedAt: string; readonly requestedBy: string };
  /**
   * Controls not covered by an automated check. Surfaced in the summary so a
   * reader sees immediately how much of the posture rests on human statements.
   */
  readonly attestedOrUnassessable: number;
  readonly generatedAt: string;
}

const DEFAULT_WINDOW_DAYS = 30;

export class AssuranceEngine {
  readonly #store: ControlStore;
  readonly #audit: AuditAppend;
  readonly #verifyChain: AssuranceOptions['verifyChain'];
  readonly #organizationId: string;
  readonly #fallbackEffect: PolicyEffect;
  readonly #now: () => Date;

  constructor(options: AssuranceOptions) {
    this.#store = options.store;
    this.#audit = options.audit;
    this.#verifyChain = options.verifyChain;
    this.#organizationId = options.organizationId ?? 'default';
    this.#fallbackEffect = options.fallbackEffect ?? 'DENY';
    this.#now = options.now ?? (() => new Date());
  }

  // --- control library ---------------------------------------------------

  /**
   * Installs the baseline catalogue for any control not already present.
   *
   * Idempotent, and deliberately non-destructive: an operator who disabled
   * ARC-AI-007 or rewrote its frequency keeps that across restarts and
   * upgrades. Only genuinely absent controls are added.
   */
  async seedBaseline(): Promise<{ readonly added: readonly string[]; readonly kept: readonly string[] }> {
    const added: string[] = [];
    const kept: string[] = [];

    for (const definition of baselineControls(this.#now())) {
      const existing = await this.#store.controls.get(definition.id);
      if (existing) {
        kept.push(existing.id);
        continue;
      }
      await this.#store.controls.put(definition.id, definition);
      added.push(definition.id);
    }

    return { added, kept };
  }

  async listControls(): Promise<readonly ControlDefinition[]> {
    return this.#store.controls.list();
  }

  async getControl(id: string): Promise<ControlDefinition | undefined> {
    return this.#store.controls.get(id);
  }

  /** Enables or disables a control. Audited: switching off a control is a governance act. */
  async setControlEnabled(id: string, enabled: boolean, actor: string): Promise<ControlDefinition> {
    return this.#store.controls.transact(async () => {
      const existing = await this.#store.controls.get(id);
      if (!existing) throw new Error(`no control with id ${id}`);

      const updated: ControlDefinition = { ...existing, enabled, updatedAt: this.#now().toISOString() };
      await this.#store.controls.put(id, updated);

      await this.#audit({
        type: enabled ? 'control.enabled' : 'control.disabled',
        organizationId: this.#organizationId,
        actor,
        subject: id,
        summary: `${actor} ${enabled ? 'enabled' : 'disabled'} control ${id}`,
        data: { controlId: id, title: existing.title },
      });

      return updated;
    });
  }

  // --- attestations ------------------------------------------------------

  /**
   * Records a human attestation against a control.
   *
   * Used by the `deployment` and `manual` controls, which ARC cannot decide
   * for itself. An attestation carries an expiry because the alternative — a
   * statement that stays true forever — is how a control nobody has looked at
   * in three years keeps reporting green.
   */
  async recordAttestation(input: {
    readonly controlId: string;
    readonly attestedBy: string;
    readonly statement: string;
    readonly validForDays?: number;
    readonly reference?: string;
  }): Promise<HumanAttestation> {
    const control = await this.#store.controls.get(input.controlId);
    if (!control) throw new Error(`no control with id ${input.controlId}`);

    const now = this.#now();
    const validFor = input.validForDays ?? 90;
    const attestation: HumanAttestation = {
      id: newId('attestation'),
      controlId: input.controlId,
      attestedBy: input.attestedBy,
      attestedAt: now.toISOString(),
      statement: input.statement,
      expiresAt: new Date(now.getTime() + validFor * 86_400_000).toISOString(),
      ...(input.reference ? { reference: input.reference } : {}),
    };

    // Every attestation is kept, never replaced: the register of who said what
    // and when is the point, and overwriting last quarter's statement with
    // this quarter's would destroy exactly the history an auditor asks for.
    await this.#store.attestations.put(attestation.id, attestation);

    await this.#audit({
      type: 'attestation.recorded',
      organizationId: this.#organizationId,
      actor: input.attestedBy,
      subject: input.controlId,
      summary: `${input.attestedBy} attested control ${input.controlId} valid until ${attestation.expiresAt.slice(0, 10)}`,
      data: { controlId: input.controlId, attestationId: attestation.id, expiresAt: attestation.expiresAt },
    });

    return attestation;
  }

  /**
   * The newest unexpired attestation for a control.
   *
   * Expiry is checked here rather than at write time, so an attestation goes
   * stale on its own and the control reverts to `not_assessable` without
   * anyone having to remember to retract it.
   */
  async currentAttestation(controlId: string): Promise<HumanAttestation | undefined> {
    const now = this.#now().getTime();
    const live = await this.#store.attestations.filter(
      (attestation) => attestation.controlId === controlId && Date.parse(attestation.expiresAt) > now,
    );
    return live.slice().sort((a, b) => Date.parse(b.attestedAt) - Date.parse(a.attestedAt))[0];
  }

  /** Every attestation ever recorded for a control, newest first. */
  async attestationHistory(controlId: string): Promise<readonly HumanAttestation[]> {
    const all = await this.#store.attestations.filter((attestation) => attestation.controlId === controlId);
    return all.slice().sort((a, b) => Date.parse(b.attestedAt) - Date.parse(a.attestedAt));
  }

  // --- assessment runs ---------------------------------------------------

  /**
   * Evaluates the control library over a window and persists the result.
   *
   * The snapshot is loaded once and handed to every evaluator, so all the
   * controls in a run describe the same moment. Evaluating them against
   * separately loaded views would let two controls in the same report
   * contradict each other, which is exactly the kind of inconsistency that
   * makes a reader distrust the whole document.
   */
  async run(options: RunOptions): Promise<{ readonly run: AssessmentRun; readonly assessments: readonly ControlAssessment[] }> {
    const startedAt = this.#now();
    const to = options.to ?? startedAt;
    const from = options.from ?? new Date(to.getTime() - DEFAULT_WINDOW_DAYS * 86_400_000);

    const [agents, tools, policies, allActions, allEvidence, approvals] = await Promise.all([
      this.#store.agents.list(),
      this.#store.tools.list(),
      this.#store.policies.list(),
      this.#store.actions.list(),
      this.#store.evidence.list(),
      this.#store.approvals.list(),
    ]);

    const inWindow = (timestamp: string): boolean => {
      const at = Date.parse(timestamp);
      return at >= from.getTime() && at <= to.getTime();
    };

    const actions = allActions.filter((action) => inWindow(action.requestedAt));
    const actionIds = new Set(actions.map((action) => action.id));
    const evidence = allEvidence.filter((record) => actionIds.has(record.actionId));

    const window: AssessmentWindow = {
      from: from.toISOString(),
      to: to.toISOString(),
      actionsConsidered: actions.length,
      evidenceConsidered: evidence.length,
    };

    let chain: ChainVerification | undefined;
    let externallyAnchored = false;
    if (this.#verifyChain) {
      const checked = await this.#verifyChain();
      chain = checked.verification;
      externallyAnchored = checked.externallyAnchored;
    }

    const library = await this.#store.controls.list();
    const selected = library.filter(
      (control) => control.enabled && (options.controlIds ? options.controlIds.includes(control.id) : true),
    );

    const runId = newId('assessmentRun');
    const assessments: ControlAssessment[] = [];
    const totals = emptyTotals();

    for (const control of selected) {
      const attestation = await this.currentAttestation(control.id);
      const context: EvaluationContext = {
        organizationId: this.#organizationId,
        window,
        now: startedAt,
        agents,
        tools,
        policies,
        actions,
        evidence,
        approvals,
        externallyAnchored,
        fallbackEffect: this.#fallbackEffect,
        ...(chain ? { chain } : {}),
        ...(attestation ? { attestation } : {}),
      };

      const assessment = await this.#assess(control, context, runId, attestation);
      assessments.push(assessment);
      totals[assessment.status] += 1;
    }

    const head = await this.#store.audit.last();
    const finishedAt = this.#now();

    const run: AssessmentRun = {
      id: runId,
      organizationId: this.#organizationId,
      requestedBy: options.requestedBy,
      window,
      controlIds: selected.map((control) => control.id),
      assessmentIds: assessments.map((assessment) => assessment.id),
      totals,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      ...(head ? { auditHead: { sequence: head.sequence, digest: head.digest } } : {}),
    };

    await this.#store.assessmentRuns.put(run.id, run);

    await this.#audit({
      type: 'assessment.ran',
      organizationId: this.#organizationId,
      actor: options.requestedBy,
      subject: run.id,
      summary: `${options.requestedBy} ran ${selected.length} control(s): ${describeTotals(totals)}`,
      data: {
        runId: run.id,
        window: { from: window.from, to: window.to },
        totals,
        controlIds: run.controlIds,
      },
    });

    return { run, assessments };
  }

  /** Evaluates one control, persists the assessment, and reconciles its findings. */
  async #assess(
    control: ControlDefinition,
    context: EvaluationContext,
    runId: string,
    attestation: HumanAttestation | undefined,
  ): Promise<ControlAssessment> {
    const startedAt = process.hrtime.bigint();

    let result: EvaluationResult;
    try {
      const evaluator = EVALUATORS[control.id] ?? unimplementedEvaluator;
      result = evaluator(context);
    } catch (cause) {
      // An evaluator that throws reports not_assessable, never pass. A bug in
      // assurance code must not be able to manufacture a passing control.
      result = {
        status: 'not_assessable',
        summary: `The evaluator for ${control.id} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        observations: [],
      };
    }

    const evaluationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    const id = newId('assessment');

    const findingIds = await this.#reconcileFindings(control, result, id, context);

    const content = {
      id,
      schemaVersion: 2 as const,
      runId,
      controlId: control.id,
      controlVersion: control.version,
      organizationId: context.organizationId,
      status: result.status,
      assurance: control.assurance,
      summary: result.summary,
      observations: result.observations,
      window: context.window,
      ...(attestation && result.status === 'attested' ? { attestation } : {}),
      limitations: control.limitations,
      findingIds,
      evaluatedAt: context.now.toISOString(),
      evaluationMs,
    };

    const assessment: ControlAssessment = { ...content, integrityDigest: digest(content) };
    await this.#store.assessments.put(assessment.id, assessment);
    return assessment;
  }

  /**
   * Opens, updates and resolves findings for one control's result.
   *
   * Keyed by control plus subject, so the same failing agent across ten runs
   * is one finding with ten occurrences rather than ten findings. A subject
   * that stops failing has its finding resolved with the assessment that
   * cleared it named in the resolution, so "fixed" is attributable.
   */
  async #reconcileFindings(
    control: ControlDefinition,
    result: EvaluationResult,
    assessmentId: string,
    context: EvaluationContext,
  ): Promise<readonly string[]> {
    const timestamp = context.now.toISOString();
    const severity = result.severity ?? control.failureSeverity;

    const failing = result.observations.filter((observation) => !observation.ok);
    const open = await this.#store.findings.filter(
      (finding) =>
        finding.controlId === control.id && (finding.status === 'open' || finding.status === 'in_progress'),
    );
    const openBySubject = new Map(open.map((finding) => [finding.subject, finding]));
    const touched: string[] = [];

    for (const observation of failing) {
      const existing = openBySubject.get(observation.subject);

      if (existing) {
        const updated: Finding = {
          ...existing,
          severity,
          detail: observation.detail,
          occurrences: existing.occurrences + 1,
          lastSeenAt: timestamp,
          updatedAt: timestamp,
          evidenceIds: observation.evidenceIds ?? existing.evidenceIds,
        };
        await this.#store.findings.put(updated.id, updated);
        touched.push(updated.id);
        openBySubject.delete(observation.subject);
        continue;
      }

      const finding: Finding = {
        id: newId('finding'),
        organizationId: context.organizationId,
        controlId: control.id,
        assessmentId,
        severity,
        status: 'open',
        title: `${control.id}: ${control.title}`,
        detail: observation.detail,
        subject: observation.subject,
        subjectKind: observation.subjectKind,
        ...(control.owner ? { owner: control.owner } : {}),
        evidenceIds: observation.evidenceIds ?? [],
        occurrences: 1,
        firstSeenAt: timestamp,
        lastSeenAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      await this.#store.findings.put(finding.id, finding);
      touched.push(finding.id);

      await this.#audit({
        type: 'finding.opened',
        organizationId: context.organizationId,
        actor: 'system',
        subject: finding.id,
        summary: `${control.id} raised a ${severity} finding against ${observation.subject}`,
        data: { controlId: control.id, findingId: finding.id, subject: observation.subject, severity },
      });
    }

    // Whatever is still in the map was open but is no longer observed failing.
    for (const stale of openBySubject.values()) {
      const resolved: Finding = {
        ...stale,
        status: 'resolved',
        resolution: {
          by: 'system',
          at: timestamp,
          note: `No longer observed failing by assessment ${assessmentId}.`,
        },
        updatedAt: timestamp,
      };
      await this.#store.findings.put(resolved.id, resolved);

      await this.#audit({
        type: 'finding.resolved',
        organizationId: context.organizationId,
        actor: 'system',
        subject: resolved.id,
        summary: `${control.id} finding against ${stale.subject} is no longer observed`,
        data: { controlId: control.id, findingId: resolved.id, assessmentId },
      });
    }

    return touched;
  }

  // --- reading results ---------------------------------------------------

  async listRuns(limit = 50): Promise<readonly AssessmentRun[]> {
    const runs = await this.#store.assessmentRuns.list();
    return runs.slice().sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)).slice(0, limit);
  }

  async getRun(id: string): Promise<AssessmentRun | undefined> {
    return this.#store.assessmentRuns.get(id);
  }

  async assessmentsForRun(runId: string): Promise<readonly ControlAssessment[]> {
    return this.#store.assessments.filter((assessment) => assessment.runId === runId);
  }

  async getAssessment(id: string): Promise<ControlAssessment | undefined> {
    return this.#store.assessments.get(id);
  }

  /** The most recent assessment of each control, which is what a dashboard shows. */
  async latestAssessments(): Promise<readonly ControlAssessment[]> {
    const all = await this.#store.assessments.list();
    const latest = new Map<string, ControlAssessment>();
    for (const assessment of all) {
      const current = latest.get(assessment.controlId);
      if (!current || Date.parse(assessment.evaluatedAt) > Date.parse(current.evaluatedAt)) {
        latest.set(assessment.controlId, assessment);
      }
    }
    return [...latest.values()].sort((a, b) => a.controlId.localeCompare(b.controlId));
  }

  async assessmentHistory(controlId: string, limit = 50): Promise<readonly ControlAssessment[]> {
    const all = await this.#store.assessments.filter((assessment) => assessment.controlId === controlId);
    return all.slice().sort((a, b) => Date.parse(b.evaluatedAt) - Date.parse(a.evaluatedAt)).slice(0, limit);
  }

  // --- findings ----------------------------------------------------------

  async listFindings(filter: { readonly status?: FindingStatus; readonly controlId?: string } = {}): Promise<readonly Finding[]> {
    const all = await this.#store.findings.list();
    return all
      .filter((finding) => (filter.status ? finding.status === filter.status : true))
      .filter((finding) => (filter.controlId ? finding.controlId === filter.controlId : true))
      .slice()
      .sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt));
  }

  async getFinding(id: string): Promise<Finding | undefined> {
    return this.#store.findings.get(id);
  }

  /** Assigns, re-prioritises or sets a due date on a finding. */
  async updateFinding(
    id: string,
    patch: { readonly owner?: string; readonly dueAt?: string; readonly severity?: FindingSeverity; readonly status?: FindingStatus },
    actor: string,
  ): Promise<Finding> {
    return this.#store.findings.transact(async () => {
      const existing = await this.#store.findings.get(id);
      if (!existing) throw new Error(`no finding with id ${id}`);

      const updated: Finding = {
        ...existing,
        ...(patch.owner !== undefined ? { owner: patch.owner } : {}),
        ...(patch.dueAt !== undefined ? { dueAt: patch.dueAt } : {}),
        ...(patch.severity !== undefined ? { severity: patch.severity } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        updatedAt: this.#now().toISOString(),
      };

      await this.#store.findings.put(id, updated);
      await this.#audit({
        type: 'finding.updated',
        organizationId: existing.organizationId,
        actor,
        subject: id,
        summary: `${actor} updated finding ${id}`,
        data: { findingId: id, patch },
      });
      return updated;
    });
  }

  /**
   * Closes a finding with a reason.
   *
   * `accepted` and `false_positive` both close it without a fix, and the
   * difference matters: the first says the organization chose to live with it,
   * the second says it was never true. Collapsing them would make the register
   * useless for arguing about either.
   */
  async resolveFinding(
    id: string,
    resolution: { readonly status: Extract<FindingStatus, 'resolved' | 'accepted' | 'false_positive'>; readonly by: string; readonly note: string },
  ): Promise<Finding> {
    return this.#store.findings.transact(async () => {
      const existing = await this.#store.findings.get(id);
      if (!existing) throw new Error(`no finding with id ${id}`);

      const updated: Finding = {
        ...existing,
        status: resolution.status,
        resolution: { by: resolution.by, at: this.#now().toISOString(), note: resolution.note },
        updatedAt: this.#now().toISOString(),
      };

      await this.#store.findings.put(id, updated);
      await this.#audit({
        type: 'finding.resolved',
        organizationId: existing.organizationId,
        actor: resolution.by,
        subject: id,
        summary: `${resolution.by} marked finding ${id} ${resolution.status}`,
        data: { findingId: id, status: resolution.status, note: resolution.note },
      });
      return updated;
    });
  }

  // --- risk register -----------------------------------------------------

  async listRisks(): Promise<readonly Risk[]> {
    const risks = await this.#store.risks.list();
    return risks.slice().sort((a, b) => b.inherent.score - a.inherent.score);
  }

  async getRisk(id: string): Promise<Risk | undefined> {
    return this.#store.risks.get(id);
  }

  async createRisk(input: {
    readonly reference: string;
    readonly title: string;
    readonly description: string;
    readonly category: string;
    readonly impact: RiskBand;
    readonly likelihood: RiskBand;
    readonly treatment: RiskTreatment;
    readonly owner: string;
    readonly controlIds?: readonly string[];
    readonly scope?: readonly string[];
    readonly reviewDueAt?: string;
    readonly labels?: Readonly<Record<string, string>>;
  }, actor: string): Promise<Risk> {
    const timestamp = this.#now().toISOString();
    const risk: Risk = {
      id: newId('risk'),
      reference: input.reference,
      title: input.title,
      description: input.description,
      organizationId: this.#organizationId,
      category: input.category,
      status: 'identified',
      inherent: rateRisk(input.impact, input.likelihood),
      treatment: input.treatment,
      owner: input.owner,
      controlIds: input.controlIds ?? [],
      scope: input.scope ?? [],
      ...(input.reviewDueAt ? { reviewDueAt: input.reviewDueAt } : {}),
      labels: input.labels ?? {},
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    await this.#store.risks.put(risk.id, risk);
    await this.#audit({
      type: 'risk.created',
      organizationId: this.#organizationId,
      actor,
      subject: risk.id,
      summary: `${actor} recorded risk ${risk.reference} (${risk.inherent.severity}) owned by ${risk.owner}`,
      data: { riskId: risk.id, reference: risk.reference, inherent: risk.inherent, controlIds: risk.controlIds },
    });
    return risk;
  }

  /**
   * Records a reviewed residual rating.
   *
   * Deliberately a separate, explicitly attributed call rather than a field on
   * create: residual risk is the number that goes in front of a board, and the
   * one thing ARC must never do is compute it from the existence of controls.
   */
  async reviewResidual(
    id: string,
    review: { readonly impact: RiskBand; readonly likelihood: RiskBand; readonly reviewedBy: string; readonly rationale: string },
  ): Promise<Risk> {
    return this.#store.risks.transact(async () => {
      const existing = await this.#store.risks.get(id);
      if (!existing) throw new Error(`no risk with id ${id}`);

      const rated = rateRisk(review.impact, review.likelihood);
      const updated: Risk = {
        ...existing,
        status: existing.status === 'identified' ? 'assessed' : existing.status,
        residual: {
          ...rated,
          reviewedBy: review.reviewedBy,
          reviewedAt: this.#now().toISOString(),
          rationale: review.rationale,
        },
        updatedAt: this.#now().toISOString(),
      };

      await this.#store.risks.put(id, updated);
      await this.#audit({
        type: 'risk.updated',
        organizationId: existing.organizationId,
        actor: review.reviewedBy,
        subject: id,
        summary: `${review.reviewedBy} reviewed residual risk for ${existing.reference} as ${rated.severity}`,
        data: { riskId: id, residual: updated.residual },
      });
      return updated;
    });
  }

  /** Records a dated, expiring acceptance of a risk by a named owner. */
  async acceptRisk(
    id: string,
    acceptance: { readonly acceptedBy: string; readonly rationale: string; readonly validForDays?: number },
  ): Promise<Risk> {
    return this.#store.risks.transact(async () => {
      const existing = await this.#store.risks.get(id);
      if (!existing) throw new Error(`no risk with id ${id}`);

      const now = this.#now();
      const validFor = acceptance.validForDays ?? 180;
      const updated: Risk = {
        ...existing,
        status: 'accepted',
        treatment: 'accept',
        acceptance: {
          acceptedBy: acceptance.acceptedBy,
          acceptedAt: now.toISOString(),
          rationale: acceptance.rationale,
          expiresAt: new Date(now.getTime() + validFor * 86_400_000).toISOString(),
        },
        updatedAt: now.toISOString(),
      };

      await this.#store.risks.put(id, updated);
      await this.#audit({
        type: 'risk.accepted',
        organizationId: existing.organizationId,
        actor: acceptance.acceptedBy,
        subject: id,
        summary: `${acceptance.acceptedBy} accepted risk ${existing.reference} until ${updated.acceptance!.expiresAt.slice(0, 10)}`,
        data: { riskId: id, acceptance: updated.acceptance },
      });
      return updated;
    });
  }

  /** Links a risk to the controls that address it. */
  async linkControls(id: string, controlIds: readonly string[], actor: string): Promise<Risk> {
    return this.#store.risks.transact(async () => {
      const existing = await this.#store.risks.get(id);
      if (!existing) throw new Error(`no risk with id ${id}`);

      const unknown: string[] = [];
      for (const controlId of controlIds) {
        if (!(await this.#store.controls.get(controlId))) unknown.push(controlId);
      }
      if (unknown.length > 0) throw new Error(`unknown control id(s): ${unknown.join(', ')}`);

      const updated: Risk = { ...existing, controlIds, updatedAt: this.#now().toISOString() };
      await this.#store.risks.put(id, updated);
      await this.#audit({
        type: 'risk.updated',
        organizationId: existing.organizationId,
        actor,
        subject: id,
        summary: `${actor} linked ${existing.reference} to ${controlIds.join(', ') || 'no controls'}`,
        data: { riskId: id, controlIds },
      });
      return updated;
    });
  }

  // --- summary -----------------------------------------------------------

  /** The posture figures a dashboard shows, every one of them window-stamped. */
  async summary(): Promise<AssuranceSummary> {
    const [controls, latest, findings, risks, runs] = await Promise.all([
      this.#store.controls.list(),
      this.latestAssessments(),
      this.#store.findings.list(),
      this.#store.risks.list(),
      this.listRuns(1),
    ]);

    const totals = emptyTotals();
    for (const assessment of latest) totals[assessment.status] += 1;

    const openFindings: Record<FindingSeverity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
    for (const finding of findings) {
      if (finding.status === 'open' || finding.status === 'in_progress') openFindings[finding.severity] += 1;
    }

    const now = this.#now().getTime();
    const lastRun = runs[0];

    return {
      window: lastRun?.window ?? {
        from: new Date(now).toISOString(),
        to: new Date(now).toISOString(),
        actionsConsidered: 0,
        evidenceConsidered: 0,
      },
      totals,
      controls: controls.length,
      controlsEnabled: controls.filter((control) => control.enabled).length,
      openFindings,
      risks: {
        total: risks.length,
        accepted: risks.filter((risk) => risk.status === 'accepted').length,
        overdueReview: risks.filter((risk) => risk.reviewDueAt && Date.parse(risk.reviewDueAt) < now).length,
      },
      ...(lastRun
        ? { lastRun: { id: lastRun.id, finishedAt: lastRun.finishedAt, requestedBy: lastRun.requestedBy } }
        : {}),
      attestedOrUnassessable: totals.attested + totals.not_assessable,
      generatedAt: new Date(now).toISOString(),
    };
  }
}

function emptyTotals(): Record<ControlStatus, number> {
  return { pass: 0, fail: 0, not_assessable: 0, not_applicable: 0, attested: 0 };
}

function describeTotals(totals: Readonly<Record<ControlStatus, number>>): string {
  return Object.entries(totals)
    .filter(([, count]) => count > 0)
    .map(([status, count]) => `${count} ${status}`)
    .join(', ');
}

function severityRank(severity: FindingSeverity): number {
  return ['critical', 'high', 'medium', 'low', 'info'].indexOf(severity);
}

export type { Action, Agent, ApprovalRequest, EvidenceRecord, Policy, ControlObservation };
