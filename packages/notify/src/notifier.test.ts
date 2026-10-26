import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import type { ArcError } from '@arc-control/schemas';
import { MAX_DELIVERY_ATTEMPTS } from '@arc-control/schemas';
import { MemoryStore } from '@arc-control/store';
import { Notifier } from './notifier.js';

/**
 * Delivered against a real listener, because the failure modes that matter —
 * a 500, a timeout, a connection refused — are properties of the network and
 * not of a mock.
 */

interface Received {
  readonly body: unknown;
  readonly signature: string | undefined;
}

function receiver(): {
  server: Server;
  listen: () => Promise<number>;
  received: Received[];
  /** Status the next request will get. */
  reply: { status: number; hang: boolean };
} {
  const received: Received[] = [];
  const reply = { status: 200, hang: false };

  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      received.push({
        body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown,
        signature: typeof request.headers['x-arc-signature'] === 'string' ? request.headers['x-arc-signature'] : undefined,
      });

      // A hung channel is the realistic bad case: the endpoint accepts the
      // connection and never answers, so a sender without a timeout waits.
      if (reply.hang) return;
      response.writeHead(reply.status);
      response.end();
    });
  });

  return {
    server,
    received,
    reply,
    listen: () =>
      new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          const address = server.address();
          resolve(typeof address === 'object' && address ? address.port : 0);
        });
      }),
  };
}

describe('notification delivery', () => {
  let channel: ReturnType<typeof receiver>;
  let url: string;

  before(async () => {
    channel = receiver();
    const port = await channel.listen();
    url = `http://127.0.0.1:${String(port)}/hook`;
  });

  after(async () => {
    if (channel?.server.listening) await new Promise<void>((resolve) => channel.server.close(() => resolve()));
  });

  function notifier(options: Record<string, unknown> = {}): { notifier: Notifier; store: MemoryStore } {
    const store = new MemoryStore();
    return {
      notifier: new Notifier({ store, consoleUrl: 'https://arc.example.com', ...options }),
      store,
    };
  }

  const approval = {
    event: 'approval.requested' as const,
    subject: 'arc_apr_1',
    summary: 'stripe.refund needs a human: 1 approval from finance-manager',
    path: '/approvals/arc_apr_1',
  };

  it('delivers to an enabled channel and records the delivery', async () => {
    channel.reply.status = 200;
    const { notifier: notify } = notifier();
    await notify.addChannel({ name: 'ops', url });

    const [delivery] = await notify.notify(approval);

    assert.equal(delivery?.status, 'delivered');
    assert.equal(delivery.attempts.length, 1);
    assert.equal(delivery.attempts[0]?.status, 200);
    assert.ok(delivery.deliveredAt, 'the time it landed is recorded');
  });

  it('includes a link so the message says where to act, not just what happened', async () => {
    channel.reply.status = 200;
    const { notifier: notify } = notifier();
    await notify.addChannel({ name: 'ops', url });
    channel.received.length = 0;

    await notify.notify(approval);
    const body = channel.received[0]?.body as Record<string, unknown>;
    assert.equal(body.url, 'https://arc.example.com/approvals/arc_apr_1');
  });

  it('sends a chat-shaped payload to a slack channel', async () => {
    channel.reply.status = 200;
    const { notifier: notify } = notifier();
    await notify.addChannel({ name: 'chat', url, format: 'slack' });
    channel.received.length = 0;

    await notify.notify(approval);
    const body = channel.received[0]?.body as Record<string, unknown>;
    assert.match(String(body.text), /needs a human/);
    assert.match(String(body.text), /arc\.example\.com/);
  });

  /**
   * A notification leaves the deployment and lands somewhere with its own
   * membership. "Redacted" is not "safe to post in a chat workspace": a tool
   * name, an amount and a customer reference together are a disclosure with
   * every secret already removed.
   */
  it('withholds action parameters unless the channel asked for them', async () => {
    channel.reply.status = 200;
    const { notifier: notify } = notifier();
    await notify.addChannel({ name: 'quiet', url });
    channel.received.length = 0;

    await notify.notify({ ...approval, parameters: { amount: 25_000, customer: 'cus_123' } });

    const body = channel.received[0]?.body as Record<string, unknown>;
    assert.ok(!('parameters' in body), 'parameters are not sent by default');
    assert.ok(!JSON.stringify(body).includes('cus_123'));
  });

  it('includes them when it did', async () => {
    channel.reply.status = 200;
    const { notifier: notify } = notifier();
    await notify.addChannel({ name: 'verbose', url, includeParameters: true });
    channel.received.length = 0;

    await notify.notify({ ...approval, parameters: { amount: 25_000 } });
    const body = channel.received[0]?.body as Record<string, unknown>;
    assert.deepEqual(body.parameters, { amount: 25_000 });
  });

  it('signs a generic payload so a receiver can verify it', async () => {
    channel.reply.status = 200;
    const { notifier: notify } = notifier({ signingSecret: 'secret-value' });
    await notify.addChannel({ name: 'ops', url });
    channel.received.length = 0;

    await notify.notify(approval);
    assert.match(String(channel.received[0]?.signature), /^sha256=[0-9a-f]{64}$/);
  });

  it('sends only the events a channel asked for', async () => {
    channel.reply.status = 200;
    const { notifier: notify } = notifier();
    await notify.addChannel({ name: 'findings-only', url, events: ['finding.overdue'] });

    assert.equal((await notify.notify(approval)).length, 0, 'an uninterested channel gets nothing');
    assert.equal(
      (await notify.notify({ event: 'finding.overdue', subject: 'arc_fnd_1', summary: 'late' })).length,
      1,
    );
  });

  it('sends nothing to a disabled channel', async () => {
    channel.reply.status = 200;
    const { notifier: notify } = notifier();
    const added = await notify.addChannel({ name: 'ops', url });
    await notify.setChannelEnabled(added.id, false);

    assert.equal((await notify.notify(approval)).length, 0);
  });

  it('refuses a plaintext destination, so approval metadata is not sent in clear', async () => {
    const { notifier: notify } = notifier();
    await assert.rejects(
      () => notify.addChannel({ name: 'insecure', url: 'http://hooks.example.com/x' }),
      (error: ArcError) => error.code === 'invalid_request' && /use https/.test(error.message),
    );
  });

  it('allows a loopback destination so a deployment can test locally', async () => {
    const { notifier: notify } = notifier();
    assert.ok(await notify.addChannel({ name: 'local', url }));
  });
});

