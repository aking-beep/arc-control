/**
 * Framework mappings.
 *
 * A mapping says: "evidence from these ARC controls is relevant to this
 * framework reference." It does not say the reference is satisfied, and it
 * certainly does not say the customer is compliant. Those are conclusions only
 * the customer's own assessor can reach, and a product that blurs the line
 * sells a compliance claim it cannot stand behind.
 *
 * Two deliberate decisions:
 *
 *  1. **Every mapping ships as `proposed`, not `reviewed`.** ARC's engineering
 *     team can draft a mapping; only someone accountable for the customer's
 *     compliance programme can accept one. Marking them reviewed at the
 *     factory would be asserting a review that never happened — and the
 *     resulting table is precisely the artefact that gets screenshotted into a
 *     board pack. An operator promotes a mapping to `reviewed` when they have
 *     actually checked it, and the console shows the two states differently.
 *
 *  2. **Coverage counts only reviewed mappings.** An unreviewed draft
 *     contributes nothing to a coverage figure, so the number starts at zero
 *     and rises as real review happens, rather than starting at 100% because
 *     we shipped a table.
 *
 * The subcategory references below are drafted against NIST AI RMF 1.0
 * (January 2023). Titles are abbreviated for display; a reviewer should check
 * each one against the published framework text rather than relying on the
 * paraphrase here. That instruction is part of the data, not a footnote.
 */
import type { ControlAssessment, FrameworkDefinition, FrameworkId, FrameworkMapping } from '@arc-control/schemas';

