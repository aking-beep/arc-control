import type { AssuranceEngine } from '@arc-control/assurance';
import type { Gateway } from '@arc-control/gateway';
import type { Notifier } from '@arc-control/notify';
import type { SessionManager } from '@arc-control/operator-identity';
import type { NotificationEvent } from '@arc-control/schemas';
import type { SpendMonitor } from '@arc-control/spend';

/**
 * The unattended half of the product.
 *
 * ARC 2.0 did everything on request: assessments ran when somebody asked,
 * approvals lapsed only when something touched them, and nothing was ever
 * sent anywhere. That is a tool. A product has to work while nobody is
 * looking, because the whole premise is governing agents that act on their
 * own schedule rather than ours.
 *
 * The design rule here is that **a run that failed must not look like a run
 * that passed**. Every tick records what it did, a failure is audited rather
 * than swallowed, and a tick that could not assess reports that rather than
 * leaving yesterday's assessment standing as though it were current.
 */

export interface SchedulerOptions {
  readonly gateway: Gateway;
  readonly assurance: AssuranceEngine;
  readonly notifier?: Notifier;
  readonly sessions?: SessionManager;
  /**
   * Pulls verified spend from providers and acts on runaways (2.3). Absent
   * unless a provider is configured: no provider, no ingestion.
   */
  readonly spendMonitor?: Pick<SpendMonitor, 'tick'>;
  /** How often a tick runs. */
  readonly intervalMs?: number;
  /** How often a full assessment runs. Longer than a tick: assessments are not free. */
  readonly assessmentIntervalMs?: number;
  /** How long before an approval lapses to warn about it. */
  readonly expiryWarningMs?: number;
  /** Sessions whose expiry is older than this are deleted. */
  readonly sessionRetentionMs?: number;
  readonly now?: () => Date;
  /** Where a failure goes when there is nothing else to tell. Defaults to stderr. */
  readonly onError?: (error: unknown) => void;
}

export interface TickResult {
  readonly at: string;
  readonly approvalsExpired: number;
  readonly expiryWarningsSent: number;
  readonly assessmentRan: boolean;
  readonly controlsFailing: number;
  readonly overdueNotified: number;
  readonly deliveriesAttempted: number;
  readonly deliveriesAbandoned: number;
  readonly sessionsPruned: number;
  /** Provider spend rows recorded this tick. */
  readonly spendIngested: number;
  /** Agents whose spend spiked this tick. */
  readonly spendIncidents: number;
  /** Anything that went wrong, named. An empty list is the only clean tick. */
  readonly problems: readonly string[];
}

const MINUTE = 60_000;

export class Scheduler {
  readonly #options: SchedulerOptions;
  readonly #now: () => Date;
  #timer: NodeJS.Timeout | undefined;
  #lastAssessmentAt = 0;
  #running = false;

  constructor(options: SchedulerOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
  }

  get intervalMs(): number {
    return this.#options.intervalMs ?? 5 * MINUTE;
  }

