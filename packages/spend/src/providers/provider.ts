/**
 * A source of verified spend.
 *
 * Adding a provider means implementing this interface and nothing else: the
 * monitor records what `fetch` returns as `provider` spend, attributes it with
 * the operator's mapping, and the ledger and budgets take it from there.
 */
export interface ProviderSpend {
  /** Stable identity of the row, so a re-fetch replaces rather than duplicates it. */
  readonly reference: string;
  readonly occurredAt: string;
  readonly amountUsd: number;
  /**
   * Provider-side owner of the cost, e.g. `workspace:wrkspc_01...` or
   * `workspace:default`. The monitor maps it to an agent; unmapped spend is
   * recorded against the organization.
   */
  readonly attribution: string;
  readonly model?: string;
}

export interface SpendProvider {
  readonly name: string;
  /** Spend in `[start, end)`. Throws when the provider cannot be read: no data is not the same as no spend. */
  fetch(window: { readonly start: Date; readonly end: Date }): Promise<readonly ProviderSpend[]>;
}