const NIST_AI_RMF: FrameworkDefinition = {
  id: 'nist-ai-rmf',
  name: 'NIST AI Risk Management Framework',
  publisher: 'National Institute of Standards and Technology',
  edition: 'AI RMF 1.0 (NIST AI 100-1, January 2023)',
  disclaimer:
    'These mappings indicate which ARC Control evidence is relevant to a framework reference. They are not an assessment, not a certification, and not a statement that the reference is satisfied. The AI RMF is voluntary guidance, not a control standard with pass criteria; any conclusion about conformity is the organization’s own to reach. References are abbreviated for display and should be checked against the published framework text.',
  mappings: [
    {
      framework: 'nist-ai-rmf',
      reference: 'GOVERN 1.3',
      title: 'Risk management activities are scaled to the organization’s risk tolerance',
      controlIds: ['ARC-AI-002', 'ARC-AI-008'],
      review: 'proposed',
      note: 'ARC evidences that high-impact tools are deliberately governed and that agent permissions are periodically reviewed. It does not evidence that the organization has set a risk tolerance, nor that the scaling matches it.',
    },
    {
      framework: 'nist-ai-rmf',
      reference: 'GOVERN 1.5',
      title: 'Ongoing monitoring and periodic review, with defined roles and review frequency',
      controlIds: ['ARC-AI-008'],
      review: 'proposed',
      note: 'ARC records review cadence per agent and reports overdue reviews. The adequacy of the cadence, and whether reviewers are competent, are outside what ARC can evidence.',
    },
    {
      framework: 'nist-ai-rmf',
      reference: 'GOVERN 2.1',
      title: 'Roles, responsibilities and accountability are documented',
      controlIds: ['ARC-AI-001'],
      review: 'proposed',
      note: 'ARC evidences a named accountable owner per agent. It cannot evidence that the named person accepts the accountability or is still in post.',
    },
    {
      framework: 'nist-ai-rmf',
      reference: 'GOVERN 3.2',
      title: 'Human oversight roles for AI systems are defined and differentiated',
      controlIds: ['ARC-AI-004'],
      review: 'proposed',
      note: 'ARC evidences that policy-required human approvals occurred before execution, with separation of duties where demanded. In this release approver identity is a configured header rather than an authenticated user, which materially limits what the evidence establishes about *who* exercised oversight.',
    },
    {
      framework: 'nist-ai-rmf',
      reference: 'GOVERN 4.3',
      title: 'Practices for reporting and documenting AI risks are in place',
      controlIds: ['ARC-AI-005', 'ARC-AI-006'],
      review: 'proposed',
      note: 'ARC evidences that attempts and refusals are recorded and that the record is tamper-evident. ARC-AI-006 does not pass without an externally anchored audit head.',
    },
    {
      framework: 'nist-ai-rmf',
      reference: 'GOVERN 6.1',
      title: 'Policies address risks from third-party software and data',
      controlIds: ['ARC-AI-007'],
      review: 'proposed',
      note: 'ARC evidences that MCP tool manifests are pinned so upstream change is detectable. It does not assess the third party itself, and vendor assessment is not implemented in this release.',
    },
    {
      framework: 'nist-ai-rmf',
      reference: 'MAP 1.1',
      title: 'Intended purpose and context of use are understood and documented',
      controlIds: ['ARC-AI-001'],
      review: 'proposed',
      note: 'ARC stores a stated business purpose and criticality per agent. The text is free-form and ARC cannot judge its accuracy or currency.',
    },
    {
      framework: 'nist-ai-rmf',
      reference: 'MAP 2.1',
      title: 'The tasks the system supports are defined',
      controlIds: ['ARC-AI-001', 'ARC-AI-002'],
      review: 'proposed',
      note: 'The tool registry and the policies selecting it together document what an agent is permitted to attempt, which is a narrower and more reliable statement than what it is intended to do.',
    },
    {
      framework: 'nist-ai-rmf',
      reference: 'MAP 4.1',
      title: 'Risks of third-party components are mapped',
      controlIds: ['ARC-AI-007', 'ARC-AI-009'],
      review: 'proposed',
      note: 'Manifest pinning covers MCP components. ARC-AI-009 covers whether a governed system is reachable outside ARC, and it is attestation-based: ARC cannot test it.',
    },
    {
      framework: 'nist-ai-rmf',
      reference: 'MEASURE 1.1',
      title: 'Approaches and metrics for measuring AI risk are selected',
      controlIds: ['ARC-AI-002', 'ARC-AI-003', 'ARC-AI-004', 'ARC-AI-005'],
      review: 'proposed',
      note: 'The control library is itself the selected approach for the authorization and evidence risks. It deliberately does not address model-level risks such as accuracy, bias or drift, which ARC does not observe.',
    },
    {
      framework: 'nist-ai-rmf',
      reference: 'MEASURE 2.7',
      title: 'Security and resilience are evaluated and documented',
      controlIds: ['ARC-AI-003', 'ARC-AI-006', 'ARC-AI-007', 'ARC-AI-009'],
      review: 'proposed',
      note: 'Covers enforcement, log integrity, supply-chain drift detection and bypass prevention. It is not a penetration test and makes no statement about resilience under load or attack.',
    },
    {
      framework: 'nist-ai-rmf',
      reference: 'MEASURE 2.8',
      title: 'Transparency and accountability risks are examined',
      controlIds: ['ARC-AI-005', 'ARC-AI-006'],
      review: 'proposed',
      note: 'Every decision carries a rule-by-rule trace and an evidence record, and the record is exportable and independently checkable. The limits of tamper-evidence are stated on the control rather than omitted.',
    },
    {
      framework: 'nist-ai-rmf',
      reference: 'MEASURE 3.1',
      title: 'Mechanisms exist to determine whether assurance criteria are met',
      controlIds: ['ARC-AI-001', 'ARC-AI-002', 'ARC-AI-003', 'ARC-AI-004', 'ARC-AI-005', 'ARC-AI-006', 'ARC-AI-007', 'ARC-AI-008'],
      review: 'proposed',
      note: 'The assessment runner is this mechanism. Its honest limit is recorded in the results themselves: a control ARC cannot decide reports not assessable rather than passing.',
    },
    {
      framework: 'nist-ai-rmf',
      reference: 'MANAGE 1.2',
      title: 'Treatment of documented risks is prioritized by impact and likelihood',
      controlIds: [],
      review: 'proposed',
      note: 'Addressed by the risk register rather than by a control: risks carry inherent and reviewed-residual ratings, a treatment decision and an owner. No ARC control evidences this, and the mapping says so rather than borrowing a control that does not fit.',
    },
    {
      framework: 'nist-ai-rmf',
      reference: 'MANAGE 2.2',
      title: 'Mechanisms sustain the value of deployed systems',
      controlIds: ['ARC-AI-008'],
      review: 'proposed',
      note: 'Periodic permission review is the only part of this ARC speaks to. Most of the reference is about model value and performance, which ARC does not observe.',
    },
    {
      framework: 'nist-ai-rmf',
      reference: 'MANAGE 2.4',
      title: 'Mechanisms exist to deactivate systems behaving inconsistently with intended use',
      controlIds: ['ARC-AI-003'],
      review: 'proposed',
      note: 'ARC provides agent suspension, tool and connector disablement and retirement, each audited. The in-flight limitation is documented: disabling stops new actions and does not recall one already executing.',
    },
    {
      framework: 'nist-ai-rmf',
      reference: 'MANAGE 4.1',
      title: 'Post-deployment monitoring plans are implemented',
      controlIds: ['ARC-AI-003', 'ARC-AI-005'],
      review: 'proposed',
      note: 'Continuous evaluation over a stated window, with the window on every result. ARC monitors authorization and evidence, not model behaviour.',
    },
  ],
};

