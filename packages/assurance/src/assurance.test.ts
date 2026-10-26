import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MemoryStore } from '@arc-control/store';
import type { ChainVerification, ControlStatus } from '@arc-control/schemas';
import { AssuranceEngine, type AssuranceOptions, type AuditAppend } from './engine.js';
import { baselineControls, BASELINE_CONTROL_IDS } from './catalogue.js';
import {
  EVALUATORS,
  evaluateApprovalIntegrity,
  evaluateAuditIntegrity,
  evaluateAuthorizationEnforcement,
  evaluateBypassPrevention,
  evaluateEvidenceCompleteness,
  evaluateIdentityOwnership,
  evaluateMcpManifestPinning,
  evaluatePermissionReview,
  evaluatePolicyCoverage,
  type EvaluationContext,
} from './evaluate.js';
import { buildCoverageReport } from './coverage.js';
import { FRAMEWORKS, frameworkCoverage } from './frameworks.js';
import { action, agent, approval, AT, evidence, execution, governedAgent, policy, tool } from './fixtures.test-support.js';

const NOW = new Date(AT);

/** A context with everything empty; tests fill in only what they are about. */
function context(overrides: Partial<EvaluationContext> = {}): EvaluationContext {
  return {
    organizationId: 'default',
    window: { from: '2026-10-01T00:00:00.000Z', to: AT, actionsConsidered: 0, evidenceConsidered: 0 },
    now: NOW,
    agents: [],
    tools: [],
    policies: [],
    actions: [],
    evidence: [],
    approvals: [],
    externallyAnchored: false,
    fallbackEffect: 'DENY',
    ...overrides,
  };
}

function validChain(overrides: Partial<ChainVerification> = {}): ChainVerification {
  return {
    valid: true,
    recordsChecked: 12,
    failures: [],
    headDigest: 'sha256:head',
    headSequence: 12,
    checkedAgainstExpectation: false,
    ...overrides,
  };
}

const noAudit: AuditAppend = async () => undefined;

function engineOn(store: MemoryStore, extra: Partial<AssuranceOptions> = {}) {
  return new AssuranceEngine({ store, audit: noAudit, now: () => NOW, ...extra });
}

// ---------------------------------------------------------------------------

describe('the control catalogue', () => {
  it('ships the nine baseline controls', () => {
    const controls = baselineControls(NOW);
    assert.equal(controls.length, 9);
    assert.deepEqual(
      controls.map((control) => control.id),
      ['ARC-AI-001', 'ARC-AI-002', 'ARC-AI-003', 'ARC-AI-004', 'ARC-AI-005', 'ARC-AI-006', 'ARC-AI-007', 'ARC-AI-008', 'ARC-AI-009'],
    );
  });

  it('states limitations on every control, so a caveat travels with every result', () => {
    for (const control of baselineControls(NOW)) {
      assert.ok(control.limitations.length > 0, `${control.id} has no stated limitations`);
      assert.ok(control.objective.length > 0);
      assert.ok(control.procedure.length > 0);
    }
  });

  it('has an evaluator for every baseline control', () => {
    for (const id of BASELINE_CONTROL_IDS) {
      assert.ok(EVALUATORS[id], `no evaluator for ${id}`);
    }
  });

  it('seeds idempotently and never overwrites an operator edit', async () => {
    const store = new MemoryStore();
    const engine = engineOn(store);

    const first = await engine.seedBaseline();
    assert.equal(first.added.length, 9);

    await engine.setControlEnabled('ARC-AI-007', false, 'ops@example.com');

    const second = await engine.seedBaseline();
    assert.equal(second.added.length, 0);
    assert.equal(second.kept.length, 9);
    assert.equal((await engine.getControl('ARC-AI-007'))?.enabled, false);
  });
});

