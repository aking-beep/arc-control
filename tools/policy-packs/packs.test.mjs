import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { MemoryStore } from '@arc-control/store';
import { createControlApi } from '@arc-control/control-api';
import { applyPack } from './apply.mjs';
import { discover, packProblems } from './validate.mjs';

const load = async (path) => JSON.parse(await readFile(path, 'utf8'));

describe('policy packs', () => {
  it('every shipped pack passes the pack rules', async () => {
    const files = await discover();
    assert.ok(files.length >= 4);
    for (const file of files) assert.deepEqual(packProblems(await load(file)), [], file);
  });

  it('refuses a pack policy that is not PACK- prefixed, matches beyond roles, or falls back to ALLOW', async () => {
    const pack = await load((await discover())[0]);
    const policy = pack.policies[0];
    const variants = [
      { ...policy, id: 'FINANCE-004' },
      { ...policy, match: {} },
      { ...policy, match: { agents: ['approval-router'] } },
      { ...policy, match: { agents: ['role:approval-router', '*'] } },
      { ...policy, fallback: { effect: 'ALLOW', reason: 'open' } },
    ];
    for (const variant of variants) {
      assert.equal(packProblems({ ...pack, policies: [variant] }).length, 1, JSON.stringify(variant.match ?? variant.id));
    }
    assert.ok(packProblems({ ...pack, pack: undefined }).length > 0);
  });

  it('dry-runs by default and sends nothing', async () => {
    const pack = await load((await discover())[0]);
    let calls = 0;
    const result = await applyPack(pack, { api: 'http://x', token: 't', fetch: async () => { calls += 1; } });
    assert.equal(calls, 0);
    assert.deepEqual(result.errors, []);
    assert.equal(result.dryRun.length, pack.policies.length);
  });

  it('publishes through the audited API, labelled with the pack, and never overwrites on re-apply', async () => {
    const store = new MemoryStore();
    const api = createControlApi({ store, operatorToken: 'pack-test-token', schedule: false });
    const address = await api.listen(0);
    const base = `http://${address.host}:${address.port}`;
    try {
      const pack = await load((await discover()).find((file) => file.includes('meeting-to-crm')));
      const first = await applyPack(pack, { api: base, token: 'pack-test-token', publish: true });
      assert.deepEqual(first.errors, []);
      const stored = await api.gateway.policies.get('PACK-CRM-001');
      assert.equal(stored?.labels?.['arc.pack'], 'pack-meeting-to-crm');
      assert.ok((await api.gateway.audit.read()).some((record) => record.type === 'policy.created' && record.subject === 'PACK-CRM-001'));

      const again = await applyPack(pack, { api: base, token: 'pack-test-token', publish: true });
      assert.match(again.errors[0] ?? '', /HTTP 409/);
    } finally {
      await api.close();
      await store.close();
    }
  });

  it('refuses to publish a pack that does not validate', async () => {
    const pack = await load((await discover())[0]);
    let calls = 0;
    const broken = { ...pack, scenarios: pack.scenarios.map((scenario) => ({ ...scenario, expect: 'executed' })) };
    const result = await applyPack(broken, { api: 'http://x', token: 't', publish: true, fetch: async () => { calls += 1; } });
    assert.ok(result.errors.length > 0);
    assert.equal(calls, 0);
  });
});