export const FRAMEWORKS: Readonly<Record<FrameworkId, FrameworkDefinition | undefined>> = {
  'nist-ai-rmf': NIST_AI_RMF,
  // Drafted in docs/roadmap, not shipped as data: publishing an unreviewed
  // mapping table for a framework with legal consequences invites someone to
  // rely on it. ISO/IEC 42001 and the EU AI Act are P1 in the 2.0 plan.
  'nist-ai-600-1': undefined,
  'iso-42001': undefined,
  'eu-ai-act': undefined,
};

export interface FrameworkCoverageRow {
  readonly mapping: FrameworkMapping;
  /** Latest status of each mapped control. */
  readonly controls: readonly { readonly controlId: string; readonly status?: string; readonly evaluatedAt?: string }[];
  /**
   * True only when the mapping is reviewed, names at least one control, and
   * every named control has a current passing or attested assessment.
   */
  readonly evidenced: boolean;
  /** Why the row is not evidenced, when it is not. */
  readonly gap?: string;
}

/**
 * Joins a framework's mappings to the latest control results.
 *
 * `evidenced` is intentionally hard to earn. A reviewed mapping whose controls
 * are `not_assessable` is not evidenced, because an unanswerable question is
 * not supporting evidence; and an unreviewed mapping is never evidenced
 * whatever its controls say.
 */
export function frameworkCoverage(
  framework: FrameworkDefinition,
  latest: readonly ControlAssessment[],
): readonly FrameworkCoverageRow[] {
  const byControl = new Map(latest.map((assessment) => [assessment.controlId, assessment]));

  return framework.mappings.map((mapping) => {
    const controls = mapping.controlIds.map((controlId) => {
      const assessment = byControl.get(controlId);
      return {
        controlId,
        ...(assessment ? { status: assessment.status, evaluatedAt: assessment.evaluatedAt } : {}),
      };
    });

    if (mapping.review !== 'reviewed') {
      return { mapping, controls, evidenced: false, gap: 'the mapping has not been reviewed' };
    }
    if (mapping.controlIds.length === 0) {
      return { mapping, controls, evidenced: false, gap: 'no ARC control is mapped to this reference' };
    }

    const unevidenced = controls.filter(
      (control) => control.status !== 'pass' && control.status !== 'attested' && control.status !== 'not_applicable',
    );

    if (unevidenced.length > 0) {
      return {
        mapping,
        controls,
        evidenced: false,
        gap: `${unevidenced.map((control) => `${control.controlId} is ${control.status ?? 'never assessed'}`).join(', ')}`,
      };
    }

    return { mapping, controls, evidenced: true };
  });
}
