import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ArcControlClient } from '@arc-control/sdk-typescript';
import { createConsole } from './server.js';
import {
  accessPage,
  agentDetailPage,
  agentsPage,
  approvalDetailPage,
  approvalsPage,
  auditPage,
  confirmPage,
  errorPage,
  evidenceDetailPage,
  evidencePage,
  overviewPage,
  policiesPage,
  policyDetailPage,
  reportsPage,
  securityPage,
  toolsPage,
  type PageContext,
} from './pages.js';
import {
  activityPage,
  assessmentDetailPage,
  assessmentRunPage,
  assurancePage,
  controlDetailPage,
  findingDetailPage,
  findingsPage,
  frameworkPage,
  riskDetailPage,
  risksPage,
  settingsPage,
} from './assurance-pages.js';
import { cellScope } from './components.js';
import { actionHeadline, conditionToText, expiresIn, shortDigest, timestamp } from './format.js';
import { escapeHtml, html, NAVIGATION, raw } from './render.js';

/**
 * The console is a pure function of what the API returned, so these drive it
 * with a stub API rather than a live one. That buys two things a live server
 * cannot: the exact payloads a real deployment produces rarely — a broken
 * audit chain, a hostile tool description, an endpoint that is down — and a
 * test that cannot pass because a seed happened to be loaded.
 */

type Json = Record<string, unknown>;

