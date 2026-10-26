import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  ArcError,
  isSessionLive,
  newId,
  type OperatorIdentity,
  type OperatorSession,
} from '@arc-control/schemas';
import type { ControlStore } from '@arc-control/store';

/**
 * Console sessions.
 *
 * The cookie carries a session id and a signature over it; everything else
 * lives in the store. That split is the point: the cookie is a bearer token
 * the browser holds, so it must prove nothing on its own beyond "the server
 * issued this", and every question that matters — is it still valid, what
 * roles does this person have, has someone revoked it — is answered from
 * server state at the time of the request rather than from a claim minted
 * when they signed in.
 *
 * A stateless token would be less work and would make "revoke this person's
 * access now" impossible to answer honestly.
 */

/** How long a session lasts without re-authenticating. */
const DEFAULT_LIFETIME_MS = 12 * 60 * 60 * 1000;

/** Idle time after which a session stops being accepted. */
const DEFAULT_IDLE_MS = 2 * 60 * 60 * 1000;

/**
 * Longest a session may be used without `lastSeenAt` being rewritten.
 *
 * The write is throttled so that a busy console does not turn every request
 * into a store write. But the throttle is an upper bound only: it is clamped
 * against the idle timeout below, because a throttle that approaches the idle
 * window stops recording the very activity the window is measuring, and an
 * operator clicking steadily gets signed out for being idle.
 */
const MAX_TOUCH_INTERVAL_MS = 60_000;

export interface SessionManagerOptions {
  readonly store: ControlStore;
  /**
   * Secret used to sign session cookies. Must be at least 32 bytes of entropy
   * and must be stable across restarts, or every operator is signed out on
   * each deploy.
   */
  readonly signingSecret: string;
  readonly lifetimeMs?: number;
  readonly idleTimeoutMs?: number;
  readonly now?: () => Date;
}

export class SessionManager {
  readonly #store: ControlStore;
  readonly #secret: Buffer;
  readonly #lifetimeMs: number;
  readonly #idleMs: number;
  readonly #touchMs: number;
  readonly #now: () => Date;

  constructor(options: SessionManagerOptions) {
    if (!options.signingSecret || options.signingSecret.length < 32) {
      throw new ArcError(
        'invalid_request',
        'the session signing secret must be at least 32 characters; generate one with `openssl rand -hex 32`',
      );
    }

    this.#store = options.store;
    this.#secret = Buffer.from(options.signingSecret, 'utf8');
    this.#lifetimeMs = options.lifetimeMs ?? DEFAULT_LIFETIME_MS;
    this.#idleMs = options.idleTimeoutMs ?? DEFAULT_IDLE_MS;
    // A quarter of the idle window, so activity is recorded at least four
    // times before it could ever look idle.
    this.#touchMs = Math.max(1, Math.min(MAX_TOUCH_INTERVAL_MS, Math.floor(this.#idleMs / 4)));
    this.#now = options.now ?? (() => new Date());
  }

