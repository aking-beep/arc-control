import type { BudgetPeriod } from '@arc-control/schemas';

/**
 * Start of the period containing `now`, in UTC.
 *
 * UTC rather than the organization's local time because a budget is read on
 * every decision across every region, and a period boundary that moved with
 * the server's time zone would let the same spend count in two days or none.
 */
export function periodStart(period: BudgetPeriod, now: Date): Date {
  return period === 'day'
    ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** Rounds to a millionth of a dollar, so summed floating point does not drift in reports. */
export function roundUsd(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
