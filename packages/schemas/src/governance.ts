/**
 * The governance, risk and assurance model — ARC Control 2.0's new object
 * layer, sitting on top of the enforcement objects rather than beside them.
 *
 * The distinction that organises this file: **enforcement** objects (actions,
 * decisions, evidence, audit) record what happened. **Assurance** objects
 * (controls, assessments, risks, findings) record what somebody asserted
 * *about* what happened, who asserted it, and how strong the assertion is.
 *
 * Keeping those apart is the whole point. A control result is a claim with a
 * provenance, not a fact, and the model refuses to let the two blur: there is
 * no way to record a passing control without also recording whether a machine
 * proved it or a human asserted it, and no way to record a pass at all when
 * the evidence needed to decide was absent.
 */

// --- risk ------------------------------------------------------------------

/**
 * Likelihood and impact are 1-5 ordinal bands rather than probabilities.
 * Nobody can honestly put a number on "an agent exfiltrates customer data
 * this quarter", and a model that demands one produces false precision that
 * then gets multiplied. Bands are what risk committees actually reason in.
 */
export type RiskBand = 1 | 2 | 3 | 4 | 5;

export const RISK_BAND_LABELS: Readonly<Record<RiskBand, string>> = {
  1: 'very low',
  2: 'low',
  3: 'moderate',
  4: 'high',
  5: 'very high',
};

/** Severity tier derived from impact x likelihood. */
export type RiskSeverity = 'low' | 'moderate' | 'high' | 'critical';

/** How the organization has decided to deal with a risk. */
export type RiskTreatment = 'mitigate' | 'transfer' | 'avoid' | 'accept';

export type RiskStatus = 'identified' | 'assessed' | 'treated' | 'accepted' | 'closed';

/**
 * A rating of a risk at a point in time.
 *
 * `inherent` is the risk before ARC's controls are credited. `residual` is
 * what remains after them — and it is deliberately *not* computed. Crediting a
 * control automatically would mean the platform grading its own homework: the
 * residual number would improve because a control exists, not because anyone
 * checked it works. So residual is absent until a named human reviews it, and
 * carries who reviewed it and when.
 */
export interface RiskRating {
  readonly impact: RiskBand;
  readonly likelihood: RiskBand;
  /** impact x likelihood, 1-25. */
  readonly score: number;
  readonly severity: RiskSeverity;
}

export interface ResidualRating extends RiskRating {
  /** Who reviewed the residual position. Required: an unreviewed residual is not a residual. */
  readonly reviewedBy: string;
  readonly reviewedAt: string;
  /** What the reviewer relied on. Free text, shown verbatim beside the number. */
  readonly rationale: string;
}

export interface RiskAcceptance {
  readonly acceptedBy: string;
  readonly acceptedAt: string;
  readonly rationale: string;
  /** Acceptances expire. An acceptance with no end date is a decision nobody revisits. */
  readonly expiresAt: string;
}

