/**
 * Evidence bundles — the artefact an auditor is actually given.
 *
 * The design constraint is that the bundle must be checkable by someone who
 * does not trust ARC Control. That rules out the obvious shape, which is a
 * report with a signature from the thing being audited. Instead a bundle
 * carries the primary records themselves, each with the digest it was stored
 * under, plus a manifest digest over all of them; a verifier recomputes every
 * digest from the bundle's own bytes and never calls the API.
 *
 * What that proves and does not prove is stated in the bundle, not in a doc:
 * recomputing the digests proves the records have not been altered *since
 * export*. It does not prove ARC recorded them faithfully in the first place.
 * Closing that gap needs the audit head anchored outside ARC, which is why
 * `anchor` is part of the model and why its absence is reported rather than
 * quietly tolerated.
 */
import type { AuditRecord, ChainVerification } from './audit.js';
import type { EvidenceRecord } from './evidence.js';
import type { Policy } from './policy.js';
import type { ApprovalRequest } from './approval.js';
import type { AssessmentRun, AssessmentWindow, ControlAssessment, ControlDefinition, Finding } from './governance.js';

/** One record in a bundle, with the digest it is expected to hash to. */
export interface BundleEntry<T> {
  readonly id: string;
  /** `sha256:...` over the canonical form of `record`. */
  readonly digest: string;
  readonly record: T;
}

export type BundleScope =
  /** Everything in the window. */
  | { readonly kind: 'window' }
  /** One assessment run and only what it rests on. */
  | { readonly kind: 'run'; readonly runId: string }
  /** One control across the window. */
  | { readonly kind: 'control'; readonly controlId: string }
  /** Named evidence records only. */
  | { readonly kind: 'evidence'; readonly evidenceIds: readonly string[] };

/**
 * An externally recorded audit head, if one was supplied at export time.
 *
 * Without it, a bundle is internally consistent but says nothing about
 * truncation: a bundle exported from a log with its tail removed verifies
 * perfectly. The verifier reports that as a limitation rather than a pass.
 */
export interface BundleAnchor {
  readonly headDigest: string;
  readonly headSequence: number;
  /** Where the operator says this head was recorded, e.g. `s3://audit-anchors/2026-10`. */
  readonly recordedAt: string;
  readonly recordedBy: string;
}

export interface EvidenceBundleManifest {
  readonly id: string;
  readonly schemaVersion: 2;
  /** ARC Control version that produced the bundle. */
  readonly producedBy: string;
  readonly organizationId: string;
  readonly scope: BundleScope;
  readonly window: AssessmentWindow;
  readonly exportedAt: string;
  readonly exportedBy: string;
  readonly counts: Readonly<Record<string, number>>;
  /** Digest over every entry digest in the bundle, in sorted order. */
  readonly contentDigest: string;
}

export interface EvidenceBundle {
  readonly manifest: EvidenceBundleManifest;
  readonly controls: readonly BundleEntry<ControlDefinition>[];
  readonly assessments: readonly BundleEntry<ControlAssessment>[];
  readonly runs: readonly BundleEntry<AssessmentRun>[];
  readonly findings: readonly BundleEntry<Finding>[];
  readonly evidence: readonly BundleEntry<EvidenceRecord>[];
  readonly approvals: readonly BundleEntry<ApprovalRequest>[];
  readonly policies: readonly BundleEntry<Policy>[];
  /** The audit records covering the window, so the chain can be walked offline. */
  readonly audit: readonly BundleEntry<AuditRecord>[];
  readonly anchor?: BundleAnchor;
  /** The chain verification as ARC saw it at export time. Advisory: the verifier redoes it. */
  readonly chainAtExport?: ChainVerification;
  /** Stated in the bundle so it travels with it. */
  readonly limitations: readonly string[];
}

export type BundleProblem =
  | 'entry_digest_mismatch'
  | 'content_digest_mismatch'
  | 'chain_broken'
  | 'chain_unanchored'
  | 'reference_missing'
  | 'empty_window'
  | 'schema_unsupported';

export interface BundleVerification {
  readonly valid: boolean;
  readonly entriesChecked: number;
  readonly failures: readonly {
    readonly problem: BundleProblem;
    readonly subject: string;
    readonly detail: string;
  }[];
  /**
   * Problems that do not invalidate the bundle but limit what it proves —
   * chiefly the absence of an external anchor. Separated from `failures`
   * because conflating "this was tampered with" and "this cannot rule out
   * truncation" helps nobody.
   */
  readonly limitations: readonly {
    readonly problem: BundleProblem;
    readonly detail: string;
  }[];
  readonly chain?: ChainVerification;
  readonly verifiedAt: string;
}
