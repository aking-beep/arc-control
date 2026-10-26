import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AUDIT_GENESIS_DIGEST, digest, type AuditRecord, type EvidenceBundle, type EvidenceRecord } from '@arc-control/schemas';
import { MemoryStore } from '@arc-control/store';
import { buildBundle, verifyBundle, verifyChainSlice } from './bundle.js';
import { buildEvidence } from './builder.js';

const AT = '2026-10-20T12:00:00.000Z';

async function storeWithTraffic(): Promise<MemoryStore> {
  const store = new MemoryStore();

  const record = buildEvidence({
    action: {
      id: 'arc_act_1',
      agentId: 'arc_ag_1',
      agentName: 'finance-agent',
      organizationId: 'default',
      environment: 'production',
      tool: 'stripe.refund',
      toolId: 'arc_tl_1',
      parameters: { amount: 100 },
      parametersDigest: digest({ amount: 100 }),
      requestedAt: AT,
    },
    principal: {
      agentId: 'arc_ag_1',
      agentName: 'finance-agent',
      kind: 'autonomous',
      organizationId: 'default',
      environment: 'production',
      owner: 'ops@example.com',
      roles: ['finance'],
      labels: {},
      credentialId: 'arc_cred_1',
    },
    tool: {
      id: 'arc_tl_1',
      name: 'stripe.refund',
      description: 'Refund a charge.',
      system: 'stripe',
      effect: 'irreversible',
      riskTier: 'critical',
      connector: 'simulation',
      connectorConfig: {},
      parameters: [],
      labels: {},
      createdAt: AT,
      updatedAt: AT,
    },
    decision: {
      id: 'arc_dec_1',
      actionId: 'arc_act_1',
      effect: 'ALLOW',
      policyId: 'FINANCE-004',
      policyVersion: 1,
      ruleId: 'under-500',
      reason: 'within authority',
      obligations: [],
      evaluations: [],
      trace: [],
      decidedAt: AT,
      evaluationMs: 1,
    },
    outcome: 'executed',
    now: new Date(AT),
  });

  await store.evidence.put(record.id, record);

  await store.audit.append((previous, sequence) => {
    const content = {
      id: 'arc_aud_1',
      sequence,
      type: 'action.allowed' as const,
      organizationId: 'default',
      occurredAt: AT,
      actor: 'arc_ag_1',
      subject: 'arc_act_1',
      summary: 'allowed a refund',
      data: {},
      previousDigest: previous?.digest ?? AUDIT_GENESIS_DIGEST,
    };
    return { ...content, digest: digest(content) } as AuditRecord;
  });

  return store;
}

/**
 * A store with a real two-record chain.
 *
 * Built by appending through the store rather than by reaching for
 * `@arc-control/audit`: this package does not depend on the audit log and its
 * tests should not either, or a test would be the only thing holding an
 * undeclared edge in the dependency graph. The record digest is computed the
 * same way `computeAuditDigest` does — over every field but `digest` itself.
 */
async function realStore(): Promise<MemoryStore> {
  const store = new MemoryStore();

  for (const [index, summary] of ['one', 'two'].entries()) {
    await store.audit.append((previous, sequence) => {
      const content = {
        id: `arc_aud_${index + 1}`,
        sequence,
        type: 'action.allowed' as const,
        organizationId: 'default',
        occurredAt: AT,
        actor: 'a',
        subject: 's',
        summary,
        data: {},
        previousDigest: previous?.digest ?? AUDIT_GENESIS_DIGEST,
      };
      return { ...content, digest: digest(content) } as AuditRecord;
    });
  }

  return store;
}

