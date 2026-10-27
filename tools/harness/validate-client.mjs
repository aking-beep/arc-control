#!/usr/bin/env node
/**
 * Validates a client profile against the real control plane.
 *
 * A client profile (`clients/<id>/profile.json`) is everything ARC needs to
 * govern one customer's agents: the tools they expose, the agents that act,
 * the policies that decide, the humans who approve, and the scenarios that
 * say what must happen. This script loads a profile into a real in-memory
 * gateway — real registry, real policy engine, real approvals, real evidence —
 * with only the final side effect simulated, and checks:
 *
 *   1. structure     — required fields, unique names, references resolve
 *   2. policy        — every policy passes `validatePolicy` (what `arc policy lint` runs)
 *   3. registration  — every tool and agent registers through the audited admin path
 *   4. coverage      — every tool is matched by an enabled policy; every
 *                      write/irreversible tool has at least one positive and
 *                      one negative scenario; every agent is exercised
 *   5. separation    — approval rules on irreversible tools require
 *                      separation of duties (error when the profile demands it)
 *   6. scenarios     — each one produces its expected outcome AND its expected
 *                      number of effects at the connector, because a response
 *                      that says "denied" while the effect happened is the
 *                      failure this exists to catch
 *   7. evidence      — every decided scenario left a record that verifies
 *
 * Usage:
 *   node tools/harness/validate-client.mjs                 # every clients/*\/profile.json
 *   node tools/harness/validate-client.mjs path/to/profile.json [--json] [--out result.json]
 *
 * Exits non-zero when any profile has an error. Warnings do not fail the run;
 * they are what a reviewer should read before the profile goes to a customer.
 *
 * This proves the profile is internally consistent against this build of ARC.
 * It does not prove the client's real systems are reachable only through ARC,
 * that their approvers are who the profile says, or anything about load.
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Gateway } from '@arc-control/gateway';
import { MemoryStore } from '@arc-control/store';
import { SimulationConnector } from '@arc-control/connector-simulation';
import { verifyEvidence } from '@arc-control/evidence';
import { validatePolicy } from '@arc-control/schemas';
import { parseArgs, writeResult } from './lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUTCOMES = new Set(['executed', 'denied', 'pending_approval', 'refused']);
const ACTOR = { identifier: 'harness:client-validator', via: 'system' };
/** Every tool is rebound to this connector, so nothing in a profile can reach a real system. */
const CONNECTOR = 'harness-simulation';

