import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ArcError } from '@arc-control/schemas';
import { MemoryStore } from '@arc-control/store';
import { SessionManager } from './sessions.js';

const SECRET = 'a'.repeat(64);

function managerAt(now: () => Date, options: Record<string, unknown> = {}): { manager: SessionManager; store: MemoryStore } {
  const store = new MemoryStore();
  return { manager: new SessionManager({ store, signingSecret: SECRET, now, ...options }), store };
}

const PERSON = {
  identifier: 'cfo@example.com',
  subject: 'provider-subject-1',
  issuer: 'https://login.example.com',
  roles: ['finance-manager'],
};

describe('session cookies', () => {
  it('refuses a signing secret too short to be worth signing with', () => {
    assert.throws(
      () => new SessionManager({ store: new MemoryStore(), signingSecret: 'short' }),
      /at least 32 characters/,
    );
  });

  it('resolves a cookie it issued to the identity behind it', async () => {
    const { manager } = managerAt(() => new Date());
    const { cookie } = await manager.open(PERSON);

    const identity = await manager.resolve(cookie);
    assert.equal(identity.identifier, 'cfo@example.com');
    assert.deepEqual(identity.roles, ['finance-manager']);
    assert.equal(identity.assurance, 'authenticated', 'a verified sign-in is authenticated, not claimed');
    assert.equal(identity.issuer, 'https://login.example.com');
    assert.equal(identity.subject, 'provider-subject-1');
  });

  /**
   * The cookie is a bearer token the browser holds, so the only thing it may
   * prove on its own is that this deployment issued it.
   */
  it('refuses a cookie this deployment did not sign', async () => {
    const { manager } = managerAt(() => new Date());
    const { session } = await manager.open(PERSON);

    for (const forged of [session.id, `${session.id}.`, `${session.id}.not-a-signature`, 'nonsense']) {
      await assert.rejects(
        () => manager.resolve(forged),
        (error: ArcError) => error.code === 'unauthenticated',
        `"${forged}" must not resolve`,
      );
    }
  });

  it('refuses a cookie signed by a different deployment', async () => {
    const store = new MemoryStore();
    const ours = new SessionManager({ store, signingSecret: SECRET });
    const theirs = new SessionManager({ store, signingSecret: 'b'.repeat(64) });

    const { session } = await ours.open(PERSON);
    await assert.rejects(() => ours.resolve(theirs.sign(session.id)));
  });

  it('refuses a cookie naming a session that does not exist', async () => {
    const { manager } = managerAt(() => new Date());
    await assert.rejects(
      () => manager.resolve(manager.sign('arc_ses_0000')),
      (error: ArcError) => /not known to this deployment/.test(error.message),
    );
  });

  it('gives each sign-in a new identifier, so a planted session cannot be reused', async () => {
    const { manager } = managerAt(() => new Date());
    const first = await manager.open(PERSON);
    const second = await manager.open(PERSON);

    assert.notEqual(first.session.id, second.session.id);
  });
});

