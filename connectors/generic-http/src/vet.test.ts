import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyAddress, vetEndpoint, type EndpointProbe } from './vet.js';

const NOW = new Date('2026-10-27T00:00:00Z');
const inDays = (days: number) => new Date(NOW.getTime() + days * 86_400_000).toUTCString();
const healthy: EndpointProbe = { tls: { authorized: true, validTo: inDays(90), subject: 'api.example.com' }, status: 200 };

function vet(url: string, overrides: { addresses?: string[]; probe?: EndpointProbe | Error; allowPrivateHosts?: string[] } = {}) {
  let probed = 0;
  const result = vetEndpoint(url, {
    now: () => NOW,
    resolve: async () => overrides.addresses ?? ['93.184.216.34'],
    probe: async () => {
      probed += 1;
      if (overrides.probe instanceof Error) throw overrides.probe;
      return overrides.probe ?? healthy;
    },
    ...(overrides.allowPrivateHosts ? { allowPrivateHosts: overrides.allowPrivateHosts } : {}),
  });
  return result.then((value) => ({ ...value, probed }));
}

const ids = (result: { findings: readonly { id: string; severity: string }[] }) =>
  result.findings.filter((finding) => finding.severity === 'error').map((finding) => finding.id);

describe('vetEndpoint', () => {
  it('passes a healthy public HTTPS endpoint and records the certificate', async () => {
    const result = await vet('https://api.example.com/v1/refunds/{charge}');
    assert.equal(result.ok, true);
    assert.equal(result.certificate?.daysRemaining, 90);
  });

  it('refuses plaintext HTTP off loopback, and allows it on loopback', async () => {
    assert.deepEqual(ids(await vet('http://api.example.com/x')), ['EP-004']);
    const local = await vet('http://localhost:8080/x', { addresses: ['127.0.0.1'], allowPrivateHosts: ['localhost'], probe: { status: 200 } });
    assert.equal(local.ok, true);
  });

  it('refuses metadata hosts and link-local resolution, even when the host is allow-listed as private', async () => {
    assert.deepEqual(ids(await vet('https://metadata.google.internal/computeMetadata/v1/')), ['EP-003']);
    const rebinding = await vet('https://innocent.example.com/x', { addresses: ['169.254.169.254'], allowPrivateHosts: ['innocent.example.com'] });
    assert.deepEqual(ids(rebinding), ['EP-003']);
    assert.equal(rebinding.probed, 0, 'nothing is probed once resolution is refused');
    assert.deepEqual(ids(await vet('https://169.254.169.254/latest/meta-data/')), ['EP-003']);
  });

  it('refuses a private address unless the host is sanctioned', async () => {
    assert.deepEqual(ids(await vet('https://billing.corp.example/x', { addresses: ['10.0.4.2'] })), ['EP-003']);
    assert.equal((await vet('https://billing.corp.example/x', { addresses: ['10.0.4.2'], allowPrivateHosts: ['billing.corp.example'] })).ok, true);
  });

  it('refuses if any resolved address is private, not only the first', async () => {
    assert.deepEqual(ids(await vet('https://api.example.com/x', { addresses: ['93.184.216.34', '192.168.1.5'] })), ['EP-003']);
  });

  it('fails closed when the host does not resolve or cannot be probed', async () => {
    const unresolved = await vetEndpoint('https://nowhere.example/x', { resolve: async () => { throw new Error('ENOTFOUND'); } });
    assert.deepEqual(ids(unresolved), ['EP-002']);
    assert.deepEqual(ids(await vet('https://api.example.com/x', { probe: new Error('ECONNREFUSED') })), ['EP-005']);
  });

  it('refuses an unverified, expired or nearly expired certificate', async () => {
    assert.deepEqual(ids(await vet('https://api.example.com/x', { probe: { tls: { authorized: false, authorizationError: 'SELF_SIGNED', validTo: inDays(90) }, status: 200 } })), ['EP-005']);
    assert.deepEqual(ids(await vet('https://api.example.com/x', { probe: { tls: { authorized: true, validTo: inDays(-2) }, status: 200 } })), ['EP-006']);
    assert.deepEqual(ids(await vet('https://api.example.com/x', { probe: { tls: { authorized: true, validTo: inDays(5) }, status: 200 } })), ['EP-006']);
    assert.deepEqual(ids(await vet('https://api.example.com/x', { probe: { tls: { authorized: true }, status: 200 } })), ['EP-006']);
  });

  it('refuses a redirect off host or to plaintext, and warns on a same-host redirect', async () => {
    assert.deepEqual(ids(await vet('https://api.example.com/x', { probe: { ...healthy, status: 302, location: 'https://evil.example/x' } })), ['EP-007']);
    assert.deepEqual(ids(await vet('https://api.example.com/x', { probe: { ...healthy, status: 301, location: 'http://api.example.com/x' } })), ['EP-007']);
    const same = await vet('https://api.example.com/x', { probe: { ...healthy, status: 308, location: '/v2/x' } });
    assert.equal(same.ok, true);
    assert.equal(same.findings[0]?.severity, 'warning');
  });

  it('ARC-SEC-007: never echoes credentials or query values from the URL', async () => {
    const result = await vet('https://user:hunter2@api.example.com/x?api_key=SECRET123');
    const invalid = await vet('https://user:hunter2@exa mple.com/?token=SECRET123');
    for (const text of [JSON.stringify(result), JSON.stringify(invalid)]) {
      assert.ok(!text.includes('hunter2'));
      assert.ok(!text.includes('SECRET123'));
    }
  });

  it('refuses credentials embedded in the URL and non-HTTP schemes', async () => {
    assert.deepEqual(ids(await vet('https://user:pass@api.example.com/x')), ['EP-001']);
    assert.deepEqual(ids(await vet('file:///etc/passwd')), ['EP-001']);
    assert.deepEqual(ids(await vet('not a url')), ['EP-001']);
  });
});

describe('classifyAddress', () => {
  it('classifies the ranges that matter, including IPv4-mapped IPv6 in both forms', () => {
    const cases: [string, string][] = [
      ['8.8.8.8', 'public'],
      ['10.1.2.3', 'private'],
      ['172.16.0.1', 'private'],
      ['172.32.0.1', 'public'],
      ['192.168.0.1', 'private'],
      ['127.0.0.1', 'private'],
      ['169.254.169.254', 'link-local'],
      ['0.0.0.0', 'unspecified'],
      ['::', 'unspecified'],
      ['::1', 'private'],
      ['fe80::1', 'link-local'],
      ['fd00::1', 'private'],
      ['2606:4700::1111', 'public'],
      ['::ffff:169.254.169.254', 'link-local'],
      ['::ffff:a9fe:a9fe', 'link-local'],
      ['::ffff:7f00:1', 'private'],
      ['garbage', 'private'],
      // ARC-SEC-012: embedded IPv4 in every IPv6 transition form, and the remaining reserved ranges.
      ['::a9fe:a9fe', 'link-local'],
      ['::169.254.169.254', 'link-local'],
      ['64:ff9b::a9fe:a9fe', 'link-local'],
      ['2002:a9fe:a9fe::1', 'link-local'],
      ['::7f00:1', 'private'],
      ['198.18.0.1', 'private'],
      ['fec0::1', 'private'],
    ];
    for (const [address, kind] of cases) assert.equal(classifyAddress(address), kind, address);
  });
});
