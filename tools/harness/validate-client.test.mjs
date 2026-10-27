import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { validateProfile } from './validate-client.mjs';

/**
 * The client validator is only useful if it fails when a profile is wrong. A
 * validator that passes everything would make every client look governed, so
 * each check below starts from the valid template and breaks one thing.
 */

const template = JSON.parse(await readFile(new URL('../../clients/_template/profile.json', import.meta.url), 'utf8'));
const clone = () => structuredClone(template);

describe('validate-client', () => {
  it('accepts the template', async () => {
    const report = await validateProfile(clone());
    assert.deepEqual(report.errors, []);
    assert.equal(report.results.filter((result) => result.pass).length, template.scenarios.length);
  });

  it('fails a scenario whose expected outcome is wrong', async () => {
    const profile = clone();
    profile.scenarios[0].expect = 'denied';
    const report = await validateProfile(profile);
    assert.ok(report.errors.some((message) => message.includes('routine-refund') && message.includes('expected denied, got executed')));
  });

  it('fails a policy that would let a held refund through', async () => {
    const profile = clone();
    profile.policies[0].rules = profile.policies[0].rules.map((rule) =>
      rule.id === 'manager-approval' ? { ...rule, effect: 'ALLOW', approval: undefined } : rule,
    );
    const report = await validateProfile(profile);
    assert.ok(report.errors.some((message) => message.includes('held-refund')));
  });

  it('requires a negative scenario for every write or irreversible tool', async () => {
    const profile = clone();
    profile.scenarios = profile.scenarios.filter((scenario) => scenario.expect === 'executed');
    const report = await validateProfile(profile);
    assert.ok(report.errors.some((message) => message.includes('has no negative scenario')));
  });

  it('enforces separation of duties on irreversible approvals when the profile requires it', async () => {
    const profile = clone();
    delete profile.policies[0].rules[2].approval.requireSeparationOfDuties;
    const strict = await validateProfile(profile);
    assert.ok(strict.errors.some((message) => message.includes('without requireSeparationOfDuties')));

    profile.requirements.separationOfDutiesForIrreversible = false;
    const lenient = await validateProfile(profile);
    assert.deepEqual(lenient.errors, []);
    assert.ok(lenient.warnings.some((message) => message.includes('without requireSeparationOfDuties')));
  });

  it('rejects an invalid policy before registering anything', async () => {
    const profile = clone();
    profile.policies[0].rules[0].effect = 'MAYBE';
    const report = await validateProfile(profile);
    assert.ok(report.errors.some((message) => message.startsWith('policy "TEMPLATE-BILLING-001"')));
    assert.equal(report.results.length, 0);
  });

  it('rejects references to agents, tools and approvers that do not exist', async () => {
    const profile = clone();
    profile.agents[0].declaredTools = ['billing.void'];
    profile.scenarios[0].agent = 'ghost-agent';
    profile.scenarios[2].approveAs = 'nobody@client.example';
    const report = await validateProfile(profile);
    assert.ok(report.errors.some((message) => message.includes('unknown tool "billing.void"')));
    assert.ok(report.errors.some((message) => message.includes('unknown agent "ghost-agent"')));
    assert.ok(report.errors.some((message) => message.includes('unknown approver')));
  });

  it('warns when a tool is covered by no policy', async () => {
    const profile = clone();
    profile.tools.push({ name: 'billing.lookup', description: 'Read a charge.', effect: 'read', connector: 'generic-http', parameters: [] });
    const report = await validateProfile(profile);
    assert.deepEqual(report.errors, []);
    assert.ok(report.warnings.some((message) => message.includes('"billing.lookup" is matched by no enabled policy')));
  });
});

describe('validate-client evidence', () => {
  it('fails a decided scenario whose evidence was never recorded', async () => {
    const report = await validateProfile(clone(), '(test)', {
      gateway(gateway) {
        gateway.evidence = async () => undefined;
      },
    });
    assert.ok(report.errors.some((message) => message.includes('was not recorded')));
  });

  it('fails a decided scenario that returns no evidence id at all', async () => {
    const report = await validateProfile(clone(), '(test)', {
      gateway(gateway) {
        const handle = gateway.handle.bind(gateway);
        gateway.handle = async (...args) => {
          const { evidenceId: _dropped, ...rest } = await handle(...args);
          return rest;
        };
      },
    });
    assert.ok(report.errors.some((message) => message.includes('returned no evidence id')));
  });
});