describe('ending a session', () => {
  it('stops accepting it the moment it is revoked', async () => {
    const { manager } = managerAt(() => new Date());
    const { session, cookie } = await manager.open(PERSON);

    assert.ok(await manager.resolve(cookie));
    await manager.revoke(session.id, 'cfo@example.com', 'signed out');

    await assert.rejects(
      () => manager.resolve(cookie),
      (error: ArcError) => /was ended/.test(error.message) && /signed out/.test(error.message),
    );
  });

  it('is idempotent, so signing out twice is not an error', async () => {
    const { manager } = managerAt(() => new Date());
    const { session } = await manager.open(PERSON);

    await manager.revoke(session.id, 'cfo@example.com', 'signed out');
    const again = await manager.revoke(session.id, 'cfo@example.com', 'signed out');
    assert.ok(again, 'the record is returned');
    assert.equal(again.revokedReason, 'signed out', 'and the first reason stands');
  });

  /**
   * Offboarding keys on the provider's subject, not the email: an address can
   * be reassigned to a new hire, and revocation has to catch the person who
   * left rather than whoever now holds their mailbox.
   */
  it('ends every session for a person, keyed on the provider subject', async () => {
    const { manager } = managerAt(() => new Date());
    const laptop = await manager.open(PERSON);
    const phone = await manager.open(PERSON);
    const colleague = await manager.open({ ...PERSON, identifier: 'cto@example.com', subject: 'provider-subject-2' });

    const ended = await manager.revokeAllFor('provider-subject-1', 'admin@example.com', 'left the company');
    assert.equal(ended, 2);

    await assert.rejects(() => manager.resolve(laptop.cookie));
    await assert.rejects(() => manager.resolve(phone.cookie));
    assert.ok(await manager.resolve(colleague.cookie), 'a colleague keeps their session');
  });

  it('survives a reassigned email, because the subject is what is matched', async () => {
    const { manager } = managerAt(() => new Date());
    const leaver = await manager.open(PERSON);
    const newHire = await manager.open({ ...PERSON, subject: 'provider-subject-9' });

    await manager.revokeAllFor('provider-subject-1', 'admin@example.com', 'left the company');

    await assert.rejects(() => manager.resolve(leaver.cookie));
    assert.ok(await manager.resolve(newHire.cookie), 'the new holder of the address is unaffected');
  });
});

/**
 * Recording that a session is in use writes a record that was read earlier,
 * which is the shape that has now gone wrong four times in this codebase.
 *
 * The specific harm: a revocation landing between the read and the write is
 * erased by the stale snapshot, and the session comes back to life. Offboarding
 * silently fails at exactly the moment it matters — while the person is still
 * clicking — and the audit record says they were removed.
 */
describe('using a session cannot undo a revocation', () => {
  /**
   * The interleave is forced rather than raced.
   *
   * Starting two promises and hoping they collide is not a test: JavaScript's
   * ordering decided the winner, and the first version of this test passed
   * against the bug. So the store's read is instrumented to land the
   * revocation at the one moment that matters — after `resolve` has its
   * snapshot and before it writes the last-seen time.
   */
  it('does not resurrect a session revoked between the read and the write', async () => {
    let now = Date.parse('2026-06-15T12:00:00.000Z');
    const store = new MemoryStore();
    const manager = new SessionManager({
      store,
      signingSecret: SECRET,
      now: () => new Date(now),
      idleTimeoutMs: 600_000,
    });

    const { session, cookie } = await manager.open(PERSON);

    // Past the write throttle, so the resolve below will try to record activity.
    now += 300_000;

    const realGet = store.operatorSessions.get.bind(store.operatorSessions);
    let landed = false;
    store.operatorSessions.get = async (id: string) => {
      const value = await realGet(id);
      if (!landed) {
        // Set before awaiting, so the revoke's own read does not recurse.
        landed = true;
        await manager.revoke(session.id, 'admin@example.com', 'left the company');
      }
      return value;
    };

    await manager.resolve(cookie).catch(() => undefined);
    store.operatorSessions.get = realGet;

    const after = await store.operatorSessions.get(session.id);
    assert.ok(after?.revokedAt, 'the revocation must survive a concurrent touch');
    assert.equal(after.revokedReason, 'left the company');

    await assert.rejects(
      () => manager.resolve(cookie),
      (error: ArcError) => error.code === 'unauthenticated',
      'and the cookie must be dead afterwards',
    );
  });

  it('still records activity when nothing is racing it', async () => {
    let now = Date.parse('2026-06-15T12:00:00.000Z');
    const store = new MemoryStore();
    const manager = new SessionManager({
      store,
      signingSecret: SECRET,
      now: () => new Date(now),
      idleTimeoutMs: 600_000,
    });

    const { session, cookie } = await manager.open(PERSON);
    const before = (await store.operatorSessions.get(session.id))!.lastSeenAt;

    now += 300_000;
    await manager.resolve(cookie);

    assert.notEqual(
      (await store.operatorSessions.get(session.id))?.lastSeenAt,
      before,
      'the throttle must not have swallowed a real update',
    );
  });

  it('does not write at all for a session already revoked', async () => {
    let now = Date.parse('2026-06-15T12:00:00.000Z');
    const store = new MemoryStore();
    const manager = new SessionManager({ store, signingSecret: SECRET, now: () => new Date(now) });

    const { session, cookie } = await manager.open(PERSON);
    await manager.revoke(session.id, 'admin@example.com', 'revoked');
    const snapshot = JSON.stringify(await store.operatorSessions.get(session.id));

    now += 300_000;
    await assert.rejects(() => manager.resolve(cookie));

    assert.equal(
      JSON.stringify(await store.operatorSessions.get(session.id)),
      snapshot,
      'a refused resolve must leave the record exactly as it was',
    );
  });
});

