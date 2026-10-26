import { AssuranceEngine } from '@arc-control/assurance';
import { AuditLog } from '@arc-control/audit';
import { MemoryStore } from '@arc-control/store';
import { buildBundle, verifyBundle } from '@arc-control/evidence';
import { digest } from '@arc-control/schemas';
import { expect } from '../harness.mjs';
import { buildHarness, refund, SEED_ACTOR } from '../fixtures.mjs';

/**
 * The assurance module's value rests entirely on what it refuses to say.
 *
 * A governance dashboard that reports green where it has no evidence is worse
 * than no dashboard: it converts an unexamined risk into a documented
 * assurance, and somebody puts it in front of an auditor or a buyer. These
 * properties are the ones a reviewer should check before trusting any figure
 * the module produces, and they are asserted here rather than only in unit
 * tests because they are claims about the product, not about a function.
 */

/** An engine over a harness's store, with the chain verifier wired as the API wires it. */
function engineFor(gateway, { anchored = false, now } = {}) {
  const audit = new AuditLog(gateway.store);
  return new AssuranceEngine({
    store: gateway.store,
    audit: (event) => audit.append(event),
    ...(now ? { now } : {}),
    verifyChain: async () => ({
      verification: await audit.verify(await gateway.store.recordedAuditHead?.()),
      externallyAnchored: anchored,
    }),
  });
}