  /**
   * Starts ticking.
   *
   * `unref` so the timer never keeps a process alive on its own: a scheduler
   * that prevents a clean shutdown turns every deploy into a forced kill.
   */
  start(): void {
    if (this.#timer !== undefined) return;

    this.#timer = setInterval(() => {
      void this.tick().catch((cause: unknown) => this.#report(cause));
    }, this.intervalMs);

    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer === undefined) return;
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /**
   * One pass. The testable unit: `start` only puts this on a timer, so no test
   * needs to wait for wall-clock time.
   *
   * Each step is independent and its failure is collected rather than thrown,
   * because a broken webhook must not stop approvals from expiring and a
   * failing assessment must not stop the webhook from being retried.
   */
  async tick(): Promise<TickResult> {
    // One pass at a time. A slow assessment overlapping the next tick would
    // double the work and interleave writes for no benefit.
    if (this.#running) {
      return this.#empty(['a previous tick was still running, so this one was skipped']);
    }
    this.#running = true;

    const problems: string[] = [];
    let approvalsExpired = 0;
    let expiryWarningsSent = 0;
    let assessmentRan = false;
    let controlsFailing = 0;
    let overdueNotified = 0;
    let deliveriesAttempted = 0;
    let deliveriesAbandoned = 0;
    let sessionsPruned = 0;
    let spendIngested = 0;
    let spendIncidents = 0;

    try {
      // 1. Warn before a decision is lost, not after.
      try {
        expiryWarningsSent = await this.#warnAboutExpiring();
      } catch (cause) {
        problems.push(`could not warn about expiring approvals: ${describe(cause)}`);
      }

      // 2. Then lapse the ones whose window has closed, so the queue reflects
      //    reality rather than who last looked at it.
      try {
        approvalsExpired = (await this.#options.gateway.approvals.expireDue()).length;
      } catch (cause) {
        problems.push(`could not expire lapsed approvals: ${describe(cause)}`);
      }

      try {
        const assessment = await this.#assessIfDue();
        assessmentRan = assessment.ran;
        controlsFailing = assessment.failing;
      } catch (cause) {
        problems.push(`could not run the scheduled assessment: ${describe(cause)}`);
      }

      try {
        overdueNotified = await this.#notifyOverdueFindings();
      } catch (cause) {
        problems.push(`could not notify about overdue findings: ${describe(cause)}`);
      }

      // Last, so anything queued above is attempted in this same tick.
      if (this.#options.notifier !== undefined) {
        try {
          const swept = await this.#options.notifier.sweep();
          deliveriesAttempted = swept.attempted;
          deliveriesAbandoned = swept.abandoned;
        } catch (cause) {
          problems.push(`could not retry pending notifications: ${describe(cause)}`);
        }
      }

      if (this.#options.sessions !== undefined) {
        try {
          sessionsPruned = await this.#options.sessions.prune(
            this.#options.sessionRetentionMs ?? 90 * 24 * 60 * MINUTE,
          );
        } catch (cause) {
          problems.push(`could not prune expired sessions: ${describe(cause)}`);
        }
      }

      // A provider that cannot be read is a problem, not an empty month:
      // budgets keep counting what was last recorded, and somebody should know
      // the figures are going stale.
      if (this.#options.spendMonitor !== undefined) {
        try {
          const spend = await this.#options.spendMonitor.tick();
          spendIngested = spend.ingested;
          spendIncidents = spend.incidents.length;
          for (const failure of spend.failures) {
            problems.push(`could not read spend from ${failure.provider}: ${failure.error}`);
          }
        } catch (cause) {
          problems.push(`could not run the spend monitor: ${describe(cause)}`);
        }
      }
    } finally {
      this.#running = false;
    }

    const result: TickResult = {
      at: this.#now().toISOString(),
      approvalsExpired,
      expiryWarningsSent,
      assessmentRan,
      controlsFailing,
      overdueNotified,
      deliveriesAttempted,
      deliveriesAbandoned,
      sessionsPruned,
      spendIngested,
      spendIncidents,
      problems,
    };

    // A failed tick is audited. The alternative is a scheduler that quietly
    // stops working, which looks exactly like a scheduler with nothing to do.
    if (problems.length > 0) {
      try {
        await this.#options.gateway.audit.append({
          type: 'assessment.ran',
          organizationId: 'default',
          actor: 'scheduler',
          subject: 'scheduler',
          summary: `a scheduled run completed with ${String(problems.length)} problem(s): ${problems.join('; ')}`,
          data: { ...result },
        });
      } catch (cause) {
        this.#report(cause);
      }
    }

    return result;
  }

  async #warnAboutExpiring(): Promise<number> {
    const notifier = this.#options.notifier;
    if (notifier === undefined) return 0;

    const soon = await this.#options.gateway.approvals.expiringSoon(this.#options.expiryWarningMs ?? 30 * MINUTE);
    let sent = 0;

    for (const request of soon) {
      // Once per approval. A warning repeated every five minutes is an alarm
      // people learn to mute, which costs more than it buys.
      if (await this.#alreadyNotified('approval.expiring', request.id)) continue;

      await notifier.notify({
        event: 'approval.expiring',
        subject: request.id,
        summary:
          `An approval for ${request.tool} expires at ${request.expiresAt} with ` +
          `${String(request.votes.length)} of ${String(request.requirement.minApprovals)} votes cast. ` +
          'If it lapses the action will not run.',
        path: `/approvals/${request.id}`,
        details: { tool: request.tool, agent: request.agentName, expiresAt: request.expiresAt },
      });
      sent += 1;
    }

    return sent;
  }

  async #assessIfDue(): Promise<{ readonly ran: boolean; readonly failing: number }> {
    const interval = this.#options.assessmentIntervalMs ?? 60 * MINUTE;
    const now = this.#now().getTime();
    if (now - this.#lastAssessmentAt < interval) return { ran: false, failing: 0 };

    const { assessments } = await this.#options.assurance.run({ requestedBy: 'scheduler' });
    this.#lastAssessmentAt = now;

    const failing = assessments.filter((assessment) => assessment.status === 'fail');
    const notifier = this.#options.notifier;

    if (notifier !== undefined) {
      for (const assessment of failing) {
        // Keyed on the control, so a control that keeps failing is reported
        // once rather than on every run — the finding is the running record.
        if (await this.#alreadyNotified('assessment.failed', assessment.controlId)) continue;

        await notifier.notify({
          event: 'assessment.failed',
          subject: assessment.controlId,
          summary: `${assessment.controlId} is failing: ${assessment.summary}`,
          path: `/assurance/${assessment.controlId}`,
          details: { controlId: assessment.controlId, status: assessment.status, window: assessment.window },
        });
      }
    }

    return { ran: true, failing: failing.length };
  }

  async #notifyOverdueFindings(): Promise<number> {
    const notifier = this.#options.notifier;
    if (notifier === undefined) return 0;

    const overdue = await this.#options.assurance.listFindings({ overdue: true });
    let sent = 0;

    for (const finding of overdue) {
      if (await this.#alreadyNotified('finding.overdue', finding.id)) continue;

      await notifier.notify({
        event: 'finding.overdue',
        subject: finding.id,
        summary:
          `${finding.controlId} finding is past its deadline of ${String(finding.dueAt)}` +
          (finding.owner === undefined ? ' and has no owner' : `, owned by ${finding.owner}`),
        path: `/findings/${finding.id}`,
        details: {
          controlId: finding.controlId,
          severity: finding.severity,
          dueAt: finding.dueAt,
          owner: finding.owner ?? null,
        },
      });
      sent += 1;
    }

    return sent;
  }

  /**
   * Whether this subject has already been notified about this event.
   *
   * Read from the delivery records rather than kept in memory, so a restart
   * does not re-notify everything that is currently overdue — which is
   * precisely when an operator least wants a hundred messages.
   *
   * Asked of the whole collection. This used to scan the newest 500
   * deliveries, which is correct until a deployment writes its 501st: after
   * that the window rolls past the record of having notified, and every
   * overdue finding and expiring approval is announced again on every tick.
   * A paged read cannot answer "ever", so it no longer tries to.
   */
  async #alreadyNotified(event: NotificationEvent, subject: string): Promise<boolean> {
    const notifier = this.#options.notifier;
    if (notifier === undefined) return true;

    return notifier.hasNotified(event, subject);
  }

  #empty(problems: readonly string[]): TickResult {
    return {
      at: this.#now().toISOString(),
      approvalsExpired: 0,
      expiryWarningsSent: 0,
      assessmentRan: false,
      controlsFailing: 0,
      overdueNotified: 0,
      deliveriesAttempted: 0,
      deliveriesAbandoned: 0,
      sessionsPruned: 0,
      spendIngested: 0,
      spendIncidents: 0,
      problems,
    };
  }

  #report(cause: unknown): void {
    if (this.#options.onError) {
      this.#options.onError(cause);
      return;
    }
    process.stderr.write(`arc-control scheduler: ${describe(cause)}\n`);
  }
}

function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}
