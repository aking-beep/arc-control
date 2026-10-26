import { ArcError, type Action, type ActionResult } from '@arc-control/schemas';
import type { ControlStore } from '@arc-control/store';

/**
 * The scope an idempotency key is unique within.
 *
 * Narrower than the key itself on purpose: two agents, or one agent calling
 * two tools, may use `retry-1` without colliding, because the key is the
 * caller's name for *its own* attempt and ARC has no business conflating them.
 * Wider than the parameters, because a key reused with different parameters is
 * the conflict the caller needs told about rather than a second logical
 * action.
 */
export function scopeOf(action: Action): string {
  // NUL-joined: no component of an identifier, tool name or key may contain
  // it, so no two distinct tuples can produce the same string.
  return [action.organizationId, action.agentId, action.tool, action.idempotencyKey].join('\u0000');
}

/** The key was free and is now held by this request, which must go on to settle it. */
export interface KeyClaimed {
  readonly kind: 'claimed';
  readonly scope: string;
}

/** The key is held by a request that is still running in this process. */
export interface KeyInFlight {
  readonly kind: 'in_progress';
  readonly original: Action;
  /** Settles with the original request's result, or rejects as it did. */
  readonly outcome: Promise<ActionResult>;
}

/** The key is held by a request that is no longer running here. */
export interface KeySettled {
  readonly kind: 'settled';
  readonly original: Action;
}

export type KeyClaim = KeyClaimed | KeyInFlight | KeySettled;

interface Pending {
  readonly outcome: Promise<ActionResult>;
  readonly resolve: (result: ActionResult) => void;
  readonly reject: (cause: unknown) => void;
}

/**
 * Enforces one logical action per idempotency key.
 *
 * The defect this exists to close: recording the action and then looking for
 * an earlier one with the same key are two steps, and between them any number
 * of concurrent callers can pass. Eight parallel refunds sharing a key each
 * wrote their own action row, each looked for a *finished* predecessor, each
 * found none — because the first one's evidence is not written until after the
 * connector returns — and each refunded the customer. Replay only ever worked
 * for a retry that arrived after the original had finished, which is the one
 * case that needs it least.
 *
 * The claim is therefore taken in one critical section, against the actions
 * collection's own lock, and the action row and the in-flight marker are
 * written inside it together. A caller that does not get the claim never
 * reaches policy evaluation or a connector: it either joins the request that
 * did, or reads back the outcome that request recorded.
 *
 * **Scope of the guarantee.** `Collection.transact` serializes read-modify-
 * write sequences *within one process*. Both shipped stores — `MemoryStore`
 * and `FileStore` — implement it with an in-process mutex, so that is exactly
 * what this class guarantees: at most one execution per key per ARC Control
 * process. Two processes sharing a `FileStore` directory can both claim the
 * same key, and ARC does not pretend otherwise; a second claimant that finds
 * a held key with no recorded outcome refuses rather than guessing. Enforcing
 * one execution across processes needs a store whose `transact` is backed by
 * shared state — a conditional write, a row lock, an advisory lock — and that
 * claim should not be made for a deployment until it has been tested against
 * one.
 *
 * **Cost.** The claim is a linear scan of the actions collection inside the
 * lock, plus one append. The scan is what the replay check always cost; what
 * is new is that it is serialized, so keyed submissions queue behind one
 * another rather than overlapping. At the single-process scale this store
 * targets that is the right trade — a duplicate refund costs more than a
 * millisecond — but it is the first thing to index when a store with real
 * queries replaces this one: a unique constraint on the scope tuple turns
 * this whole method into one conditional insert.
 */
export class IdempotencyLedger {
  readonly #store: ControlStore;
  readonly #pending = new Map<string, Pending>();

  constructor(store: ControlStore) {
    this.#store = store;
  }

  /** Requests held by a call that is still running. For diagnostics and tests. */
  get inFlight(): number {
    return this.#pending.size;
  }

  /**
   * Claims the key for `action`, recording it, or reports the request that
   * already holds it.
   *
   * The action row is written only by the caller that wins the claim, so a
   * repeat does not mint a second action for one logical request — which is
   * also what keeps "every recorded action has evidence" true.
   */
  async claim(action: Action): Promise<KeyClaim> {
    if (action.idempotencyKey === undefined) {
      throw new ArcError('internal', 'an action without an idempotency key cannot claim one');
    }
    const scope = scopeOf(action);

    return this.#store.actions.transact(async () => {
      const original = await this.#store.actions.find(
        (candidate) =>
          candidate.idempotencyKey === action.idempotencyKey &&
          candidate.agentId === action.agentId &&
          candidate.organizationId === action.organizationId &&
          candidate.tool === action.tool,
      );

      if (original) {
        const pending = this.#pending.get(scope);
        return pending
          ? { kind: 'in_progress' as const, original, outcome: pending.outcome }
          : { kind: 'settled' as const, original };
      }

      await this.#store.actions.put(action.id, action);

      let resolve!: (result: ActionResult) => void;
      let reject!: (cause: unknown) => void;
      const outcome = new Promise<ActionResult>((settle, fail) => {
        resolve = settle;
        reject = fail;
      });
      // Nothing may be joined to this claim when it settles, and an
      // unobserved rejection would otherwise be fatal to the process. A
      // handler here marks it observed; a caller awaiting the same promise
      // still sees the rejection.
      void outcome.catch(() => {});

      this.#pending.set(scope, { outcome, resolve, reject });
      return { kind: 'claimed' as const, scope };
    });
  }

  /** Completes a claim, releasing anyone joined to it. */
  settle(scope: string, result: ActionResult): void {
    const pending = this.#pending.get(scope);
    this.#pending.delete(scope);
    pending?.resolve(result);
  }

  /**
   * Fails a claim, raising the same error for anyone joined to it.
   *
   * The action row stays: the attempt happened, and the next caller presenting
   * the key reads back whatever outcome was recorded for it rather than acting
   * again.
   */
  abandon(scope: string, cause: unknown): void {
    const pending = this.#pending.get(scope);
    this.#pending.delete(scope);
    pending?.reject(cause);
  }
}