export interface Risk {
  /** Opaque identifier, `arc_rsk_...`. */
  readonly id: string;
  /** Operator-facing reference, e.g. `RISK-AI-004`. Unique, cited in reports. */
  readonly reference: string;
  readonly title: string;
  readonly description: string;
  readonly organizationId: string;
  /** Risk category, e.g. `unauthorized-action`, `data-exposure`, `availability`. */
  readonly category: string;
  readonly status: RiskStatus;
  readonly inherent: RiskRating;
  readonly residual?: ResidualRating;
  readonly treatment: RiskTreatment;
  /** Human or team accountable for the risk, not for the agent. */
  readonly owner: string;
  /** Control references that address this risk, e.g. `['ARC-AI-003']`. */
  readonly controlIds: readonly string[];
  /** Agents, tools or systems this risk concerns. Empty means organization-wide. */
  readonly scope: readonly string[];
  readonly acceptance?: RiskAcceptance;
  readonly reviewDueAt?: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** impact x likelihood, banded. The bands are the usual 5x5 heat-map cuts. */
export function rateRisk(impact: RiskBand, likelihood: RiskBand): RiskRating {
  const score = impact * likelihood;
  const severity: RiskSeverity = score >= 20 ? 'critical' : score >= 12 ? 'high' : score >= 5 ? 'moderate' : 'low';
  return { impact, likelihood, score, severity };
}

// --- controls --------------------------------------------------------------

/**
 * What kind of verification a control admits. This is the honesty valve for
 * the whole module.
 *
 * - `automated` — ARC can decide it from its own records, deterministically.
 * - `deployment` — the answer depends on facts outside ARC's records (network
 *   routes, IAM policy, who holds a token). ARC can describe what to check and
 *   hold the answer, but cannot test it. It never reports `pass` on its own.
 * - `manual` — a judgement a human makes and attests to.
 *
 * A `deployment` or `manual` control whose attestation is missing or stale is
 * `not_assessable`, never `pass`. A dashboard that shows green for a control
 * nobody verified is worse than one that shows nothing, because somebody will
 * put it in front of an auditor.
 */
export type ControlAssuranceKind = 'automated' | 'deployment' | 'manual';

/** How often a control is expected to be re-evaluated. */
export type ControlFrequency = 'continuous' | 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'annual';

export interface ControlDefinition {
  /** Operator-facing control id, e.g. `ARC-AI-001`. Stable: cited in reports and mappings. */
  readonly id: string;
  readonly version: number;
  readonly title: string;
  /** The assurance the control provides, in one sentence an auditor can read. */
  readonly objective: string;
  /**
   * What exactly is checked, in prose. For an automated control this describes
   * the implemented assertion; for the others it is the instruction to the
   * human or deployment reviewer.
   */
  readonly procedure: string;
  readonly assurance: ControlAssuranceKind;
  readonly frequency: ControlFrequency;
  readonly enabled: boolean;
  /** Risk category the control addresses. */
  readonly category: string;
  /** Severity of a failure of this control, used to rank findings. */
  readonly failureSeverity: FindingSeverity;
  /**
   * What the control cannot tell you. Recorded on the definition so it travels
   * with every result and every export, rather than living in a doc nobody
   * reads next to the green tick.
   */
  readonly limitations: readonly string[];
  readonly owner?: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * The outcome of evaluating one control once.
 *
 * `not_assessable` is a first-class result, not an error. It means the
 * question was asked and could not be answered, which is a materially
 * different statement from both "yes" and "no" and must survive into reports
 * as its own category.
 */
export type ControlStatus = 'pass' | 'fail' | 'not_assessable' | 'not_applicable' | 'attested';

export const CONTROL_STATUSES: readonly ControlStatus[] = [
  'pass',
  'fail',
  'not_assessable',
  'not_applicable',
  'attested',
] as const;

/** A single thing the evaluator looked at, and what it concluded about it. */
export interface ControlObservation {
  /** The object examined: an agent id, tool name, policy id, evidence id, audit sequence. */
  readonly subject: string;
  readonly subjectKind: 'agent' | 'tool' | 'policy' | 'action' | 'evidence' | 'approval' | 'audit' | 'connector' | 'system';
  readonly ok: boolean;
  /** Why. Shown verbatim in the console and the export. */
  readonly detail: string;
  /** Identifiers of the records this observation rests on, for the evidence explorer. */
  readonly evidenceIds?: readonly string[];
}

/**
 * The window a result covers.
 *
 * Mandatory on every assessment, because "87% of controls passing" means
 * nothing without it, and a report that omits it invites the reader to assume
 * "always". An assessment over an empty window says so rather than passing.
 */
export interface AssessmentWindow {
  readonly from: string;
  readonly to: string;
  /** Count of enforcement records in the window, so a reader can see how thin the basis is. */
  readonly actionsConsidered: number;
  readonly evidenceConsidered: number;
}

export interface HumanAttestation {
  readonly id: string;
  /** The control attested. On the record itself so an exported attestation stands alone. */
  readonly controlId: string;
  readonly attestedBy: string;
  readonly attestedAt: string;
  readonly statement: string;
  /** When the attestation goes stale and the control reverts to not_assessable. */
  readonly expiresAt: string;
  /** Optional reference to an out-of-band artefact: a ticket, a report, a scan. */
  readonly reference?: string;
}

export interface ControlAssessment {
  /** Opaque identifier, `arc_asm_...`. */
  readonly id: string;
  readonly schemaVersion: 2;
  readonly runId: string;
  readonly controlId: string;
  readonly controlVersion: number;
  readonly organizationId: string;
  readonly status: ControlStatus;
  /** How this result was reached. Mirrors the definition, recorded again so the result stands alone. */
  readonly assurance: ControlAssuranceKind;
  /** One-sentence result an operator reads first. */
  readonly summary: string;
  readonly observations: readonly ControlObservation[];
  readonly window: AssessmentWindow;
  /** Present when the status came from a human rather than a check. */
  readonly attestation?: HumanAttestation;
  /** Carried from the definition so an exported result keeps its caveats. */
  readonly limitations: readonly string[];
  /** Findings opened by this assessment. */
  readonly findingIds: readonly string[];
  readonly evaluatedAt: string;
  readonly evaluationMs: number;
  /** Digest over this record's content, so an exported assessment can be checked. */
  readonly integrityDigest: string;
}

/** A batch evaluation of many controls at one moment. */
export interface AssessmentRun {
  readonly id: string;
  readonly organizationId: string;
  /** Who asked for the run: an operator identifier, or `schedule`. */
  readonly requestedBy: string;
  readonly window: AssessmentWindow;
  /** Control ids in the run, in evaluation order. */
  readonly controlIds: readonly string[];
  readonly assessmentIds: readonly string[];
  readonly totals: Readonly<Record<ControlStatus, number>>;
  readonly startedAt: string;
  readonly finishedAt: string;
  /** The audit head at the moment of the run, so the run can be tied to a chain position. */
  readonly auditHead?: { readonly sequence: number; readonly digest: string };
}

// --- findings --------------------------------------------------------------

export type FindingSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';

export const FINDING_SEVERITY_ORDER: readonly FindingSeverity[] = ['critical', 'high', 'medium', 'low', 'info'] as const;

export type FindingStatus = 'open' | 'in_progress' | 'resolved' | 'accepted' | 'false_positive';

export interface Finding {
  readonly id: string;
  readonly organizationId: string;
  /** Control whose failure raised this. */
  readonly controlId: string;
  /** Assessment that first raised it. */
  readonly assessmentId: string;
  readonly severity: FindingSeverity;
  readonly status: FindingStatus;
  readonly title: string;
  readonly detail: string;
  /** The object at fault, e.g. an agent id or tool name. */
  readonly subject: string;
  readonly subjectKind: ControlObservation['subjectKind'];
  readonly owner?: string;
  readonly dueAt?: string;
  readonly evidenceIds: readonly string[];
  /** Set when status is resolved, accepted or false_positive. */
  readonly resolution?: {
    readonly by: string;
    readonly at: string;
    readonly note: string;
  };
  /** Times this finding has been re-raised by a later assessment. */
  readonly occurrences: number;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

// --- framework mappings ----------------------------------------------------

export type FrameworkId = 'nist-ai-rmf' | 'nist-ai-600-1' | 'iso-42001' | 'eu-ai-act';

/**
 * Whether a mapping has actually been looked at by a person.
 *
 * `proposed` mappings are drafts. They render differently and are excluded
 * from coverage totals, because a framework table full of unreviewed guesses
 * is exactly the artefact that gets screenshotted into a customer deck.
 */
export type MappingReviewState = 'proposed' | 'reviewed';

export interface FrameworkMapping {
  readonly framework: FrameworkId;
  /** Subcategory or clause reference, e.g. `GOVERN 1.1`, `MEASURE 2.7`. */
  readonly reference: string;
  readonly title: string;
  /** Control ids that contribute evidence toward this reference. */
  readonly controlIds: readonly string[];
  readonly review: MappingReviewState;
  readonly reviewedBy?: string;
  readonly reviewedAt?: string;
  /** What ARC's controls do and do not evidence for this reference. Required. */
  readonly note: string;
}

export interface FrameworkDefinition {
  readonly id: FrameworkId;
  readonly name: string;
  readonly publisher: string;
  /** Edition or version this mapping was made against. */
  readonly edition: string;
  /** Plain statement of what a mapping is and is not. Rendered above every framework view. */
  readonly disclaimer: string;
  readonly mappings: readonly FrameworkMapping[];
}

// --- coverage --------------------------------------------------------------

/**
 * Where governance is absent. This is the most commercially useful read in the
 * module: not "are the controls passing" but "what is not covered at all",
 * which is the question that loses deals when it cannot be answered.
 */
export interface CoverageReport {
  readonly organizationId: string;
  readonly window: AssessmentWindow;
  /** Agents with no owner, no business purpose or no governance record. */
  readonly ungovernedAgents: readonly { readonly id: string; readonly name: string; readonly missing: readonly string[] }[];
  /** High-impact tools no enabled policy selects. */
  readonly uncoveredTools: readonly { readonly name: string; readonly riskTier: string; readonly effect: string }[];
  /** Agents no enabled policy selects. */
  readonly uncoveredAgents: readonly { readonly id: string; readonly name: string }[];
  /** Controls that have never been assessed, or whose last assessment is older than their frequency allows. */
  readonly staleControls: readonly { readonly controlId: string; readonly lastAssessedAt?: string; readonly frequency: ControlFrequency }[];
  /** Actions in the window with no evidence record. Should always be empty; non-empty is a serious defect. */
  readonly actionsMissingEvidence: readonly string[];
  readonly totals: {
    readonly agents: number;
    readonly tools: number;
    readonly policies: number;
    readonly controls: number;
    readonly controlsAssessed: number;
  };
  readonly generatedAt: string;
}
