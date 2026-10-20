import { Gateway } from '@arc-control/gateway';
import { MemoryStore } from '@arc-control/store';
import { SimulationConnector } from '@arc-control/connector-simulation';
import type { ParsedArgs } from '../args.js';
import { detail, out, paintEffect, style, table } from '../output.js';

/**
 * `arc demo`.
 *
 * Runs the refund workflow end to end in one process, with no server and no
 * configuration, and prints what ARC Control decided at each amount. Every
 * part of the control path is real — identity, policy, approval, evidence and
 * the audit chain — and only the refund itself is simulated.
 */
export async function runDemo(_args: ParsedArgs): Promise<number> {
  const connector = new SimulationConnector().handle('stripe.refund', (parameters) => ({
    refundId: 're_demo',
    amount: parameters.amount,
    status: 'succeeded',
  }));

  const gateway = new Gateway({ store: new MemoryStore() });
  gateway.addConnector(connector);

  const actor = { identifier: 'arc demo', via: 'cli' } as const;

  await gateway.admin.registerTool(
    {
      name: 'stripe.refund',
      description: 'Refund a charge. Irreversible.',
      effect: 'irreversible',
      riskTier: 'critical',
      connector: connector.name,
      parameters: [
        { name: 'customer', type: 'string', required: true },
        { name: 'amount', type: 'number', required: true, minimum: 0 },
      ],
    },
    actor,
  );

  await gateway.admin.publishPolicy(
    {
      id: 'FINANCE-004',
      version: 1,
      name: 'Autonomous refund authority',
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
          reason: 'above autonomous refund authority, below the hard ceiling',
          approval: { approvers: ['role:finance-manager'], minApprovals: 1 },
        },
        {
          id: 'over-ceiling',
          when: { always: true },
          effect: 'DENY',
          reason: 'exceeds autonomous refund authority',
        },
      ],
      fallback: { effect: 'DENY', reason: 'no refund rule matched' },
    },
    actor,
  );

  const agent = await gateway.admin.registerAgent(
    { name: 'finance-agent', owner: 'finance-ops@example.com', roles: ['finance'] },
    actor,
  );
  const { apiKey } = await gateway.admin.issueKey(agent.id, actor);

  out(style.bold('ARC Control — refund workflow'));
  out(style.dim('Agent, policy and tool registered. Effects are simulated; the control path is real.'));
  out();

  const rows: string[][] = [];

  for (const amount of [120, 1800, 4200]) {
    const result = await gateway.handle(apiKey, {
      tool: 'stripe.refund',
      parameters: { customer: 'customer_123', amount },
    });

    rows.push([
      `$${amount.toLocaleString('en-US')}`,
      paintEffect(result.decision.effect),
      result.outcome.replace(/_/g, ' '),
      result.decision.ruleId ?? '',
      result.evidenceId,
    ]);

    if (result.outcome === 'pending_approval' && result.approvalId) {
      await gateway.approvals.vote({
        approvalId: result.approvalId,
        approver: { identifier: 'cfo@example.com', roles: ['finance-manager'] },
        vote: 'approve',
        comment: 'verified with the customer',
      });
      const executed = await gateway.resume(result.approvalId);
      rows.push([
        style.dim('  after approval'),
        style.dim('—'),
        executed.outcome,
        style.dim('cfo@example.com'),
        executed.evidenceId,
      ]);
    }
  }

  table(['amount', 'decision', 'outcome', 'rule / approver', 'evidence'], rows);
  out();

  // The denial, in the form an operator or an auditor would be shown it.
  const denied = (await gateway.listEvidence({ outcome: 'denied' }))[0];
  if (denied) {
    out(style.bold(style.red('DENIED')));
    detail([
      ['Agent', denied.agent.name],
      ['Tool', denied.tool.name],
      ['Amount', `$${Number(denied.request.parameters.amount).toLocaleString('en-US')}`],
      ['Policy', `${denied.decision.policyId} (rule ${denied.decision.ruleId})`],
      ['Reason', denied.decision.reason],
      ['Timestamp', denied.createdAt],
      ['Evidence ID', denied.id],
    ]);
    out();
  }

  const verification = await gateway.audit.verify();
  out(
    `${style.bold('Audit chain')}  ${verification.valid ? style.green('intact') : style.red('BROKEN')} — ${verification.recordsChecked} record(s)`,
  );
  out(
    `${style.bold('Refunds that reached Stripe')}  ${connector.callCount('stripe.refund')} of 3 attempted ${style.dim('(the $4,200 refund never left ARC Control)')}`,
  );
  out();

  return 0;
}
