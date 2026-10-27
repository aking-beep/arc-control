import type { SpendRecord } from '@arc-control/schemas';
import type { ControlStore } from '@arc-control/store';
import type { SpendLedger } from './ledger.js';
import { periodStart, roundUsd } from './periods.js';
import { isAmount } from './validate.js';
import type { SpendProvider } from './providers/provider.js';

/** When today's spend is a runaway rather than a busy day. */
export interface SpikeRule {
  /** Today's spend must be at least this many times the agent's trailing daily average. */
  readonly multiplier: number;
  /** ...and at least this many dollars, so a $0.02 → $0.10 day is not an incident. */
  readonly minimumUsd: number;
  /** Days before today that make up the baseline. */
  readonly baselineDays: number;
}

export interface SpendIncident {
  readonly agentId: string;
  readonly todayUsd: number;
  readonly baselineUsd: number;
  readonly rule: SpikeRule;
}

/**
 * Agents whose spend today is a spike against their own recent history.
 *
 * Pure, so the rule can be tested against fixed records. The baseline is the
 * mean over `baselineDays` full days before today, counting days with no spend
 * as zero, so a new agent's first expensive day is judged on `minimumUsd`
 * alone rather than slipping through for lack of history.
 */
export function detectSpikes(records: readonly SpendRecord[], now: Date, rule: SpikeRule): readonly SpendIncident[] {
  const today = periodStart('day', now).getTime();
  const baselineStart = today - rule.baselineDays * 86_400_000;
  const todayByAgent = new Map<string, number>();
  const baselineByAgent = new Map<string, number>();

  for (const record of records) {
    if (record.agentId === undefined) continue;
    const at = Date.parse(record.occurredAt);
    if (at >= today) todayByAgent.set(record.agentId, (todayByAgent.get(record.agentId) ?? 0) + record.amountUsd);
    // Only verified spend sets the baseline. Anything reported can be
    // padded to make tomorrow's runaway look ordinary.
    else if (at >= baselineStart && record.verified) {
      baselineByAgent.set(record.agentId, (baselineByAgent.get(record.agentId) ?? 0) + record.amountUsd);
    }
  }

  const incidents: SpendIncident[] = [];
  for (const [agentId, total] of todayByAgent) {
    const todayUsd = roundUsd(total);
    const baselineUsd = roundUsd((baselineByAgent.get(agentId) ?? 0) / Math.max(1, rule.baselineDays));
    if (todayUsd >= rule.minimumUsd && todayUsd >= rule.multiplier * baselineUsd) {
      incidents.push({ agentId, todayUsd, baselineUsd, rule });
    }
  }
  return incidents.sort((left, right) => left.agentId.localeCompare(right.agentId));
}

/** An audit entry the monitor wants written. The caller owns the audit log. */
export interface MonitorAuditEvent {
  readonly type: 'spend.ingested' | 'spend.incident';
  readonly subject: string;
  readonly summary: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface SpendMonitorOptions {
  readonly store: ControlStore;
  readonly ledger: SpendLedger;
  readonly providers: readonly SpendProvider[];
  readonly organizationId: string;
  /** Provider attribution (`workspace:wrkspc_...`) → agent name. Unmapped spend is the organization's. */
  readonly attribution?: Readonly<Record<string, string>>;
  readonly spike?: SpikeRule;
  /**
   * What a spike does. `record` audits it; `suspend` also suspends the agent,
   * which is the detect-and-cut kill switch. Suspension only ever tightens, and
   * an operator reverses it the ordinary, audited way.
   */
  readonly onSpike?: 'record' | 'suspend';
  readonly audit: (event: MonitorAuditEvent) => Promise<unknown>;
  readonly suspend?: (agentId: string, reason: string) => Promise<unknown>;
  readonly now?: () => Date;
}

export interface MonitorResult {
  readonly ingested: number;
  readonly failures: readonly { readonly provider: string; readonly error: string }[];
  readonly incidents: readonly SpendIncident[];
  readonly suspended: readonly string[];
}

/**
 * Pulls verified spend from providers and acts on runaways.
 *
 * Meant to run on the scheduler. Each tick reads the month so far plus the
 * spike baseline from every provider, records it as `provider` spend, then
 * looks for spikes. A provider that cannot be read is audited and reported,
 * never treated as zero spend: budgets keep counting what was last recorded.
 */
export class SpendMonitor {
  readonly #options: SpendMonitorOptions;
  readonly #now: () => Date;
  /** `agentId:day` pairs already raised, so a spike is one incident per day, not one per tick. */
  readonly #raised = new Set<string>();

