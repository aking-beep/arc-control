#!/usr/bin/env node
/**
 * Publishes a policy pack's policies to a running ARC Control, through the
 * audited administration API.
 *
 * Only the policies are published. A pack's tools, agents and scenarios are
 * the fixture it was validated against, not things to create in a client's
 * deployment. The pack is validated first and nothing is sent if it fails,
 * and the default is a dry run that prints what would be published: a pack
 * is a starting point an operator reads, adapts and then owns, never
 * something applied implicitly.
 *
 * Usage:
 *   node tools/policy-packs/apply.mjs policy-packs/<id>/pack.json            # dry run
 *   ARC_OPERATOR_TOKEN=... node tools/policy-packs/apply.mjs <pack.json> --api https://arc.example.com --publish
 *
 * A policy whose id already exists at the same or a higher version is
 * refused by the API (`conflict`), so re-applying a pack never silently
 * overwrites an operator's edits.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateProfile } from '../harness/validate-client.mjs';
import { parseArgs } from '../harness/lib.mjs';
import { packProblems } from './validate.mjs';

export async function applyPack(pack, { api, token, operator = 'policy-packs', publish = false, fetch = globalThis.fetch } = {}) {
  const profile = await validateProfile(pack, pack.id);
  const errors = [...packProblems(pack), ...profile.errors];
  if (errors.length > 0) return { published: [], errors };
  if (!publish) return { published: [], dryRun: pack.policies.map((policy) => `${policy.id} v${policy.version}`), errors: [] };
  if (!api || !token) return { published: [], errors: ['--publish needs --api and ARC_OPERATOR_TOKEN'] };

  const published = [];
  for (const policy of pack.policies) {
    const response = await fetch(`${api.replace(/\/$/, '')}/v1/policies`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'x-arc-operator': operator, 'content-type': 'application/json' },
      body: JSON.stringify({ ...policy, labels: { ...(policy.labels ?? {}), 'arc.pack': pack.id, 'arc.pack.version': String(pack.pack.version) } }),
    });
    if (!response.ok) {
      const body = await response.text();
      return { published, errors: [`${policy.id}: HTTP ${response.status} ${body.slice(0, 300)}`] };
    }
    published.push(`${policy.id} v${policy.version}`);
  }
  return { published, errors: [] };
}

async function main() {
  const { options, positional } = parseArgs();
  if (positional.length !== 1) {
    process.stderr.write('usage: apply.mjs <pack.json> [--api <url> --publish] [--operator <identifier>]\n');
    process.exitCode = 2;
    return;
  }
  const pack = JSON.parse(await readFile(resolve(positional[0]), 'utf8'));
  const result = await applyPack(pack, {
    api: typeof options.api === 'string' ? options.api : undefined,
    token: process.env.ARC_OPERATOR_TOKEN,
    operator: typeof options.operator === 'string' ? options.operator : 'policy-packs',
    publish: options.publish === true,
  });
  for (const line of result.errors) process.stderr.write(`error ${line}\n`);
  for (const line of result.dryRun ?? []) process.stdout.write(`would publish ${line}\n`);
  for (const line of result.published) process.stdout.write(`published ${line}\n`);
  if (result.errors.length > 0) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
