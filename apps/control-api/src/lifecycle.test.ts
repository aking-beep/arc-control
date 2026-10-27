import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { MemoryStore } from '@arc-control/store';
import { createControlApi, type ControlApi } from './server.js';

/**
 * ARC-SEC-003 over HTTP: every lifecycle route refuses a retired agent with
 * 409, and every refusal leaves an audit record.
 */

const TOKEN = 'lifecycle-operator-token';
const operator = {
  authorization: `Bearer ${TOKEN}`,
  'x-arc-operator': 'ops@example.com',
  'content-type': 'application/json',
};

describe('retired agents over HTTP', () => {
  let api: ControlApi;
  let base: string;

  before(async () => {
    api = createControlApi({ store: new MemoryStore(), operatorToken: TOKEN });
    const address = await api.listen(0);
    base = `http://${address.host}:${address.port}`;
  });

  after(async () => {
    await api.close();
  });

  const post = async (path: string, body: unknown = {}) => {
    const response = await fetch(`${base}${path}`, { method: 'POST', headers: operator, body: JSON.stringify(body) });
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };
  const get = async (path: string) => (await (await fetch(`${base}${path}`, { headers: operator })).json()) as Record<string, any>;

  it('activate, resume, suspend, keys and retire all answer 409, and each refusal is audited', async () => {
    const created = await post('/v1/agents', { name: 'retiree-agent', owner: 'owner@example.com' });
    assert.equal(created.status, 201);
    const id = created.body.id as string;
    assert.equal((await post(`/v1/agents/${id}/keys`)).status, 201);
    assert.equal((await post(`/v1/agents/${id}/retire`)).body.status, 'retired');

    for (const route of ['activate', 'resume', 'suspend', 'keys', 'retire']) {
      const response = await post(`/v1/agents/${id}/${route}`);
      assert.equal(response.status, 409, `POST /v1/agents/:id/${route}`);
      assert.equal(response.body.error.details.reason, 'agent_retired');
    }

    assert.equal((await get(`/v1/agents/${id}`)).status, 'retired');
    const live = ((await get(`/v1/agents/${id}/keys`)).credentials as { revokedAt?: string }[]).filter((credential) => !credential.revokedAt);
    assert.equal(live.length, 0);

    const records = (await get('/v1/audit?limit=500')).records as { type: string; subject: string }[];
    const refused = records.filter((record) => record.type === 'agent.transition_refused' && record.subject === id);
    assert.equal(refused.length, 5);
  });
});
