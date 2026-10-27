import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ArcError, type ToolRegistration } from '@arc-control/schemas';
import { MemoryStore } from '@arc-control/store';
import { Gateway } from './gateway.js';
import type { EndpointVetter } from './admin.js';

const operator = { identifier: 'ops@example.com', via: 'api' } as const;

const tool = (url?: string): ToolRegistration => ({
  name: 'billing.refund',
  description: 'Refund.',
  effect: 'irreversible',
  riskTier: 'critical',
  connector: 'generic-http',
  connectorConfig: url === undefined ? {} : { url, method: 'POST' },
  parameters: [],
});

function setup(vetter?: EndpointVetter) {
  const store = new MemoryStore();
  const gateway = new Gateway({ store, ...(vetter ? { gates: { endpointVetter: vetter } } : {}) });
  gateway.addConnector({ name: 'generic-http', supports: (t) => t.connector === 'generic-http', execute: async () => ({ output: {} }) });
  return { store, gateway };
}

const passing: EndpointVetter = {
  vet: async (url) => ({ ok: true, url, findings: [], certificate: { validTo: '2027-01-01T00:00:00.000Z' }, vettedAt: '2026-10-27T00:00:00.000Z' }),
};
const failing: EndpointVetter = {
  vet: async (url) => ({ ok: false, url, findings: [{ id: 'EP-003', severity: 'error', detail: 'resolves to 169.254.169.254' }], vettedAt: '2026-10-27T00:00:00.000Z' }),
};

describe('endpoint gate at tool registration', () => {
  it('registers a tool whose endpoint passes, labelled with when and until when', async () => {
    const { gateway } = setup(passing);
    const registered = await gateway.admin.registerTool(tool('https://api.example.com/refunds'), operator);
    assert.equal(registered.labels.endpointVettedAt, '2026-10-27T00:00:00.000Z');
    assert.equal(registered.labels.endpointCertificateValidTo, '2027-01-01T00:00:00.000Z');
  });

  it('refuses a tool whose endpoint fails, registers nothing, and audits the findings', async () => {
    const { gateway, store } = setup(failing);
    await assert.rejects(
      gateway.admin.registerTool(tool('https://innocent.example.com/x'), operator),
      (error: unknown) => error instanceof ArcError && error.code === 'gate_refused' && error.details.gate === 'endpoint',
    );
    assert.equal(await store.tools.count(), 0);
    const entry = (await gateway.audit.read()).find((record) => record.type === 'tool.registration_refused');
    assert.match(JSON.stringify(entry?.data), /EP-003/);
  });

  it('fails closed when the vetter throws', async () => {
    const { gateway, store } = setup({ vet: async () => { throw new Error('resolver down'); } });
    await assert.rejects(gateway.admin.registerTool(tool('https://api.example.com/x'), operator), /could not be vetted/);
    assert.equal(await store.tools.count(), 0);
  });

  it('refuses a vetter result that says ok but carries an error finding', async () => {
    const contradictory: EndpointVetter = {
      vet: async (url) => ({ ok: true, url, findings: [{ id: 'EP-006', severity: 'error', detail: 'expired' }], vettedAt: 'x' }),
    };
    const { gateway } = setup(contradictory);
    await assert.rejects(gateway.admin.registerTool(tool('https://api.example.com/x'), operator), /EP-006/);
  });

  it('leaves tools without a URL, and every tool when the gate is off, alone', async () => {
    const vetted = setup(failing);
    await vetted.gateway.admin.registerTool({ ...tool(), name: 'sim.tool' }, operator);
    const off = setup();
    const registered = await off.gateway.admin.registerTool(tool('https://api.example.com/x'), operator);
    assert.equal(registered.labels.endpointVettedAt, undefined);
  });
});
