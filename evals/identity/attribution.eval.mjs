import { MemoryStore } from '@arc-control/store';
import { SessionManager } from '@arc-control/operator-identity';
import { Notifier } from '@arc-control/notify';
import { assuranceOf, isAttributable, weakestAssurance } from '@arc-control/schemas';
import { expect } from '../harness.mjs';

/**
 * What a recorded name is worth.
 *
 * The 2.0 release took an operator's identity from a request header behind a
 * shared token, and said so plainly. 2.1 can authenticate people properly —
 * and the risk that creates is subtler than the one it fixes: once some
 * approvals are attributable, the temptation is to present all of them that
 * way.
 *
 * These are the properties that stop that. Each is a claim about the product
 * rather than about a function: a record must never read as stronger than the
 * way its subject was identified.
 */
export default {
  id: 'identity/attribution',
  title: 'A recorded identity never reads as stronger than it is',
  rationale:
    'An approval is only worth the way its approver was identified, and a mixed deployment is worth its weakest.',
  cases: [
    {
      name: 'a record written before assurance was tracked reads as claimed, not as verified',
      run() {
        // The honest default for a 1.x or 2.0 vote. Assuming the best of a
        // record that cannot speak for itself would silently upgrade the whole
        // history of every deployment that upgrades.
        expect.equal(assuranceOf({}), 'claimed');
        expect.equal(assuranceOf({ assurance: undefined }), 'claimed');
        expect.equal(assuranceOf({ assurance: 'authenticated' }), 'authenticated');
      },
    },
    {
      name: 'a claimed identity is never attributable, whatever else is true of it',
      run() {
        expect.equal(isAttributable('claimed'), false);
        expect.equal(isAttributable('authenticated'), true);
        expect.equal(isAttributable('asserted_by_proxy'), true);
      },
    },
    {
      name: 'a mixed set of identities is worth its weakest member',
      run() {
        // One claimed vote in an otherwise verified approval makes the
        // approval unattributable, because that is the vote somebody would
        // dispute. Rounding up is how a report becomes a lie.
        expect.equal(weakestAssurance(['authenticated', 'claimed']), 'claimed');
        expect.equal(weakestAssurance(['authenticated', 'asserted_by_proxy']), 'asserted_by_proxy');
        expect.equal(weakestAssurance(['authenticated', 'authenticated']), 'authenticated');
        expect.equal(weakestAssurance([]), undefined, 'an empty set makes no claim at all');
      },
    },
    {
      name: 'a session cookie proves only that this deployment issued it',
      async run() {
        const store = new MemoryStore();
        const sessions = new SessionManager({ store, signingSecret: 's'.repeat(64) });
        const { session, cookie } = await sessions.open({
          identifier: 'cfo@example.com',
          subject: 'subject-1',
          issuer: 'https://login.example.com',
          roles: ['finance-manager'],
        });

        const resolved = await sessions.resolve(cookie);
        expect.equal(resolved.assurance, 'authenticated');
        expect.equal(resolved.identifier, 'cfo@example.com');

        const unsigned = await sessions.resolve(session.id).then(
          () => 'resolved',
          (error) => error.code,
        );
        expect.equal(unsigned, 'unauthenticated', 'an unsigned session id must not authenticate anyone');
      },
    },
    {
      name: 'roles come from the session, never from the request',
      async run() {
        const store = new MemoryStore();
        const sessions = new SessionManager({ store, signingSecret: 's'.repeat(64) });
        const { cookie } = await sessions.open({
          identifier: 'intern@example.com',
          subject: 'subject-2',
          issuer: 'https://login.example.com',
          roles: [],
        });

        const resolved = await sessions.resolve(cookie);
        expect.equal(resolved.roles.length, 0, 'a signed-in operator cannot widen their own authority');
      },
    },
    {
      name: 'revoking a session ends it immediately rather than at expiry',
      async run() {
        const store = new MemoryStore();
        const sessions = new SessionManager({ store, signingSecret: 's'.repeat(64) });
        const { session, cookie } = await sessions.open({
          identifier: 'leaver@example.com',
          subject: 'subject-3',
          issuer: 'https://login.example.com',
          roles: ['admin'],
        });

        await sessions.revoke(session.id, 'admin@example.com', 'left the company');

        const after = await sessions.resolve(cookie).then(
          () => 'still valid',
          (error) => error.code,
        );
        expect.equal(after, 'unauthenticated', 'a stateless token would stay valid until it expired');
      },
    },
    {
      name: 'a notification that was not delivered is never recorded as delivered',
      async run() {
        const store = new MemoryStore();
        const notifier = new Notifier({ store, fetch: () => Promise.reject(new Error('unreachable')) });
        await notifier.addChannel({ name: 'broken', url: 'https://127.0.0.1:1/hook' });

        const [delivery] = await notifier.notify({
          event: 'approval.requested',
          subject: 'arc_apr_1',
          summary: 'needs a human',
        });

        expect.ok(delivery, 'the attempt is recorded even though it failed');
        expect.ok(delivery.status !== 'delivered', `status was "${delivery.status}"`);
        expect.equal(delivery.deliveredAt, undefined, 'and carries no delivery time');
        expect.ok(delivery.attempts.length > 0, 'with the reason attached');
        expect.equal((await notifier.failures()).length, 1, 'and it is listed as a failure');
      },
    },
    {
      name: 'a notification leaves action parameters behind unless a channel asked for them',
      async run() {
        const store = new MemoryStore();
        const sent = [];
        const notifier = new Notifier({
          store,
          fetch: (url, init) => {
            sent.push(JSON.parse(String(init.body)));
            return Promise.resolve(new Response('', { status: 200 }));
          },
        });

        await notifier.addChannel({ name: 'quiet', url: 'https://hooks.example.com/a' });
        await notifier.notify({
          event: 'approval.requested',
          subject: 'arc_apr_1',
          summary: 'a refund needs a human',
          parameters: { amount: 25000, customer: 'cus_secret' },
        });

        const body = JSON.stringify(sent[0]);
        expect.ok(!body.includes('cus_secret'), 'a chat workspace has its own membership and retention');
        expect.ok(!body.includes('25000'), 'redacted is not the same as safe to publish');
      },
    },
    {
      name: 'a plaintext notification destination is refused',
      async run() {
        const notifier = new Notifier({ store: new MemoryStore() });
        const outcome = await notifier.addChannel({ name: 'insecure', url: 'http://hooks.example.com/a' }).then(
          () => 'accepted',
          (error) => error.code,
        );
        expect.equal(outcome, 'invalid_request', 'approval metadata must not go out in clear');
      },
    },
  ],
};
