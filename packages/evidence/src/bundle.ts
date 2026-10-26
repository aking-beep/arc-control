/**
 * Evidence bundles: the artefact an auditor is handed.
 *
 * The design problem is that the obvious shape does not work. A signed PDF
 * report from the system under audit proves only that the system under audit
 * says so. So a bundle carries the **primary records** — the evidence, the
 * approvals, the policy documents, the control results, the audit slice — each
 * with the digest it is expected to hash to, and a verifier recomputes every
 * one from the bundle's own bytes. Nothing in verification contacts ARC.
 *
 * What that establishes, stated plainly because the bundle states it too:
 * recomputation proves the records have not been altered **since export**. It
 * does not prove ARC recorded them faithfully in the first place. Closing that
 * gap needs the audit head recorded somewhere ARC does not control, which is
 * why `anchor` exists and why its absence is reported as a limitation rather
 * than passed over.
 *
 * One structural consequence worth knowing: a bundle contains a *slice* of the
 * audit chain, not the chain from genesis, because exporting the whole log for
 * a one-week window would be absurd. A slice cannot be checked against the
 * genesis constant, so `verifyBundle` checks linkage *within* the slice and
 * reports that it is a slice. If the slice happens to begin at sequence 1 the
 * genesis check is performed as well.
 */
import {
  AUDIT_GENESIS_DIGEST,
  digest,
  newId,
  type AssessmentRun,
  type AssessmentWindow,
  type AuditRecord,
  type BundleAnchor,
  type BundleEntry,
  type BundleProblem,
  type BundleScope,
  type BundleVerification,
  type ChainVerification,
  type ControlAssessment,
  type EvidenceBundle,
  type EvidenceRecord,
} from '@arc-control/schemas';
import { computeAuditDigest, type ControlStore } from '@arc-control/store';
import { verifyEvidence } from './builder.js';

/** Digest of a record as it appears in the bundle. */
function entryOf<T>(id: string, record: T): BundleEntry<T> {
  return { id, digest: digest(record), record };
}

/** Digest over every entry digest, sorted, so entry order cannot change it. */
function contentDigestOf(bundle: Omit<EvidenceBundle, 'manifest'>): string {
  const digests = [
    ...bundle.controls,
    ...bundle.assessments,
    ...bundle.runs,
    ...bundle.findings,
    ...bundle.evidence,
    ...bundle.approvals,
    ...bundle.policies,
    ...bundle.audit,
  ]
    .map((entry) => entry.digest)
    .sort();

  return digest(digests);
}

export interface BuildBundleOptions {
  readonly store: ControlStore;
  readonly scope: BundleScope;
  readonly exportedBy: string;
  readonly organizationId?: string;
  readonly producedBy: string;
  readonly from?: Date;
  readonly to?: Date;
  /** An externally recorded audit head, if the operator has one. */
  readonly anchor?: BundleAnchor;
  readonly now?: () => Date;
}

const LIMITATIONS: readonly string[] = [
  'Recomputing the digests in this bundle proves the records have not been altered since export. It does not prove ARC Control recorded them faithfully at the time.',
  'The audit records here are a slice of the chain, not the whole log. Linkage is checked within the slice; a slice cannot by itself rule out that records were removed from either end.',
  'Approver identity in this release comes from a configured console header rather than an authenticated user, so an approval record establishes that the workflow ran, not who ran it.',
  'Control results marked not_assessable or attested were not proven by ARC Control. Read their summaries rather than counting statuses.',
];

/**
 * Assembles a bundle.
 *
 * Scope decides what goes in, but the window always bounds it: a bundle
 * without a stated window is uninterpretable, and "everything" is not a
 * window.
 */