export default {
  id: 'assurance/honesty',
  title: 'Assurance never reports more than it knows',
  rationale:
    'A control result is a claim with a provenance, not a fact. Nothing may report a pass for want of evidence, and nothing in the governance layer may weaken enforcement.',
  cases: [
    {
      name: 'a deployment with nothing in it produces no passing control',
      async run() {
        // A genuinely empty store, not the harness: the harness registers a
        // tool, a covering policy and an active agent, so its policy coverage
        // control passes for good reasons. The property under test is what
        // happens when there is nothing at all to look at.
        const store = new MemoryStore();
        const audit = new AuditLog(store);
        const engine = new AssuranceEngine({
          store,
          audit: (event) => audit.append(event),
          verifyChain: async () => ({ verification: await audit.verify(), externallyAnchored: false }),
        });
        await engine.seedBaseline();

        const { assessments } = await engine.run({ requestedBy: 'evals' });
        const passing = assessments.filter((assessment) => assessment.status === 'pass');

        expect.deepEqual(
          passing.map((assessment) => assessment.controlId),
          [],
          'a store with no agents, no tools, no policies and no traffic must produce no passes: there is nothing there to pass',
        );
        expect.ok(
          assessments.some((assessment) => assessment.status === 'not_assessable'),
          'and it must say which questions it could not answer rather than reporting silence as health',
        );
      },
    },
    {
      name: 'a control passes only where the evidence actually supports it',
      async run() {
        // The complement of the case above: the harness *does* have a covering
        // policy for its high-impact tool, so ARC-AI-002 must pass — and the
        // controls with no evidence behind them must not.
        const { gateway } = await buildHarness();
        const engine = engineFor(gateway);
        await engine.seedBaseline();

        const { assessments } = await engine.run({ requestedBy: 'evals' });
        const byId = new Map(assessments.map((assessment) => [assessment.controlId, assessment]));

        expect.equal(
          byId.get('ARC-AI-002').status,
          'pass',
          'the harness registers a policy covering its irreversible tool, so coverage genuinely holds',
        );
        expect.equal(
          byId.get('ARC-AI-001').status,
          'fail',
          'and its agent has no governance record, so identity must fail rather than be waved through',
        );
        expect.equal(
          byId.get('ARC-AI-004').status,
          'not_assessable',
          'and with no approval-gated execution in the window, the approval control must report that it was never exercised',
        );
      },
    },
    {
      name: 'every assessment states the window it covers',
      async run() {
        const { gateway, apiKey } = await buildHarness();
        await gateway.handle(apiKey, refund(10));

        const engine = engineFor(gateway);
        await engine.seedBaseline();
        const { assessments } = await engine.run({ requestedBy: 'evals' });

        for (const assessment of assessments) {
          expect.ok(
            assessment.window?.from && assessment.window?.to,
            `${assessment.controlId} must carry a data window; a status without one cannot be interpreted`,
          );
        }
      },
    },
    {
      name: 'a control ARC cannot decide reports attested, never pass',
      async run() {
        const { gateway } = await buildHarness();
        const engine = engineFor(gateway);
        await engine.seedBaseline();

        await engine.recordAttestation({
          controlId: 'ARC-AI-009',
          attestedBy: 'secops@example.com',
          statement: 'No agent-reachable credential permits direct access.',
          validForDays: 30,
        });

        const { assessments } = await engine.run({ requestedBy: 'evals', controlIds: ['ARC-AI-009'] });
        expect.equal(
          assessments[0].status,
          'attested',
          'a human statement must be recorded as an attestation, distinguishable from a check ARC performed',
        );
      },
    },
    {
      name: 'an expired attestation reverts the control rather than carrying the answer forward',
      async run() {
        const { gateway } = await buildHarness();
        let clock = new Date('2026-10-20T12:00:00.000Z');
        const engine = engineFor(gateway, { now: () => clock });
        await engine.seedBaseline();

        await engine.recordAttestation({
          controlId: 'ARC-AI-009',
          attestedBy: 'secops@example.com',
          statement: 'Checked.',
          validForDays: 10,
        });

        clock = new Date(clock.getTime() + 40 * 86_400_000);
        const { assessments } = await engine.run({ requestedBy: 'evals', controlIds: ['ARC-AI-009'] });

        expect.equal(
          assessments[0].status,
          'not_assessable',
          'a stale attestation must stop supporting the control instead of remaining its answer',
        );
      },
    },
    {
      name: 'an unanchored audit chain cannot pass the integrity control',
      async run() {
        const { gateway, apiKey } = await buildHarness();
        await gateway.handle(apiKey, refund(10));

        const engine = engineFor(gateway, { anchored: false });
        await engine.seedBaseline();
        const { assessments } = await engine.run({ requestedBy: 'evals', controlIds: ['ARC-AI-006'] });

        expect.equal(
          assessments[0].status,
          'not_assessable',
          'ARC verifying its own log against its own copy of the head proves nothing to a reader who does not trust ARC, and must not render as a pass',
        );
        expect.match(
          assessments[0].summary,
          /truncation/,
          'and the reason given must name truncation, which walking the records cannot detect',
        );
      },
    },
    {
      name: 'residual risk is never computed from the existence of controls',
      async run() {
        const { gateway } = await buildHarness();
        const engine = engineFor(gateway);
        await engine.seedBaseline();

        const risk = await engine.createRisk(
          {
            reference: 'RISK-EVAL-001',
            title: 'Agent issues an unauthorized refund',
            description: 'A finance agent refunds outside policy.',
            category: 'unauthorized-action',
            impact: 4,
            likelihood: 4,
            treatment: 'mitigate',
            owner: 'cfo@example.com',
            controlIds: ['ARC-AI-003', 'ARC-AI-004'],
          },
          'evals',
        );

        expect.equal(
          risk.residual,
          undefined,
          'linking two controls must not produce a residual rating: crediting a control automatically would mean the platform grading its own homework',
        );

        const reviewed = await engine.reviewResidual(risk.id, {
          impact: 4,
          likelihood: 1,
          reviewedBy: 'risk@example.com',
          rationale: 'Approval gate verified operating.',
        });
        expect.equal(reviewed.residual.reviewedBy, 'risk@example.com', 'a residual must name its reviewer');
      },
    },
    {
      name: 'an evaluator that throws reports not assessable rather than passing',
      async run() {
        const { gateway } = await buildHarness();
        const engine = engineFor(gateway);
        await engine.seedBaseline();

        // A customer-defined control with no implemented evaluator is the same
        // situation as a broken one: nobody checked.
        await gateway.store.controls.put('EVAL-CUSTOM-001', {
          id: 'EVAL-CUSTOM-001',
          version: 1,
          title: 'A control ARC has no code for',
          objective: 'o',
          procedure: 'p',
          assurance: 'manual',
          frequency: 'annual',
          enabled: true,
          category: 'custom',
          failureSeverity: 'high',
          limitations: [],
          labels: {},
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });

        const { assessments } = await engine.run({ requestedBy: 'evals', controlIds: ['EVAL-CUSTOM-001'] });
        expect.equal(
          assessments[0].status,
          'not_assessable',
          'a bug or a gap in assurance code must never be able to manufacture a passing control',
        );
      },
    },
    {
      name: 'the governance layer cannot change an authorization outcome',
      async run() {
        const { gateway, apiKey, connector } = await buildHarness();
        const engine = engineFor(gateway);
        await engine.seedBaseline();

        const before = await gateway.handle(apiKey, refund(99_999));
        expect.equal(before.outcome, 'denied', 'the control group: this refund is above the ceiling');

        // Everything the governance surface can do, done at once.
        await engine.run({ requestedBy: 'evals' });
        await engine.setControlEnabled('ARC-AI-003', false, 'evals');
        await engine.recordAttestation({
          controlId: 'ARC-AI-009',
          attestedBy: 'evals',
          statement: 'Everything is fine.',
        });
        const risk = await engine.createRisk(
          {
            reference: 'RISK-EVAL-002',
            title: 'r',
            description: 'd',
            category: 'c',
            impact: 1,
            likelihood: 1,
            treatment: 'accept',
            owner: 'o',
          },
          'evals',
        );
        await engine.acceptRisk(risk.id, { acceptedBy: 'evals', rationale: 'Accepted.' });

        const after = await gateway.handle(apiKey, refund(99_999));
        expect.equal(
          after.outcome,
          'denied',
          'disabling a control, attesting one, and accepting the risk outright must not change what policy decides',
        );
        expect.equal(
          connector.callCount('stripe.refund'),
          0,
          'and the refund must still never have reached the connector',
        );
      },
    },
    {
      name: 'an assurance storage failure does not open the gateway',
      async run() {
        const { gateway, apiKey, connector } = await buildHarness();

        const explode = () => {
          throw new Error('assurance storage is unavailable');
        };
        for (const name of ['controls', 'assessments', 'assessmentRuns', 'findings', 'risks', 'attestations']) {
          Object.defineProperty(gateway.store, name, {
            value: new Proxy({}, { get: () => explode }),
            configurable: true,
          });
        }

        const allowed = await gateway.handle(apiKey, refund(10));
        expect.equal(allowed.outcome, 'executed', 'an allowed action must still execute when assurance is broken');

        const denied = await gateway.handle(apiKey, refund(99_999));
        expect.equal(denied.outcome, 'denied', 'and a denied action must still be denied');
        expect.equal(
          connector.callCount('stripe.refund'),
          1,
          'exactly the allowed action reached the connector, and nothing else',
        );
      },
    },
    {
      name: 'a disabled tool cannot be re-enabled by any policy',
      async run() {
        const { gateway, apiKey, connector } = await buildHarness({
          policies: [
            {
              id: 'EVAL-OPEN',
              version: 1,
              name: 'Allow everything',
              enabled: true,
              match: {},
              rules: [{ id: 'all', when: { always: true }, effect: 'ALLOW', reason: 'permitted by this eval' }],
              fallback: { effect: 'ALLOW', reason: 'open fallback, deliberately' },
            },
          ],
        });

        const tool = await gateway.store.tools.find((candidate) => candidate.name === 'stripe.refund');
        await gateway.admin.setToolDisabled(tool.id, true, SEED_ACTOR, 'suspected runaway');

        await expect.rejects(
          () => gateway.handle(apiKey, refund(10)),
          'tool_disabled',
          'a kill switch must hold against a policy that allows everything, including an ALLOW fallback',
        );
        expect.equal(connector.callCount('stripe.refund'), 0, 'and nothing reached the connector');
      },
    },
    {
      name: 'an exported bundle verifies offline, and stops verifying if altered',
      async run() {
        const { gateway, apiKey } = await buildHarness();
        await gateway.handle(apiKey, refund(10));
        await gateway.handle(apiKey, refund(99_999));

        const engine = engineFor(gateway);
        await engine.seedBaseline();
        await engine.run({ requestedBy: 'evals' });

        const bundle = await buildBundle({
          store: gateway.store,
          scope: { kind: 'window' },
          exportedBy: 'evals',
          producedBy: 'arc-control/evals',
        });

        // Round-tripped through JSON: a verifier is handed a file, not a live
        // object graph.
        const onDisk = JSON.parse(JSON.stringify(bundle));
        const clean = verifyBundle(onDisk);
        expect.ok(clean.valid, `an untouched bundle must verify: ${JSON.stringify(clean.failures)}`);
        expect.ok(
          clean.limitations.some((limitation) => limitation.problem === 'chain_unanchored'),
          'and an unanchored bundle must report that as a limitation rather than silently passing',
        );

        // The sophisticated tamper: rewrite the record and its bundle digest,
        // leaving only the integrity digest ARC wrote to disagree.
        const tampered = JSON.parse(JSON.stringify(bundle));
        const target = tampered.evidence.find((entry) => entry.record.decision.effect === 'DENY');
        expect.ok(target, 'the fixture must contain a denial to rewrite');
        target.record.decision.effect = 'ALLOW';
        target.record.outcome = 'executed';
        target.digest = digest(target.record);

        const checked = verifyBundle(tampered);
        expect.equal(checked.valid, false, 'a rewritten decision must not verify');
        expect.ok(
          checked.failures.some((failure) => /integrity digest ARC Control stored with it/.test(failure.detail)),
          'and the record’s own integrity digest must be what catches it, since the bundle digest was recomputed',
        );
      },
    },
    {
      name: 'coverage reports gaps by name and never as a proportion',
      async run() {
        const { gateway } = await buildHarness();
        const { buildCoverageReport } = await import('@arc-control/assurance');
        const report = await buildCoverageReport({ store: gateway.store });

        const serialized = JSON.stringify(report);
        expect.ok(!/percent/i.test(serialized), 'coverage must not report a percentage');
        expect.ok(
          report.ungovernedAgents.length > 0,
          'the harness agent has no governance record, so it must be named as a gap',
        );
        expect.ok(
          report.ungovernedAgents.every((agent) => agent.name && agent.missing.length > 0),
          'and each gap must say which agent and what is missing, not just that there is one',
        );
      },
    },
  ],
};