/**
 * The rule that makes this worth building: a delivery that failed is not a
 * notification. Fire-and-forget is worse than no webhook, because it creates
 * the belief that somebody was told.
 */
describe('a failed delivery is recorded, not lost', () => {
  let channel: ReturnType<typeof receiver>;
  let url: string;

  before(async () => {
    channel = receiver();
    const port = await channel.listen();
    url = `http://127.0.0.1:${String(port)}/hook`;
  });

  after(async () => {
    if (channel?.server.listening) await new Promise<void>((resolve) => channel.server.close(() => resolve()));
  });

  const approval = { event: 'approval.requested' as const, subject: 'arc_apr_1', summary: 'needs a human' };

  it('records a rejecting channel as failed, with the status it returned', async () => {
    channel.reply.status = 500;
    const store = new MemoryStore();
    const notify = new Notifier({ store });
    await notify.addChannel({ name: 'broken', url });

    const [delivery] = await notify.notify(approval);

    assert.equal(delivery?.status, 'failed');
    assert.equal(delivery.attempts[0]?.status, 500);
    assert.match(String(delivery.attempts[0]?.error), /HTTP 500/);
    assert.ok(delivery.nextAttemptAt, 'and it is scheduled to be retried');
  });

  it('records an unreachable channel rather than throwing at the caller', async () => {
    const store = new MemoryStore();
    const notify = new Notifier({ store });
    // Nothing is listening on this port.
    await notify.addChannel({ name: 'gone', url: 'https://127.0.0.1:1/hook' });

    const [delivery] = await notify.notify(approval);
    assert.equal(delivery?.status, 'failed');
    assert.ok(delivery.attempts[0]?.error, 'the reason is recorded');
  });

  it('gives up on a channel that never answers, rather than waiting on it', async () => {
    channel.reply.hang = true;
    const store = new MemoryStore();
    const notify = new Notifier({ store, timeoutMs: 150 });
    await notify.addChannel({ name: 'hung', url });

    const [delivery] = await notify.notify(approval);
    channel.reply.hang = false;

    assert.equal(delivery?.status, 'failed');
    assert.match(String(delivery.attempts[0]?.error), /did not respond within/);
  });

  it('retries on the sweep and succeeds once the channel recovers', async () => {
    channel.reply.status = 500;
    const store = new MemoryStore();
    let now = Date.parse('2026-06-15T12:00:00.000Z');
    const notify = new Notifier({ store, now: () => new Date(now) });
    await notify.addChannel({ name: 'flaky', url });

    const [first] = await notify.notify(approval);
    assert.equal(first?.status, 'failed');

    // Too soon: the backoff has not elapsed, so the sweep leaves it alone.
    assert.equal((await notify.sweep()).attempted, 0, 'the backoff is respected');

    now += 60_000;
    channel.reply.status = 200;
    const swept = await notify.sweep();

    assert.equal(swept.attempted, 1);
    assert.equal(swept.delivered, 1);
    assert.equal((await store.notificationDeliveries.get(first.id))?.status, 'delivered');
  });

  /**
   * After the budget is spent the record says nobody was told. That is the
   * sentence an operator needs; a record stuck on "pending" forever would
   * overstate what the queue is going to achieve.
   */
  it('abandons a delivery after its last attempt and says so', async () => {
    channel.reply.status = 500;
    const store = new MemoryStore();
    let now = Date.parse('2026-06-15T12:00:00.000Z');
    const notify = new Notifier({ store, now: () => new Date(now) });
    await notify.addChannel({ name: 'dead', url });

    const [delivery] = await notify.notify(approval);

    for (let attempt = 1; attempt < MAX_DELIVERY_ATTEMPTS; attempt += 1) {
      now += 20 * 60_000;
      await notify.sweep();
    }

    const final = await store.notificationDeliveries.get(delivery!.id);
    assert.equal(final?.status, 'abandoned');
    assert.equal(final.attempts.length, MAX_DELIVERY_ATTEMPTS);
    assert.equal(final.nextAttemptAt, undefined, 'it is not pretending another attempt is coming');
  });

  it('abandons a delivery whose channel has been deleted', async () => {
    channel.reply.status = 500;
    const store = new MemoryStore();
    let now = Date.parse('2026-06-15T12:00:00.000Z');
    const notify = new Notifier({ store, now: () => new Date(now) });
    const added = await notify.addChannel({ name: 'temporary', url });

    const [delivery] = await notify.notify(approval);
    await store.notificationChannels.delete(added.id);

    now += 60_000;
    assert.equal((await notify.sweep()).abandoned, 1);

    const final = await store.notificationDeliveries.get(delivery!.id);
    assert.equal(final?.status, 'abandoned');
    assert.match(String(final.attempts.at(-1)?.error), /no longer exists/);
  });

  /**
   * The retry is the attempt that actually reaches somebody, so it is the one
   * that most needs the link. `sweep` rebuilt the payload from the delivery
   * record, which did not store the path — so the message that arrived was
   * the one that could not say where to act.
   */
  it('keeps the console link on a retry', async () => {
    channel.reply.status = 500;
    const store = new MemoryStore();
    let now = Date.parse('2026-06-15T12:00:00.000Z');
    const notify = new Notifier({
      store,
      consoleUrl: 'https://arc.example.com',
      now: () => new Date(now),
    });
    await notify.addChannel({ name: 'flaky', url });

    await notify.notify({
      event: 'approval.requested',
      subject: 'arc_apr_1',
      summary: 'needs a human',
      path: '/approvals/arc_apr_1',
      details: { tool: 'stripe.refund' },
    });

    now += 60_000;
    channel.reply.status = 200;
    channel.received.length = 0;
    assert.equal((await notify.sweep()).delivered, 1);

    const body = channel.received[0]?.body as Record<string, unknown>;
    assert.equal(body.url, 'https://arc.example.com/approvals/arc_apr_1', 'the retry carries the link');
    assert.deepEqual(body.details, { tool: 'stripe.refund' });
  });

  /**
   * Parameters are the one field deliberately not kept on the record, so they
   * are not replayed either: a delivery row is something an operator browses,
   * and it must not become a second copy of an action's arguments.
   */
  it('does not persist action parameters onto the delivery record', async () => {
    channel.reply.status = 500;
    const store = new MemoryStore();
    const notify = new Notifier({ store });
    await notify.addChannel({ name: 'ops', url, includeParameters: true });

    const [delivery] = await notify.notify({
      event: 'approval.requested',
      subject: 'arc_apr_1',
      summary: 'needs a human',
      parameters: { amount: 25_000, customer: 'cus_secret' },
    });

    const stored = JSON.stringify(await store.notificationDeliveries.get(delivery!.id));
    assert.ok(!stored.includes('cus_secret'), 'a delivery row is not a copy of the action');
    assert.ok(!stored.includes('25000'));
  });

  /**
   * Deduplication used to read a page of recent deliveries, which held until
   * that window rolled off — after which every overdue finding was announced
   * again on every tick, forever.
   */
  it('remembers a subject was notified however many deliveries came after', async () => {
    channel.reply.status = 200;
    const store = new MemoryStore();
    const notify = new Notifier({ store });
    await notify.addChannel({ name: 'ops', url });

    await notify.notify({ event: 'finding.overdue', subject: 'arc_fnd_first', summary: 'late' });

    // More than any page size the caller might have used.
    for (let index = 0; index < 60; index += 1) {
      await notify.notify({ event: 'finding.overdue', subject: `arc_fnd_${String(index)}`, summary: 'late' });
    }

    assert.equal(await notify.hasNotified('finding.overdue', 'arc_fnd_first'), true);
    assert.equal(await notify.hasNotified('finding.overdue', 'arc_fnd_never'), false);
    assert.equal(
      await notify.hasNotified('approval.expiring', 'arc_fnd_first'),
      false,
      'and it is keyed on the event as well as the subject',
    );
  });

  it('lists failures, so a webhook that has been broken for a week is visible', async () => {
    channel.reply.status = 500;
    const store = new MemoryStore();
    const notify = new Notifier({ store });
    await notify.addChannel({ name: 'broken', url });

    await notify.notify(approval);
    await notify.notify({ ...approval, subject: 'arc_apr_2' });

    assert.equal((await notify.failures()).length, 2);
  });

  /**
   * The record is written before the request, so a crash mid-send leaves a
   * pending record the sweep retries rather than a notification nobody can
   * account for.
   */
  it('writes the record before attempting, so a crash cannot lose it', async () => {
    const store = new MemoryStore();
    const notify = new Notifier({
      store,
      fetch: () => {
        throw new Error('process died mid-send');
      },
    });
    await notify.addChannel({ name: 'ops', url });

    await notify.notify(approval);
    assert.equal(await store.notificationDeliveries.count(), 1, 'the attempt is accounted for');
  });
});