export async function buildBundle(options: BuildBundleOptions): Promise<EvidenceBundle> {
  const now = (options.now ?? (() => new Date()))();
  const to = options.to ?? now;
  const from = options.from ?? new Date(to.getTime() - 30 * 86_400_000);
  const organizationId = options.organizationId ?? 'default';

  const [allEvidence, allApprovals, allAudit, allControls, allAssessments, allRuns, allFindings, allPolicies] =
    await Promise.all([
      options.store.evidence.list(),
      options.store.approvals.list(),
      options.store.audit.read({ limit: Number.MAX_SAFE_INTEGER }),
      options.store.controls.list(),
      options.store.assessments.list(),
      options.store.assessmentRuns.list(),
      options.store.findings.list(),
      options.store.policies.list(),
    ]);

  const inWindow = (timestamp: string): boolean => {
    const at = Date.parse(timestamp);
    return at >= from.getTime() && at <= to.getTime();
  };

  // Work out the evidence and assessments in scope first; everything else is
  // pulled in because something in scope refers to it.
  let evidence: readonly EvidenceRecord[];
  let assessments: readonly ControlAssessment[];
  let runs: readonly AssessmentRun[];

  /** Evidence ids an assessment's observations point at. */
  const citedBy = (selected: readonly ControlAssessment[]): ReadonlySet<string> =>
    new Set(selected.flatMap((assessment) => assessment.observations.flatMap((o) => o.evidenceIds ?? [])));

  const scope = options.scope;
  switch (scope.kind) {
    case 'run': {
      const run = allRuns.find((candidate) => candidate.id === scope.runId);
      runs = run ? [run] : [];
      assessments = allAssessments.filter((assessment) => assessment.runId === scope.runId);
      const cited = citedBy(assessments);
      evidence = allEvidence.filter((record) => cited.has(record.id));
      break;
    }
    case 'control': {
      assessments = allAssessments.filter(
        (assessment) => assessment.controlId === scope.controlId && inWindow(assessment.evaluatedAt),
      );
      const runIds = new Set(assessments.map((assessment) => assessment.runId));
      runs = allRuns.filter((run) => runIds.has(run.id));
      const cited = citedBy(assessments);
      evidence = allEvidence.filter((record) => cited.has(record.id));
      break;
    }
    case 'evidence': {
      const wanted = new Set(scope.evidenceIds);
      evidence = allEvidence.filter((record) => wanted.has(record.id));
      assessments = [];
      runs = [];
      break;
    }
    case 'window': {
      evidence = allEvidence.filter((record) => inWindow(record.createdAt));
      assessments = allAssessments.filter((assessment) => inWindow(assessment.evaluatedAt));
      const runIds = new Set(assessments.map((assessment) => assessment.runId));
      runs = allRuns.filter((run) => runIds.has(run.id));
      break;
    }
  }

  // Pull in everything the in-scope records refer to, so the bundle is
  // self-contained: a reference a reader cannot follow is not evidence.
  const controlIds = new Set(assessments.map((assessment) => assessment.controlId));
  const controls = allControls.filter((control) => controlIds.has(control.id));

  const findingIds = new Set(assessments.flatMap((assessment) => assessment.findingIds));
  const findings = allFindings.filter((finding) => findingIds.has(finding.id) || controlIds.has(finding.controlId));

  const approvalIds = new Set(evidence.map((record) => record.approval?.id).filter((id): id is string => !!id));
  const approvals = allApprovals.filter((approval) => approvalIds.has(approval.id));

  const policyIds = new Set(evidence.map((record) => record.decision.policyId).filter((id): id is string => !!id));
  const policies = allPolicies.filter((policy) => policyIds.has(policy.id));

  const audit = allAudit.filter((record) => inWindow(record.occurredAt));

  const body: Omit<EvidenceBundle, 'manifest'> = {
    controls: controls.map((control) => entryOf(control.id, control)),
    assessments: assessments.map((assessment) => entryOf(assessment.id, assessment)),
    runs: runs.map((run) => entryOf(run.id, run)),
    findings: findings.map((finding) => entryOf(finding.id, finding)),
    evidence: evidence.map((record) => entryOf(record.id, record)),
    approvals: approvals.map((approval) => entryOf(approval.id, approval)),
    policies: policies.map((policy) => entryOf(`${policy.id}@${policy.version}`, policy)),
    audit: audit.map((record) => entryOf(record.id, record)),
    ...(options.anchor ? { anchor: options.anchor } : {}),
    limitations: LIMITATIONS,
  };

  const window: AssessmentWindow = {
    from: from.toISOString(),
    to: to.toISOString(),
    actionsConsidered: evidence.length,
    evidenceConsidered: evidence.length,
  };

  const chainAtExport = verifyChainSlice(audit, options.anchor);

  return {
    manifest: {
      id: newId('bundle'),
      schemaVersion: 2,
      producedBy: options.producedBy,
      organizationId,
      scope: options.scope,
      window,
      exportedAt: now.toISOString(),
      exportedBy: options.exportedBy,
      counts: {
        controls: body.controls.length,
        assessments: body.assessments.length,
        runs: body.runs.length,
        findings: body.findings.length,
        evidence: body.evidence.length,
        approvals: body.approvals.length,
        policies: body.policies.length,
        audit: body.audit.length,
      },
      contentDigest: contentDigestOf(body),
    },
    ...body,
    chainAtExport,
  };
}