describe('ARC-AI-001 identity and ownership', () => {
  it('passes when every agent has an owner, purpose and criticality', () => {
    const result = evaluateIdentityOwnership(context({ agents: [governedAgent()] }));
    assert.equal(result.status, 'pass');
  });

  it('fails an agent with no governance record', () => {
    const result = evaluateIdentityOwnership(context({ agents: [agent()] }));
    assert.equal(result.status, 'fail');
    assert.match(result.observations[0]!.detail, /governance record/);
  });

  it('ignores retired agents but still assesses drafts', () => {
    const result = evaluateIdentityOwnership(
      context({ agents: [agent({ status: 'retired' }), governedAgent({ id: 'arc_ag_d', status: 'draft' })] }),
    );
    assert.equal(result.status, 'pass');
    assert.equal(result.observations.length, 1);
  });

  it('reports not_assessable rather than pass when there are no agents at all', () => {
    const result = evaluateIdentityOwnership(context());
    assert.equal(result.status, 'not_assessable');
    assert.match(result.summary, /not a pass/);
  });
});

describe('ARC-AI-002 policy coverage of high-impact tools', () => {
  it('is not applicable when nothing high-impact is registered', () => {
    const result = evaluatePolicyCoverage(
      context({ tools: [tool({ riskTier: 'low', effect: 'read' })], agents: [governedAgent()] }),
    );
    assert.equal(result.status, 'not_applicable');
  });

  it('passes when an enabled policy selects the tool', () => {
    const result = evaluatePolicyCoverage(
      context({ tools: [tool()], agents: [governedAgent()], policies: [policy()] }),
    );
    assert.equal(result.status, 'pass');
  });

  it('fails when no enabled policy selects the tool', () => {
    const result = evaluatePolicyCoverage(
      context({ tools: [tool()], agents: [governedAgent()], policies: [policy({ enabled: false })] }),
    );
    assert.equal(result.status, 'fail');
    assert.match(result.observations[0]!.detail, /no enabled policy/);
  });

  it('calls out coverage that comes only from a policy matching every tool', () => {
    const result = evaluatePolicyCoverage(
      context({ tools: [tool()], agents: [governedAgent()], policies: [policy({ match: {} })] }),
    );
    assert.equal(result.status, 'pass');
    assert.match(result.observations[0]!.detail, /probably not the coverage intended/);
  });

  /**
   * The same gap means different things in different configurations, and the
   * finding severity has to follow the configuration rather than the catalogue.
   */
  it('ranks an uncovered tool critical behind an ALLOW fallback and medium behind DENY', () => {
    const base = { tools: [tool()], agents: [governedAgent()], policies: [] };
    assert.equal(evaluatePolicyCoverage(context({ ...base, fallbackEffect: 'DENY' })).severity, 'medium');
    assert.equal(evaluatePolicyCoverage(context({ ...base, fallbackEffect: 'ALLOW' })).severity, 'critical');
  });

  it('names the gateway default in the observation, so the reader knows what an uncovered action does', () => {
    const result = evaluatePolicyCoverage(
      context({ tools: [tool()], agents: [governedAgent()], policies: [], fallbackEffect: 'ALLOW' }),
    );
    assert.match(result.observations[0]!.detail, /gateway default of ALLOW/);
  });
});

describe('ARC-AI-003 nothing executes without authorization', () => {
  it('passes when executions all sit behind an ALLOW', () => {
    const result = evaluateAuthorizationEnforcement(
      context({ evidence: [evidence({ execution: execution() })] }),
    );
    assert.equal(result.status, 'pass');
  });

  it('fails an execution that happened under a DENY', () => {
    const result = evaluateAuthorizationEnforcement(
      context({
        evidence: [
          evidence({
            decision: { ...evidence().decision, effect: 'DENY', reason: 'blocked' },
            execution: execution(),
          }),
        ],
      }),
    );
    assert.equal(result.status, 'fail');
    assert.match(result.observations[0]!.detail, /executed despite a DENY/);
  });

  it('fails an execution whose approval never reached approved', () => {
    const record = evidence({
      decision: { ...evidence().decision, effect: 'REQUIRE_APPROVAL' },
      approval: { id: approval().id, status: 'pending', approvers: ['role:x'], minApprovals: 1, votes: [] },
      execution: execution(),
    });
    const result = evaluateAuthorizationEnforcement(context({ evidence: [record], approvals: [approval({ status: 'pending' })] }));
    assert.equal(result.status, 'fail');
  });

  it('treats a decision that did not execute as compliant', () => {
    const result = evaluateAuthorizationEnforcement(
      context({ evidence: [evidence({ decision: { ...evidence().decision, effect: 'DENY', reason: 'no' } })] }),
    );
    assert.equal(result.status, 'pass');
  });
});

