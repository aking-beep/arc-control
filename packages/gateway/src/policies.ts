import { ArcError, validatePolicy, type Policy, type PolicyVersionRecord } from '@arc-control/schemas';
import type { ControlStore } from '@arc-control/store';
import { policyHistory, recordVersion } from './policy-tools.js';

export interface PolicyStoreOptions {
  readonly now?: () => Date;
}

/** Who published a policy, for the version-history entry. */
export interface Publisher {
  readonly identifier: string;
  readonly via?: string;
}

/**
 * Stores policy documents.
 *
 * Policies are versioned rather than edited: publishing a change writes a new
 * version, so a decision that cites `FINANCE-004` version 3 can still be
 * explained a year later, after the policy has moved on.
 *
 * 2.0 adds the history that makes that claim real. Until now the *current*
 * document was kept and the superseded one was gone, so "explain version 3"
 * worked only if nobody had published version 4. Every publish now appends the
 * full document alongside the one it replaced, with a structural diff and the
 * name of whoever published it.
 *
 * The history write lives here rather than in `Administration` for the same
 * reason the audit append lives there: the API, the CLI and a seed script all
 * come through this method, and none of them can forget to record a version.
 */
export class PolicyStore {
  readonly #store: ControlStore;
  readonly #now: () => Date;

  constructor(store: ControlStore, options: PolicyStoreOptions = {}) {
    this.#store = store;
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * Publishes a policy. A document for an id that already exists must declare
   * a higher version, which stops two operators silently overwriting one
   * another's work.
   */
  async publish(policy: Policy, publisher: Publisher = { identifier: 'system', via: 'system' }): Promise<Policy> {
    return this.#store.policies.transact(async () => {
      const result = validatePolicy(policy);
      if (!result.valid) {
        throw new ArcError('invalid_request', `policy "${policy.id}" is not valid`, {
          details: { issues: result.issues },
        });
      }

      const current = await this.#store.policies.get(policy.id);
      if (current && policy.version <= current.version) {
        throw new ArcError(
          'conflict',
          `policy "${policy.id}" is already at version ${current.version}; publish a higher version`,
          { details: { currentVersion: current.version, submittedVersion: policy.version } },
        );
      }

      const timestamp = this.#now().toISOString();
      const stored: Policy = {
        ...policy,
        createdAt: current?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };

      await this.#store.policies.put(stored.id, stored);
      await recordVersion({
        store: this.#store,
        previous: current,
        next: stored,
        publishedBy: publisher.identifier,
        via: publisher.via ?? 'system',
        now: this.#now(),
      });

      return stored;
    });
  }

  /** Every published version of a policy, newest first. */
  async history(policyId: string): Promise<readonly PolicyVersionRecord[]> {
    return policyHistory(this.#store, policyId);
  }

  async get(policyId: string): Promise<Policy | undefined> {
    return this.#store.policies.get(policyId);
  }

  async require(policyId: string): Promise<Policy> {
    const policy = await this.get(policyId);
    if (!policy) throw new ArcError('not_found', `no policy with id ${policyId}`);
    return policy;
  }

  /** Every policy, enabled or not. The engine filters; the console shows all. */
  async list(): Promise<readonly Policy[]> {
    return this.#store.policies.list();
  }

  /**
   * Enables or disables a policy without bumping its version.
   *
   * Recorded in the history as a change at the same version, because flipping
   * a policy off is as consequential as rewriting a rule and an operator
   * looking for "when did this stop applying?" will look here.
   */
  async setEnabled(
    policyId: string,
    enabled: boolean,
    publisher: Publisher = { identifier: 'system', via: 'system' },
  ): Promise<Policy> {
    return this.#store.policies.transact(async () => {
      const policy = await this.require(policyId);
      if (policy.enabled === enabled) return policy;

      const updated: Policy = { ...policy, enabled, updatedAt: this.#now().toISOString() };
      await this.#store.policies.put(updated.id, updated);
      await recordVersion({
        store: this.#store,
        previous: policy,
        next: updated,
        publishedBy: publisher.identifier,
        via: publisher.via ?? 'system',
        now: this.#now(),
      });

      return updated;
    });
  }
}
