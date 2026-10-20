import { expect } from '../harness.mjs';
import { buildHarness, refund, tamperKey } from '../fixtures.mjs';

/**
 * Identity is the first gate. If an action can reach a tool without being
 * attributed to a known, active agent, nothing downstream matters: policy
 * cannot bound an agent it cannot name, and evidence cannot attribute an act
 * to a principal that was never established.
 */
export default {
  id: 'authorization/identity',
  title: 'Identity is the first gate',
  rationale: 'Nothing reaches a tool without being attributed to a known, active agent.',
  cases: [
    {
      name: 'an action with no credential never reaches the tool',
      async run() {
        const { gateway, connector } = await buildHarness();
        await expect.rejects(
          () => gateway.handle(undefined, refund(10)),
          'unauthenticated',
          'an unauthenticated action must be refused',
        );
        expect.equal(connector.callCount(), 0, 'an unauthenticated action must not reach the connector');
      },
    },
    {
      name: 'a forged credential never reaches the tool',
      async run() {
        const { gateway, connector, apiKey } = await buildHarness();
        await expect.rejects(
          () => gateway.handle(tamperKey(apiKey), refund(10)),
          'unauthenticated',
          'a credential with an altered secret must be refused',
        );
        expect.equal(connector.callCount(), 0, 'a forged credential must not reach the connector');
      },
    },
    {
      name: 'every authentication failure reports the same thing',
      async run() {
        const { gateway, apiKey } = await buildHarness();

        const errors = await Promise.all([
          expect.rejects(() => gateway.handle('', refund(10)), 'unauthenticated', 'empty key'),
          expect.rejects(() => gateway.handle('not-a-key', refund(10)), 'unauthenticated', 'malformed key'),
          expect.rejects(() => gateway.handle('arck_0000000000000000_' + '0'.repeat(64), refund(10)), 'unauthenticated', 'unknown reference'),
          expect.rejects(() => gateway.handle(tamperKey(apiKey), refund(10)), 'unauthenticated', 'wrong secret'),
        ]);

        const messages = new Set(errors.map((error) => error.message));
        expect.equal(
          messages.size,
          1,
          'authentication failures must be indistinguishable, or the endpoint enumerates valid credentials',
        );
      },
    },
    {
      name: 'a revoked credential stops working immediately',
      async run() {
        const { gateway, agent, apiKey, connector } = await buildHarness();
        const keys = await gateway.agents.listKeys(agent.id);
        await gateway.admin.revokeKey(keys[0].id, { identifier: 'evals', via: 'system' });

        await expect.rejects(
          () => gateway.handle(apiKey, refund(10)),
          'unauthenticated',
          'a revoked credential must be refused',
        );
        expect.equal(connector.callCount(), 0, 'a revoked credential must not reach the connector');
      },
    },
    {
      name: 'suspending an agent stops it before policy is consulted',
      async run() {
        const { gateway, agent, apiKey, connector } = await buildHarness();
        await gateway.admin.setAgentStatus(agent.id, 'suspended', { identifier: 'evals', via: 'system' });

        // $10 would otherwise be allowed outright, so reaching the suspension
        // check proves the stop happens before evaluation.
        const error = await expect.rejects(
          () => gateway.handle(apiKey, refund(10)),
          'agent_suspended',
          'a suspended agent must be refused even for an action policy would allow',
        );
        expect.match(error.message, /suspended/, 'the refusal should say the agent is suspended');
        expect.equal(connector.callCount(), 0, 'a suspended agent must not reach the connector');
      },
    },
    {
      name: 'resuming an agent restores exactly its prior authority',
      async run() {
        const { gateway, agent, apiKey } = await buildHarness();
        const actor = { identifier: 'evals', via: 'system' };
        await gateway.admin.setAgentStatus(agent.id, 'suspended', actor);
        await gateway.admin.setAgentStatus(agent.id, 'active', actor);

        const allowed = await gateway.handle(apiKey, refund(10));
        expect.equal(allowed.outcome, 'executed', 'a resumed agent regains its allowed actions');

        const denied = await gateway.handle(apiKey, refund(4200));
        expect.equal(denied.outcome, 'denied', 'resuming must not grant anything policy did not already permit');
      },
    },
    {
      name: 'evidence names the credential that authenticated the request',
      async run() {
        const { gateway, agent, apiKey } = await buildHarness();
        const result = await gateway.handle(apiKey, refund(10));
        const evidence = await gateway.evidence(result.evidenceId);
        const keys = await gateway.agents.listKeys(agent.id);

        expect.equal(
          evidence.agent.credentialId,
          keys[0].id,
          'evidence must name the credential used, so a compromised key can be traced to everything it did',
        );
      },
    },
  ],
};