  /** Signs a value so the browser cannot alter it. */
  sign(value: string): string {
    const mac = createHmac('sha256', this.#secret).update(value, 'utf8').digest('base64url');
    return `${value}.${mac}`;
  }

  /** Recovers a signed value, or undefined if the signature does not hold. */
  unsign(signed: string): string | undefined {
    const index = signed.lastIndexOf('.');
    if (index <= 0) return undefined;

    const value = signed.slice(0, index);
    const presented = Buffer.from(signed.slice(index + 1), 'base64url');
    const expected = createHmac('sha256', this.#secret).update(value, 'utf8').digest();

    if (presented.length !== expected.length) return undefined;
    return timingSafeEqual(presented, expected) ? value : undefined;
  }

  /**
   * Opens a session for an identity the provider has vouched for.
   *
   * A fresh identifier every time, so signing in again cannot be made to
   * reuse a session id an attacker already planted in the browser.
   */
  async open(input: {
    readonly identifier: string;
    readonly subject: string;
    readonly issuer: string;
    readonly roles: readonly string[];
  }): Promise<{ readonly session: OperatorSession; readonly cookie: string }> {
    const now = this.#now();
    const session: OperatorSession = {
      id: newId('session'),
      identifier: input.identifier,
      subject: input.subject,
      issuer: input.issuer,
      roles: [...input.roles],
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.#lifetimeMs).toISOString(),
      lastSeenAt: now.toISOString(),
    };

    await this.#store.operatorSessions.put(session.id, session);
    return { session, cookie: this.sign(session.id) };
  }

  /**
   * Resolves a cookie to an identity, or throws.
   *
   * Roles come from the stored session, which came from verified claims. They
   * are never read from the request, so a signed-in operator cannot widen
   * their own authority by adding a header.
   */
  async resolve(cookie: string | undefined): Promise<OperatorIdentity> {
    if (!cookie) throw new ArcError('unauthenticated', 'no operator session; sign in at /auth/login');

    const sessionId = this.unsign(cookie);
    if (sessionId === undefined) {
      throw new ArcError('unauthenticated', 'the session cookie is not signed by this deployment');
    }

    const session = await this.#store.operatorSessions.get(sessionId);
    if (!session) throw new ArcError('unauthenticated', 'that session is not known to this deployment');

    const now = this.#now().getTime();

    if (session.revokedAt !== undefined) {
      throw new ArcError('unauthenticated', `that session was ended${reason(session)}; sign in again`);
    }

    if (!isSessionLive(session, now)) {
      throw new ArcError('unauthenticated', 'that session has expired; sign in again');
    }

    if (now - Date.parse(session.lastSeenAt) > this.#idleMs) {
      // Recorded, not merely refused: an idle session that is left usable is
      // a session a borrowed laptop can still act with.
      await this.revoke(session.id, session.identifier, 'idle timeout');
      throw new ArcError('unauthenticated', 'that session was idle too long and has been ended; sign in again');
    }

    await this.#touch(session, now);

    return {
      identifier: session.identifier,
      roles: session.roles,
      assurance: 'authenticated',
      issuer: session.issuer,
      subject: session.subject,
      sessionId: session.id,
    };
  }

  /**
   * Records that a session is in use.
   *
   * Inside the lock, and re-read inside it, because this writes a record it
   * read earlier. Without that, a revocation landing between the read and the
   * write is erased by the stale snapshot and the session comes back to life:
   * offboarding would silently fail at exactly the moment it matters, while
   * the person is still clicking.
   *
   * This is the fourth time this shape has gone wrong in this codebase.
   * Reading outside a lock is fine; writing back what you read is not.
   */
  async #touch(session: OperatorSession, now: number): Promise<void> {
    if (now - Date.parse(session.lastSeenAt) < this.#touchMs) return;

    await this.#store.operatorSessions.transact(async () => {
      const current = await this.#store.operatorSessions.get(session.id);

      // Gone, or ended since the read. Either way there is nothing here whose
      // last-seen time is worth recording, and writing one would resurrect it.
      if (!current || current.revokedAt !== undefined) return;
      if (now - Date.parse(current.lastSeenAt) < this.#touchMs) return;

      await this.#store.operatorSessions.put(current.id, {
        ...current,
        lastSeenAt: new Date(now).toISOString(),
      });
    });
  }

  /** Ends one session. Idempotent, so signing out twice is not an error. */
  async revoke(sessionId: string, by: string, why: string): Promise<OperatorSession | undefined> {
    return this.#store.operatorSessions.transact(async () => {
      const session = await this.#store.operatorSessions.get(sessionId);
      if (!session || session.revokedAt !== undefined) return session;

      const revoked: OperatorSession = {
        ...session,
        revokedAt: this.#now().toISOString(),
        revokedBy: by,
        revokedReason: why,
      };
      await this.#store.operatorSessions.put(revoked.id, revoked);
      return revoked;
    });
  }

  /**
   * Ends every live session for one person.
   *
   * Keyed on the provider's subject rather than the email, because an email
   * can be reassigned and the subject cannot: offboarding has to catch the
   * person, not whoever holds their old address.
   */
  async revokeAllFor(subject: string, by: string, why: string): Promise<number> {
    const live = await this.#store.operatorSessions.filter(
      (session) => session.subject === subject && session.revokedAt === undefined,
    );

    let ended = 0;
    for (const session of live) {
      if (await this.revoke(session.id, by, why)) ended += 1;
    }
    return ended;
  }

  /** Live sessions, for the console's own session list. */
  async live(): Promise<readonly OperatorSession[]> {
    const now = this.#now().getTime();
    return this.#store.operatorSessions.filter((session) => isSessionLive(session, now));
  }

  /**
   * Removes sessions that ended long ago.
   *
   * Expired sessions are evidence for a while — "who was signed in when this
   * was approved" is a real question — so they are kept well past expiry and
   * then dropped, rather than deleted the moment they stop working.
   */
  async prune(olderThanMs: number): Promise<number> {
    const cutoff = this.#now().getTime() - olderThanMs;
    const stale = await this.#store.operatorSessions.filter(
      (session) => Date.parse(session.expiresAt) < cutoff,
    );

    for (const session of stale) await this.#store.operatorSessions.delete(session.id);
    return stale.length;
  }
}

function reason(session: OperatorSession): string {
  const why = session.revokedReason ? ` (${session.revokedReason})` : '';
  const by = session.revokedBy ? ` by ${session.revokedBy}` : '';
  return `${by}${why}`;
}

/** A short-lived signed value, used to carry PKCE state through the redirect. */
export function newLoginNonce(): string {
  return randomBytes(16).toString('base64url');
}
