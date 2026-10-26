import { ArcError, NOTIFICATION_EVENTS, type NotificationEvent } from '@arc-control/schemas';
import type { Notifier } from '@arc-control/notify';
import type { Gateway } from '@arc-control/gateway';
import { withStatus, type Router } from './http.js';
import type { OperatorAuth } from './operator.js';
import type { Scheduler } from './scheduler.js';

export interface NotificationRouteOptions {
  readonly gateway: Gateway;
  readonly operators: OperatorAuth;
  readonly notifier?: Notifier;
  readonly scheduler?: Scheduler;
}

/**
 * Notification administration, and the record of what was delivered.
 *
 * The delivery list is the point rather than an extra: a product that sends
 * webhooks and cannot tell you which ones failed has moved the problem rather
 * than solved it.
 */
export function addNotificationRoutes(router: Router, options: NotificationRouteOptions): Router {
  const { gateway, operators, notifier, scheduler } = options;

  /** Always present, so the console can say plainly that nothing is configured. */
  router.get('/v1/notifications', async (context) => {
    await operators.authenticate(context);

    if (notifier === undefined) {
      return {
        configured: false,
        channels: [],
        deliveries: [],
        failures: 0,
        notice:
          'No notification channel is configured, so ARC surfaces approvals and deadlines in this console and ' +
          'tells nobody. Add a channel to change that.',
      };
    }

    const [channels, deliveries, failures] = await Promise.all([
      notifier.channels(),
      notifier.deliveries(50),
      notifier.failures(),
    ]);

    return {
      configured: channels.some((channel) => channel.enabled),
      channels,
      deliveries,
      failures: failures.length,
      /**
       * Stated rather than left for a reader to count, because an undelivered
       * notification is the failure mode that looks like success.
       */
      notice:
        failures.length === 0
          ? null
          : `${String(failures.length)} notification(s) were not delivered. Anyone relying on them was not told.`,
    };
  });

  router.post('/v1/notifications/channels', async (context) => {
    const operator = await operators.authenticate(context);
    if (notifier === undefined) {
      throw new ArcError('invalid_request', 'notifications are not enabled on this deployment');
    }

    const body = await context.body<{
      name?: string;
      url?: string;
      format?: string;
      events?: unknown;
      includeParameters?: boolean;
    }>();

    if (typeof body.name !== 'string' || !body.name) throw new ArcError('invalid_request', 'name is required');
    if (typeof body.url !== 'string' || !body.url) throw new ArcError('invalid_request', 'url is required');

    if (body.format !== undefined && body.format !== 'slack' && body.format !== 'generic') {
      throw new ArcError('invalid_request', 'format must be "slack" or "generic"');
    }

    const events: NotificationEvent[] = [];
    if (Array.isArray(body.events)) {
      for (const entry of body.events) {
        if (!NOTIFICATION_EVENTS.includes(entry as NotificationEvent)) {
          throw new ArcError(
            'invalid_request',
            `"${String(entry)}" is not a notification event; expected one of ${NOTIFICATION_EVENTS.join(', ')}`,
          );
        }
        events.push(entry as NotificationEvent);
      }
    }

    const channel = await notifier.addChannel({
      name: body.name,
      url: body.url,
      ...(body.format ? { format: body.format } : {}),
      ...(events.length > 0 ? { events } : {}),
      ...(body.includeParameters === true ? { includeParameters: true } : {}),
    });

    // Adding a destination for governance events is itself a governance
    // change: it decides who learns about approvals and failures.
    await gateway.audit.append({
      type: 'control.updated',
      organizationId: 'default',
      actor: operator.identifier,
      subject: channel.id,
      summary: `${operator.identifier} added notification channel "${channel.name}"`,
      data: {
        channelId: channel.id,
        // The host, not the URL: a webhook URL is a credential, and an audit
        // record is exported.
        host: safeHost(channel.url),
        events: channel.events,
        includeParameters: channel.includeParameters === true,
      },
    });

    return withStatus(201, channel);
  });

  router.post('/v1/notifications/channels/:id/disable', async (context) => {
    const operator = await operators.authenticate(context);
    if (notifier === undefined) {
      throw new ArcError('invalid_request', 'notifications are not enabled on this deployment');
    }

    const channel = await notifier.setChannelEnabled(context.params.id!, false);
    await gateway.audit.append({
      type: 'control.updated',
      organizationId: 'default',
      actor: operator.identifier,
      subject: channel.id,
      summary: `${operator.identifier} disabled notification channel "${channel.name}"`,
      data: { channelId: channel.id },
    });

    return channel;
  });

  router.post('/v1/notifications/channels/:id/enable', async (context) => {
    const operator = await operators.authenticate(context);
    if (notifier === undefined) {
      throw new ArcError('invalid_request', 'notifications are not enabled on this deployment');
    }

    const channel = await notifier.setChannelEnabled(context.params.id!, true);
    await gateway.audit.append({
      type: 'control.updated',
      organizationId: 'default',
      actor: operator.identifier,
      subject: channel.id,
      summary: `${operator.identifier} enabled notification channel "${channel.name}"`,
      data: { channelId: channel.id },
    });

    return channel;
  });

  /**
   * Runs one scheduler pass now.
   *
   * Exists so an operator can retry a broken webhook without waiting for the
   * next tick, and so the scheduler is observable rather than a black box.
   */
  router.post('/v1/scheduler/run', async (context) => {
    await operators.authenticate(context);
    if (scheduler === undefined) {
      throw new ArcError('invalid_request', 'the scheduler is not running on this deployment');
    }
    return scheduler.tick();
  });

  return router;
}

/** The host of a webhook URL. The rest is a credential. */
function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'unparseable';
  }
}
