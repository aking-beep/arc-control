import type { ProviderSpend, SpendProvider } from './provider.js';

export interface AnthropicCostProviderOptions {
  /** An Anthropic **Admin** API key (`sk-ant-admin...`). Held in memory only; never recorded. */
  readonly adminKey: string;
  readonly baseUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
  /** Most pages read in one fetch, a guard against a cursor that never ends. */
  readonly maxPages?: number;
}

interface CostReportPage {
  readonly data?: readonly {
    readonly starting_at: string;
    readonly results?: readonly {
      readonly amount?: string;
      readonly currency?: string;
      readonly workspace_id?: string | null;
    }[];
  }[];
  readonly has_more?: boolean;
  readonly next_page?: string | null;
}

/**
 * Verified spend from Anthropic's Admin API cost report
 * (`GET /v1/organizations/cost_report`).
 *
 * One record per day per workspace. The report is bucketed by day, so this
 * provider can say what a workspace cost **today so far**, not in the last
 * five minutes; a budget fed by it cuts off as fresh as that.
 *
 * Amounts arrive as decimal strings in the lowest currency unit — `"123.45"`
 * USD is $1.23 — and anything not in USD, or not a finite non-negative
 * number, makes the whole fetch fail rather than being skipped: silently
 * dropping a row would under-count spend, and under-counting is the one
 * error a budget cannot afford.
 */
export class AnthropicCostProvider implements SpendProvider {
  readonly name = 'anthropic';
  readonly #adminKey: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #maxPages: number;

  constructor(options: AnthropicCostProviderOptions) {
    if (typeof options.adminKey !== 'string' || options.adminKey.length === 0) {
      throw new Error('AnthropicCostProvider needs an admin API key');
    }
    this.#adminKey = options.adminKey;
    this.#baseUrl = (options.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '');
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#maxPages = options.maxPages ?? 20;
  }

  async fetch(window: { readonly start: Date; readonly end: Date }): Promise<readonly ProviderSpend[]> {
    const totals = new Map<string, ProviderSpend>();
    let page: string | undefined;

    for (let count = 0; count < this.#maxPages; count += 1) {
      const params = new URLSearchParams({
        starting_at: window.start.toISOString(),
        ending_at: window.end.toISOString(),
        bucket_width: '1d',
        limit: '31',
      });
      params.append('group_by[]', 'workspace_id');
      if (page) params.set('page', page);

      const response = await this.#fetch(`${this.#baseUrl}/v1/organizations/cost_report?${params.toString()}`, {
        headers: { 'x-api-key': this.#adminKey, 'anthropic-version': '2023-06-01', accept: 'application/json' },
      });
      if (!response.ok) {
        // The body can echo request details; the status is enough to act on.
        throw new Error(`Anthropic cost report returned HTTP ${response.status}`);
      }
      const body = (await response.json()) as CostReportPage;

      for (const bucket of body.data ?? []) {
        const day = new Date(bucket.starting_at);
        if (Number.isNaN(day.getTime())) throw new Error('Anthropic cost report returned a bucket with no valid start');
        for (const row of bucket.results ?? []) {
          if ((row.currency ?? 'USD') !== 'USD') {
            throw new Error(`Anthropic cost report returned a ${String(row.currency)} amount; only USD is supported`);
          }
          const cents = Number(row.amount ?? '0');
          if (!Number.isFinite(cents) || cents < 0) {
            throw new Error('Anthropic cost report returned an amount that is not a non-negative number');
          }
          const workspace = row.workspace_id ?? 'default';
          const reference = `cost_report:${day.toISOString().slice(0, 10)}:${workspace}`;
          const previous = totals.get(reference);
          totals.set(reference, {
            reference,
            occurredAt: day.toISOString(),
            amountUsd: (previous?.amountUsd ?? 0) + cents / 100,
            attribution: `workspace:${workspace}`,
          });
        }
      }

      if (!body.has_more || !body.next_page) return [...totals.values()];
      page = body.next_page;
    }

    // Returning what was read would under-count; refusing is the safe failure.
    throw new Error(`Anthropic cost report did not finish within ${this.#maxPages} pages`);
  }
}
