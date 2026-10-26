import { createHmac } from 'node:crypto';
import {
  ArcError,
  MAX_DELIVERY_ATTEMPTS,
  backoffMs,
  isDeliverable,
  newId,
  type DeliveryAttempt,
  type NotificationChannel,
  type NotificationDelivery,
  type NotificationEvent,
} from '@arc-control/schemas';
import type { ControlStore } from '@arc-control/store';

/**
 * Outbound delivery.
 *
 * Every send produces a durable record before the request is made, so a
 * notification that never arrives leaves a trace rather than nothing. The
 * record is the deliverable: a webhook that has been quietly failing for a
 * week is a governance failure, and it should be as visible as a failing
 * control.
 */

export interface NotifierOptions {
  readonly store: ControlStore;
  readonly organizationId?: string;
  /**
   * Base URL of the console, used to build the link in each message.
   *
   * Without it a notification can say what happened but not where to act on
   * it, which is most of its value.
   */
  readonly consoleUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => Date;
  readonly timeoutMs?: number;
  /** Secret used to sign generic webhook payloads so a receiver can verify them. */
  readonly signingSecret?: string;
}

/** What a caller hands over. The notifier turns this into one record per channel. */
export interface NotificationInput {
  readonly event: NotificationEvent;
  /** The object this is about: an approval id, a finding id, a control id. */
  readonly subject: string;
  /** One line, already written for a human. */
  readonly summary: string;
  /** Path on the console where this can be acted on, e.g. `/approvals/arc_apr_…`. */
  readonly path?: string;
  /**
   * Extra fields for the structured payload.
   *
   * Must already be safe to leave the deployment. The notifier does not redact:
   * a component that silently decides what is safe to publish is a component
   * that will one day decide wrongly, so the caller states it explicitly.
   */
  readonly details?: Readonly<Record<string, unknown>>;
  /** Redacted action parameters, sent only to channels that asked for them. */
  readonly parameters?: Readonly<Record<string, unknown>>;
}

export class Notifier {
  readonly #store: ControlStore;
  readonly #organizationId: string;
  readonly #consoleUrl: string | undefined;
  readonly #fetch: typeof globalThis.fetch;
  readonly #now: () => Date;
  readonly #timeoutMs: number;
  readonly #signingSecret: string | undefined;

  constructor(options: NotifierOptions) {
    this.#store = options.store;
    this.#organizationId = options.organizationId ?? 'default';
    this.#consoleUrl = options.consoleUrl?.replace(/\/$/, '');
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? (() => new Date());
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#signingSecret = options.signingSecret;
  }

  async channels(): Promise<readonly NotificationChannel[]> {
    return this.#store.notificationChannels.list();
  }

  async addChannel(input: {
    readonly name: string;
    readonly url: string;
    readonly format?: 'slack' | 'generic';
    readonly events?: readonly NotificationEvent[];
    readonly includeParameters?: boolean;
  }): Promise<NotificationChannel> {
    let parsed: URL;
    try {
      parsed = new URL(input.url);
    } catch {
      throw new ArcError('invalid_request', `"${input.url}" is not a valid URL`);
    }

    // A plaintext destination would put approval metadata on the wire in
    // clear. Loopback is allowed so a deployment can test against something
    // local without turning the check off everywhere.
    if (parsed.protocol !== 'https:' && !isLoopback(parsed.hostname)) {
      throw new ArcError(
        'invalid_request',
        `refusing to send notifications to ${parsed.protocol}//${parsed.hostname}; use https`,
      );
    }

    const channel: NotificationChannel = {
      id: newId('channel'),
      name: input.name,
      url: input.url,
      format: input.format ?? 'generic',
      events: input.events ?? [],
      ...(input.includeParameters === true ? { includeParameters: true } : {}),
      enabled: true,
      createdAt: this.#now().toISOString(),
    };

    await this.#store.notificationChannels.put(channel.id, channel);
    return channel;
  }

  async setChannelEnabled(channelId: string, enabled: boolean): Promise<NotificationChannel> {
    const channel = await this.#store.notificationChannels.get(channelId);
    if (!channel) throw new ArcError('not_found', `no notification channel with id ${channelId}`);

    const updated: NotificationChannel = { ...channel, enabled };
    await this.#store.notificationChannels.put(updated.id, updated);
    return updated;
  }