describe('building a bundle', () => {
  it('stamps a window, a scope and an exporter on the manifest', async () => {
    const store = await storeWithTraffic();
    const bundle = await buildBundle({
      store,
      scope: { kind: 'window' },
      exportedBy: 'auditor@example.com',
      producedBy: 'arc-control/2.0.0',
      from: new Date('2026-10-01T00:00:00.000Z'),
      to: new Date('2026-10-31T00:00:00.000Z'),
      now: () => new Date(AT),
    });

    assert.equal(bundle.manifest.schemaVersion, 2);
    assert.equal(bundle.manifest.exportedBy, 'auditor@example.com');
    assert.equal(bundle.manifest.producedBy, 'arc-control/2.0.0');
    assert.deepEqual(bundle.manifest.scope, { kind: 'window' });
    assert.ok(bundle.manifest.window.from < bundle.manifest.window.to);
    assert.match(bundle.manifest.contentDigest, /^sha256:[0-9a-f]{64}$/);
  });

  it('carries its own limitations, so the caveats travel with the file', async () => {
    const store = await storeWithTraffic();
    const bundle = await buildBundle({ store, scope: { kind: 'window' }, exportedBy: 'a', producedBy: 'p' });

    assert.ok(bundle.limitations.length >= 3);
    assert.ok(bundle.limitations.some((l) => /does not prove ARC Control recorded them faithfully/.test(l)));
    assert.ok(bundle.limitations.some((l) => /not the whole log/.test(l)));
  });

  it('includes only the named records when scoped to specific evidence', async () => {
    const store = await storeWithTraffic();
    const [record] = await store.evidence.list();

    const bundle = await buildBundle({
      store,
      scope: { kind: 'evidence', evidenceIds: [record!.id] },
      exportedBy: 'a',
      producedBy: 'p',
    });

    assert.equal(bundle.evidence.length, 1);
    assert.equal(bundle.assessments.length, 0);
  });
});

describe('verifying a bundle', () => {
  async function bundleOf(): Promise<EvidenceBundle> {
    const store = await storeWithTraffic();
    return buildBundle({
      store,
      scope: { kind: 'window' },
      exportedBy: 'auditor@example.com',
      producedBy: 'arc-control/2.0.0',
      from: new Date('2026-10-01T00:00:00.000Z'),
      to: new Date('2026-10-31T00:00:00.000Z'),
    });
  }

  it('verifies an untouched bundle', async () => {
    const result = verifyBundle(await bundleOf());
    assert.equal(result.valid, true, JSON.stringify(result.failures));
    assert.ok(result.entriesChecked > 0);
  });

  it('fails when a record is altered after export', async () => {
    const bundle = await bundleOf();
    const tampered: EvidenceBundle = {
      ...bundle,
      evidence: bundle.evidence.map((entry) => ({
        ...entry,
        record: { ...entry.record, outcome: 'denied' } as EvidenceRecord,
      })),
    };

    const result = verifyBundle(tampered);
    assert.equal(result.valid, false);
    assert.ok(result.failures.some((failure) => failure.problem === 'entry_digest_mismatch'));
  });

  /**
   * The subtler attack: alter the record *and* its bundle digest so they
   * agree. The record's own integrity digest, written when ARC stored it,
   * still disagrees.
   */
  it('fails when a record and its bundle digest were both rewritten', async () => {
    const bundle = await bundleOf();
    const altered = { ...bundle.evidence[0]!.record, outcome: 'denied' } as EvidenceRecord;

    const result = verifyBundle({
      ...bundle,
      evidence: [{ id: bundle.evidence[0]!.id, digest: digest(altered), record: altered }],
      manifest: { ...bundle.manifest },
    });

    assert.equal(result.valid, false);
    assert.ok(
      result.failures.some((failure) => /integrity digest ARC Control stored with it/.test(failure.detail)),
      JSON.stringify(result.failures),
    );
  });

  it('fails when a record is removed from the bundle', async () => {
    const bundle = await bundleOf();
    const result = verifyBundle({ ...bundle, evidence: [] });

    assert.equal(result.valid, false);
    assert.ok(result.failures.some((failure) => failure.problem === 'content_digest_mismatch'));
  });

  it('rejects a bundle schema it does not understand', async () => {
    const bundle = await bundleOf();
    const result = verifyBundle({
      ...bundle,
      manifest: { ...bundle.manifest, schemaVersion: 99 as never },
    });

    assert.equal(result.valid, false);
    assert.equal(result.failures[0]!.problem, 'schema_unsupported');
  });

  /**
   * The distinction the whole report design turns on: an intact bundle with no
   * external anchor is valid *and* limited. Reporting that as tampering would
   * be as misleading as not reporting it at all.
   */
  it('separates a missing anchor from a tampered record', async () => {
    const result = verifyBundle(await bundleOf());

    assert.equal(result.valid, true);
    assert.equal(result.failures.length, 0);
    assert.ok(result.limitations.some((limitation) => limitation.problem === 'chain_unanchored'));
    assert.ok(result.limitations.some((limitation) => /cannot rule out that records were removed/.test(limitation.detail)));
  });

  it('stops reporting the anchor limitation once an anchor is supplied', async () => {
    const store = await realStore();
    const head = await store.audit.last();

    const bundle = await buildBundle({
      store,
      scope: { kind: 'window' },
      exportedBy: 'a',
      producedBy: 'p',
      from: new Date('2026-10-01T00:00:00.000Z'),
      to: new Date('2026-10-31T00:00:00.000Z'),
      anchor: {
        headDigest: head!.digest,
        headSequence: head!.sequence,
        recordedAt: 's3://audit-anchors/2026-10',
        recordedBy: 'secops@example.com',
      },
    });

    const result = verifyBundle(bundle);
    assert.equal(result.valid, true, JSON.stringify(result.failures));
    assert.equal(result.limitations.filter((l) => l.problem === 'chain_unanchored').length, 0);
    assert.equal(result.chain!.checkedAgainstExpectation, true);
  });

  it('notices an anchor that disagrees with the slice head', async () => {
    const store = await realStore();
    const head = await store.audit.last();

    const bundle = await buildBundle({
      store,
      scope: { kind: 'window' },
      exportedBy: 'a',
      producedBy: 'p',
      from: new Date('2026-10-01T00:00:00.000Z'),
      to: new Date('2026-10-31T00:00:00.000Z'),
      anchor: {
        headDigest: 'sha256:0000000000000000000000000000000000000000000000000000000000000001',
        headSequence: head!.sequence,
        recordedAt: 'elsewhere',
        recordedBy: 'secops@example.com',
      },
    });

    const result = verifyBundle(bundle);
    assert.equal(result.valid, false);
    assert.ok(result.failures.some((failure) => /anchor recorded/.test(failure.detail)));
  });

  it('reports an empty bundle as evidencing nothing', async () => {
    const store = new MemoryStore();
    const bundle = await buildBundle({ store, scope: { kind: 'window' }, exportedBy: 'a', producedBy: 'p' });

    const result = verifyBundle(bundle);
    assert.equal(result.entriesChecked, 0);
    assert.ok(result.limitations.some((limitation) => limitation.problem === 'empty_window'));
  });

  it('needs no store, no network and no ARC instance', async () => {
    // Round-tripping through JSON is the real test: whatever a verifier is
    // handed, it is a file, not a live object graph.
    const bundle = await bundleOf();
    const roundTripped = JSON.parse(JSON.stringify(bundle)) as EvidenceBundle;

    const result = verifyBundle(roundTripped);
    assert.equal(result.valid, true, JSON.stringify(result.failures));
  });
});