describe('ARC-AI-004 approvals actually happened', () => {
  function heldAndExecuted(overrides: Parameters<typeof approval>[0] = {}, startedAt = AT) {
    const request = approval(overrides);
    const record = evidence({
      decision: { ...evidence().decision, effect: 'REQUIRE_APPROVAL' },
      approval: {
        id: request.id,
        status: request.status,
        approvers: request.requirement.approvers,
        minApprovals: request.requirement.minApprovals,
        votes: request.votes.map((vote) => ({ approver: vote.approver, vote: vote.vote, votedAt: vote.votedAt })),
        ...(request.resolvedAt ? { resolvedAt: request.resolvedAt } : {}),
      },
      execution: execution(startedAt),
    });
    return context({ evidence: [record], approvals: [request] });
  }

  it('passes a properly approved execution', () => {
    const result = evaluateApprovalIntegrity(heldAndExecuted());
    assert.equal(result.status, 'pass');
  });

  /**
   * The headline failure this control exists to catch: an approval recorded
   * after the action already ran.
   */
  it('fails when a vote was cast after execution began', () => {
    const result = evaluateApprovalIntegrity(
      heldAndExecuted({ votes: [{ approver: 'cfo@example.com', vote: 'approve', votedAt: '2026-10-20T12:30:00.000Z' }] }, AT),
    );
    assert.equal(result.status, 'fail');
    assert.match(result.observations[0]!.detail, /after execution began/);
  });

  it('fails when fewer distinct approvers voted than the rule demanded', () => {
    const result = evaluateApprovalIntegrity(
      heldAndExecuted({
        requirement: { approvers: ['role:finance-manager'], minApprovals: 2 },
        votes: [{ approver: 'cfo@example.com', vote: 'approve', votedAt: AT }],
      }),
    );
    assert.equal(result.status, 'fail');
    assert.match(result.observations[0]!.detail, /1 distinct approvals recorded, 2 required/);
  });

  it('fails when separation of duties was required and the agent owner approved', () => {
    const result = evaluateApprovalIntegrity(
      heldAndExecuted({
        requirement: { approvers: ['owner'], minApprovals: 1, requireSeparationOfDuties: true },
        votes: [{ approver: 'ops@example.com', vote: 'approve', votedAt: AT }],
      }),
    );
    assert.equal(result.status, 'fail');
    assert.match(result.observations[0]!.detail, /separation of duties/);
  });

  it('fails an approval that was never consumed, since it could be replayed', () => {
    const request = approval({ consumedAt: undefined });
    const record = evidence({
      decision: { ...evidence().decision, effect: 'REQUIRE_APPROVAL' },
      approval: { id: request.id, status: 'approved', approvers: ['role:x'], minApprovals: 1, votes: [{ approver: 'cfo@example.com', vote: 'approve', votedAt: AT }] },
      execution: execution(),
    });
    const result = evaluateApprovalIntegrity(context({ evidence: [record], approvals: [request] }));
    assert.equal(result.status, 'fail');
    assert.match(result.observations[0]!.detail, /never marked consumed/);
  });

  it('reports not_assessable when the approval path was never exercised', () => {
    const result = evaluateApprovalIntegrity(context({ evidence: [evidence({ execution: execution() })] }));
    assert.equal(result.status, 'not_assessable');
    assert.match(result.summary, /not a pass/);
  });
});

