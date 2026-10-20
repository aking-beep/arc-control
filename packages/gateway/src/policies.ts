import { ArcError, validatePolicy, type Policy } from '@arc-control/schemas';
import type { ControlStore } from '@arc-control/store';

export interface PolicyStoreOptions {
  readonly now?: () => Date;
}

/**
 * Stores policy documents.
 *
 * Policies are versioned rather than edited: publishing a change writes a new
 * version, so a decision that cites `FINANCE-004` version 3 can still be
 * explained a year later, after the policy has moved on.
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
  async publish(policy: Policy): Promise<Policy> {
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
      return stored;
    });
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

  async setEnabled(policyId: string, enabled: boolean): Promise<Policy> {
    return this.#store.policies.transact(async () => {
      const policy = await this.require(policyId);
      const updated: Policy = { ...policy, enabled, updatedAt: this.#now().toISOString() };
      await this.#store.policies.put(updated.id, updated);
      return updated;
    });
  }
}
