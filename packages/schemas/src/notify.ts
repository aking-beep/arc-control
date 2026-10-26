/**
 * Telling somebody.
 *
 * The 2.0 console said, in those words, "this page is the notification". That
 * was honest and it was also the first complaint anyone deploying it would
 * have: an approval nobody is told about waits until somebody happens to look,
 * and the queue a governance product exists to drain instead fills up.
 *
 * Two rules shape what is here.
 *
 * **A delivery that failed is not a notification.** Fire-and-forget to a
 * webhook is worse than no webhook, because it creates the belief that someone
 * was told. Every attempt is recorded, a failing channel is visible, and the
 * platform can say "nobody was told" as clearly as it says "nobody approved".
 *
 * **A notification leaves the trust boundary.** It lands in a chat workspace
 * with its own membership and retention, so the default payload carries
 * metadata and a link and no action parameters at all. An operator who wants
 * the amount in the message has to ask for it.
 */

export type NotificationEvent =
  /** A human is needed before an action can proceed. */
  | 'approval.requested'
  /** An approval window is about to close with nobody having voted. */
  | 'approval.expiring'
  /** A remediation deadline has passed. */
  | 'finding.overdue'
  /** An assessment run found a control failing. */
  | 'assessment.failed'
  /** The audit chain did not verify. */
  | 'audit.chain_invalid';

export const NOTIFICATION_EVENTS: readonly NotificationEvent[] = [
  'approval.requested',
  'approval.expiring',
  'finding.overdue',
  'assessment.failed',
  'audit.chain_invalid',
] as const;

/** Where a notification goes. */
export interface NotificationChannel {
  readonly id: string;
  readonly name: string;
  /** HTTPS endpoint. A chat provider's incoming webhook, or anything that accepts JSON. */
  readonly url: string;
  /**
   * Payload shape. `slack` sends a `text` field, which chat providers render;
   * `generic` sends the structured event.
   */
  readonly format: 'slack' | 'generic';
  /** Events this channel wants. An empty list means every event. */
  readonly events: readonly NotificationEvent[];
  /**
   * Whether redacted action parameters may be included.
   *
   * Off by default. Parameters are redacted before they reach evidence, but
   * "redacted" is not "safe to post in a chat workspace": a tool name plus an
   * amount plus a customer reference is a disclosure even with the secrets
   * removed.
   */
  readonly includeParameters?: boolean;
  readonly enabled: boolean;
  readonly createdAt: string;
}

export type DeliveryStatus =
  | 'pending'
  | 'delivered'
  /** Failed and still inside its retry budget. */
  | 'failed'
  /** Failed its last attempt. Nobody was told, and this record says so. */
  | 'abandoned';

export interface DeliveryAttempt {
  readonly at: string;
  /** HTTP status, when a response arrived. */
  readonly status?: number;
  readonly error?: string;
  readonly durationMs: number;
}

/**
 * One attempt to tell one channel about one event.
 *
 * Durable, because the question "was anyone actually told about this approval"
 * has to be answerable afterwards, and because an operator needs to find a
 * broken webhook without reading application logs.
 */
export interface NotificationDelivery {
  readonly id: string;
  readonly organizationId: string;
  readonly event: NotificationEvent;
  readonly channelId: string;
  readonly channelName: string;
  /** What the notification was about: an approval id, a finding id, a control id. */
  readonly subject: string;
  /** The human-readable line that was sent, kept so the record shows what was said. */
  readonly summary: string;
  readonly status: DeliveryStatus;
  /**
   * Console path this was about, kept so a retry can rebuild the same message.
   *
   * Without it a retry that succeeds carries no link — so the attempt that
   * actually reaches somebody is the one that cannot tell them where to act,
   * which is most of a notification's value.
   */
  readonly path?: string;
  /** Structured fields sent with the original, kept for the same reason. */
  readonly details?: Readonly<Record<string, unknown>>;
  readonly attempts: readonly DeliveryAttempt[];
  readonly createdAt: string;
  readonly deliveredAt?: string;
  /** When the next attempt becomes due. Absent once delivered or abandoned. */
  readonly nextAttemptAt?: string;
}

/** Whether a delivery should be attempted again. */
export function isDeliverable(delivery: NotificationDelivery, now: number): boolean {
  if (delivery.status !== 'pending' && delivery.status !== 'failed') return false;
  if (delivery.nextAttemptAt === undefined) return true;
  return Date.parse(delivery.nextAttemptAt) <= now;
}

/** Attempts before a delivery is abandoned. */
export const MAX_DELIVERY_ATTEMPTS = 5;

/**
 * Backoff before attempt `n`, in milliseconds.
 *
 * Exponential from thirty seconds, capped so a notification that is still
 * useful is not deferred past the point of being useful. An approval nobody
 * hears about for an hour may as well not have been sent.
 */
export function backoffMs(attempt: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempt - 1), 15 * 60_000);
}