describe('ARC-AI-005 evidence completeness', () => {
  it('passes when every action has consistent evidence', () => {
    const result = evaluateEvidenceCompleteness(context({ actions: [action()], evidence: [evidence()] }));
    assert.equal(result.status, 'pass');
  });

  it('fails an action with no evidence record', () => {
    const result = evaluateEvidenceCompleteness(context({ actions: [action()], evidence: [] }));
    assert.equal(result.status, 'fail');
    assert.match(result.observations[0]!.detail, /no evidence record/);
  });

  it('fails when the evidence parameter digest does not match the stored action', () => {
    const record = evidence({ request: { ...evidence().request, parametersDigest: 'sha256:different' } });
    const result = evaluateEvidenceCompleteness(context({ actions: [action()], evidence: [record] }));
    assert.equal(result.status, 'fail');
    assert.match(result.observations[0]!.detail, /does not match/);
  });
});

describe('ARC-AI-006 audit chain integrity', () => {
  it('fails a broken chain', () => {
    const result = evaluateAuditIntegrity(
      context({
        chain: validChain({
          valid: false,
          failures: [{ sequence: 4, id: 'arc_aud_x', problem: 'digest_mismatch', detail: 'record 4 was edited' }],
        }),
      }),
    );
    assert.equal(result.status, 'fail');
  });

  it('passes a chain checked against an externally recorded head', () => {
    const result = evaluateAuditIntegrity(context({ chain: validChain(), externallyAnchored: true }));
    assert.equal(result.status, 'pass');
  });

  /**
   * The most consequential honesty decision in the module. A chain that
   * verifies only against itself cannot detect truncation, so it does not
   * pass — ARC checking its own log against its own copy of the head proves
   * nothing to a reader who does not trust ARC.
   */
  it('reports not_assessable for an internally valid but unanchored chain', () => {
    const result = evaluateAuditIntegrity(context({ chain: validChain(), externallyAnchored: false }));
    assert.equal(result.status, 'not_assessable');
    assert.match(result.summary, /truncation is undetectable/);
  });

  it('reports not_assessable when the chain was not verified at all', () => {
    assert.equal(evaluateAuditIntegrity(context()).status, 'not_assessable');
  });
});

describe('ARC-AI-007 MCP manifest pinning', () => {
  it('is not applicable without an MCP-backed tool', () => {
    assert.equal(evaluateMcpManifestPinning(context({ tools: [tool()] })).status, 'not_applicable');
  });

  it('fails an MCP tool with no pinned manifest digest', () => {
    const result = evaluateMcpManifestPinning(context({ tools: [tool({ connector: 'mcp' })] }));
    assert.equal(result.status, 'fail');
  });

  it('passes an MCP tool whose manifest digest is pinned', () => {
    const result = evaluateMcpManifestPinning(
      context({ tools: [tool({ connector: 'mcp', connectorConfig: { manifestDigest: 'sha256:abc' } })] }),
    );
    assert.equal(result.status, 'pass');
  });
});

describe('ARC-AI-008 periodic permission review', () => {
  it('passes an agent reviewed inside its interval', () => {
    assert.equal(evaluatePermissionReview(context({ agents: [governedAgent()] })).status, 'pass');
  });

  it('fails an agent that has never been reviewed', () => {
    const result = evaluatePermissionReview(context({ agents: [governedAgent({ governance: { purpose: 'p', criticality: 'low' } })] }));
    assert.equal(result.status, 'fail');
    assert.match(result.observations[0]!.detail, /no permission review has ever been recorded/);
  });

  it('fails an agent whose review is older than its interval', () => {
    const result = evaluatePermissionReview(
      context({
        agents: [
          governedAgent({
            governance: { purpose: 'p', criticality: 'low', reviewIntervalDays: 30, lastReviewedAt: '2026-01-01T00:00:00.000Z' },
          }),
        ],
      }),
    );
    assert.equal(result.status, 'fail');
    assert.match(result.observations[0]!.detail, /past the 30-day interval/);
  });
});