export async function validateProfile(profile, source = '(inline)') {
  const errors = [];
  const warnings = [];
  const results = [];
  const error = (message) => errors.push(message);
  const warn = (message) => warnings.push(message);

  // --- 1. structure -------------------------------------------------------
  for (const field of ['id', 'name', 'tools', 'agents', 'policies', 'scenarios']) {
    if (profile[field] === undefined) error(`missing required field "${field}"`);
  }
  if (errors.length > 0) return { source, id: profile.id, errors, warnings, results };

  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(profile.id) && profile.id !== '_template') {
    error(`id "${profile.id}" must be lowercase letters, digits and dashes`);
  }
  const unique = (items, label) => {
    const seen = new Set();
    for (const item of items) {
      const key = item.name ?? item.id ?? item.identifier;
      if (seen.has(key)) error(`duplicate ${label} "${key}"`);
      seen.add(key);
    }
    return seen;
  };
  const toolNames = unique(profile.tools, 'tool');
  const agentNames = unique(profile.agents, 'agent');
  unique(profile.policies, 'policy');
  unique(profile.scenarios, 'scenario');
  const approvers = new Map((profile.approvers ?? []).map((approver) => [approver.identifier, approver]));

  for (const agent of profile.agents) {
    for (const tool of agent.declaredTools ?? []) {
      if (!toolNames.has(tool)) error(`agent "${agent.name}" declares unknown tool "${tool}"`);
    }
  }
  for (const scenario of profile.scenarios) {
    if (!OUTCOMES.has(scenario.expect)) error(`scenario "${scenario.id}" expects unknown outcome "${scenario.expect}"`);
    if (!agentNames.has(scenario.agent)) error(`scenario "${scenario.id}" names unknown agent "${scenario.agent}"`);
    if (scenario.approveAs !== undefined) {
      if (scenario.expect !== 'pending_approval') error(`scenario "${scenario.id}" sets approveAs but does not expect pending_approval`);
      if (!approvers.has(scenario.approveAs)) error(`scenario "${scenario.id}" approves as unknown approver "${scenario.approveAs}"`);
    }
  }

  // --- 2. policy ----------------------------------------------------------
  for (const policy of profile.policies) {
    const verdict = validatePolicy(policy);
    if (!verdict.valid) {
      for (const issue of verdict.issues) error(`policy "${policy.id}": ${issue.path} ${issue.message}`);
    }
  }
  if (errors.length > 0) return { source, id: profile.id, errors, warnings, results };

  // --- 3. registration ----------------------------------------------------
  const connector = new SimulationConnector({ name: CONNECTOR });
  for (const tool of profile.tools) connector.handle(tool.name, (parameters) => ({ simulated: true, tool: tool.name, parameters }));

  const gateway = new Gateway({
    store: new MemoryStore(),
    defaultOrganizationId: profile.organizationId ?? profile.id,
    defaultEnvironment: profile.environment ?? 'production',
    ...(profile.classification ? { classification: profile.classification } : {}),
  });
  gateway.addConnector(connector);

  const keys = new Map();
  try {
    for (const tool of profile.tools) {
      await gateway.admin.registerTool({ ...tool, connector: CONNECTOR, connectorConfig: {} }, ACTOR);
    }
    for (const policy of profile.policies) await gateway.admin.publishPolicy(policy, ACTOR);
    for (const agent of profile.agents) {
      const registered = await gateway.admin.registerAgent(agent, ACTOR);
      keys.set(agent.name, (await gateway.admin.issueKey(registered.id, ACTOR)).apiKey);
    }
  } catch (cause) {
    error(`registration failed: ${cause.message}`);
    return { source, id: profile.id, errors, warnings, results };
  }

  // --- 4. coverage --------------------------------------------------------
  const enabled = profile.policies.filter((policy) => policy.enabled !== false);
  const matchesTool = (policy, name) => {
    const patterns = policy.match?.tools;
    if (!patterns || patterns.length === 0) return true;
    return patterns.some((pattern) => pattern === name || pattern === '*' || (pattern.endsWith('.*') && name.startsWith(pattern.slice(0, -1))));
  };
  for (const tool of profile.tools) {
    if (!enabled.some((policy) => matchesTool(policy, tool.name))) {
      warn(`tool "${tool.name}" is matched by no enabled policy, so every call to it is denied by default`);
    }
    const exercising = profile.scenarios.filter((scenario) => scenario.tool === tool.name);
    if (tool.effect !== 'read') {
      if (!exercising.some((scenario) => scenario.expect === 'executed' || scenario.approveAs)) {
        warn(`${tool.effect} tool "${tool.name}" has no scenario showing it can be used`);
      }
      if (!exercising.some((scenario) => scenario.expect === 'denied' || scenario.expect === 'refused' || (scenario.expect === 'pending_approval' && !scenario.approveAs))) {
        error(`${tool.effect} tool "${tool.name}" has no negative scenario (denied, refused or held); a profile must show what it stops`);
      }
    }
  }
  for (const agent of profile.agents) {
    if (!profile.scenarios.some((scenario) => scenario.agent === agent.name)) warn(`agent "${agent.name}" is not exercised by any scenario`);
  }

  // --- 5. separation of duties -------------------------------------------
  const irreversible = profile.tools.filter((tool) => tool.effect === 'irreversible').map((tool) => tool.name);
  for (const policy of enabled) {
    for (const rule of policy.rules) {
      if (rule.effect !== 'REQUIRE_APPROVAL') continue;
      const covers = irreversible.filter((name) => matchesTool(policy, name));
      if (covers.length === 0 || rule.approval?.requireSeparationOfDuties === true) continue;
      const message = `${policy.id}/${rule.id} approves irreversible ${covers.join(', ')} without requireSeparationOfDuties`;
      if (profile.requirements?.separationOfDutiesForIrreversible === true) error(message);
      else warn(message);
    }
  }

  // --- 6 & 7. scenarios and evidence --------------------------------------
  for (const scenario of profile.scenarios) {
    const before = connector.callCount();
    const result = { id: scenario.id, expect: scenario.expect, pass: false };
    try {
      let outcome;
      let response;
      try {
        response = await gateway.handle(keys.get(scenario.agent), {
          tool: scenario.tool,
          parameters: scenario.parameters ?? {},
          correlationId: `harness-${profile.id}-${scenario.id}`,
        });
        outcome = response.outcome;
      } catch (cause) {
        outcome = 'refused';
        result.code = cause.code;
      }
      result.actual = outcome;
      let effects = connector.callCount() - before;

      if (outcome === scenario.expect && scenario.approveAs && response?.approvalId) {
        const approver = approvers.get(scenario.approveAs);
        await gateway.approvals.vote({ approvalId: response.approvalId, approver, vote: 'approve' });
        const released = await gateway.resume(response.approvalId);
        result.released = released.outcome;
        if (released.outcome !== 'executed') throw new Error(`approved as ${approver.identifier} but release was ${released.outcome}`);
        effects = connector.callCount() - before;
        response = released;
      }

      const wantedEffects = scenario.expect === 'executed' || scenario.approveAs ? 1 : 0;
      result.effects = effects;
      if (outcome !== scenario.expect) throw new Error(`expected ${scenario.expect}, got ${outcome}${result.code ? ` (${result.code})` : ''}`);
      if (effects !== wantedEffects) throw new Error(`expected ${wantedEffects} effect(s) at the connector, observed ${effects}`);
      if (scenario.policyId && response?.decision?.policyId !== scenario.policyId) {
        throw new Error(`expected the decision to cite ${scenario.policyId}, got ${response?.decision?.policyId ?? 'none'}`);
      }
      if (response?.evidenceId) {
        const record = await gateway.evidence(response.evidenceId);
        if (!record || !verifyEvidence(record)) throw new Error('evidence record missing or does not verify');
      }
      result.pass = true;
    } catch (cause) {
      result.error = cause.message;
      error(`scenario "${scenario.id}": ${cause.message}`);
    }
    results.push(result);
  }

  const chain = await gateway.store.audit.verify();
  if (!chain.valid) error(`audit chain did not verify after the run: ${chain.failures.map((failure) => failure.problem).join(', ')}`);

  return { source, id: profile.id, errors, warnings, results };
}