/**
 * Verifies a contiguous slice of the audit chain.
 *
 * Differs from the store's `verifyChain` in exactly one way, and it matters:
 * it does not require the first record to link to the genesis constant,
 * because a windowed export legitimately starts partway along. Linkage,
 * sequence contiguity and every record digest are checked as normal, and the
 * genesis check is applied only when the slice really does start at sequence 1.
 */
export function verifyChainSlice(records: readonly AuditRecord[], anchor?: BundleAnchor): ChainVerification {
  const failures: ChainVerification['failures'][number][] = [];
  let previous: AuditRecord | undefined;

  for (const record of records) {
    if (computeAuditDigest(record) !== record.digest) {
      failures.push({
        sequence: record.sequence,
        id: record.id,
        problem: 'digest_mismatch',
        detail: 'record content does not match its stored digest',
      });
    }

    if (previous) {
      if (record.sequence !== previous.sequence + 1) {
        failures.push({
          sequence: record.sequence,
          id: record.id,
          problem: 'sequence_gap',
          detail: `sequence jumps from ${previous.sequence} to ${record.sequence}`,
        });
      }
      if (record.previousDigest !== previous.digest) {
        failures.push({
          sequence: record.sequence,
          id: record.id,
          problem: 'broken_link',
          detail: `previousDigest does not match the digest of record ${previous.sequence}`,
        });
      }
    } else if (record.sequence === 1 && record.previousDigest !== AUDIT_GENESIS_DIGEST) {
      failures.push({
        sequence: record.sequence,
        id: record.id,
        problem: 'broken_link',
        detail: 'the first record of the chain does not link to the genesis digest',
      });
    }

    previous = record;
  }

  const head = records.at(-1);

  if (anchor && head && head.digest !== anchor.headDigest && head.sequence === anchor.headSequence) {
    failures.push({
      sequence: head.sequence,
      id: head.id,
      problem: 'head_mismatch',
      detail: `the slice head digest is ${head.digest} but the anchor recorded ${anchor.headDigest} at the same sequence`,
    });
  }

  return {
    valid: failures.length === 0,
    recordsChecked: records.length,
    failures,
    ...(head ? { headDigest: head.digest, headSequence: head.sequence } : {}),
    checkedAgainstExpectation: anchor !== undefined,
  };
}

/**
 * Verifies a bundle from its own bytes.
 *
 * Takes no store, makes no request and trusts nothing in the bundle except
 * the records themselves. `failures` means something is wrong;
 * `limitations` means the bundle is intact but proves less than a reader might
 * assume. Keeping those apart is the point — telling someone their evidence
 * was tampered with when in fact it merely lacks an external anchor would
 * destroy their trust in the tool that told them.
 */
