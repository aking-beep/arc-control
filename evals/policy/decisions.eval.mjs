import { expect } from '../harness.mjs';
import {
  AAA_PERMISSIVE,
  FINANCE_004,
  GLOBAL_001,
  buildHarness,
  SEED_ACTOR,
  financeManager,
  refund,
} from '../fixtures.mjs';

/**
 * Policy decisions.
 *
 * Three properties carry the whole model, and each is asserted here against
 * the real engine rather than described in a document:
 *
 *  1. The bands in a policy mean what their text says, at the boundaries.
 *  2. Layering can only tighten: adding a policy never loosens authorization,
 *     so a new policy is always safe to roll out.
 *  3. The engine fails closed: a malformed condition, a missing parameter or a
 *     type mismatch never produces an ALLOW.
 */
export default {
  id: 'policy/decisions',
  title: 'Policy decides, and fails closed',
  rationale: 'Bands hold at their boundaries, layering only tightens, and nothing broken ever allows.',
  cases: [
    {
      name: 'the refund bands hold exactly at their boundaries',
      async run() {
        const { gateway, apiKey } = await buildHarness();

        const cases = [
          [499.99, 'ALLOW'],
          [500, 'REQUIRE_APPROVAL'],
          [2500, 'REQUIRE_APPROVAL'],
          [2500.01, 'DENY'],
        ];

        for (const [amount, wanted] of cases) {
          const result = await gateway.handle(apiKey, refund(amount));
          expect.equal(
            result.decision.effect,
            wanted,
            `$${amount} must be ${wanted}: a boundary that drifts is a boundary nobody can rely on`,
          );
        }
      },
    },
    {
      name: 'a zero-dollar refund is allowed, and a negative one is refused by the contract',
      async run() {
        const { gateway, apiKey } = await buildHarness();

        const zero = await gateway.handle(apiKey, refund(0));
        expect.equal(zero.decision.effect, 'ALLOW', '$0 is below the autonomous limit');

        await expect.rejects(
          () => gateway.handle(apiKey, refund(-100)),
          'invalid_parameters',
          'a negative amount violates the tool contract and must be refused before policy runs',
        );
      },
    },
    {
      name: 'adding a permissive policy cannot loosen a denial',
      async run() {
        const { gateway, apiKey, connector } = await buildHarness({
          policies: [FINANCE_004, AAA_PERMISSIVE],
        });

        const result = await gateway.handle(apiKey, refund(4200));
        expect.equal(result.decision.effect, 'DENY', 'the strictest effect must win over a permissive policy');
        expect.equal(result.decision.policyId, 'FINANCE-004', 'the decision must cite the policy that denied');
        expect.equal(connector.callCount(), 0, 'a denied refund must not reach the system');
      },
    },
    {
      name: 'adding a permissive policy cannot bypass an approval',
      async run() {
        const { gateway, apiKey } = await buildHarness({ policies: [FINANCE_004, AAA_PERMISSIVE] });
        const result = await gateway.handle(apiKey, refund(1800));
        expect.equal(
          result.decision.effect,
          'REQUIRE_APPROVAL',
          'a permissive policy must not be able to skip a human',
        );
      },
    },
    {
      name: 'a stricter layered policy tightens an action the domain policy would allow',
      async run() {
        const { gateway, apiKey, connector } = await buildHarness({ policies: [FINANCE_004, GLOBAL_001] });

        // FINANCE-004 alone allows $120. The production floor raises it.
        const result = await gateway.handle(apiKey, refund(120));
        expect.equal(result.decision.effect, 'REQUIRE_APPROVAL', 'a global floor must be able to tighten a band');
        expect.equal(result.decision.policyId, 'GLOBAL-001', 'the decision must cite the policy that tightened it');
        expect.equal(connector.callCount(), 0, 'nothing executes while a human is owed');
      },
    },
    {
      name: 'a layered policy still cannot soften the hard ceiling',
      async run() {
        const { gateway, apiKey } = await buildHarness({ policies: [FINANCE_004, GLOBAL_001] });
        const result = await gateway.handle(apiKey, refund(4200));
        expect.equal(result.decision.effect, 'DENY', 'DENY outranks REQUIRE_APPROVAL');
        expect.equal(result.decision.policyId, 'FINANCE-004', 'the denial is still the finance ceiling');
      },
    },
    {
      name: 'with no policy at all, nothing is authorized',
      async run() {
        const { gateway, apiKey, connector } = await buildHarness({ policies: [] });
        const result = await gateway.handle(apiKey, refund(1));
        expect.equal(result.decision.effect, 'DENY', 'a control plane that allows what it has no policy for is not one');
        expect.equal(connector.callCount(), 0, 'nothing executes without a policy');
      },
    },
    {
      name: 'a disabled policy governs nothing',
      async run() {
        const { gateway, apiKey } = await buildHarness();
        await gateway.admin.setPolicyEnabled('FINANCE-004', false, { identifier: 'evals', via: 'system' });

        const result = await gateway.handle(apiKey, refund(10));
        expect.equal(result.decision.effect, 'DENY', 'disabling the only policy must deny, not allow');
      },
    },
    {
      name: 'a numeric limit is never satisfied by a string',
      async run() {
        const { gateway, apiKey } = await buildHarness();

        // The tool contract rejects this first, which is the outer defence.
        await expect.rejects(
          () => gateway.handle(apiKey, { tool: 'stripe.refund', parameters: { customer: 'c', amount: '10' } }),
          'invalid_parameters',
          'a refund amount submitted as text must be refused by the tool contract',
        );

        // And the engine itself refuses to compare across types, which is the
        // inner defence if a tool is ever registered without a typed contract.
        const { PolicyEngine } = await import('@arc-control/policy-engine');
        const decision = new PolicyEngine().evaluate([FINANCE_004], {
          agent: { id: 'a', name: 'finance-agent', kind: 'autonomous', environment: 'production', owner: 'o', roles: [], labels: {} },
          tool: { name: 'stripe.refund', system: 'stripe', effect: 'irreversible', riskTier: 'critical', labels: {} },
          action: { id: 'arc_act_x', parameters: { amount: '10' } },
          context: { environment: 'production', requestedAt: '2026-01-01T00:00:00.000Z', hourUtc: 0, dayOfWeekUtc: 4 },
        });

        expect.equal(decision.effect, 'DENY', 'a type mismatch must never produce an ALLOW');
        const failed = decision.trace.find((entry) => entry.ruleId === 'under-500');
        expect.ok(failed.error, 'the trace must record why the rule could not be evaluated');
      },
    },
    {
      name: 'a rule that cannot be evaluated is recorded and cannot allow',
      async run() {
        const { PolicyEngine } = await import('@arc-control/policy-engine');
        const broken = {
          id: 'BROKEN-001',
          version: 1,
          name: 'A policy with an unevaluable rule',
          enabled: true,
          match: {},
          rules: [
            { id: 'bad-operator', when: { gt: ['$.action.parameters.amount', 'not-a-number'] }, effect: 'ALLOW', reason: 'should never apply' },
          ],
          fallback: { effect: 'DENY', reason: 'the rule could not be evaluated' },
        };

        const decision = new PolicyEngine().evaluate([broken], {
          agent: { id: 'a', name: 'n', kind: 'autonomous', environment: 'production', owner: 'o', roles: [], labels: {} },
          tool: { name: 't', system: 's', effect: 'write', riskTier: 'low', labels: {} },
          action: { id: 'arc_act_x', parameters: { amount: 10 } },
          context: { environment: 'production', requestedAt: '2026-01-01T00:00:00.000Z', hourUtc: 0, dayOfWeekUtc: 4 },
        });

        expect.equal(decision.effect, 'DENY', 'an unevaluable rule must fall through to the fallback, not allow');
        expect.ok(decision.trace[0].error, 'the error must be preserved for whoever has to fix the policy');
      },
    },
    {
      name: 'a broken DENY rule is not overruled by a later ALLOW rule',
      async run() {
        const { PolicyEngine } = await import('@arc-control/policy-engine');
        const ceiling = {
          id: 'CEILING-001',
          version: 1,
          name: 'Hard ceiling, otherwise allow',
          enabled: true,
          match: {},
          rules: [
            { id: 'over-1000', when: { gt: ['$.action.parameters.amount', 1000] }, effect: 'DENY', reason: 'over the ceiling' },
            { id: 'otherwise', when: { always: true }, effect: 'ALLOW', reason: 'under the ceiling' },
          ],
          fallback: { effect: 'ALLOW', reason: 'nothing objected' },
        };

        const decision = new PolicyEngine().evaluate([ceiling], {
          agent: { id: 'a', name: 'n', kind: 'autonomous', environment: 'production', owner: 'o', roles: [], labels: {} },
          tool: { name: 't', system: 's', effect: 'write', riskTier: 'low', labels: {} },
          action: { id: 'arc_act_x', parameters: { amount: '50000' } },
          context: { environment: 'production', requestedAt: '2026-01-01T00:00:00.000Z', hourUtc: 0, dayOfWeekUtc: 4 },
        });

        expect.equal(
          decision.effect,
          'DENY',
          'a rule that cannot be evaluated ends the policy: neither a later rule nor an ALLOW fallback may decide for it',
        );
      },
    },
    {
      name: 'the same inputs always produce the same citation',
      async run() {
        const { PolicyEngine } = await import('@arc-control/policy-engine');
        const engine = new PolicyEngine();
        const input = {
          agent: { id: 'a', name: 'finance-agent', kind: 'autonomous', environment: 'production', owner: 'o', roles: [], labels: {} },
          tool: { name: 'stripe.refund', system: 'stripe', effect: 'irreversible', riskTier: 'critical', labels: {} },
          action: { id: 'arc_act_x', parameters: { amount: 100 } },
          context: { environment: 'production', requestedAt: '2026-01-01T00:00:00.000Z', hourUtc: 0, dayOfWeekUtc: 4 },
        };

        const forward = engine.evaluate([FINANCE_004, AAA_PERMISSIVE], input);
        const reverse = engine.evaluate([AAA_PERMISSIVE, FINANCE_004], input);

        expect.equal(
          forward.policyId,
          reverse.policyId,
          'policy order must not change the citation, or two auditors reading the same decision disagree',
        );
        expect.equal(forward.ruleId, reverse.ruleId, 'the cited rule must also be stable');
      },
    },
    {
      name: 'a decision carries the reasoning, not just the verdict',
      async run() {
        const { gateway, apiKey } = await buildHarness();
        const result = await gateway.handle(apiKey, refund(4200));
        const evidence = await gateway.evidence(result.evidenceId);

        expect.equal(evidence.decision.policyId, 'FINANCE-004', 'evidence must cite the policy');
        expect.equal(evidence.decision.ruleId, 'over-ceiling', 'evidence must cite the rule');
        expect.equal(
          evidence.decision.reason,
          'exceeds autonomous refund authority',
          'evidence must carry the reason a human can act on',
        );
        expect.match(
          evidence.decision.traceDigest,
          /^sha256:[0-9a-f]{64}$/,
          'evidence must bind the full trace by digest',
        );
      },
    },
    {
      name: 'policy can be tested without anything happening',
      async run() {
        const { gateway, apiKey, connector } = await buildHarness();
        const principal = await gateway.agents.authenticate(apiKey);

        const decision = await gateway.explain(principal, refund(4200));
        expect.equal(decision.effect, 'DENY', 'explain must return the real decision');
        expect.equal(connector.callCount(), 0, 'explain must not execute anything');
        expect.equal(
          (await gateway.listEvidence()).length,
          0,
          'explain must not write evidence, or a dry run pollutes the audit record',
        );
      },
    },
    {
      name: 'a deny published while an approval is open stops the release',
      async run() {
        const { gateway, apiKey, connector } = await buildHarness();

        const held = await gateway.handle(apiKey, refund(1800));
        await gateway.approvals.vote({ approvalId: held.approvalId, approver: financeManager, vote: 'approve' });

        await gateway.admin.publishPolicy(
          {
            id: 'REFUNDS-FROZEN',
            version: 1,
            name: 'Refunds suspended',
            enabled: true,
            match: { tools: ['stripe.refund'] },
            rules: [{ id: 'freeze', when: { always: true }, effect: 'DENY', reason: 'refunds are suspended' }],
            fallback: { effect: 'DENY', reason: 'refunds are suspended' },
          },
          SEED_ACTOR,
        );

        const released = await gateway.resume(held.approvalId);

        expect.equal(released.outcome, 'denied', 'a stale approval must not outrank current policy');
        expect.equal(connector.callCount('stripe.refund'), 0, 'and the refund must not have happened');
      },
    },
    {
      name: 'the release records that current policy was consulted, whichever way it went',
      async run() {
        const { gateway, apiKey } = await buildHarness();

        const held = await gateway.handle(apiKey, refund(1800));
        await gateway.approvals.vote({ approvalId: held.approvalId, approver: financeManager, vote: 'approve' });
        const released = await gateway.resume(held.approvalId);

        const evidence = await gateway.evidence(released.evidenceId);
        expect.equal(
          evidence.revalidation?.verdict,
          'proceeded',
          'an auditor must be able to see the second look happened, not assume it',
        );
        expect.equal(evidence.decision.policyId, 'FINANCE-004', 'and the original decision must survive it');
        expect.equal(evidence.approval?.status, 'approved', 'along with the approval history');
      },
    },
    {
      name: 'a narrowed approval requirement sends a held action back rather than releasing it',
      async run() {
        const { gateway, apiKey, connector } = await buildHarness();

        const held = await gateway.handle(apiKey, refund(1800));
        await gateway.approvals.vote({ approvalId: held.approvalId, approver: financeManager, vote: 'approve' });

        await gateway.admin.publishPolicy(
          {
            ...FINANCE_004,
            version: 2,
            rules: [
              {
                id: 'needs-cfo',
                when: { always: true },
                effect: 'REQUIRE_APPROVAL',
                reason: 'only the CFO may approve this now',
                approval: { approvers: ['user:cfo-only@example.com'], minApprovals: 1 },
              },
            ],
          },
          SEED_ACTOR,
        );

        const released = await gateway.resume(held.approvalId);

        expect.equal(released.outcome, 'pending_approval', 'the grant on file no longer carries this action');
        expect.equal(connector.callCount('stripe.refund'), 0, 'and nothing may execute on it');
        const fresh = await gateway.approvals.require(released.approvalId);
        expect.deepEqual(fresh.requirement.approvers, ['user:cfo-only@example.com'], 'policy names who to ask now');
      },
    },
    {
      name: 'an approval requirement comes from the policy, not the caller',
      async run() {
        const { gateway, apiKey } = await buildHarness();
        const held = await gateway.handle(apiKey, refund(1800));
        const request = await gateway.approvals.require(held.approvalId);

        expect.deepEqual(
          request.requirement.approvers,
          ['role:finance-manager'],
          'the policy names the approvers',
        );
        expect.equal(request.requirement.minApprovals, 1, 'the policy sets the threshold');
        expect.equal(
          gateway.approvals.canApprove(request, { identifier: 'intern@example.com', roles: ['support'] }),
          false,
          'someone the policy did not name must not be able to approve',
        );
        expect.equal(
          gateway.approvals.canApprove(request, financeManager),
          true,
          'someone the policy did name must be able to approve',
        );
      },
    },
  ],
};