describe('ARC-AI-009 bypass prevention', () => {
  it('reports not_assessable with no attestation, because ARC cannot test it', () => {
    const result = evaluateBypassPrevention(context({ tools: [tool()] }));
    assert.equal(result.status, 'not_assessable');
    assert.match(result.summary, /outside ARC's records/);
  });

  it('reports attested — never pass — when a human has attested it', () => {
    const result = evaluateBypassPrevention(
      context({
        tools: [tool()],
        attestation: {
          id: 'arc_att_1',
          controlId: 'ARC-AI-009',
          attestedBy: 'secops@example.com',
          attestedAt: AT,
          statement: 'No agent-reachable credential permits direct Stripe access.',
          expiresAt: '2027-01-01T00:00:00.000Z',
        },
      }),
    );
    assert.equal(result.status, 'attested');
    assert.match(result.summary, /not a test ARC performed/);
  });
});

describe('the assessment runner', () => {
  async function seeded() {
    const store = new MemoryStore();
    const audited: { type: string; subject: string }[] = [];
    const engine = new AssuranceEngine({
      store,
      audit: async (event) => void audited.push({ type: event.type, subject: event.subject }),
      now: () => NOW,
      verifyChain: async () => ({ verification: validChain(), externallyAnchored: false }),
    });
    await engine.seedBaseline();
    return { store, engine, audited };
  }

  it('persists a run, one assessment per enabled control, and audits it', async () => {
    const { engine, audited } = await seeded();
    const { run, assessments } = await engine.run({ requestedBy: 'ops@example.com' });

    assert.equal(assessments.length, 9);
    assert.equal(run.assessmentIds.length, 9);
    assert.equal((await engine.getRun(run.id))?.requestedBy, 'ops@example.com');
    assert.ok(audited.some((event) => event.type === 'assessment.ran'));
  });

  it('never reports a pass on an empty deployment', async () => {
    const { engine } = await seeded();
    const { assessments } = await engine.run({ requestedBy: 'ops@example.com' });

    const passing = assessments.filter((assessment) => assessment.status === 'pass');
    assert.deepEqual(passing, [], `an empty deployment produced passes: ${passing.map((a) => a.controlId).join(', ')}`);
  });

  it('stamps every assessment with its window and an integrity digest', async () => {
    const { engine } = await seeded();
    const { assessments } = await engine.run({ requestedBy: 'ops@example.com' });

    for (const assessment of assessments) {
      assert.ok(assessment.window.from < assessment.window.to);
      assert.match(assessment.integrityDigest, /^sha256:[0-9a-f]{64}$/);
      assert.equal(assessment.schemaVersion, 2);
    }
  });

  it('carries the control limitations onto every result', async () => {
    const { engine } = await seeded();
    const { assessments } = await engine.run({ requestedBy: 'ops@example.com' });
    const audit = assessments.find((assessment) => assessment.controlId === 'ARC-AI-006');
    assert.ok(audit!.limitations.length > 0);
  });

  it('restricts a run to the controls asked for', async () => {
    const { engine } = await seeded();
    const { assessments } = await engine.run({ requestedBy: 'ops', controlIds: ['ARC-AI-001'] });
    assert.deepEqual(assessments.map((assessment) => assessment.controlId), ['ARC-AI-001']);
  });

  it('skips a disabled control', async () => {
    const { engine } = await seeded();
    await engine.setControlEnabled('ARC-AI-001', false, 'ops');
    const { assessments } = await engine.run({ requestedBy: 'ops' });
    assert.ok(!assessments.some((assessment) => assessment.controlId === 'ARC-AI-001'));
  });
});

describe('findings reconciliation', () => {
  async function storeWithUngovernedAgent() {
    const store = new MemoryStore();
    await store.agents.put(agent().id, agent());
    const engine = engineOn(store);
    await engine.seedBaseline();
    // Only ARC-AI-001 and ARC-AI-008, which both key findings on the agent id.
    await engine.setControlEnabled('ARC-AI-008', false, 'ops');
    for (const id of ['ARC-AI-002', 'ARC-AI-003', 'ARC-AI-004', 'ARC-AI-005', 'ARC-AI-006', 'ARC-AI-007', 'ARC-AI-009']) {
      await engine.setControlEnabled(id, false, 'ops');
    }
    return { store, engine };
  }

  it('opens a finding for a failing subject', async () => {
    const { engine } = await storeWithUngovernedAgent();
    await engine.run({ requestedBy: 'ops' });

    const findings = await engine.listFindings({ status: 'open' });
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.controlId, 'ARC-AI-001');
    assert.equal(findings[0]!.subject, agent().id);
    assert.equal(findings[0]!.occurrences, 1);
  });

  it('increments occurrences instead of duplicating across runs', async () => {
    const { engine } = await storeWithUngovernedAgent();
    await engine.run({ requestedBy: 'ops' });
    await engine.run({ requestedBy: 'ops' });
    await engine.run({ requestedBy: 'ops' });

    const findings = await engine.listFindings({ status: 'open' });
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.occurrences, 3);
  });

  it('resolves a finding once the subject stops failing, naming what cleared it', async () => {
    const { store, engine } = await storeWithUngovernedAgent();
    await engine.run({ requestedBy: 'ops' });

    await store.agents.put(governedAgent().id, governedAgent());
    await engine.run({ requestedBy: 'ops' });

    assert.equal((await engine.listFindings({ status: 'open' })).length, 0);
    const resolved = await engine.listFindings({ status: 'resolved' });
    assert.equal(resolved.length, 1);
    assert.match(resolved[0]!.resolution!.note, /No longer observed failing by assessment arc_asm_/);
  });

  /**
   * Regression, found by running the real API rather than a fixture.
   *
   * A finding's subject has to be a stable name for the thing observed, not
   * the value observed. ARC-AI-006 keyed on the chain head digest, which moves
   * every time a record is appended, so each run saw a new subject: it opened
   * a fresh finding and resolved the previous one, every run, forever.
   */
  it('does not churn findings when the observed value moves but the condition does not', async () => {
    const store = new MemoryStore();
    let appended = 0;
    const engine = new AssuranceEngine({
      store,
      audit: noAudit,
      now: () => NOW,
      // A head digest that changes on every run, as a growing log's does.
      verifyChain: async () => {
        appended += 1;
        return {
          verification: validChain({ headDigest: `sha256:head-${appended}`, headSequence: appended }),
          externallyAnchored: false,
        };
      },
    });
    await engine.seedBaseline();

    for (let run = 0; run < 4; run += 1) {
      await engine.run({ requestedBy: 'ops', controlIds: ['ARC-AI-006'] });
    }

    const all = await engine.listFindings({ controlId: 'ARC-AI-006' });
    assert.equal(all.length, 1, `expected one finding across four runs, got ${all.length}`);
    assert.equal(all[0]!.occurrences, 4);
    assert.equal(all[0]!.status, 'open');
    // The moving value still has to be visible somewhere.
    assert.match(all[0]!.detail, /sha256:head-4/);
  });

  it('keeps accepted and false_positive distinct from resolved', async () => {
    const { engine } = await storeWithUngovernedAgent();
    await engine.run({ requestedBy: 'ops' });
    const [finding] = await engine.listFindings({ status: 'open' });

    const accepted = await engine.resolveFinding(finding!.id, {
      status: 'accepted',
      by: 'ciso@example.com',
      note: 'Dormant test agent, scheduled for retirement.',
    });
    assert.equal(accepted.status, 'accepted');
    assert.equal(accepted.resolution!.by, 'ciso@example.com');
  });
});