  constructor(options: SpendMonitorOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
  }

  async tick(): Promise<MonitorResult> {
    const { store, ledger, providers, organizationId } = this.#options;
    const now = this.#now();
    const baselineDays = this.#options.spike?.baselineDays ?? 0;
    const start = new Date(
      Math.min(periodStart('month', now).getTime(), periodStart('day', now).getTime() - baselineDays * 86_400_000),
    );

    const agentsByName = new Map((await store.agents.list()).map((agent) => [agent.name, agent.id]));
    const failures: { provider: string; error: string }[] = [];
    let ingested = 0;

    for (const provider of providers) {
      try {
        const rows = await provider.fetch({ start, end: now });
        // Checked before any write: a bad row half-way through must not leave
        // the batch partly recorded.
        const bad = rows.find((row) => !isAmount(row.amountUsd) || Number.isNaN(Date.parse(row.occurredAt)));
        if (bad) throw new Error(`${provider.name} returned an unusable row (${bad.reference}); nothing from this fetch was recorded`);
        let unattributed = 0;
        for (const row of rows) {
          const name = this.#options.attribution?.[row.attribution];
          const agentId = name === undefined ? undefined : agentsByName.get(name);
          if (agentId === undefined) unattributed += 1;
          await ledger.record(
            {
              organizationId,
              ...(agentId !== undefined ? { agentId } : {}),
              provider: provider.name,
              amountUsd: row.amountUsd,
              occurredAt: row.occurredAt,
              reference: row.reference,
              ...(row.model !== undefined ? { model: row.model } : {}),
            },
            'provider',
            `system:${provider.name}`,
          );
          ingested += 1;
        }
        await this.#options.audit({
          type: 'spend.ingested',
          subject: provider.name,
          summary: `recorded ${rows.length} spend row(s) from ${provider.name}${unattributed > 0 ? `, ${unattributed} not attributed to any agent` : ''}`,
          data: { provider: provider.name, rows: rows.length, unattributed, ok: true, since: start.toISOString() },
        });
      } catch (cause) {
        const error = cause instanceof Error ? cause.message : String(cause);
        failures.push({ provider: provider.name, error });
        await this.#options.audit({
          type: 'spend.ingested',
          subject: provider.name,
          summary: `could not read spend from ${provider.name}; budgets keep counting what was last recorded: ${error}`,
          data: { provider: provider.name, ok: false, error },
        });
      }
    }

    const incidents = this.#options.spike
      ? detectSpikes(await ledger.list({ since: start }), now, this.#options.spike).filter(
          (incident) => !this.#raised.has(`${incident.agentId}:${periodStart('day', now).toISOString()}`),
        )
      : [];

    const suspended: string[] = [];
    for (const incident of incidents) {
      this.#raised.add(`${incident.agentId}:${periodStart('day', now).toISOString()}`);
      const agent = await store.agents.get(incident.agentId);
      const cut = this.#options.onSpike === 'suspend' && this.#options.suspend !== undefined && agent?.status === 'active';
      const reason =
        `spend today $${incident.todayUsd.toFixed(2)} is at least ${incident.rule.multiplier}x the ` +
        `${incident.rule.baselineDays}-day average of $${incident.baselineUsd.toFixed(2)}`;

      await this.#options.audit({
        type: 'spend.incident',
        subject: incident.agentId,
        summary: `${agent?.name ?? incident.agentId}: ${reason}${cut ? '; agent suspended' : ''}`,
        data: { ...incident, action: cut ? 'suspended' : 'recorded' },
      });
      if (cut) {
        await this.#options.suspend!(incident.agentId, reason);
        suspended.push(incident.agentId);
      }
    }

    return { ingested, failures, incidents, suspended };
  }
}