async function discover() {
  const directory = join(ROOT, 'clients');
  const entries = await readdir(directory, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => join(directory, entry.name, 'profile.json'));
}

async function main() {
  const { options, positional: paths } = parseArgs();
  const json = options.json === true;
  const files = paths.length > 0 ? paths.map((path) => resolve(path)) : await discover();

  const reports = [];
  for (const file of files) {
    let profile;
    try {
      profile = JSON.parse(await readFile(file, 'utf8'));
    } catch (cause) {
      reports.push({ source: relative(ROOT, file), errors: [`cannot read profile: ${cause.message}`], warnings: [], results: [] });
      continue;
    }
    reports.push(await validateProfile(profile, relative(ROOT, file)));
  }

  if (json) {
    process.stdout.write(`${JSON.stringify(reports, null, 2)}\n`);
  } else {
    for (const report of reports) {
      const passed = report.results.filter((result) => result.pass).length;
      process.stdout.write(`\n${report.errors.length === 0 ? 'PASS' : 'FAIL'} ${report.source} — ${passed}/${report.results.length} scenarios\n`);
      for (const result of report.results) {
        process.stdout.write(`  ${result.pass ? 'ok  ' : 'FAIL'} ${result.id}: ${result.actual ?? '-'}${result.released ? ` → ${result.released}` : ''}, ${result.effects ?? '?'} effect(s)\n`);
      }
      for (const message of report.errors) process.stdout.write(`  error   ${message}\n`);
      for (const message of report.warnings) process.stdout.write(`  warning ${message}\n`);
    }
    const failed = reports.filter((report) => report.errors.length > 0).length;
    process.stdout.write(`\n${reports.length - failed}/${reports.length} client profile(s) valid\n`);
  }
  const scenarios = reports.flatMap((report) => report.results);
  await writeResult(options.out, {
    skill: 'client-onboarding',
    tool: 'validate-client',
    ok: reports.every((report) => report.errors.length === 0),
    metrics: {
      profiles_total: reports.length,
      profiles_invalid: reports.filter((report) => report.errors.length > 0).length,
      scenarios_total: scenarios.length,
      scenarios_passed: scenarios.filter((result) => result.pass).length,
      scenario_pass_rate: scenarios.length ? scenarios.filter((result) => result.pass).length / scenarios.length : 0,
      warnings_total: reports.reduce((sum, report) => sum + report.warnings.length, 0),
    },
    details: reports.map((report) => ({ source: report.source, errors: report.errors, warnings: report.warnings })),
  });
  if (reports.some((report) => report.errors.length > 0)) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