describe('verifying an audit slice', () => {
  it('accepts a slice that does not start at genesis', async () => {
    const store = await realStore();
    const all = await store.audit.read({ limit: 10 });
    const result = verifyChainSlice(all.slice(1));

    assert.equal(result.valid, true, JSON.stringify(result.failures));
    assert.equal(result.recordsChecked, 1);
  });

  it('still checks genesis when the slice does start at sequence 1', async () => {
    const store = await realStore();
    const all = await store.audit.read({ limit: 10 });
    const broken = [{ ...all[0]!, previousDigest: 'sha256:deadbeef' }, ...all.slice(1)];

    const result = verifyChainSlice(broken);
    assert.equal(result.valid, false);
    assert.ok(result.failures.some((failure) => /genesis digest/.test(failure.detail)));
  });

  it('detects a gap inside the slice', async () => {
    const store = await realStore();
    const all = await store.audit.read({ limit: 10 });
    const result = verifyChainSlice([all[0]!, { ...all[1]!, sequence: 9 }]);

    assert.equal(result.valid, false);
    assert.ok(result.failures.some((failure) => failure.problem === 'sequence_gap'));
  });

  it('detects an edited record', async () => {
    const store = await realStore();
    const all = await store.audit.read({ limit: 10 });
    const result = verifyChainSlice([{ ...all[0]!, summary: 'rewritten' }, all[1]!]);

    assert.equal(result.valid, false);
    assert.ok(result.failures.some((failure) => failure.problem === 'digest_mismatch'));
  });
});
