/**
 * The ARC Control baseline control catalogue.
 *
 * Nine controls, each one a question an auditor or a buyer's security team
 * actually asks about an agent deployment. They are deliberately a small set:
 * nine controls that genuinely evaluate are worth more than sixty that mostly
 * report `not_assessable`, and a catalogue the customer can read in one
 * sitting is one they will argue with, which is the point.
 *
 * Every definition carries three things that normally go missing:
 *
 *  - `assurance` — whether ARC can decide this from its own records
 *    (`automated`), needs a fact about the deployment it cannot see
 *    (`deployment`), or needs a human judgement (`manual`).
 *  - `limitations` — what a pass does *not* tell you. These travel with every
 *    result and every export, so the caveat arrives attached to the green
 *    tick rather than in a document beside it.
 *  - `failureSeverity` — how bad a failure is, which is what ranks the
 *    findings queue.
 *
 * The catalogue is seeded into the store on first run and is then
 * customer-owned: an operator may disable a control or adjust its frequency,
 * and those edits survive upgrade. Changing a control's *procedure* bumps its
 * version, because a result is only interpretable against the procedure that
 * produced it.
 */
import type { ControlDefinition } from '@arc-control/schemas';

/** Catalogue revision. Bumped when a control's procedure or scope changes. */
export const CATALOGUE_VERSION = 1;

type Seed = Omit<ControlDefinition, 'createdAt' | 'updatedAt' | 'enabled' | 'version'>;