describe('the risk register', () => {
  it('rates inherent risk but never computes residual', async () => {
    const store = new MemoryStore();
    const engine = engineOn(store);

    const risk = await engine.createRisk(
      {
        reference: 'RISK-AI-001',
        title: 'Agent issues an unauthorized refund',
        description: 'A finance agent refunds a charge outside policy.',
        category: 'unauthorized-action',
        impact: 4,
        likelihood: 3,
        treatment: 'mitigate',
        owner: 'cfo@example.com',
      },
      'ops@example.com',
    );

    assert.equal(risk.inherent.score, 12);
    assert.equal(risk.inherent.severity, 'high');
    assert.equal(risk.residual, undefined, 'residual must not be computed from the existence of controls');
  });

  it('records a residual rating only with a named reviewer and a rationale', async () => {
    const store = new MemoryStore();
    const engine = engineOn(store);
    const risk = await engine.createRisk(
      { reference: 'R1', title: 't', description: 'd', category: 'c', impact: 5, likelihood: 4, treatment: 'mitigate', owner: 'o' },
      'ops',
    );

    const reviewed = await engine.reviewResidual(risk.id, {
      impact: 5,
      likelihood: 1,
      reviewedBy: 'risk@example.com',
      rationale: 'Approval gate verified operating for the last two quarters.',
    });

    assert.equal(reviewed.residual!.score, 5);
    assert.equal(reviewed.residual!.reviewedBy, 'risk@example.com');
    assert.equal(reviewed.status, 'assessed');
  });

  it('gives every acceptance an expiry', async () => {
    const store = new MemoryStore();
    const engine = engineOn(store);
    const risk = await engine.createRisk(
      { reference: 'R1', title: 't', description: 'd', category: 'c', impact: 2, likelihood: 2, treatment: 'mitigate', owner: 'o' },
      'ops',
    );

    const accepted = await engine.acceptRisk(risk.id, { acceptedBy: 'ciso@example.com', rationale: 'Low impact.' });
    assert.ok(accepted.acceptance!.expiresAt > accepted.acceptance!.acceptedAt);
  });

  it('refuses to link a risk to a control that does not exist', async () => {
    const store = new MemoryStore();
    const engine = engineOn(store);
    const risk = await engine.createRisk(
      { reference: 'R1', title: 't', description: 'd', category: 'c', impact: 2, likelihood: 2, treatment: 'mitigate', owner: 'o' },
      'ops',
    );

    await assert.rejects(() => engine.linkControls(risk.id, ['ARC-AI-999'], 'ops'), /unknown control/);
  });
});