  /**
   * Queues one notification per interested channel and attempts each once.
   *
   * Returns the delivery records rather than a boolean: the caller usually
   * does not care whether it worked, but the record has to exist either way,
   * and a caller that does care can read the status.
   */
  async notify(input: NotificationInput): Promise<readonly NotificationDelivery[]> {
    const channels = (await this.channels()).filter(
      (channel) => channel.enabled && (channel.events.length === 0 || channel.events.includes(input.event)),
    );

    const deliveries: NotificationDelivery[] = [];
    for (const channel of channels) {
      const delivery: NotificationDelivery = {
        id: newId('delivery'),
        organizationId: this.#organizationId,
        event: input.event,
        channelId: channel.id,
        channelName: channel.name,
        subject: input.subject,
        summary: input.summary,
        status: 'pending',
        attempts: [],
        createdAt: this.#now().toISOString(),
      };

      // Written before the request, so a crash mid-send leaves a pending
      // record the sweep will retry rather than a notification nobody can
      // account for.
      await this.#store.notificationDeliveries.put(delivery.id, delivery);
      deliveries.push(await this.#attempt(delivery, channel, input));
    }

    return deliveries;
  }

  /**
   * Retries deliveries that are due.
   *
   * Driven by the scheduler rather than in-process timers: a timer per failed
   * delivery is unbounded state that does not survive a restart, and a restart
   * is exactly when a lot of deliveries are pending.
   */
  async sweep(): Promise<{ readonly attempted: number; readonly delivered: number; readonly abandoned: number }> {
    const now = this.#now().getTime();
    const due = (await this.#store.notificationDeliveries.list()).filter((delivery) =>
      isDeliverable(delivery, now),
    );

    let delivered = 0;
    let abandoned = 0;

    for (const delivery of due) {
      const channel = await this.#store.notificationChannels.get(delivery.channelId);
      if (!channel || !channel.enabled) {
        // The channel is gone or switched off. Abandoning is the honest
        // outcome: this will never be delivered, and leaving it pending would
        // overstate what the queue is going to achieve.
        await this.#finish(delivery, 'abandoned', {
          at: new Date(now).toISOString(),
          error: channel ? 'the channel is disabled' : 'the channel no longer exists',
          durationMs: 0,
        });
        abandoned += 1;
        continue;
      }

      const result = await this.#attempt(delivery, channel, {
        event: delivery.event,
        subject: delivery.subject,
        summary: delivery.summary,
      });

      if (result.status === 'delivered') delivered += 1;
      if (result.status === 'abandoned') abandoned += 1;
    }

    return { attempted: due.length, delivered, abandoned };
  }

  /** Deliveries nobody received, which an operator needs to see. */
  async failures(): Promise<readonly NotificationDelivery[]> {
    return this.#store.notificationDeliveries.filter(
      (delivery) => delivery.status === 'abandoned' || delivery.status === 'failed',
    );
  }

  async deliveries(limit = 50): Promise<readonly NotificationDelivery[]> {
    const all = await this.#store.notificationDeliveries.list();
    return [...all].sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, limit);
  }

  async #attempt(
    delivery: NotificationDelivery,
    channel: NotificationChannel,
    input: NotificationInput,
  ): Promise<NotificationDelivery> {
    const body = this.#payload(channel, input);
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);

    let attempt: DeliveryAttempt;
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (this.#signingSecret !== undefined && channel.format === 'generic') {
        // Lets a receiver verify the payload came from this deployment, which
        // matters because a webhook URL is often the only thing protecting it.
        headers['x-arc-signature'] = `sha256=${createHmac('sha256', this.#signingSecret)
          .update(body, 'utf8')
          .digest('hex')}`;
      }

      const response = await this.#fetch(channel.url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });

      attempt = {
        at: this.#now().toISOString(),
        status: response.status,
        durationMs: Date.now() - started,
        ...(response.ok ? {} : { error: `the channel returned HTTP ${String(response.status)}` }),
      };

      if (response.ok) return this.#finish(delivery, 'delivered', attempt);
    } catch (cause) {
      attempt = {
        at: this.#now().toISOString(),
        durationMs: Date.now() - started,
        error: controller.signal.aborted
          ? `the channel did not respond within ${String(this.#timeoutMs)}ms`
          : describe(cause),
      };
    } finally {
      clearTimeout(timer);
    }

    const attempts = delivery.attempts.length + 1;
    return attempts >= MAX_DELIVERY_ATTEMPTS
      ? this.#finish(delivery, 'abandoned', attempt)
      : this.#finish(delivery, 'failed', attempt);
  }

  async #finish(
    delivery: NotificationDelivery,
    status: NotificationDelivery['status'],
    attempt: DeliveryAttempt,
  ): Promise<NotificationDelivery> {
    const attempts = [...delivery.attempts, attempt];

    // `nextAttemptAt` is dropped rather than carried forward. Spreading the
    // previous record kept it on a delivered or abandoned one, so the record
    // read as though another attempt were coming when none was — a small lie,
    // in exactly the field an operator would use to decide whether to wait.
    const { nextAttemptAt: _previous, ...rest } = delivery;
    const updated: NotificationDelivery = {
      ...rest,
      status,
      attempts,
      ...(status === 'delivered' ? { deliveredAt: attempt.at } : {}),
      ...(status === 'failed'
        ? { nextAttemptAt: new Date(Date.parse(attempt.at) + backoffMs(attempts.length)).toISOString() }
        : {}),
    };

    await this.#store.notificationDeliveries.put(updated.id, updated);
    return updated;
  }

  #payload(channel: NotificationChannel, input: NotificationInput): string {
    const link = this.#consoleUrl !== undefined && input.path !== undefined ? `${this.#consoleUrl}${input.path}` : undefined;

    if (channel.format === 'slack') {
      // Chat providers render `text`. Kept to one line plus a link, because a
      // notification that needs reading twice does not get read once.
      return JSON.stringify({ text: link === undefined ? input.summary : `${input.summary}\n${link}` });
    }

    return JSON.stringify({
      event: input.event,
      subject: input.subject,
      summary: input.summary,
      occurredAt: this.#now().toISOString(),
      organizationId: this.#organizationId,
      ...(link === undefined ? {} : { url: link }),
      ...(input.details === undefined ? {} : { details: input.details }),
      // Only where the channel asked. Redacted is not the same as safe to post
      // in a chat workspace: a tool name, an amount and a customer reference
      // together are a disclosure with every secret already removed.
      ...(channel.includeParameters === true && input.parameters !== undefined
        ? { parameters: input.parameters }
        : {}),
    });
  }
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}