const SEEDS: readonly Seed[] = [
  {
    id: 'ARC-AI-001',
    title: 'Every registered agent has a recorded identity and owner',
    objective:
      'An agent acting on enterprise systems can be traced to a named accountable human and a stated business purpose.',
    procedure:
      'For every agent that is not retired, assert that it has an owner, and a governance record stating its business purpose and criticality. Agents in draft are included: an agent registered without an owner is a gap whether or not it has been cleared to act yet.',
    assurance: 'automated',
    frequency: 'continuous',
    category: 'governance',
    failureSeverity: 'high',
    limitations: [
      'Checks that an owner is recorded, not that the named person knows they own it or is still employed.',
      'A business purpose is free text. ARC cannot judge whether it is accurate or current.',
    ],
    labels: { pillar: 'identity' },
  },
  {
    id: 'ARC-AI-002',
    title: 'High-impact tools have explicit active policy coverage',
    objective:
      'No tool that moves money, destroys data or changes privilege is reachable without a policy that deliberately governs it.',
    procedure:
      'For every registered tool at risk tier high or critical, or declaring an irreversible effect, assert that at least one enabled policy selects it. A policy that matches everything by omitting selectors counts, and is reported as the reason, because a blanket policy is coverage but rarely the coverage anyone intended.',
    assurance: 'automated',
    frequency: 'continuous',
    category: 'authorization',
    failureSeverity: 'critical',
    limitations: [
      'Coverage is not correctness: a policy that matches the tool and allows everything satisfies this control.',
      'Risk tier and effect are declared by whoever registered the tool. A tool registered as low risk is assessed as low risk.',
    ],
    labels: { pillar: 'authorization' },
  },
  {
    id: 'ARC-AI-003',
    title: 'Actions without valid authorization are denied',
    objective: 'Nothing executed that policy did not permit.',
    procedure:
      'For every action in the window, assert that a decision exists, and that any execution was preceded by an ALLOW, or by an approval the policy itself demanded and which was recorded as approved. An execution with no decision, or against a DENY, is a control failure of the highest severity.',
    assurance: 'automated',
    frequency: 'continuous',
    category: 'authorization',
    failureSeverity: 'critical',
    limitations: [
      'Assesses actions that reached ARC. It cannot see an action that bypassed the gateway entirely — that is ARC-AI-009.',
    ],
    labels: { pillar: 'enforcement' },
  },
  {
    id: 'ARC-AI-004',
    title: 'Required human approvals occur before execution',
    objective:
      'Where policy demanded a human decision, a human actually made it, in time, and in sufficient number.',
    procedure:
      'For every action in the window whose decision was REQUIRE_APPROVAL and which executed, assert that an approval request exists, that it reached approved status, that the distinct approving votes met the required minimum, that every vote was cast before execution began, and that separation of duties was honoured where the rule demanded it.',
    assurance: 'automated',
    frequency: 'continuous',
    category: 'authorization',
    failureSeverity: 'critical',
    limitations: [
      'Whether an approval can be attributed to a named individual depends on how that operator was authenticated, which varies by deployment and can vary between two approvals in the same window. Each assessment therefore states the attribution of the votes it actually examined, rather than this catalogue asserting one answer for every installation.',
    ],
    labels: { pillar: 'enforcement' },
  },
  {
    id: 'ARC-AI-005',
    title: 'Relevant actions and denials leave audit evidence',
    objective: 'Every attempt, allowed or refused, is recoverable afterwards.',
    procedure:
      'For every action in the window, assert that an evidence record exists and that its recorded parameter digest matches the action as stored. Denials are included deliberately: a refused attempt is the more interesting security signal, and a system that only evidences successes cannot be used to investigate anything.',
    assurance: 'automated',
    frequency: 'continuous',
    category: 'evidence',
    failureSeverity: 'high',
    limitations: [
      'Checks that evidence exists and is internally consistent, not that it is complete in every field.',
    ],
    labels: { pillar: 'evidence' },
  },
  {
    id: 'ARC-AI-006',
    title: 'Audit-chain integrity is checked with its trust limitations disclosed',
    objective: 'The audit log has not been altered, and the limits of that statement are stated.',
    procedure:
      'Verify the hash chain end to end. A broken or edited chain fails. A chain that verifies against an externally recorded head passes. A chain that verifies only against itself is reported as not assessable, because walking the records cannot detect truncation: remove entries from the end and what remains is a shorter, perfectly valid chain.',
    assurance: 'automated',
    frequency: 'continuous',
    category: 'evidence',
    failureSeverity: 'critical',
    limitations: [
      'Without an externally anchored head this control cannot pass, and that is the intended behaviour rather than a defect. ARC verifying its own log against its own copy of the head proves nothing to a reader who does not trust ARC.',
      "The store's head marker file is defence against accidental truncation — a crash, a partial restore, a log rotation that dropped the tail. An attacker who can rewrite the log can usually rewrite that file too.",
    ],
    labels: { pillar: 'evidence' },
  },
  {
    id: 'ARC-AI-007',
    title: 'MCP tool manifests are reviewed and changes detected',
    objective:
      'A tool an agent can call does not silently change what it does, and a manifest that changed was looked at.',
    procedure:
      'For every tool executed by an MCP connector, assert that a manifest digest is pinned in its connector configuration, so a change in the upstream server is detectable rather than invisible. Reports not applicable when no MCP-backed tool is registered.',
    assurance: 'automated',
    frequency: 'daily',
    category: 'supply-chain',
    failureSeverity: 'high',
    limitations: [
      'A pinned digest makes drift detectable. It does not detect drift on its own — that needs a scan, which ARC performs on demand rather than on a schedule in this release.',
      'The scan reads what the server declares about itself. A server that lies about its own tool descriptions is not caught by reading them.',
    ],
    labels: { pillar: 'supply-chain' },
  },
  {
    id: 'ARC-AI-008',
    title: 'Agent and tool permissions receive periodic review',
    objective: 'Somebody has recently looked at what each agent is allowed to do and confirmed it is still right.',
    procedure:
      'For every active agent, assert that a permission review is recorded within the interval its governance record specifies, defaulting to 90 days where none is set. An agent with no review ever recorded fails: the absence of a review is an answerable question, not an unanswerable one.',
    assurance: 'automated',
    frequency: 'monthly',
    category: 'governance',
    failureSeverity: 'medium',
    limitations: [
      'Checks that a review was recorded, not that it was thorough. The reviewer’s note is stored verbatim and is the only evidence of depth.',
    ],
    labels: { pillar: 'identity' },
  },
  {
    id: 'ARC-AI-009',
    title: 'Protected connectors cannot be bypassed through other routes',
    objective:
      'The systems ARC governs are reachable by agents only through ARC, so a policy decision cannot be sidestepped.',
    procedure:
      'ARC cannot test this from inside itself: whether an agent can call Stripe directly depends on network routes, firewall rules and who holds which credential — facts outside ARC’s records. This control therefore requires a dated attestation from a named reviewer confirming that, for each governed system, no credential reachable by an agent permits direct access. Without a current attestation the control reports not assessable, never a pass.',
    assurance: 'deployment',
    frequency: 'quarterly',
    category: 'authorization',
    failureSeverity: 'critical',
    limitations: [
      'This is the control most likely to be wrong in practice and the one ARC can say least about. A product that reported it green from its own records would be lying.',
      'An attestation is a statement by a person at a point in time. It goes stale, and ARC reverts the control to not assessable when it does rather than carrying the old answer forward.',
    ],
    labels: { pillar: 'authorization' },
  },
];

/** The catalogue as storable definitions, stamped with a creation time. */
export function baselineControls(now: Date = new Date()): readonly ControlDefinition[] {
  const timestamp = now.toISOString();
  return SEEDS.map((seed) => ({
    ...seed,
    version: CATALOGUE_VERSION,
    enabled: true,
    createdAt: timestamp,
    updatedAt: timestamp,
  }));
}

export const BASELINE_CONTROL_IDS: readonly string[] = SEEDS.map((seed) => seed.id);

/** Days between permission reviews when an agent's governance record omits one. */
export const DEFAULT_REVIEW_INTERVAL_DAYS = 90;
