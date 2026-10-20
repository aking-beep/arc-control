#!/usr/bin/env node
/**
 * An agent that has to ask.
 *
 * This is ARC Control's v0.1 workflow end to end, in one process:
 *
 *   agent → gateway → identify → inspect → evaluate policy
 *         → allow | hold for a human | deny → execute → evidence → audit
 *
 * The refund itself is simulated. Everything that decides whether it happens
 * is the shipped implementation: the same gateway, policy engine, approval
 * engine, evidence builder and audit chain that run in production. A demo that
 * faked the decision would prove nothing.
 *
 * Run with:  node examples/approval-required-agent/run.js
 */
import { Gateway } from '@arc-control/gateway';
import { MemoryStore } from '@arc-control/store';
import { SimulationConnector } from '@arc-control/connector-simulation';

const OPERATOR = { identifier: 'platform@example.com', via: 'system' };

/** How a finance manager is identified when they vote in the console. */
const FINANCE_MANAGER = { identifier: 'cfo@example.com', roles: ['finance-manager'] };

const FINANCE_004 = {
  id: 'FINANCE-004',
  version: 1,
  name: 'Autonomous refund authority',
  description:
    'Bounds how much a finance agent may refund without a human. Refunds are irreversible, so the ceiling is a hard stop rather than a warning.',
  enabled: true,
  match: { tools: ['stripe.refund'] },
  rules: [
    {
      id: 'under-500',
      description: 'Routine customer-service refunds.',
      when: { lt: ['$.action.parameters.amount', 500] },
      effect: 'ALLOW',
      reason: 'within autonomous refund authority',
    },
    {
      id: 'needs-approval',
      description: 'Material refunds need a finance manager.',
      when: { lte: ['$.action.parameters.amount', 2500] },
      effect: 'REQUIRE_APPROVAL',
      reason: 'above autonomous refund authority, below the hard ceiling',
      approval: { approvers: ['role:finance-manager'], minApprovals: 1, expiresInSeconds: 3600 },
    },
    {
      id: 'over-ceiling',
      description: 'No agent refunds this much, approved or otherwise.',
      when: { always: true },
      effect: 'DENY',
      reason: 'exceeds autonomous refund authority',
    },
  ],
  fallback: { effect: 'DENY', reason: 'no refund rule matched' },
  labels: { domain: 'finance', control: 'SOX-302' },
};

function heading(text) {
  process.stdout.write(`\n${'─'.repeat(72)}\n${text}\n${'─'.repeat(72)}\n`);
}

function line(label, value) {
  process.stdout.write(`  ${label.padEnd(14)} ${value}\n`);
}

