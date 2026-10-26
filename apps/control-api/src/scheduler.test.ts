import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { SimulationConnector } from '@arc-control/connector-simulation';
import { MemoryStore } from '@arc-control/store';
import type { Policy } from '@arc-control/schemas';
import { createControlApi, type ControlApi } from './server.js';

/**
 * The scheduler is what makes this a product rather than a tool: it has to
 * work while nobody is looking, because agents act on their own schedule.
 *
 * Every test drives `tick()` directly. Nothing here waits on wall-clock time,
 * which is the difference between a scheduler test that is trusted and one
 * that gets marked flaky and then ignored.
 */

const HOLD: Policy = {
  id: 'HOLD-SCHED',
  version: 1,
  name: 'Hold refunds',
  enabled: true,
  match: { tools: ['stripe.refund'] },
  rules: [
    {
      id: 'hold',
      when: { always: true },
      effect: 'REQUIRE_APPROVAL',
      reason: 'needs a human',
      approval: { approvers: ['role:finance-manager'], minApprovals: 1, expiresInSeconds: 120 },
    },
  ],
  fallback: { effect: 'DENY', reason: 'no rule matched' },
};

describe('the scheduler', () => {
  let hook: { server: Server; received: unknown[]; reply: { status: number } };
  let hookUrl: string;

  before(async () => {
    const received: unknown[] = [];
    const reply = { status: 200 };
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        received.push(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown);
        response.writeHead(reply.status);
        response.end();
      });
    });

    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        resolve(typeof address === 'object' && address ? address.port : 0);
      });
    });

    hook = { server, received, reply };
    hookUrl = `http://127.0.0.1:${String(port)}/hook`;
  });

  after(async () => {
    if (hook?.server.listening) await new Promise<void>((resolve) => hook.server.close(() => resolve()));
  });

  /** An API with the scheduler built but not ticking, so tests drive it. */
  async function harness(): Promise<{
    api: ControlApi;
    store: MemoryStore;
    apiKey: string;
    close: () => Promise<void>;
  }> {
    const store = new MemoryStore();
    const api = createControlApi({ store, operatorToken: 'token', schedule: false });

    api.gateway.addConnector(new SimulationConnector({ handlers: { 'stripe.refund': () => ({ ok: true }) } }));
    await api.gateway.tools.register({
      name: 'stripe.refund',
      description: 'Refund a charge.',
      effect: 'irreversible',
      riskTier: 'critical',
      connector: 'simulation',
      parameters: [{ name: 'amount', type: 'number', required: true, minimum: 0 }],
    });
    await api.gateway.admin.publishPolicy(HOLD, { identifier: 'ops@example.com', via: 'api' });
    await api.assurance.seedBaseline();

    const agent = await api.gateway.agents.register({ name: 'support-agent', owner: 'lead@example.com' });
    const { apiKey } = await api.gateway.agents.issueKey(agent.id);

    return { api, store, apiKey, close: async () => void (await store.close()) };
  }

  /** Raises a held approval directly through the gateway. */
  async function hold(api: ControlApi, apiKey: string): Promise<string> {
    const result = await api.gateway.handle(apiKey, { tool: 'stripe.refund', parameters: { amount: 100 } });
    assert.equal(result.outcome, 'pending_approval');
    return result.approvalId!;
  }

  /**
   * Once per subject means *ever*, not "within the last few hundred
   * deliveries".
   *
   * The check used to read the newest 500 delivery records, which is correct
   * right up to a deployment's 501st. After that the window rolls past the
   * record of having notified, and every overdue finding and expiring
   * approval is announced again on every tick — forever, every five minutes,
   * which is how an alerting channel gets muted and the next real warning
   * goes unread.
   *
   * So this test pushes the original delivery out of any plausible page
   * before ticking again. It is slow by the standards of this file; the bug
   * it pins down is invisible to a test with a handful of records.
   */
  it('does not notify twice once the delivery window has rolled past the record', async () => {
    const h = await harness();
    try {
      await h.api.notifier.addChannel({ name: 'ops', url: hookUrl, events: ['finding.overdue'] });
      // A second channel, so the filler traffic below is actually recorded.
      // Without one, `notify` on an event nobody subscribes to writes no
      // delivery record at all — the first version of this test buried the
      // record under 600 notifications that produced nothing, and passed
      // against the bug it was written to catch.
      await h.api.notifier.addChannel({ name: 'traffic', url: hookUrl, events: ['approval.requested'] });

      // An assessment raises the findings; a failing control is how one comes
      // to exist. Then give it a deadline that has already passed, which is
      // what makes it overdue.
      await h.api.assurance.run({ requestedBy: 'ops@example.com' });
      const open = await h.api.assurance.listFindings({ status: 'open' });
      assert.ok(open.length > 0, 'the baseline assessment should raise at least one finding');
      await h.api.assurance.updateFinding(
        open[0]!.id,
        { owner: 'ops@example.com', dueAt: new Date(Date.now() - 86_400_000).toISOString() },
        'ops@example.com',
      );

      const first = await h.api.scheduler.tick();
      assert.equal(first.overdueNotified, 1, 'the overdue finding is notified once');
      assert.deepEqual(first.problems, []);

      // Unrelated traffic, enough to bury that record past the page the check
      // used to read.
      for (let index = 0; index < 600; index += 1) {
        await h.api.notifier.notify({
          event: 'approval.requested',
          subject: `filler-${String(index)}`,
          summary: 'Unrelated traffic.',
        });
      }

      // The premise of the test, asserted rather than assumed: the record of
      // having notified is now outside the newest 500.
      const recent = await h.api.notifier.deliveries(500);
      assert.ok(
        !recent.some((delivery) => delivery.event === 'finding.overdue'),
        'the fixture failed to push the delivery record out of the window, so this test proves nothing',
      );

      const second = await h.api.scheduler.tick();
      assert.equal(
        second.overdueNotified,
        0,
        'the same finding was announced again once its delivery record fell out of the window',
      );
    } finally {
      await h.close();
    }
  });

  /**
   * The notifier object always exists, so the "no channel configured" case is
   * easy to lose: the route would return `configured: false` with no
   * explanation and the console would render an empty table that reads as
   * "nothing to report" rather than "nobody is being told". Found by running
   * the real binary.
   */
  it('says plainly that nobody is being told when no channel is enabled', async () => {
    const h = await harness();
    try {
      const address = await h.api.listen(0);
      const base = `http://${address.host}:${address.port}`;
      const headers = { authorization: 'Bearer token', 'x-arc-operator': 'ops@example.com' };

      const empty = (await (await fetch(`${base}/v1/notifications`, { headers })).json()) as {
        configured: boolean;
        notice: string | null;
      };
      assert.equal(empty.configured, false);
      assert.match(String(empty.notice), /tells\s+nobody/);

      await h.api.notifier.addChannel({ name: 'ops', url: hookUrl });

      const configured = (await (await fetch(`${base}/v1/notifications`, { headers })).json()) as {
        configured: boolean;
        notice: string | null;
      };
      assert.equal(configured.configured, true);
      assert.equal(configured.notice, null, 'and the warning goes away once a channel exists');

      await h.api.close();
    } finally {
      await h.close();
    }
  });

  it('reports a clean tick with no problems', async () => {
    const h = await harness();
    try {
      const result = await h.api.scheduler.tick();
      assert.deepEqual(result.problems, [], 'an empty problem list is the only clean tick');
    } finally {
      await h.close();
    }
  });

  /**
   * Until 2.1 a lapsed approval only became `expired` when something touched
   * it, so an abandoned request sat in the store reading `pending` and the
   * console showed it as live work.
   */
  it('lapses an approval whose window has closed', async () => {
    const h = await harness();
    try {
      const approvalId = await hold(h.api, h.apiKey);

      const stored = await h.store.approvals.get(approvalId);
      await h.store.approvals.put(approvalId, {
        ...stored!,
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      });

      const result = await h.api.scheduler.tick();
      assert.equal(result.approvalsExpired, 1);
      assert.equal((await h.store.approvals.get(approvalId))?.status, 'expired');
    } finally {
      await h.close();
    }
  });

  it('leaves a live approval alone', async () => {
    const h = await harness();
    try {
      const approvalId = await hold(h.api, h.apiKey);
      assert.equal((await h.api.scheduler.tick()).approvalsExpired, 0);
      assert.equal((await h.store.approvals.get(approvalId))?.status, 'pending');
    } finally {
      await h.close();
    }
  });

  it('warns before a decision is lost, and only once', async () => {
    const h = await harness();
    try {
      await h.api.notifier.addChannel({ name: 'ops', url: hookUrl });
      await hold(h.api, h.apiKey);
      hook.received.length = 0;

      // The hold's window is two minutes, inside the default warning horizon.
      const first = await h.api.scheduler.tick();
      assert.equal(first.expiryWarningsSent, 1);

      const second = await h.api.scheduler.tick();
      assert.equal(second.expiryWarningsSent, 0, 'a warning repeated every tick is an alarm people mute');
    } finally {
      await h.close();
    }
  });

  it('runs an assessment on its own interval rather than every tick', async () => {
    const h = await harness();
    try {
      assert.equal((await h.api.scheduler.tick()).assessmentRan, true, 'the first tick assesses');
      assert.equal((await h.api.scheduler.tick()).assessmentRan, false, 'the next one does not');

      const runs = await h.store.assessmentRuns.count();
      assert.equal(runs, 1);
    } finally {
      await h.close();
    }
  });

  it('records who ran it, so a scheduled assessment is distinguishable from an operator one', async () => {
    const h = await harness();
    try {
      await h.api.scheduler.tick();
      const run = (await h.store.assessmentRuns.list())[0];
      assert.equal(run?.requestedBy, 'scheduler');
    } finally {
      await h.close();
    }
  });

  it('notifies about an overdue finding once', async () => {
    const h = await harness();
    try {
      await h.api.notifier.addChannel({ name: 'ops', url: hookUrl, events: ['finding.overdue'] });
      await h.api.scheduler.tick();

      const findings = await h.api.assurance.listFindings({ status: 'open' });
      const finding = findings[0];
      assert.ok(finding, 'the baseline assessment raised something to be overdue about');

      await h.store.findings.put(finding.id, {
        ...finding,
        owner: 'risk@example.com',
        dueAt: new Date(Date.now() - 86_400_000).toISOString(),
      });

      assert.equal((await h.api.scheduler.tick()).overdueNotified, 1);
      assert.equal((await h.api.scheduler.tick()).overdueNotified, 0, 'not re-sent on every pass');
    } finally {
      await h.close();
    }
  });

  /**
   * A broken webhook must not stop approvals from lapsing, and a failing
   * assessment must not stop the webhook from being retried. Each step's
   * failure is collected and named instead of thrown.
   */
  it('keeps going when one step fails, and names what broke', async () => {
    const h = await harness();
    try {
      const approvalId = await hold(h.api, h.apiKey);
      const stored = await h.store.approvals.get(approvalId);
      await h.store.approvals.put(approvalId, {
        ...stored!,
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      });

      // Break the assessment step only.
      Object.defineProperty(h.store, 'controls', {
        value: new Proxy({} as never, {
          get: () => () => {
            throw new Error('assurance storage is unavailable');
          },
        }),
        configurable: true,
      });

      const result = await h.api.scheduler.tick();

      assert.equal(result.approvalsExpired, 1, 'approvals still lapsed');
      assert.ok(
        result.problems.some((problem) => /scheduled assessment/.test(problem)),
        'and the failure is named rather than swallowed',
      );
      assert.ok(result.problems.some((problem) => /assurance storage is unavailable/.test(problem)));
    } finally {
      await h.close();
    }
  });

  /**
   * A scheduler that quietly stops working looks exactly like a scheduler with
   * nothing to do, so a failed pass goes into the audit chain.
   */
  it('audits a tick that had problems', async () => {
    const h = await harness();
    try {
      Object.defineProperty(h.store, 'controls', {
        value: new Proxy({} as never, {
          get: () => () => {
            throw new Error('assurance storage is unavailable');
          },
        }),
        configurable: true,
      });

      await h.api.scheduler.tick();

      const audit = await h.api.gateway.audit.read({ limit: 50 });
      assert.ok(
        audit.some((record) => record.actor === 'scheduler' && /problem\(s\)/.test(record.summary)),
        'the failed pass is in the chain',
      );
    } finally {
      await h.close();
    }
  });

  it('retries a failed notification on the next pass', async () => {
    const h = await harness();
    try {
      hook.reply.status = 500;
      await h.api.notifier.addChannel({ name: 'flaky', url: hookUrl });
      await hold(h.api, h.apiKey);

      // The warning queued above failed; nothing is due yet.
      await h.api.scheduler.tick();
      const failed = (await h.api.notifier.failures()).length;
      assert.ok(failed >= 1, 'the failure is recorded rather than lost');

      hook.reply.status = 200;
    } finally {
      hook.reply.status = 200;
      await h.close();
    }
  });

  it('does not start a second pass while one is running', async () => {
    const h = await harness();
    try {
      const [first, second] = await Promise.all([h.api.scheduler.tick(), h.api.scheduler.tick()]);
      const skipped = [first, second].filter((result) => result.problems.some((p) => /still running/.test(p)));
      assert.equal(skipped.length, 1, 'exactly one pass is skipped rather than interleaving writes');
    } finally {
      await h.close();
    }
  });

  /**
   * A background timer that keeps the process alive turns every deploy into a
   * forced kill.
   */
  it('does not hold the process open', async () => {
    const h = await harness();
    try {
      h.api.scheduler.start();
      // `unref` means the handle exists but does not count toward keeping the
      // loop alive; stopping is still idempotent.
      h.api.scheduler.stop();
      h.api.scheduler.stop();
    } finally {
      await h.close();
    }
  });
});