describe('attestations', () => {
  it('lets an attested control report attested, and reverts it once the attestation expires', async () => {
    const store = new MemoryStore();
    await store.tools.put(tool().id, tool());
    let clock = new Date(AT);
    const engine = new AssuranceEngine({ store, audit: noAudit, now: () => clock });
    await engine.seedBaseline();

    await engine.recordAttestation({
      controlId: 'ARC-AI-009',
      attestedBy: 'secops@example.com',
      statement: 'Verified no direct route to Stripe from agent networks.',
      validForDays: 30,
    });

    const first = await engine.run({ requestedBy: 'ops', controlIds: ['ARC-AI-009'] });
    assert.equal(first.assessments[0]!.status, 'attested');
    assert.ok(first.assessments[0]!.attestation);

    clock = new Date(Date.parse(AT) + 60 * 86_400_000);
    const second = await engine.run({ requestedBy: 'ops', controlIds: ['ARC-AI-009'] });
    assert.equal(second.assessments[0]!.status, 'not_assessable');
  });

  it('keeps every attestation rather than replacing the last one', async () => {
    const store = new MemoryStore();
    const engine = engineOn(store);
    await engine.seedBaseline();

    await engine.recordAttestation({ controlId: 'ARC-AI-009', attestedBy: 'a@example.com', statement: 'first' });
    await engine.recordAttestation({ controlId: 'ARC-AI-009', attestedBy: 'b@example.com', statement: 'second' });

    assert.equal((await engine.attestationHistory('ARC-AI-009')).length, 2);
  });
});

describe('a control with no evaluator', () => {
  it('reports not_assessable rather than passing', async () => {
    const store = new MemoryStore();
    const engine = engineOn(store);
    await store.controls.put('CUST-001', {
      id: 'CUST-001',
      version: 1,
      title: 'A customer-defined control',
      objective: 'o',
      procedure: 'p',
      assurance: 'manual',
      frequency: 'annual',
      enabled: true,
      category: 'custom',
      failureSeverity: 'medium',
      limitations: [],
      labels: {},
      createdAt: AT,
      updatedAt: AT,
    });

    const { assessments } = await engine.run({ requestedBy: 'ops' });
    assert.equal(assessments[0]!.status, 'not_assessable');
    assert.match(assessments[0]!.summary, /No automated evaluator/);
  });
});