export function verifyBundle(bundle: EvidenceBundle, now: Date = new Date()): BundleVerification {
  const failures: { problem: BundleProblem; subject: string; detail: string }[] = [];
  const limitations: { problem: BundleProblem; detail: string }[] = [];

  if (bundle.manifest.schemaVersion !== 2) {
    return {
      valid: false,
      entriesChecked: 0,
      failures: [
        {
          problem: 'schema_unsupported',
          subject: String(bundle.manifest.id),
          detail: `bundle schema version ${String(bundle.manifest.schemaVersion)} is not supported by this verifier`,
        },
      ],
      limitations: [],
      verifiedAt: now.toISOString(),
    };
  }

  const groups: readonly (readonly [string, readonly BundleEntry<unknown>[]])[] = [
    ['control', bundle.controls],
    ['assessment', bundle.assessments],
    ['run', bundle.runs],
    ['finding', bundle.findings],
    ['evidence', bundle.evidence],
    ['approval', bundle.approvals],
    ['policy', bundle.policies],
    ['audit', bundle.audit],
  ];

  let entriesChecked = 0;

  for (const [kind, entries] of groups) {
    for (const entry of entries) {
      entriesChecked += 1;
      if (digest(entry.record) !== entry.digest) {
        failures.push({
          problem: 'entry_digest_mismatch',
          subject: `${kind} ${entry.id}`,
          detail: 'the record does not hash to the digest recorded for it in the bundle',
        });
      }
    }
  }

  // Evidence and assessments carry their own self-digest as well, computed
  // when ARC wrote them rather than when the bundle was built. Checking both
  // catches a record altered before export, which the bundle digest alone
  // would not: that was computed from whatever was in the record at export.
  for (const entry of bundle.evidence) {
    if (!verifyEvidence(entry.record)) {
      failures.push({
        problem: 'entry_digest_mismatch',
        subject: `evidence ${entry.id}`,
        detail: 'the record does not match the integrity digest ARC Control stored with it',
      });
    }
  }

  for (const entry of bundle.assessments) {
    const { integrityDigest, ...content } = entry.record;
    if (digest(content) !== integrityDigest) {
      failures.push({
        problem: 'entry_digest_mismatch',
        subject: `assessment ${entry.id}`,
        detail: 'the assessment does not match the integrity digest ARC Control stored with it',
      });
    }
  }

  const recomputedContent = contentDigestOf(bundle);
  if (recomputedContent !== bundle.manifest.contentDigest) {
    failures.push({
      problem: 'content_digest_mismatch',
      subject: bundle.manifest.id,
      detail: `the manifest records ${bundle.manifest.contentDigest} but the entries hash to ${recomputedContent}; records have been added or removed`,
    });
  }

  // References must resolve inside the bundle, or it is not self-contained.
  const controlIds = new Set(bundle.controls.map((entry) => entry.record.id));
  const findingIds = new Set(bundle.findings.map((entry) => entry.record.id));

  for (const entry of bundle.assessments) {
    if (!controlIds.has(entry.record.controlId)) {
      failures.push({
        problem: 'reference_missing',
        subject: `assessment ${entry.id}`,
        detail: `cites control ${entry.record.controlId}, which is not in the bundle`,
      });
    }
    for (const findingId of entry.record.findingIds) {
      if (!findingIds.has(findingId)) {
        failures.push({
          problem: 'reference_missing',
          subject: `assessment ${entry.id}`,
          detail: `cites finding ${findingId}, which is not in the bundle`,
        });
      }
    }
  }

  const chain = verifyChainSlice(
    bundle.audit.map((entry) => entry.record),
    bundle.anchor,
  );

  if (!chain.valid) {
    for (const failure of chain.failures) {
      failures.push({
        problem: 'chain_broken',
        subject: `audit ${failure.sequence}`,
        detail: `${failure.problem}: ${failure.detail}`,
      });
    }
  }

  if (!bundle.anchor) {
    limitations.push({
      problem: 'chain_unanchored',
      detail:
        'No externally recorded audit head accompanies this bundle, so it cannot rule out that records were removed from the end of the log before export. The remaining records are internally consistent.',
    });
  }

  const firstAudit = bundle.audit[0]?.record;
  if (firstAudit && firstAudit.sequence !== 1 && !bundle.anchor) {
    limitations.push({
      problem: 'chain_unanchored',
      detail: `The audit slice begins at sequence ${firstAudit.sequence} rather than at the start of the chain, so earlier records are outside what this bundle evidences.`,
    });
  }

  if (entriesChecked === 0) {
    limitations.push({
      problem: 'empty_window',
      detail: 'The bundle contains no records. An empty bundle evidences nothing; check the window and scope.',
    });
  }

  return {
    valid: failures.length === 0,
    entriesChecked,
    failures,
    limitations,
    chain,
    verifiedAt: now.toISOString(),
  };
}
