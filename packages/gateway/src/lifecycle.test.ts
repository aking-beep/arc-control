import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ArcError } from '@arc-control/schemas';
import { MemoryStore } from '@arc-control/store';
import { Gateway } from './gateway.js';
import { RecordingConnector } from './harness.test-support.js';

/**
 * ARC-SEC-003: retirement is terminal on every path.
 *
 * The Meridian harness revived a retired agent through the API's activate
 * route. 2.1 rerouted that route through `activate`, but the registry still
 * had two unguarded status writes (`resume`, `suspend`), and `retire` revoked
 * credentials before writing its status, so a key issued in between survived.
 * These tests hold the invariant at the registry, where every caller lands.
 */

const ACTOR = { identifier: 'lifecycle-tests', via: 'system' as const };

async function setup() {
  const connector = new RecordingConnector();
  const gateway = new Gateway({ store: new MemoryStore() });
  gateway.addConnector(connector);
  await gateway.admin.registerTool(
    {
      name: 'stripe.refund',
      description: 'Refund a charge.',
      effect: 'irreversible',
      connector: 'recording',
      parameters: [{ name: 'amount', type: 'number', required: true, minimum: 0 }],
    },
    ACTOR,
  );
  await gateway.admin.publishPolicy(
    {
      id: 'ALLOW-REFUNDS',
      version: 1,
      name: 'Allow refunds',
      enabled: true,
      match: { tools: ['stripe.refund'] },
      rules: [{ id: 'allow', when: { always: true }, effect: 'ALLOW', reason: 'ok' }],
      fallback: { effect: 'DENY', reason: 'no' },
    },
    ACTOR,
  );
  const agent = await gateway.admin.registerAgent({ name: 'finance-agent', owner: 'ops@example.com' }, ACTOR);
  const { apiKey } = await gateway.admin.issueKey(agent.id, ACTOR);
  return { gateway, connector, agentId: agent.id, apiKey };
}

const retiredRefusal = (error: ArcError) => error.code === 'conflict' && error.details.reason === 'agent_retired';

describe('ARC-SEC-003: retirement is terminal on every path', () => {
  it('the internal registry refuses resume, activate and suspend of a retired agent', async () => {
    const { gateway, agentId } = await setup();
    await gateway.admin.retireAgent(agentId, ACTOR);

    for (const transition of ['resume', 'activate', 'suspend'] as const) {
      await assert.rejects(() => gateway.agents[transition](agentId), retiredRefusal, `registry.${transition}()`);
    }
    assert.equal((await gateway.agents.require(agentId)).status, 'retired');
  });

  it('administration refuses every reactivation path and audits each attempt', async () => {
    const { gateway, agentId } = await setup();
    await gateway.admin.retireAgent(agentId, ACTOR);

    await assert.rejects(() => gateway.admin.setAgentStatus(agentId, 'active', ACTOR), retiredRefusal);
    await assert.rejects(() => gateway.admin.setAgentStatus(agentId, 'suspended', ACTOR), retiredRefusal);
    await assert.rejects(() => gateway.admin.retireAgent(agentId, ACTOR), retiredRefusal);
    await assert.rejects(() => gateway.admin.issueKey(agentId, ACTOR), retiredRefusal);

    const refused = (await gateway.store.audit.read()).filter((record) => record.type === 'agent.transition_refused');
    assert.deepEqual(
      refused.map((record) => record.data.attempted),
      ['activate', 'suspend', 'retire', 'issue_credential'],
    );
    assert.ok(refused.every((record) => record.subject === agentId));
  });

  it('a retired agent cannot be issued or rotated a credential, and its old key does not act', async () => {
    const { gateway, connector, agentId, apiKey } = await setup();
    const [key] = await gateway.agents.listKeys(agentId);
    await gateway.admin.retireAgent(agentId, ACTOR);

    await assert.rejects(() => gateway.agents.issueKey(agentId), /retired and cannot be issued a credential/);
    await assert.rejects(() => gateway.admin.rotateKey(key!.id, ACTOR), (error: ArcError) => error.code === 'conflict');

    const live = (await gateway.agents.listKeys(agentId)).filter((credential) => !credential.revokedAt);
    assert.equal(live.length, 0);
    await assert.rejects(() => gateway.handle(apiKey, { tool: 'stripe.refund', parameters: { amount: 1 } }));
    assert.equal(connector.callCount(), 0);
  });

  it('a key issued concurrently with retirement does not survive it', async () => {
    for (let round = 0; round < 25; round += 1) {
      const { gateway, agentId } = await setup();
      const outcomes = await Promise.allSettled([
        gateway.agents.issueKey(agentId),
        gateway.admin.retireAgent(agentId, ACTOR),
        gateway.agents.issueKey(agentId),
      ]);
      assert.equal(outcomes[1]!.status, 'fulfilled');
      const live = (await gateway.agents.listKeys(agentId)).filter((credential) => !credential.revokedAt);
      assert.equal(live.length, 0, `round ${round}: a credential outlived retirement`);
    }
  });

  it('a concurrent resume cannot undo a retirement', async () => {
    for (let round = 0; round < 25; round += 1) {
      const { gateway, agentId } = await setup();
      await gateway.admin.setAgentStatus(agentId, 'suspended', ACTOR);
      await Promise.allSettled([
        gateway.agents.resume(agentId),
        gateway.admin.retireAgent(agentId, ACTOR),
        gateway.agents.resume(agentId),
        gateway.admin.setAgentStatus(agentId, 'active', ACTOR),
      ]);
      assert.equal((await gateway.agents.require(agentId)).status, 'retired', `round ${round}`);
    }
  });

  it('retirement keeps its original date', async () => {
    const { gateway, agentId } = await setup();
    const first = await gateway.admin.retireAgent(agentId, ACTOR);
    await assert.rejects(() => gateway.agents.retire(agentId), retiredRefusal);
    assert.equal((await gateway.agents.require(agentId)).retiredAt, first.retiredAt);
  });

  it('returning after retirement means a newly registered identity; draft and suspended agents still activate', async () => {
    const { gateway, connector, agentId } = await setup();
    await gateway.admin.retireAgent(agentId, ACTOR);

    const replacement = await gateway.admin.registerAgent({ name: 'finance-agent-v2', owner: 'ops@example.com' }, ACTOR);
    assert.notEqual(replacement.id, agentId);
    const { apiKey } = await gateway.admin.issueKey(replacement.id, ACTOR);
    assert.equal((await gateway.handle(apiKey, { tool: 'stripe.refund', parameters: { amount: 1 } })).outcome, 'executed');
    assert.equal(connector.callCount(), 1);

    const draft = await gateway.admin.registerAgent({ name: 'draft-agent', owner: 'x@example.com', draft: true }, ACTOR);
    assert.equal((await gateway.admin.setAgentStatus(draft.id, 'active', ACTOR)).status, 'active');
    await gateway.admin.setAgentStatus(replacement.id, 'suspended', ACTOR);
    assert.equal((await gateway.agents.resume(replacement.id)).status, 'active');
  });
});