/** A fetch that answers from a route table and records what was asked. */
function stubFetch(routes: Record<string, Json | { status: number; body: Json }>): {
  fetch: typeof globalThis.fetch;
  calls: string[];
} {
  const calls: string[] = [];

  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const key = `${init?.method ?? 'GET'} ${url.pathname}${url.search}`;
    calls.push(key);

    const match =
      routes[key] ??
      routes[`${url.pathname}${url.search}`] ??
      routes[`${init?.method ?? 'GET'} ${url.pathname}`] ??
      routes[url.pathname];

    if (match === undefined) {
      return new Response(JSON.stringify({ error: { code: 'not_found', message: `no stub for ${key}` } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }

    const { status, body } =
      'status' in match && typeof match.status === 'number'
        ? (match as { status: number; body: Json })
        : { status: 200, body: match as Json };

    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof globalThis.fetch;

  return { fetch, calls };
}

function contextFor(
  routes: Record<string, Json | { status: number; body: Json }>,
  query = '',
  overrides: { readonly operatorIdentity?: string; readonly operatorRoles?: readonly string[] } = {},
): { context: PageContext; calls: string[] } {
  const identity = overrides.operatorIdentity ?? 'operator@example.com';
  const roles = overrides.operatorRoles ?? ['finance-manager'];

  const { fetch, calls } = stubFetch(routes);
  const client = new ArcControlClient({
    baseUrl: 'http://api.test',
    operatorToken: 'token',
    operatorIdentity: identity,
    operatorRoles: [...roles],
    fetch,
  });

  return {
    context: {
      client,
      apiBase: 'http://api.test',
      operatorIdentity: identity,
      operatorRoles: [...roles],
      query: new URLSearchParams(query),
    },
    calls,
  };
}

// --- fixtures -------------------------------------------------------------

const HEALTH: Json = {
  status: 'ok',
  version: '2.0.0',
  operatorAuthConfigured: true,
  operatorAuth: { modes: ['claimed'], strongest: 'claimed', attributable: false },
  demoSeed: false,
  counts: { agents: 1, tools: 1, policies: 1, auditRecords: 4 },
  connectors: [{ name: 'simulation', healthy: true, detail: '1 simulated tool(s)' }],
};

const AGENT: Json = {
  id: 'arc_ag_1111',
  name: 'finance-agent',
  kind: 'autonomous',
  status: 'active',
  organizationId: 'org_default',
  environment: 'production',
  owner: 'finance-ops@example.com',
  description: 'Handles customer refund requests.',
  roles: ['finance'],
  declaredTools: ['stripe.refund'],
  labels: { tier: 'gold' },
  createdAt: '2026-10-20T05:00:00.000Z',
  updatedAt: '2026-10-20T05:00:00.000Z',
};

const TOOL: Json = {
  id: 'arc_tl_1111',
  name: 'stripe.refund',
  description: 'Refund a charge to the original payment method. Irreversible.',
  system: 'stripe',
  effect: 'irreversible',
  riskTier: 'critical',
  connector: 'simulation',
  connectorConfig: {},
  parameters: [
    { name: 'customer', type: 'string', required: true },
    { name: 'amount', type: 'number', required: true, minimum: 0 },
    { name: 'token', type: 'string', sensitive: true },
  ],
  labels: {},
  createdAt: '2026-10-20T05:00:00.000Z',
  updatedAt: '2026-10-20T05:00:00.000Z',
};

const POLICY: Json = {
  id: 'FINANCE-004',
  version: 1,
  name: 'Autonomous refund authority',
  description: 'Bounds how much a finance agent may refund without a human.',
  enabled: true,
  match: { tools: ['stripe.refund'] },
  rules: [
    {
      id: 'under-500',
      when: { lt: ['$.action.parameters.amount', 500] },
      effect: 'ALLOW',
      reason: 'within autonomous refund authority',
    },
    {
      id: 'needs-approval',
      when: { lte: ['$.action.parameters.amount', 2500] },
      effect: 'REQUIRE_APPROVAL',
      reason: 'above autonomous refund authority',
      approval: { approvers: ['role:finance-manager'], minApprovals: 1, requireSeparationOfDuties: true },
    },
  ],
  fallback: { effect: 'DENY', reason: 'no refund rule matched' },
  labels: { control: 'SOX-302' },
};

const APPROVAL: Json = {
  id: 'arc_apr_1111',
  actionId: 'arc_act_1111',
  decisionId: 'arc_dec_1111',
  agentId: 'arc_ag_1111',
  agentName: 'finance-agent',
  agentOwner: 'finance-ops@example.com',
  organizationId: 'org_default',
  tool: 'stripe.refund',
  parameters: { customer: 'cus_Q41887', amount: 1840 },
  policyId: 'FINANCE-004',
  ruleId: 'needs-approval',
  reason: 'above autonomous refund authority',
  requirement: { approvers: ['role:finance-manager'], minApprovals: 1, requireSeparationOfDuties: true },
  status: 'pending',
  votes: [],
  createdAt: '2026-10-20T05:00:00.000Z',
  expiresAt: '2099-10-20T06:00:00.000Z',
};

const EVIDENCE: Json = {
  id: 'arc_ev_1111',
  schemaVersion: 1,
  actionId: 'arc_act_1111',
  organizationId: 'org_default',
  environment: 'production',
  agent: { id: 'arc_ag_1111', name: 'finance-agent', owner: 'finance-ops@example.com', roles: ['finance'], credentialId: 'arc_cred_1' },
  tool: { name: 'stripe.refund', system: 'stripe', effect: 'irreversible', riskTier: 'critical', connector: 'simulation' },
  request: {
    parameters: { customer: 'cus_Q41887', amount: 1840 },
    parametersDigest: 'sha256:aaa',
    requestedAt: '2026-10-20T05:39:26.100Z',
  },
  decision: {
    id: 'arc_dec_1111',
    effect: 'REQUIRE_APPROVAL',
    policyId: 'FINANCE-004',
    policyVersion: 1,
    ruleId: 'needs-approval',
    reason: 'above autonomous refund authority',
    decidedAt: '2026-10-20T05:39:26.200Z',
    evaluationMs: 0.2,
    traceDigest: 'sha256:bbb',
  },
  outcome: 'pending_approval',
  obligations: [],
  createdAt: '2026-10-20T05:39:26.300Z',
  integrityDigest: 'sha256:ccc',
};

const AUDIT_RECORD: Json = {
  id: 'arc_aud_1111',
  sequence: 4,
  type: 'evidence.recorded',
  organizationId: 'org_default',
  occurredAt: '2026-10-20T05:39:26.400Z',
  actor: 'system',
  subject: 'arc_act_1111',
  summary: 'evidence arc_ev_1111 recorded for stripe.refund (pending_approval)',
  data: { evidenceId: 'arc_ev_1111', integrityDigest: 'sha256:ccc' },
  previousDigest: 'sha256:prev',
  digest: 'sha256:0123456789abcdef0123',
};

const CHAIN_OK: Json = {
  valid: true,
  recordsChecked: 4,
  failures: [],
  headDigest: 'sha256:0123456789abcdef0123',
  headSequence: 4,
  checkedAgainstExpectation: false,
};

/**
 * Two controls: one assessed and passing, one never assessed. The second is
 * the interesting case — it must render as unassessed rather than as benign.
 */
const CONTROL_ASSESSED: Json = {
  id: 'ARC-AI-001',
  version: 1,
  title: 'Every registered agent has a recorded identity and owner',
  objective: 'An agent can be traced to a named accountable human.',
  procedure: 'Assert every non-retired agent has an owner, a purpose and a criticality.',
  assurance: 'automated',
  frequency: 'continuous',
  enabled: true,
  category: 'governance',
  failureSeverity: 'high',
  limitations: ['Checks that an owner is recorded, not that the named person knows they own it.'],
  labels: {},
  createdAt: '2026-10-20T05:00:00.000Z',
  updatedAt: '2026-10-20T05:00:00.000Z',
  latest: {
    id: 'arc_asm_1111',
    status: 'pass',
    summary: 'All 1 agents have a recorded owner, business purpose and criticality.',
    evaluatedAt: '2026-10-20T06:00:00.000Z',
  },
};

const CONTROL_UNASSESSED: Json = {
  id: 'ARC-AI-009',
  version: 1,
  title: 'Protected connectors cannot be bypassed through other routes',
  objective: 'Governed systems are reachable by agents only through ARC.',
  procedure: 'Requires a dated attestation from a named reviewer.',
  assurance: 'deployment',
  frequency: 'quarterly',
  enabled: true,
  category: 'authorization',
  failureSeverity: 'critical',
  limitations: ['ARC cannot test this from inside itself.'],
  labels: {},
  createdAt: '2026-10-20T05:00:00.000Z',
  updatedAt: '2026-10-20T05:00:00.000Z',
};

const ASSESSMENT: Json = {
  id: 'arc_asm_1111',
  schemaVersion: 2,
  runId: 'arc_run_1111',
  controlId: 'ARC-AI-001',
  controlVersion: 1,
  organizationId: 'default',
  status: 'pass',
  assurance: 'automated',
  summary: 'All 1 agents have a recorded owner, business purpose and criticality.',
  observations: [
    {
      subject: 'arc_ag_1111',
      subjectKind: 'agent',
      ok: true,
      detail: 'owned by finance@example.com; purpose and criticality recorded',
      evidenceIds: ['arc_ev_1111'],
    },
    { subject: 'arc_ag_2222', subjectKind: 'agent', ok: false, detail: 'agent "ops-agent" is missing: governance record' },
  ],
  window: { from: '2026-09-20T06:00:00.000Z', to: '2026-10-20T06:00:00.000Z', actionsConsidered: 4, evidenceConsidered: 4 },
  limitations: ['Checks that an owner is recorded, not that the named person knows they own it.'],
  findingIds: ['arc_fnd_1111'],
  evaluatedAt: '2026-10-20T06:00:00.000Z',
  evaluationMs: 2,
  integrityDigest: 'sha256:aaaa',
};

const RUN: Json = {
  id: 'arc_run_1111',
  organizationId: 'default',
  requestedBy: 'ops@example.com',
  window: { from: '2026-09-20T06:00:00.000Z', to: '2026-10-20T06:00:00.000Z', actionsConsidered: 4, evidenceConsidered: 4 },
  controlIds: ['ARC-AI-001'],
  assessmentIds: ['arc_asm_1111'],
  totals: { pass: 1, fail: 0, not_assessable: 0, not_applicable: 0, attested: 0 },
  startedAt: '2026-10-20T06:00:00.000Z',
  finishedAt: '2026-10-20T06:00:01.000Z',
  auditHead: { sequence: 4, digest: 'sha256:0123456789abcdef0123' },
};

/** One risk with a reviewed residual, one without. */
const RISK_REVIEWED: Json = {
  id: 'arc_rsk_1111',
  reference: 'RISK-AI-001',
  title: 'Agent issues an unauthorized refund',
  description: 'A finance agent refunds a charge outside policy.',
  organizationId: 'default',
  category: 'unauthorized-action',
  status: 'assessed',
  inherent: { impact: 4, likelihood: 3, score: 12, severity: 'high' },
  residual: {
    impact: 4,
    likelihood: 1,
    score: 4,
    severity: 'low',
    reviewedBy: 'risk@example.com',
    reviewedAt: '2026-10-20T06:00:00.000Z',
    rationale: 'Approval gate verified operating for two quarters.',
  },
  treatment: 'mitigate',
  owner: 'cfo@example.com',
  controlIds: ['ARC-AI-004'],
  scope: [],
  labels: {},
  createdAt: '2026-10-20T05:00:00.000Z',
  updatedAt: '2026-10-20T06:00:00.000Z',
};

const RISK_UNREVIEWED: Json = {
  id: 'arc_rsk_2222',
  reference: 'RISK-AI-002',
  title: 'Audit log is truncated without detection',
  description: 'An attacker removes records from the end of the chain.',
  organizationId: 'default',
  category: 'evidence-integrity',
  status: 'identified',
  inherent: { impact: 5, likelihood: 2, score: 10, severity: 'moderate' },
  treatment: 'mitigate',
  owner: 'secops@example.com',
  controlIds: [],
  scope: [],
  labels: {},
  createdAt: '2026-10-20T05:00:00.000Z',
  updatedAt: '2026-10-20T05:00:00.000Z',
};

const FINDING: Json = {
  id: 'arc_fnd_1111',
  organizationId: 'default',
  controlId: 'ARC-AI-001',
  assessmentId: 'arc_asm_1111',
  severity: 'high',
  status: 'open',
  title: 'ARC-AI-001: Every registered agent has a recorded identity and owner',
  detail: 'agent "ops-agent" is missing: governance record',
  subject: 'arc_ag_2222',
  subjectKind: 'agent',
  dueAt: '2026-10-10T06:00:00.000Z',
  evidenceIds: [],
  occurrences: 3,
  firstSeenAt: '2026-10-18T06:00:00.000Z',
  lastSeenAt: '2026-10-20T06:00:00.000Z',
  createdAt: '2026-10-18T06:00:00.000Z',
  updatedAt: '2026-10-20T06:00:00.000Z',
};

const SUMMARY: Json = {
  window: { from: '2026-09-20T06:00:00.000Z', to: '2026-10-20T06:00:00.000Z', actionsConsidered: 4, evidenceConsidered: 4 },
  totals: { pass: 1, fail: 1, not_assessable: 2, not_applicable: 1, attested: 1 },
  controls: 9,
  controlsEnabled: 9,
  openFindings: { critical: 0, high: 1, medium: 0, low: 0, info: 0 },
  remediation: { open: 1, overdue: 1, dueSoon: 0, noDeadline: 0, unassigned: 1 },
  risks: { total: 2, accepted: 0, overdueReview: 0 },
  lastRun: { id: 'arc_run_1111', finishedAt: '2026-10-20T06:00:01.000Z', requestedBy: 'ops@example.com' },
  attestedOrUnassessable: 3,
  generatedAt: '2026-10-20T06:00:01.000Z',
};

const FRAMEWORKS: Json = {
  frameworks: [
    {
      id: 'nist-ai-rmf',
      name: 'NIST AI Risk Management Framework',
      edition: 'AI RMF 1.0 (NIST AI 100-1, January 2023)',
      disclaimer: 'These mappings are not an assessment, not a certification, and not a statement that the reference is satisfied.',
      mappings: 17,
      reviewed: 0,
    },
  ],
};

const FRAMEWORK_DETAIL: Json = {
  framework: {
    id: 'nist-ai-rmf',
    name: 'NIST AI Risk Management Framework',
    publisher: 'National Institute of Standards and Technology',
    edition: 'AI RMF 1.0 (NIST AI 100-1, January 2023)',
    disclaimer: 'These mappings are not an assessment, not a certification, and not a statement that the reference is satisfied.',
  },
  rows: [
    {
      mapping: {
        framework: 'nist-ai-rmf',
        reference: 'GOVERN 2.1',
        title: 'Roles, responsibilities and accountability are documented',
        controlIds: ['ARC-AI-001'],
        review: 'proposed',
        note: 'ARC evidences a named accountable owner per agent.',
      },
      controls: [{ controlId: 'ARC-AI-001', status: 'pass', evaluatedAt: '2026-10-20T06:00:00.000Z' }],
      evidenced: false,
      gap: 'the mapping has not been reviewed',
    },
  ],
};

const BASE_ROUTES: Record<string, Json | { status: number; body: Json }> = {
  '/health': HEALTH,
  '/v1/agents': { agents: [AGENT] },
  '/v1/agents/arc_ag_1111': AGENT,
  '/v1/agents/arc_ag_1111/keys': {
    credentials: [
      {
        id: 'arc_cred_1',
        agentId: 'arc_ag_1111',
        displayPrefix: 'arck_1234',
        algorithm: 'sha256',
        salt: 'SALT-MUST-NOT-RENDER',
        secretHash: 'HASH-MUST-NOT-RENDER',
        createdAt: '2026-10-20T05:00:00.000Z',
      },
    ],
  },
  '/v1/tools': { tools: [TOOL] },
  '/v1/policies': { policies: [POLICY] },
  '/v1/policies/FINANCE-004': POLICY,
  '/v1/approvals': { approvals: [APPROVAL] },
  '/v1/approvals?mine=true': { approvals: [APPROVAL] },
  '/v1/approvals/arc_apr_1111': APPROVAL,
  '/v1/evidence': { evidence: [EVIDENCE] },
  '/v1/evidence/arc_ev_1111': EVIDENCE,
  '/v1/decisions/arc_dec_1111': {
    id: 'arc_dec_1111',
    trace: [
      { policyId: 'FINANCE-004', policyVersion: 1, ruleId: 'under-500', matched: false },
      { policyId: 'FINANCE-004', policyVersion: 1, ruleId: 'needs-approval', matched: true, effect: 'REQUIRE_APPROVAL' },
    ],
  },
  '/v1/audit': { records: [AUDIT_RECORD], total: 4 },
  '/v1/audit/verify': CHAIN_OK,

  // 2.0 governance surface.
  '/v1/assurance/summary': SUMMARY,
  '/v1/assurance/controls': { controls: [CONTROL_ASSESSED, CONTROL_UNASSESSED] },
  '/v1/assurance/controls/ARC-AI-001': {
    control: CONTROL_ASSESSED,
    history: [ASSESSMENT],
    attestations: [],
  },
  '/v1/assurance/controls/ARC-AI-009': { control: CONTROL_UNASSESSED, history: [], attestations: [] },
  '/v1/assurance/runs?limit=10': { runs: [RUN] },
  '/v1/assurance/runs/arc_run_1111': { run: RUN, assessments: [ASSESSMENT] },
  '/v1/assurance/assessments/arc_asm_1111': ASSESSMENT,
  '/v1/assurance/frameworks': FRAMEWORKS,
  '/v1/assurance/frameworks/nist-ai-rmf': FRAMEWORK_DETAIL,
  '/v1/risks': { risks: [RISK_REVIEWED, RISK_UNREVIEWED] },
  '/v1/risks/arc_rsk_1111': RISK_REVIEWED,
  '/v1/risks/arc_rsk_2222': RISK_UNREVIEWED,
  '/v1/findings?status=open': { findings: [FINDING] },
  '/v1/findings?overdue=true': { findings: [FINDING] },
  '/v1/findings': { findings: [FINDING] },
  '/v1/findings/arc_fnd_1111': FINDING,
  '/v1/evidence?limit=100': { evidence: [EVIDENCE] },
};

/** Routes with a query string need the exact key, so build them per test. */
function routes(extra: Record<string, Json | { status: number; body: Json }> = {}): Record<
  string,
  Json | { status: number; body: Json }
> {
  return { ...BASE_ROUTES, ...extra };
}

// --- every section renders ------------------------------------------------

describe('Every section renders from the API', () => {
  const sections: [string, (context: PageContext) => Promise<string>][] = [
    ['Overview', overviewPage],
    ['Approvals', approvalsPage],
    ['Agents', agentsPage],
    ['Tools', toolsPage],
    ['Policies', policiesPage],
    ['Access', accessPage],
    ['Evidence', evidencePage],
    ['Audit', auditPage],
    ['Security', securityPage],
    ['Reports', reportsPage],
    ['Assurance', assurancePage],
    ['Risks', risksPage],
    ['Findings', findingsPage],
    ['Activity', activityPage],
    ['Settings', settingsPage],
  ];

  for (const [name, render] of sections) {
    it(`${name} renders a complete document`, async () => {
      const { context } = contextFor(routes());
      const page = await render(context);

      assert.match(page, /^<!doctype html>/);
      assert.match(page, /<\/html>$/);
      assert.ok(page.includes(`<title>${name} — ARC Control</title>`), `title should name ${name}`);
      assert.ok(page.includes('id="main"'), 'the skip link target must exist');
      assert.ok(page.includes('lang="en"'));
    });
  }

  it('marks exactly one navigation item as the current page', async () => {
    for (const [, render] of sections) {
      const { context } = contextFor(routes());
      const page = await render(context);
      const current = page.match(/aria-current="page"/g) ?? [];
      assert.equal(current.length, 1, 'exactly one nav item is aria-current');
    }
  });

  it('every navigation href has a route that renders', async () => {
    const hrefs = NAVIGATION.flatMap((group) => group.items.map((item) => item.href));
    assert.deepEqual(hrefs, [
      '/',
      '/approvals',
      '/activity',
      '/agents',
      '/tools',
      '/policies',
      '/access',
      '/assurance',
      '/risks',
      '/findings',
      '/security',
      '/evidence',
      '/audit',
      '/reports',
      '/settings',
    ]);
    assert.equal(hrefs.length, sections.length, 'one renderer per navigation item');
  });
});

/**
 * Collapses whitespace, for asserting on prose.
 *
 * The HTML templates wrap, so a sentence written on one line in the source
 * arrives with a newline and indentation somewhere in the middle of it.
 * Asserting on the raw string makes a test that breaks when someone reflows a
 * paragraph, which teaches people to delete the test.
 */
function prose(page: string): string {
  return page.replace(/\s+/g, ' ');
}

/**
 * What a reader actually sees: tags stripped, whitespace collapsed.
 *
 * Needed for anything spanning an element boundary — adjacent table headers
 * render as `> Owner </th><th ...> Due </th>`, so asserting on the visible
 * sequence means removing the markup between them.
 */
function visible(page: string): string {
  return page.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// --- the 2.0 governance sections tell the truth ---------------------------

/**
 * These are the assertions that keep the governance sections worth shipping.
 *
 * A console that renders a plausible figure where it has none is worse than
 * one that renders nothing, because somebody will screenshot it and put it in
 * front of a buyer. Each test below pins one way that could happen.
 */
describe('The governance sections never invent a figure', () => {
  it('shows a never-assessed control as unassessed, not as passing or pending', async () => {
    const { context } = contextFor(routes());
    const page = await assurancePage(context);

    assert.ok(page.includes('ARC-AI-009'), 'the unassessed control is listed');
    assert.ok(page.includes('never assessed'), 'and is labelled as never assessed');

    // The row for the unassessed control must carry no status badge at all.
    const row = page.slice(page.indexOf('ARC-AI-009'), page.indexOf('ARC-AI-009') + 600);
    assert.ok(!/badge (allow|ok)/.test(row), 'an unassessed control must not render as passing');
  });

  it('states the data window wherever it states a status total', async () => {
    const { context } = contextFor(routes());
    const page = await assurancePage(context);

    const text = prose(page);
    assert.ok(text.includes('Covering'), 'the window is stated');
    assert.ok(text.includes('fell in that window'));
    assert.ok(text.includes('describes that period and nothing outside it'));
  });

  it('emits no percentage or compliance score anywhere in the governance sections', async () => {
    const renderers = [assurancePage, risksPage, findingsPage, activityPage, settingsPage];

    for (const render of renderers) {
      const { context } = contextFor(routes());
      const page = await render(context);

      // A stray `%` in CSS is fine; a percentage presented as a figure is not.
      const body = page.slice(page.indexOf('id="main"'));
      assert.ok(!/\d+(\.\d+)?\s*%/.test(body), `${render.name} rendered a percentage figure`);
      assert.ok(!/compliance score/i.test(body), `${render.name} rendered a compliance score`);
      assert.ok(!/\bcompliant\b/i.test(body), `${render.name} claimed compliance`);
    }
  });

  it('shows an unreviewed residual risk as not reviewed, never by repeating the inherent figure', async () => {
    const { context } = contextFor(routes());
    const page = await risksPage(context);

    assert.ok(page.includes('RISK-AI-002'));
    assert.ok(page.includes('not reviewed'), 'the unreviewed residual says so');

    // RISK-AI-002's inherent score is 10. It must appear once, in the
    // inherent column — not twice, which is what repeating it as the residual
    // would look like.
    const row = page.slice(page.indexOf('RISK-AI-002'), page.indexOf('RISK-AI-002') + 900);
    assert.equal((row.match(/>10</g) ?? []).length, 1, 'the inherent score must not be repeated as a residual');
  });

  it('says on a risk detail page why ARC will not compute a residual', async () => {
    const { context } = contextFor(routes());
    const page = await riskDetailPage(context, 'arc_rsk_2222');

    const text = prose(page);
    assert.ok(text.includes('ARC does not compute this'));
    assert.ok(text.includes('named reviewer'));
  });

  it('attributes a reviewed residual to the person who reviewed it', async () => {
    const { context } = contextFor(routes());
    const page = await riskDetailPage(context, 'arc_rsk_1111');

    assert.ok(page.includes('risk@example.com'));
    assert.ok(page.includes('Approval gate verified operating for two quarters.'));
  });

  it('carries a control\u2019s limitations onto the control page and the assessment', async () => {
    const limitation = 'Checks that an owner is recorded, not that the named person knows they own it.';

    const control = await controlDetailPage(contextFor(routes()).context, 'ARC-AI-001');
    assert.ok(control.includes('What a pass does not tell you'));
    assert.ok(control.includes(limitation));

    const assessment = await assessmentDetailPage(contextFor(routes()).context, 'arc_asm_1111');
    assert.ok(assessment.includes('What this result does not establish'));
    assert.ok(assessment.includes(limitation));
  });

  it('says plainly that a deployment control cannot be decided by ARC', async () => {
    const { context } = contextFor(routes());
    const page = await controlDetailPage(context, 'ARC-AI-009');

    const text = prose(page);
    assert.ok(text.includes('ARC cannot test this from inside itself.'));
    assert.ok(text.includes('never been assessed'));
    assert.ok(text.includes('That is not a pass.'));
  });

  /**
   * The evidence explorer. An assessment must link each observation to the
   * primary record it rests on, so a reader never has to take the summary's
   * word for anything.
   */
  it('links an assessment observation to the evidence record behind it', async () => {
    const { context } = contextFor(routes());
    const page = await assessmentDetailPage(context, 'arc_asm_1111');

    assert.ok(page.includes('href="/evidence/arc_ev_1111"'), 'the observation links to its evidence');
    assert.ok(page.includes('href="/findings/arc_fnd_1111"'), 'and to the finding it raised');
    assert.ok(page.includes('href="/assurance/ARC-AI-001"'), 'and back to the control');
  });

  it('shows failing observations before passing ones', async () => {
    const { context } = contextFor(routes());
    const page = await assessmentDetailPage(context, 'arc_asm_1111');

    assert.ok(page.indexOf('arc_ag_2222') < page.indexOf('arc_ag_1111'), 'the failing subject comes first');
  });

  it('reports a finding\u2019s occurrence count rather than duplicating it', async () => {
    const { context } = contextFor(routes());
    const page = await findingsPage(context);

    assert.ok(page.includes('3×'), 'the occurrence count is shown');
    assert.equal((page.match(/arc_fnd_1111|ops-agent/g) ?? []).length >= 1, true);
  });

/**
   * The remediation half of the findings register. A due date the queue does
   * not show, and a lateness nothing computes, is not a deadline — an
   * operator would have to read every row and do arithmetic against today.
   */
  it('shows how late an overdue finding is, not just its date', async () => {
    const { context } = contextFor(routes());
    const page = await findingsPage(context);

    const text = prose(page);
    assert.match(text, /\d+d overdue/, 'the queue says how late, not just when');
    assert.ok(visible(page).includes('Owner Due Status'), 'and the table has a due column at all');
  });

  it('reports the remediation state above the queue', async () => {
    const { context } = contextFor(routes());
    const text = prose(await findingsPage(context));

    assert.ok(text.includes('overdue'));
    assert.ok(text.includes('no deadline set'));
    assert.ok(text.includes('unassigned'));
    assert.ok(
      text.includes('it does not notify anyone, so this page is the notification'),
      'and is honest that ARC surfaces rather than notifies',
    );
  });

  it('offers an overdue filter that asks the API for overdue findings', async () => {
    const { context, calls } = contextFor(routes(), 'status=overdue');
    const page = await findingsPage(context);

    assert.ok(calls.some((call) => call.includes('/v1/findings?overdue=true')), 'the filter reaches the API');
    assert.ok(page.includes('aria-current="true"'), 'and renders as the active chip');
  });

  /**
   * An unscheduled finding is a different gap from a late one. If it counted
   * as overdue the figure would be alarming and useless; if it were silently
   * fine, work could be hidden by never setting a date.
   */
  it('says plainly that a finding with no deadline is not overdue', async () => {
    const { context } = contextFor(routes({ '/v1/findings?overdue=true': { findings: [] } }), 'status=overdue');
    const text = prose(await findingsPage(context));

    assert.ok(text.includes('No finding is past its deadline'));
    assert.ok(text.includes('unscheduled work is a different gap from late work'));
  });

  /**
   * The queue and the counts above it must agree. They did not: the cell
   * rounded the remaining time to whole days before choosing a badge, so a
   * finding a few hours past its deadline rendered as "due in 0d" — in the
   * table the overdue filter had just selected it for, under a heading
   * counting it as overdue. Both sides now classify through `dueState`.
   *
   * These assert on the cell's own markup rather than the page text, because
   * the remediation summary above the queue also prints the word "overdue" and
   * a page-wide search would pass whatever the row said.
   */
  async function dueCellFor(dueAt: string): Promise<string> {
    const { context } = contextFor(
      routes({ '/v1/findings?status=open': { findings: [{ ...FINDING, dueAt }] } }),
    );
    const page = await findingsPage(context);
    const badge = /<span class="badge (deny|approval|muted)">([^<]*)<\/span>\s*<span class="tnum muted">/.exec(page);
    return badge ? `${badge[1]}:${badge[2]}` : 'none';
  }

  const fromNow = (ms: number): string => new Date(Date.now() + ms).toISOString();

  it('shows a finding hours past its deadline as overdue, not as due today', async () => {
    assert.equal(await dueCellFor(fromNow(-6 * 3_600_000)), 'deny:overdue');
  });

  it('does not invent a day of lateness that has not elapsed', async () => {
    assert.equal(await dueCellFor(fromNow(-60_000)), 'deny:overdue', 'a minute late is not "1d overdue"');
  });

  it('says how late it is once whole days have passed', async () => {
    assert.equal(await dueCellFor(fromNow(-3 * 86_400_000 - 3_600_000)), 'deny:3d overdue');
  });

  it('counts down in days for a deadline inside the window', async () => {
    assert.equal(await dueCellFor(fromNow(3 * 86_400_000 + 3_600_000)), 'approval:due in 3d');
  });

  it('calls a deadline later today due today rather than due in 0d', async () => {
    assert.equal(await dueCellFor(fromNow(6 * 3_600_000)), 'approval:due today');
  });

  /**
   * The other side of the same boundary: the engine's due-soon window is seven
   * days, so a deadline outside it wears no badge at all.
   */
  it('does not mark a deadline beyond the due-soon window as due soon', async () => {
    assert.equal(await dueCellFor(fromNow(8 * 86_400_000)), 'none');
  });

  it('marks a finding with no deadline as none set rather than leaving it blank', async () => {
    const { context } = contextFor(
      routes({ '/v1/findings?status=open': { findings: [{ ...FINDING, dueAt: undefined }] } }),
    );
    const page = await findingsPage(context);
    assert.ok(page.includes('none set'), 'a blank cell would read as fine');
  });

  /**
   * The settings page used to assert, unconditionally, that operator identity
   * was not authenticated. That sentence was true of every 2.0 deployment and
   * is true of only some 2.1 ones, so it now reads the deployment.
   *
   * Both directions are tested, because each failure is bad in its own way:
   * saying "not authenticated" to a deployment that has configured single
   * sign-on trains operators to ignore the warning, and failing to say it to a
   * deployment on the shared token is the dishonesty this product exists not
   * to commit.
   */
  describe('the settings page states how operators are actually authenticated', () => {
    async function settingsWith(operatorAuth: Record<string, unknown>): Promise<string> {
      const { context } = contextFor(routes({ '/health': { ...HEALTH, operatorAuth } }));
      return settingsPage(context);
    }

    it('warns plainly when identity is only claimed', async () => {
      const text = prose(await settingsWith({ modes: ['claimed'], strongest: 'claimed', attributable: false }));

      assert.ok(text.includes('Operator identity is not authenticated in this deployment'));
      assert.ok(text.includes('can claim any identity'));
      assert.ok(text.includes('not who ran it'));
      assert.ok(text.includes('ARC_OIDC_ISSUER'), 'and says how to fix it');
    });

    it('stops warning once single sign-on is configured', async () => {
      const page = await settingsWith({
        modes: ['authenticated'],
        strongest: 'authenticated',
        attributable: true,
      });
      const text = prose(page);

      assert.ok(text.includes('verified by this deployment'), 'it states the identity was verified');
      assert.ok(text.includes('attributable to you individually'));
      assert.ok(!text.includes('not who ran it'), 'the old caveat must not survive a real sign-in');
      assert.ok(!text.includes('is not authenticated in this deployment'));
      assert.ok(page.includes('badge allow">authenticated'), 'and the badge agrees');
    });

    it('describes a proxy assertion as exactly that, not as authentication', async () => {
      const text = prose(
        await settingsWith({ modes: ['asserted_by_proxy'], strongest: 'asserted_by_proxy', attributable: true }),
      );

      assert.ok(text.includes('asserted by the identity-aware proxy'));
      assert.ok(
        text.includes('a property of the network'),
        'the limit of a proxy assertion is stated rather than left implied',
      );
      assert.ok(!text.includes('attributable to you individually'), 'it is not the same claim as a verified sign-in');
    });

    it('says operator endpoints refuse everything when nothing is configured', async () => {
      const text = prose(
        await settingsWith({ modes: [], strongest: null, attributable: false }),
      );
      assert.ok(text.includes('refuses every request'));
    });

    /**
     * A signed-in operator with no roles can read and approve nothing. The
     * page has to say so, or they will try to approve something and read the
     * refusal as a bug.
     */
    it('explains an operator who has no roles', async () => {
      const { context } = contextFor(routes(), '', { operatorRoles: [] });
      const text = prose(await settingsPage(context));
      assert.ok(text.includes('can read, and approve nothing'));
    });
  });

  it('states on the settings page that enforcement does not depend on assurance', async () => {
    const { context } = contextFor(routes());
    const page = await settingsPage(context);

    const text = prose(page);
    assert.ok(text.includes('Enforcement does not depend on the assurance layer'));
    assert.ok(text.includes('cannot open the gateway'));
  });

  it('shows framework mappings as proposed and counts none as evidenced', async () => {
    const { context } = contextFor(routes());
    const page = await frameworkPage(context, 'nist-ai-rmf');

    const text = prose(page);
    assert.ok(text.includes('This is not an assessment.'));
    assert.ok(text.includes('proposed'));
    assert.ok(!page.includes('>reviewed<'), 'nothing ships marked reviewed');
    assert.ok(page.includes('the mapping has not been reviewed'), 'the gap is named');
  });

  it('renders an assessment run with its window and audit head', async () => {
    const { context } = contextFor(routes());
    const page = await assessmentRunPage(context, 'arc_run_1111');

    assert.ok(page.includes('Audit head at run time'));
    assert.ok(page.includes('sha256:0123456789abcdef0123'));
    assert.ok(page.includes('Covering'));
  });

  it('renders a finding detail page with the assessment that raised it', async () => {
    const { context } = contextFor(routes());
    const page = await findingDetailPage(context, 'arc_fnd_1111');

    assert.ok(page.includes('href="/assurance/assessments/arc_asm_1111"'));
    assert.ok(page.includes('unassigned'), 'an unassigned finding says so');
    assert.match(prose(page), /\d+d overdue/, 'and a late one says how late');
  });

  it('says an empty activity timeline is empty rather than filling it', async () => {
    const { context } = contextFor(routes({ '/v1/evidence?limit=100': { evidence: [] } }));
    const page = await activityPage(context);

    const text = prose(page);
    assert.ok(text.includes('No actions have reached the gateway yet'));
    assert.ok(text.includes('Nothing on this page is synthesised'));
  });

  it('says an empty risk register is empty rather than shipping a starter list', async () => {
    const { context } = contextFor(routes({ '/v1/risks': { risks: [] } }));
    const page = await risksPage(context);

    const text = prose(page);
    assert.ok(text.includes('No risks are recorded'));
    assert.ok(text.includes('ARC ships no starter register'));
  });

  it('tells an operator how to run an assessment when none has been run', async () => {
    const { context } = contextFor(routes({ '/v1/assurance/runs?limit=10': { runs: [] } }));
    const page = await assurancePage(context);

    const text = prose(page);
    assert.ok(text.includes('No assessment has been run'));
    assert.ok(text.includes('which is not the same as passing'));
    assert.ok(text.includes('arc assurance evaluate'));
  });

  it('escapes governance content from the API like everything else', async () => {
    const hostile = {
      ...FINDING,
      detail: '<img src=x onerror=alert(1)> &amp; "quoted"',
      subject: '</td><script>alert(1)</script>',
    };

    const { context } = contextFor(routes({ '/v1/findings?status=open': { findings: [hostile] } }));
    const page = await findingsPage(context);

    assert.ok(!page.includes('<img src=x'), 'markup from the API must not survive as markup');
    assert.ok(!page.includes('<script>alert(1)</script>'));
    assert.ok(page.includes('&lt;img src=x'), 'it survives as escaped text');
  });
});

// --- detail pages ---------------------------------------------------------

describe('Detail pages', () => {
  it('renders an agent, its credentials and its declared tools', async () => {
    const { context } = contextFor(routes({ '/v1/evidence?agentId=arc_ag_1111&limit=100': { evidence: [EVIDENCE] } }));
    const page = await agentDetailPage(context, 'arc_ag_1111');

    assert.ok(page.includes('finance-agent'));
    assert.ok(page.includes('arck_1234'), 'the credential display prefix is shown');
    assert.ok(page.includes('FINANCE-004'), 'the policy in scope for the declared tool');
  });

  it('never renders a credential salt or secret hash', async () => {
    const { context } = contextFor(routes({ '/v1/evidence?agentId=arc_ag_1111&limit=100': { evidence: [EVIDENCE] } }));
    const page = await agentDetailPage(context, 'arc_ag_1111');

    assert.ok(!page.includes('SALT-MUST-NOT-RENDER'), 'the salt must never reach the page');
    assert.ok(!page.includes('HASH-MUST-NOT-RENDER'), 'the secret hash must never reach the page');
  });

  it('renders an approval with its requirement and lifecycle', async () => {
    const { context } = contextFor(routes());
    const page = await approvalDetailPage(context, 'arc_apr_1111');

    assert.ok(page.includes('Refund'), 'the headline reads the parameters back');
    assert.ok(page.includes('the agent owner may not approve'), 'separation of duties is stated');
    assert.ok(page.includes('not consumed'), 'an unconsumed approval says so');
  });

  it('renders a policy with its rules in evaluation order', async () => {
    const { context } = contextFor(routes());
    const page = await policyDetailPage(context, 'FINANCE-004');

    const under = page.indexOf('under-500');
    const needs = page.indexOf('needs-approval');
    assert.ok(under > -1 && needs > under, 'rules appear in evaluation order');
    assert.ok(page.includes('SOX-302'), 'the control label is shown');
  });

  it('renders the evidence timeline, trace and digests', async () => {
    const { context } = contextFor(routes());
    const page = await evidenceDetailPage(context, 'arc_ev_1111');

    assert.ok(page.includes('Requested'));
    assert.ok(page.includes('Decided'));
    assert.ok(page.includes('integrityDigest'));
    assert.ok(page.includes('not executed: waiting on approval'), 'an unexecuted stage says why');
  });

  it('still renders evidence when the decision trace has aged out', async () => {
    const { context } = contextFor({ ...routes(), '/v1/decisions/arc_dec_1111': { status: 404, body: { error: { code: 'not_found', message: 'gone' } } } });
    const page = await evidenceDetailPage(context, 'arc_ev_1111');

    assert.ok(page.includes('no longer held'), 'the page explains the missing trace');
    assert.ok(page.includes('sha256:bbb'), 'the trace digest still binds it');
  });

  it('renders each confirmation as a form that posts to the existing path', async () => {
    for (const [action, id, expected] of [
      ['reject', 'arc_apr_1111', '/approvals/arc_apr_1111/vote'],
      ['suspend', 'arc_ag_1111', '/agents/arc_ag_1111/suspend'],
      ['disable', 'FINANCE-004', '/policies/FINANCE-004/disable'],
    ] as const) {
      const { context } = contextFor(routes());
      const page = await confirmPage(context, action, id);
      assert.ok(page.includes(`action="${expected}"`), `${action} posts to ${expected}`);
      assert.ok(page.includes('method="post"'), 'the mutation is a POST, never the GET that rendered this');
    }
  });
});

// --- the broken audit chain ----------------------------------------------

describe('A broken audit chain', () => {
  const BROKEN: Json = {
    valid: false,
    recordsChecked: 4,
    failures: [
      { sequence: 3, id: 'arc_aud_0003', problem: 'digest_mismatch', detail: 'the record digest does not match its contents' },
    ],
    headDigest: 'sha256:0123456789abcdef0123',
    headSequence: 4,
    checkedAgainstExpectation: false,
  };

  /**
   * `GET /v1/audit/verify` answers 409 when the chain does not verify. The SDK
   * used to throw on that, the console's catch-all turned it into a 502 and
   * the operator was told the API was unreachable — which is the opposite of
   * the truth, and hides the single most important thing the console has to
   * say.
   */
  it('is reported as BROKEN, not as an unreachable API', async () => {
    const { context } = contextFor(routes({ '/v1/audit/verify': { status: 409, body: BROKEN } }));
    const page = await auditPage(context);

    assert.ok(page.includes('BROKEN'), 'the verdict is BROKEN');
    assert.ok(!page.includes('could not be reached'), 'it is not reported as an unreachable API');
    assert.ok(page.includes('digest_mismatch'), 'the problem is named');
    assert.ok(page.includes('the record digest does not match its contents'), 'the detail is shown');
  });

  it('is the first thing Overview says needs attention', async () => {
    const { context } = contextFor(routes({ '/v1/audit/verify': { status: 409, body: BROKEN } }));
    const page = await overviewPage(context);

    assert.ok(page.includes('Audit chain BROKEN'));
    const broken = page.indexOf('Audit chain BROKEN');
    const approvals = page.indexOf('approval pending');
    assert.ok(broken > -1 && (approvals === -1 || broken < approvals), 'the chain outranks the approval queue');
  });

  it('returns the verification body rather than throwing, at the SDK level', async () => {
    const { fetch } = stubFetch({ '/v1/audit/verify': { status: 409, body: BROKEN } });
    const client = new ArcControlClient({ baseUrl: 'http://api.test', operatorToken: 't', fetch });

    const result = await client.verifyAudit();
    assert.equal(result.valid, false);
    assert.equal(result.failures.length, 1);
  });

  /**
   * An `evidence.recorded` event's `subject` is the *action* id; the evidence
   * record's own id lives in `data.evidenceId`. Linking the subject produced a
   * 404 on every such row — found by crawling the rendered site, not by a
   * test, which is why there is now a test.
   */
  it('links an evidence.recorded row to the evidence record, not to the action', async () => {
    const { context } = contextFor(routes());
    const page = await auditPage(context);

    assert.ok(page.includes('href="/evidence/arc_ev_1111"'), 'the link resolves to the evidence record');
    assert.ok(!page.includes('href="/evidence/arc_act_1111"'), 'and never to the action id');
  });

  it('keeps the self-verification caveat in full', async () => {
    const { context } = contextFor(routes());
    const page = await auditPage(context);

    assert.ok(page.includes('Checked against itself only'));
    assert.ok(page.includes('but not truncation'));
    assert.ok(page.includes('tamper evidence, not tamper proofing'));
  });

  it('says so when the chain was checked against an anchored head', async () => {
    const anchored = { ...CHAIN_OK, checkedAgainstExpectation: true };
    const { context } = contextFor(
      routes({ '/v1/audit/verify?headDigest=sha256%3A0123456789abcdef0123': anchored }),
      'headDigest=sha256:0123456789abcdef0123',
    );
    const page = await auditPage(context);

    assert.ok(page.includes('Checked against a recorded head'));
    assert.ok(page.includes('truncation of the log would have been detected'));
  });
});

// --- escaping -------------------------------------------------------------

describe('Content from agents and operators is escaped', () => {
  const XSS = '<script>alert(1)</script>';
  const ATTR = '" onmouseover="alert(1)';

  it('escapes a hostile tool description', async () => {
    const { context } = contextFor(routes({ '/v1/tools': { tools: [{ ...TOOL, description: XSS }] } }));
    const page = await toolsPage(context);

    assert.ok(!page.includes('<script>alert(1)</script>'), 'no live script tag');
    assert.ok(page.includes('&lt;script&gt;'), 'the text is shown, escaped');
  });

  it('escapes a hostile approval comment and policy reason', async () => {
    const { context } = contextFor(
      routes({
        '/v1/approvals': {
          approvals: [{ ...APPROVAL, reason: XSS, votes: [{ approver: XSS, vote: 'approve', comment: XSS, votedAt: '2026-10-20T05:00:00.000Z' }] }],
        },
        '/v1/approvals?mine=true': { approvals: [] },
      }),
    );
    const page = await approvalsPage(context);

    assert.ok(!page.includes('<script>alert(1)</script>'));
    assert.ok(page.includes('&lt;script&gt;'));
  });

  it('escapes a value that would otherwise break out of an attribute', async () => {
    const { context } = contextFor(routes({ '/v1/agents': { agents: [{ ...AGENT, id: ATTR }] } }));
    const page = await agentsPage(context);

    assert.ok(!page.includes('" onmouseover="'), 'the quote cannot close the attribute');
    assert.ok(page.includes('&quot; onmouseover=&quot;'), 'the quotes are escaped, so this stays text');
  });

  it('escapes a scan finding, which comes from a third-party manifest', async () => {
    const { context } = contextFor(routes());
    const page = await securityPage(context, {
      report: {
        server: XSS,
        endpoint: 'http://mcp.test',
        scannedAt: '2026-10-20T05:00:00.000Z',
        toolsScanned: 1,
        highestSeverity: 'critical',
        passed: false,
        findings: [{ id: 'MCP-SEC-001', severity: 'critical', title: XSS, detail: XSS, remediation: XSS, tool: XSS }],
      },
    });

    assert.ok(!page.includes('<script>alert(1)</script>'));
    assert.ok(page.includes('&lt;script&gt;'));
  });

  it('escapes a banner message, which can carry an API error verbatim', () => {
    const { context } = contextFor(routes());
    const page = errorPage({ ...context, banner: { kind: 'error', message: XSS } }, 502, XSS);

    assert.ok(!page.includes('<script>alert(1)</script>'));
    assert.ok(page.includes('&lt;script&gt;'));
  });

  it('escapeHtml covers every character that matters', () => {
    assert.equal(escapeHtml('<&>"\''), '&lt;&amp;&gt;&quot;&#39;');
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(undefined), '');
  });

  it('the html template escapes interpolations but not raw() output', () => {
    assert.equal(html`<p>${'<b>'}</p>`, '<p>&lt;b&gt;</p>');
    assert.equal(html`<p>${raw('<b>bold</b>')}</p>`, '<p><b>bold</b></p>');
    assert.equal(html`<p>${['<a>', raw('<b>')]}</p>`, '<p>&lt;a&gt;<b></p>');
  });
});

// --- empty states ---------------------------------------------------------

describe('Empty states', () => {
  const EMPTY = routes({
    '/health': { ...HEALTH, counts: { agents: 0, tools: 0, policies: 0, auditRecords: 0 }, connectors: [] },
    '/v1/agents': { agents: [] },
    '/v1/tools': { tools: [] },
    '/v1/policies': { policies: [] },
    '/v1/approvals': { approvals: [] },
    '/v1/approvals?mine=true': { approvals: [] },
    '/v1/evidence': { evidence: [] },
    '/v1/audit': { records: [], total: 0 },
    '/v1/audit/verify': { valid: true, recordsChecked: 0, failures: [], checkedAgainstExpectation: false },
  });

  it('Overview says nothing is waiting rather than showing an empty list', async () => {
    const { context } = contextFor(EMPTY);
    const page = await overviewPage(context);
    assert.ok(page.includes('Nothing is waiting on you'));
    assert.ok(page.includes('No actions have reached the gateway yet'));
  });

  it('an empty policy list states the consequence', async () => {
    const { context } = contextFor(EMPTY);
    const page = await policiesPage(context);
    assert.ok(page.includes('With no policy, every action is denied'));
  });

  it('an empty tool list states the consequence', async () => {
    const { context } = contextFor(EMPTY);
    const page = await toolsPage(context);
    assert.ok(page.includes('refused before policy runs'));
  });

  it('every other section renders without data', async () => {
    for (const render of [approvalsPage, agentsPage, accessPage, evidencePage, auditPage, securityPage, reportsPage]) {
      const { context } = contextFor(EMPTY);
      const page = await render(context);
      assert.match(page, /^<!doctype html>/);
    }
  });

  it('Reports says there is nothing to report rather than dividing by zero', async () => {
    const { context } = contextFor(EMPTY);
    const page = await reportsPage(context);
    assert.ok(page.includes('nothing to report'));
    assert.ok(!page.includes('NaN'));
  });

  it('an empty connector list states the consequence', async () => {
    const { context } = contextFor(EMPTY);
    const page = await securityPage(context);
    assert.ok(page.includes('no tool can be executed'));
  });
});

// --- API failures ---------------------------------------------------------

describe('API failures', () => {
  it('a page whose own data is missing propagates the failure', async () => {
    const { context } = contextFor({ '/health': HEALTH, '/v1/approvals': { approvals: [] } });
    await assert.rejects(() => agentsPage(context), /no stub|not_found/);
  });

  it('a failing health endpoint does not stop a page about evidence', async () => {
    const { context } = contextFor({
      '/v1/evidence': { evidence: [EVIDENCE] },
      '/v1/agents': { agents: [AGENT] },
    });
    const page = await evidencePage(context);

    assert.match(page, /^<!doctype html>/);
    assert.ok(page.includes('arc_ev_1111'), 'the records still render');
  });

  it('a failing approvals endpoint does not stop a page about agents', async () => {
    const { context } = contextFor({ '/health': HEALTH, '/v1/agents': { agents: [AGENT] } });
    const page = await agentsPage(context);

    assert.match(page, /^<!doctype html>/);
    assert.ok(page.includes('finance-agent'));
  });

  it('the error page shows the cause verbatim', () => {
    const { context } = contextFor(routes());
    const page = errorPage(context, 502, 'connect ECONNREFUSED 127.0.0.1:8787');

    assert.ok(page.includes('connect ECONNREFUSED 127.0.0.1:8787'));
    assert.ok(page.includes('The control API could not be reached'));
  });
});

// --- the access matrix ----------------------------------------------------

describe('The access matrix', () => {
  it('reports scope, and never that an action is allowed', async () => {
    const { context } = contextFor(routes());
    const page = await accessPage(context);

    assert.ok(page.includes('scope, not permission'));
    assert.ok(page.includes('◆ declared'));
    assert.ok(!/\ballowed\b/i.test(page.replace(/ALLOW/g, '')), 'no cell claims an action is allowed');
  });

  it('uses the engine’s own matcher, so a tool selector narrows scope', () => {
    const governed = cellScope(AGENT, TOOL, [POLICY]);
    assert.equal(governed.enabled.length, 1);
    assert.deepEqual(governed.effects, ['ALLOW', 'REQUIRE_APPROVAL', 'DENY']);
    assert.equal(governed.declared, true);

    const other = cellScope(AGENT, { ...TOOL, name: 'github.create_issue' }, [POLICY]);
    assert.equal(other.enabled.length, 0, 'the selector does not match another tool');
    assert.equal(other.declared, false, 'and the agent does not declare it');
  });

  it('counts a disabled policy as out of scope but still reports it', () => {
    const scope = cellScope(AGENT, TOOL, [{ ...POLICY, enabled: false }]);
    assert.equal(scope.enabled.length, 0);
    assert.equal(scope.disabled.length, 1);
    assert.deepEqual(scope.effects, [], 'a disabled policy produces no effect');
  });

  it('marks a suspended agent as refused before policy', async () => {
    const { context } = contextFor(routes({ '/v1/agents': { agents: [{ ...AGENT, status: 'suspended' }] } }));
    const page = await accessPage(context);

    assert.ok(page.includes('Refused at authentication, before policy'));
  });

  it('explains the engine default when no policy is in scope', async () => {
    const { context } = contextFor(routes({ '/v1/policies': { policies: [] } }), 'agent=arc_ag_1111&tool=stripe.refund');
    const page = await accessPage(context);

    assert.ok(page.includes('No policy in scope'));
    assert.ok(page.includes('engine default applies'));
  });
});

// --- reports --------------------------------------------------------------

describe('Reports', () => {
  it('always prints the window it describes', async () => {
    const { context } = contextFor(routes());
    const page = await reportsPage(context);

    assert.ok(page.includes('Window:'));
    assert.ok(page.includes('evidence'), 'the window is in records');
    assert.ok(page.includes('2026-10-20 05:39:26Z'), 'the window names the records it covers');
  });

  it('claims no trend', async () => {
    const { context } = contextFor(routes());
    const page = await reportsPage(context);

    assert.ok(page.includes('not a trend'));
    assert.ok(!/\bper (day|hour|week)\b/i.test(page), 'no rate is implied');
  });

  it('says which approval figures are current and which are windowed', async () => {
    const { context } = contextFor(routes());
    const page = await reportsPage(context);

    assert.ok(page.includes('pending now'));
    assert.ok(page.includes('in window'));
  });
});

// --- the demonstration label ---------------------------------------------

describe('Demonstration data is labelled', () => {
  it('shows the notice when the API reports the demo seed', async () => {
    const { context } = contextFor(routes({ '/health': { ...HEALTH, demoSeed: true } }));
    const page = await overviewPage(context);

    assert.ok(page.includes('Demonstration environment'));
    assert.ok(page.includes('ARC_SEED_DEMO'));
  });

  it('shows no notice when the API does not', async () => {
    const { context } = contextFor(routes());
    const page = await overviewPage(context);

    assert.ok(!page.includes('Demonstration environment'));
  });
});

// --- approval semantics ---------------------------------------------------

describe('Approval semantics are stated, not implied', () => {
  it('says approving does not execute', async () => {
    const { context } = contextFor(routes());
    const page = await approvalsPage(context);

    assert.ok(page.includes('Approving does not execute'));
    assert.ok(page.includes('consumed when it is used'));
  });

  it('keeps the vote form fields the API expects', async () => {
    const { context } = contextFor(routes());
    const page = await approvalsPage(context);

    assert.ok(page.includes('action="/approvals/arc_apr_1111/vote"'));
    assert.ok(page.includes('name="vote" value="approve"'));
    assert.ok(page.includes('name="comment"'));
  });

  it('routes a rejection through a confirmation first', async () => {
    const { context } = contextFor(routes());
    const page = await approvalsPage(context);

    assert.ok(page.includes('/confirm/reject/arc_apr_1111'));
  });

  it('says the queue holds pending requests only', async () => {
    const { context } = contextFor(routes());
    const page = await approvalsPage(context);

    assert.ok(page.includes('pending requests only'));
  });
});

// --- accessibility ---------------------------------------------------------

describe('Accessibility', () => {
  it('gives every data table a caption and column scopes', async () => {
    const { context } = contextFor(routes());
    const page = await evidencePage(context);

    assert.ok(page.includes('<caption class="sr-only">'));
    assert.ok(page.includes('scope="col"'));
  });

  it('makes horizontally scrolling tables focusable', async () => {
    const { context } = contextFor(routes());
    const page = await accessPage(context);

    assert.ok(page.includes('role="region"'));
    assert.ok(page.includes('tabindex="0"'));
  });

  it('offers a skip link to the main content', async () => {
    const { context } = contextFor(routes());
    const page = await overviewPage(context);

    assert.ok(page.includes('class="skip-link"'));
    assert.ok(page.includes('href="#main"'));
    assert.ok(page.includes('id="main"'));
  });

  it('pairs the effect letter with its full word for a screen reader', async () => {
    const { context } = contextFor(routes());
    const page = await accessPage(context);

    assert.ok(page.includes('<span class="sr-only"> REQUIRE_APPROVAL</span>'));
  });

  it('gives the stacked bar a text alternative', async () => {
    const { context } = contextFor(routes());
    const page = await reportsPage(context);

    assert.ok(page.includes('role="img"'));
    assert.match(page, /aria-label="Of 1 records: 1 pending approval\./);
  });

  /**
   * WCAG 1.4.1. These pages are read in greyscale often enough — printed into
   * an audit report — that an underline is the only cue that survives, so a
   * link inside prose carries one. A link that is the whole content of a table
   * cell is identified by its column instead, and does not.
   */
  it('underlines links in prose, and not identifiers in dense tables', async () => {
    const { context } = contextFor(routes());
    const page = await overviewPage(context);

    assert.ok(page.includes('a { color: var(--accent); text-decoration: underline;'));
    assert.ok(page.includes('.dt a, .matrix a,'), 'table and matrix links opt out');
  });

  it('puts every region of the page inside a landmark', async () => {
    const { context } = contextFor(routes({ '/health': { ...HEALTH, demoSeed: true } }));
    const page = await overviewPage(context);

    assert.ok(page.includes('<aside class="demo-strip" aria-label="Environment notice">'), 'the demo notice is a landmark');
    assert.ok(page.includes('<nav class="rail" aria-label="Console">'));
    assert.ok(page.includes('<main id="main">'));
  });

  it('never skips a heading level', async () => {
    for (const render of [overviewPage, approvalsPage, agentsPage, toolsPage, policiesPage, accessPage, evidencePage, auditPage, securityPage, reportsPage]) {
      const { context } = contextFor(routes());
      const page = await render(context);
      assertHeadingOrder(page);
    }

    for (const [render, id] of [
      [agentDetailPage, 'arc_ag_1111'],
      [approvalDetailPage, 'arc_apr_1111'],
      [policyDetailPage, 'FINANCE-004'],
      [evidenceDetailPage, 'arc_ev_1111'],
    ] as const) {
      const { context } = contextFor(routes({ '/v1/evidence?agentId=arc_ag_1111&limit=100': { evidence: [EVIDENCE] } }));
      assertHeadingOrder(await render(context, id));
    }
  });

  it('marks an error banner as an alert and a notice as a status', () => {
    const { context } = contextFor(routes());
    assert.ok(errorPage({ ...context, banner: { kind: 'error', message: 'no' } }, 502, 'x').includes('role="alert"'));
    assert.ok(errorPage({ ...context, banner: { kind: 'success', message: 'ok' } }, 502, 'x').includes('role="status"'));
  });
});

// --- the response itself --------------------------------------------------

describe('The security headers and the one resource the page loads', () => {
  /**
   * Pinned deliberately. This console renders evidence about security
   * decisions, and the policy is part of the product rather than a default
   * someone can widen in passing.
   */
  it('serves a policy with no script source of any kind', async () => {
    const app = createConsole({
      apiBase: 'http://api.test',
      operatorToken: 'token',
      operatorIdentity: 'operator@example.com',
      operatorRoles: [],
    });

    const headers = await new Promise<Record<string, string>>((resolve, reject) => {
      app.listen(0).then(({ port }) => {
        globalThis
          .fetch(`http://127.0.0.1:${port}/healthz`)
          .then((response) => resolve(Object.fromEntries(response.headers.entries())))
          .catch(reject);
      }, reject);
    });

    await app.close();
    assert.equal(headers['cache-control'], 'no-store');
  });

  it('declares the policy with img-src limited to data:, and no script source', () => {
    // The literal the server sends, asserted against the source of truth so a
    // widened directive cannot land unnoticed.
    const policy =
      "default-src 'none'; img-src data:; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

    assert.ok(policy.includes("default-src 'none'"));
    assert.ok(policy.includes('img-src data:'), 'the inline favicon is the only image source');
    assert.ok(!policy.includes('script-src'), 'no script source is granted');
    assert.ok(!policy.includes('http'), 'no origin is permitted');
    assert.ok(!policy.includes('unsafe-eval'));
  });

  /**
   * Without it the browser asks the origin for /favicon.ico on every page view
   * and takes a 404 — noise in an operator's network log, and a broken request
   * on any host without one at its root.
   */
  it('declares an inline favicon, so the page requests nothing from the network', async () => {
    const { context } = contextFor(routes());
    const page = await overviewPage(context);

    assert.ok(page.includes('<link rel="icon" href="data:image/svg+xml,'), 'the icon is inline');
    assert.ok(!/<(script|iframe|object|embed)\b/.test(page), 'the page embeds no executable resource');

    const external = [...page.matchAll(/(?:href|src)="(https?:)?\/\//g)];
    assert.equal(external.length, 0, 'and loads nothing from an external origin');
  });
});

// --- both themes ----------------------------------------------------------

describe('Both themes ship', () => {
  it('defines every colour token in light and dark', async () => {
    const { context } = contextFor(routes());
    const page = await overviewPage(context);

    assert.ok(page.includes('prefers-color-scheme: dark'), 'dark is a media query, not a toggle');

    const tokens = [
      '--bg', '--surface', '--surface-sunk', '--border', '--border-strong',
      '--ink', '--ink-soft', '--accent', '--accent-ink', '--focus',
      '--allow', '--allow-bg', '--deny', '--deny-bg', '--approval', '--approval-bg',
      '--failed', '--failed-bg', '--info', '--info-bg', '--proto', '--proto-bg',
    ];
    const dark = page.slice(page.indexOf('prefers-color-scheme: dark'));

    for (const token of tokens) {
      assert.ok(page.includes(`${token}:`), `${token} is defined for light`);
      assert.ok(dark.includes(`${token}:`), `${token} is redefined for dark`);
    }
  });

  it('declares color-scheme for both, so form controls follow', async () => {
    const { context } = contextFor(routes());
    const page = await overviewPage(context);

    assert.ok(page.includes('color-scheme: light'));
    assert.ok(page.includes('color-scheme: dark'));
  });

  it('carries print rules, because the page becomes the audit exhibit', async () => {
    const { context } = contextFor(routes());
    const page = await overviewPage(context);

    assert.ok(page.includes('@media print'));
  });

  it('collapses the rail on a narrow viewport', async () => {
    const { context } = contextFor(routes());
    const page = await overviewPage(context);

    assert.ok(page.includes('@media (max-width: 900px)'));
  });
});

// --- formatting -----------------------------------------------------------

describe('Formatting', () => {
  it('renders timestamps as unambiguous UTC', () => {
    assert.equal(timestamp('2026-10-20T05:39:26.123Z'), '2026-10-20 05:39:26Z');
    assert.equal(timestamp(undefined), '—');
    assert.equal(timestamp('not a date'), '—');
  });

  it('shortens a digest without losing its prefix', () => {
    assert.equal(shortDigest('sha256:0123456789abcdef0123'), '0123456789ab…');
    assert.equal(shortDigest(undefined), '—');
  });

  it('reports an elapsed approval window as expired', () => {
    const now = Date.parse('2026-10-20T06:00:00.000Z');
    assert.equal(expiresIn('2026-10-20T05:00:00.000Z', now), 'expired');
    assert.equal(expiresIn('2026-10-20T06:30:00.000Z', now), 'expires in 30 min');
    assert.equal(expiresIn('2026-10-20T08:30:00.000Z', now), 'expires in 2 h 30 min');
  });

  it('builds a headline from the parameters, and falls back to the tool name', () => {
    assert.deepEqual(actionHeadline('stripe.refund', { amount: 1840, customer: 'cus_1' }), {
      verb: 'Refund',
      strong: '$1,840.00',
      rest: 'to cus_1',
    });
    assert.deepEqual(actionHeadline('unknown.tool', { anything: 1 }), { verb: 'unknown.tool' });
    assert.deepEqual(actionHeadline('stripe.refund', {}), { verb: 'stripe.refund' }, 'no template without its parameters');
  });

  describe('conditionToText covers every operator', () => {
    const cases: [unknown, string][] = [
      [{ always: true }, 'always'],
      [{ eq: ['$.agent.name', 'finance-agent'] }, 'agent.name = "finance-agent"'],
      [{ ne: ['$.tool.effect', 'read'] }, 'tool.effect ≠ "read"'],
      [{ gt: ['$.action.parameters.amount', 1] }, 'amount > 1'],
      [{ gte: ['$.action.parameters.amount', 1] }, 'amount ≥ 1'],
      [{ lt: ['$.action.parameters.amount', 500] }, 'amount < 500'],
      [{ lte: ['$.action.parameters.amount', 2500] }, 'amount ≤ 2500'],
      [{ in: ['$.action.parameters.branch', ['main', 'master']] }, 'branch is one of ["main", "master"]'],
      [{ nin: ['$.action.parameters.branch', ['dev']] }, 'branch is none of ["dev"]'],
      [{ contains: ['$.action.parameters.title', 'urgent'] }, 'title contains "urgent"'],
      [{ startsWith: ['$.tool.name', 'stripe.'] }, 'tool.name starts with "stripe."'],
      [{ endsWith: ['$.tool.name', '.refund'] }, 'tool.name ends with ".refund"'],
      [{ matches: ['$.action.parameters.customer', '^cus_'] }, 'customer matches /^cus_/'],
      [{ exists: '$.action.parameters.reason' }, 'reason is present'],
      [{ not: { always: true } }, 'not (always)'],
      [
        { and: [{ lt: ['$.action.parameters.amount', 500] }, { exists: '$.action.parameters.reason' }] },
        'amount < 500 and reason is present',
      ],
      [
        { or: [{ eq: ['$.agent.name', 'a'] }, { eq: ['$.agent.name', 'b'] }] },
        'agent.name = "a" or agent.name = "b"',
      ],
    ];

    for (const [condition, expected] of cases) {
      const operator = Object.keys(condition as object)[0];
      it(`renders ${operator}`, () => {
        assert.equal(conditionToText(condition), expected);
      });
    }

    it('parenthesises a nested group so precedence survives', () => {
      assert.equal(
        conditionToText({
          and: [{ or: [{ always: true }, { always: true }] }, { exists: '$.x' }],
        }),
        '(always or always) and x is present',
      );
    });

    it('falls back to JSON rather than describing a shape it does not know', () => {
      assert.equal(conditionToText({ unknownOperator: ['a', 'b'] }), '{"unknownOperator":["a","b"]}');
    });
  });
});

// --- sensitive parameters -------------------------------------------------

describe('Sensitive parameters', () => {
  it('marks a parameter the tool declared sensitive', async () => {
    const { context } = contextFor(
      routes({
        '/v1/approvals': { approvals: [{ ...APPROVAL, parameters: { customer: 'cus_1', token: '[redacted]' } }] },
        '/v1/approvals?mine=true': { approvals: [] },
      }),
    );
    const page = await approvalsPage(context);

    assert.ok(page.includes('sensitive'), 'the approver is told the value is the redacted one');
  });
});

/**
 * Asserts heading levels only ever increase by one. `h2.quiet` is an h2 that
 * looks like a label; the level is what matters to a screen reader, and the
 * appearance is what matters to the layout.
 */
function assertHeadingOrder(page: string): void {
  const levels = [...page.matchAll(/<h([1-6])[\s>]/g)].map((match) => Number(match[1]));
  assert.ok(levels.length > 0, 'the page has at least one heading');
  assert.equal(levels[0], 1, 'the first heading is the h1');

  let previous = levels[0]!;
  for (const level of levels.slice(1)) {
    assert.ok(level <= previous + 1, `heading jumped from h${previous} to h${level}`);
    previous = level;
  }
}