describe('session lifetime', () => {
  it('stops accepting a session past its expiry', async () => {
    let now = Date.parse('2026-06-15T12:00:00.000Z');
    const { manager } = managerAt(() => new Date(now), { lifetimeMs: 60_000 });
    const { cookie } = await manager.open(PERSON);

    now += 30_000;
    assert.ok(await manager.resolve(cookie));

    now += 60_000;
    await assert.rejects(() => manager.resolve(cookie), (error: ArcError) => /has expired/.test(error.message));
  });

  /**
   * An idle session left usable is a session a borrowed laptop can still act
   * with, so the timeout ends it rather than only refusing this request.
   */
  it('ends an idle session rather than merely refusing it', async () => {
    let now = Date.parse('2026-06-15T12:00:00.000Z');
    const { manager, store } = managerAt(() => new Date(now), { idleTimeoutMs: 60_000, lifetimeMs: 86_400_000 });
    const { session, cookie } = await manager.open(PERSON);

    now += 120_000;
    await assert.rejects(() => manager.resolve(cookie), (error: ArcError) => /idle too long/.test(error.message));

    const stored = await store.operatorSessions.get(session.id);
    assert.ok(stored?.revokedAt, 'the session was ended, not just rejected');
    assert.equal(stored.revokedReason, 'idle timeout');
  });

  /**
   * The write that records activity is throttled, and the throttle must stay
   * well inside the idle window. When it was a flat sixty seconds, a
   * deployment with a one-minute idle timeout signed out an operator who was
   * clicking every forty-five seconds: the activity was never written down, so
   * the session looked idle while it was in use.
   */
  it('keeps a session alive while it is being used', async () => {
    let now = Date.parse('2026-06-15T12:00:00.000Z');
    const { manager } = managerAt(() => new Date(now), { idleTimeoutMs: 60_000, lifetimeMs: 86_400_000 });
    const { cookie } = await manager.open(PERSON);

    // Used every 45 seconds across five minutes: never idle for a full minute.
    for (let step = 0; step < 7; step += 1) {
      now += 45_000;
      assert.ok(await manager.resolve(cookie), `still valid at step ${String(step)}`);
    }
  });

  it('lists live sessions and leaves out the ended ones', async () => {
    const { manager } = managerAt(() => new Date());
    const keep = await manager.open(PERSON);
    const drop = await manager.open({ ...PERSON, subject: 'provider-subject-3' });
    await manager.revoke(drop.session.id, 'admin@example.com', 'revoked');

    const live = await manager.live();
    assert.deepEqual(live.map((session) => session.id), [keep.session.id]);
  });

  /**
   * Ended sessions are evidence for a while — "who was signed in when this was
   * approved" is a real question — so pruning keeps them well past expiry.
   */
  it('prunes only sessions that ended long ago', async () => {
    let now = Date.parse('2026-06-15T12:00:00.000Z');
    const { manager, store } = managerAt(() => new Date(now), { lifetimeMs: 60_000 });
    await manager.open(PERSON);

    now += 120_000;
    assert.equal(await manager.prune(86_400_000), 0, 'recently expired sessions are kept');
    assert.equal(await store.operatorSessions.count(), 1);

    now += 30 * 86_400_000;
    assert.equal(await manager.prune(86_400_000), 1);
    assert.equal(await store.operatorSessions.count(), 0);
  });
});