describe('the coverage report', () => {
  it('names ungoverned agents and the fields they are missing', async () => {
    const store = new MemoryStore();
    await store.agents.put(agent().id, agent());

    const report = await buildCoverageReport({ store, now: () => NOW });
    assert.equal(report.ungovernedAgents.length, 1);
    assert.deepEqual(report.ungovernedAgents[0]!.missing, ['governance record']);
  });

  it('names high-impact tools no policy covers', async () => {
    const store = new MemoryStore();
    await store.agents.put(governedAgent().id, governedAgent());
    await store.tools.put(tool().id, tool());

    const report = await buildCoverageReport({ store, now: () => NOW });
    assert.deepEqual(report.uncoveredTools, [{ name: 'stripe.refund', riskTier: 'critical', effect: 'irreversible' }]);
  });

  it('lists controls that have never been assessed as stale', async () => {
    const store = new MemoryStore();
    const engine = engineOn(store);
    await engine.seedBaseline();

    const report = await buildCoverageReport({ store, now: () => NOW });
    assert.equal(report.staleControls.length, 9);
    assert.equal(report.totals.controlsAssessed, 0);
  });

  it('produces no percentage anywhere', async () => {
    const store = new MemoryStore();
    const report = await buildCoverageReport({ store, now: () => NOW });
    assert.ok(!JSON.stringify(report).includes('percent'));
    assert.ok(!JSON.stringify(report).includes('%'));
  });
});

describe('framework mappings', () => {
  it('ships every NIST AI RMF mapping as proposed rather than reviewed', () => {
    const framework = FRAMEWORKS['nist-ai-rmf']!;
    for (const mapping of framework.mappings) {
      assert.equal(mapping.review, 'proposed', `${mapping.reference} ships as reviewed`);
      assert.ok(mapping.note.length > 0, `${mapping.reference} has no note`);
    }
  });

  it('covers all four framework functions', () => {
    const references = FRAMEWORKS['nist-ai-rmf']!.mappings.map((mapping) => mapping.reference);
    for (const fn of ['GOVERN', 'MAP', 'MEASURE', 'MANAGE']) {
      assert.ok(references.some((reference) => reference.startsWith(fn)), `no ${fn} mapping`);
    }
  });

  it('carries a disclaimer stating it is not an assessment', () => {
    assert.match(FRAMEWORKS['nist-ai-rmf']!.disclaimer, /not an assessment, not a certification/);
  });

  it('never marks an unreviewed mapping as evidenced, however its controls score', () => {
    const framework = FRAMEWORKS['nist-ai-rmf']!;
    const latest = framework.mappings.flatMap((mapping) =>
      mapping.controlIds.map((controlId) => ({
        controlId,
        status: 'pass' as ControlStatus,
        evaluatedAt: AT,
      })),
    );

    const rows = frameworkCoverage(framework, latest as never);
    assert.ok(rows.every((row) => !row.evidenced));
    assert.ok(rows.every((row) => row.gap === 'the mapping has not been reviewed'));
  });

  it('requires every mapped control to be passing before a reviewed mapping counts as evidenced', () => {
    const framework = FRAMEWORKS['nist-ai-rmf']!;
    const mapping = { ...framework.mappings.find((m) => m.controlIds.length === 1)!, review: 'reviewed' as const };
    const reviewed = { ...framework, mappings: [mapping] };

    const failing = frameworkCoverage(reviewed, [{ controlId: mapping.controlIds[0]!, status: 'not_assessable', evaluatedAt: AT }] as never);
    assert.equal(failing[0]!.evidenced, false);

    const passing = frameworkCoverage(reviewed, [{ controlId: mapping.controlIds[0]!, status: 'pass', evaluatedAt: AT }] as never);
    assert.equal(passing[0]!.evidenced, true);
  });
});

describe('the assurance summary', () => {
  it('reports how much of the posture rests on human statements', async () => {
    const store = new MemoryStore();
    const engine = engineOn(store);
    await engine.seedBaseline();
    await engine.run({ requestedBy: 'ops' });

    const summary = await engine.summary();
    assert.equal(summary.controls, 9);
    assert.equal(summary.controlsEnabled, 9);
    assert.ok(summary.attestedOrUnassessable > 0);
    assert.ok(summary.lastRun);
    assert.ok(summary.window.from <= summary.window.to);
  });
});