async function main() {
  // --- 1. the platform team configures ARC Control -------------------------

  const stripe = new SimulationConnector({ name: 'stripe-sandbox' }).handle('stripe.refund', (parameters) => ({
    refundId: `re_${Math.random().toString(16).slice(2, 10)}`,
    customer: parameters.customer,
    amount: parameters.amount,
    status: 'succeeded',
  }));

  const gateway = new Gateway({ store: new MemoryStore() });
  gateway.addConnector(stripe);

  await gateway.admin.registerTool(
    {
      name: 'stripe.refund',
      description: 'Refund a charge to the original payment method. Irreversible.',
      system: 'stripe',
      effect: 'irreversible',
      riskTier: 'critical',
      connector: stripe.name,
      parameters: [
        { name: 'customer', type: 'string', required: true },
        { name: 'amount', type: 'number', required: true, minimum: 0 },
        { name: 'reason', type: 'string', maxLength: 512 },
      ],
    },
    OPERATOR,
  );

  await gateway.admin.publishPolicy(FINANCE_004, OPERATOR);

  const agent = await gateway.admin.registerAgent(
    {
      name: 'finance-agent',
      owner: 'finance-ops@example.com',
      description: 'Handles customer refund requests.',
      roles: ['finance'],
      declaredTools: ['stripe.refund'],
    },
    OPERATOR,
  );

  // The plaintext key is returned once. ARC Control keeps only a salted hash.
  const { apiKey } = await gateway.admin.issueKey(agent.id, OPERATOR);

  heading('Configured');
  line('Agent', `${agent.name} (owner: ${agent.owner})`);
  line('Tool', 'stripe.refund — irreversible, critical risk');
  line('Policy', `${FINANCE_004.id} v${FINANCE_004.version} — ${FINANCE_004.name}`);
  line('Credential', `${apiKey.slice(0, 22)}… (shown once, stored as a salted hash)`);

  // --- 2. the agent works through its queue --------------------------------

  const queue = [
    { customer: 'customer_119', amount: 48, reason: 'duplicate charge' },
    { customer: 'customer_204', amount: 1800, reason: 'service outage credit' },
    { customer: 'customer_123', amount: 4200, reason: 'customer dispute' },
  ];

  for (const request of queue) {
    heading(`Agent requests: refund $${request.amount.toLocaleString('en-US')} to ${request.customer}`);

    // This is the only call the agent makes. It does not know the policy, and
    // cannot reach Stripe any other way.
    const result = await gateway.handle(apiKey, {
      tool: 'stripe.refund',
      parameters: request,
      intent: `Refund ${request.customer}: ${request.reason}`,
      correlationId: 'run_2026_10_20_a',
    });

    line('Decision', `${result.decision.effect} — ${result.decision.reason}`);
    line('Policy', `${result.decision.policyId} (rule ${result.decision.ruleId})`);
    line('Outcome', result.outcome);
    line('Evidence', result.evidenceId);

    if (result.outcome === 'executed') {
      line('Result', JSON.stringify(result.result));
      continue;
    }

    if (result.outcome === 'denied') {
      // What the agent is told. Note that it learns the reason and the policy,
      // which is what lets it do something sensible instead — here, escalate
      // to a human rather than retry a refund it will never be allowed.
      process.stdout.write('\n  The agent cannot retry its way past this. It escalates to a human.\n');
      continue;
    }

    // --- 3. a human decides ------------------------------------------------

    process.stdout.write('\n  Waiting on a human. In the console this appears in the approvals queue.\n');

    const pending = await gateway.approvals.listPending({ approver: FINANCE_MANAGER });
    line('In queue', `${pending.length} request(s) this approver may act on`);

    const voted = await gateway.approvals.vote({
      approvalId: result.approvalId,
      approver: FINANCE_MANAGER,
      vote: 'approve',
      comment: 'Outage confirmed; credit agreed with the customer.',
    });
    line('Vote', `${FINANCE_MANAGER.identifier} → ${voted.status}`);

    // Approving is not itself the act. Releasing it is a separate, audited
    // step, and the grant is consumed so it can never authorize a second one.
    const executed = await gateway.resume(result.approvalId);
    line('Outcome', executed.outcome);
    line('Result', JSON.stringify(executed.result));
    line('Evidence', executed.evidenceId);

    try {
      await gateway.resume(result.approvalId);
    } catch (error) {
      line('Replay', `refused — ${error.message}`);
    }
  }

  // --- 4. what the record shows -------------------------------------------

  heading('The denial, as an auditor sees it');
  const denied = (await gateway.listEvidence({ outcome: 'denied' }))[0];
  process.stdout.write('\n');
  line('DENIED', '');
  line('Agent', denied.agent.name);
  line('Tool', denied.tool.name);
  line('Amount', `$${denied.request.parameters.amount.toLocaleString('en-US')}`);
  line('Policy', `${denied.decision.policyId} (rule ${denied.decision.ruleId})`);
  line('Reason', denied.decision.reason);
  line('Timestamp', denied.createdAt);
  line('Evidence ID', denied.id);

  heading('Verification');
  const chain = await gateway.audit.verify();
  line('Audit chain', `${chain.valid ? 'intact' : 'BROKEN'} — ${chain.recordsChecked} record(s)`);

  const { verifyEvidence } = await import('@arc-control/evidence');
  line('Evidence', verifyEvidence(denied) ? 'verifies against its own digest' : 'ALTERED');
  line(
    'Tampering',
    verifyEvidence({ ...denied, outcome: 'executed' })
      ? 'undetected (this would be a bug)'
      : 'rewriting the denial as an execution is detected',
  );

  heading('What actually reached Stripe');
  line('Attempted', `${queue.length} refunds`);
  line('Executed', `${stripe.callCount('stripe.refund')} refunds`);
  line('Blocked', `$4,200 — never left ARC Control`);
  process.stdout.write('\n');
}

main().catch((cause) => {
  process.stderr.write(`\n${cause instanceof Error ? cause.stack : String(cause)}\n`);
  process.exit(1);
});
