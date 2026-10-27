#!/usr/bin/env node
/**
 * Deployment smoke test — the `deploy` skill's procedure, as a script.
 *
 * Starts the real API process the way a deployment does (durable `FileStore`,
 * demo seed, operator token), or points at one already running (`--base`, e.g.
 * the container image), and checks what a deployment must get right:
 *
 *   1. it becomes healthy, and how long that takes
 *   2. enforcement answers: an allowed refund executes, the $4,200 refund is denied
 *   3. the audit chain verifies over the API
 *   4. (process mode) it survives a restart: after SIGTERM and a fresh start on
 *      the same data directory, the chain still verifies against the head the
 *      store recorded, and the evidence written before the restart is still there
 *
 * Usage:
 *   node tools/harness/deploy-smoke.mjs [--out result.json]
 *   node tools/harness/deploy-smoke.mjs --base http://127.0.0.1:8787 --operator-token T --agent-key K
 *
 * This proves a single instance starts, enforces and persists. It does not
 * prove anything about a cluster, a load balancer, TLS, an identity provider,
 * or network isolation — those are deployment properties checked elsewhere.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { parseArgs, writeResult } from './lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { options } = parseArgs();
const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok, detail });
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}\n`);
  return ok;
};

const freePort = () =>
  new Promise((resolvePort) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });

async function waitHealthy(base, timeoutMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok) return Date.now() - started;
    } catch {
      /* not up yet */
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  return undefined;
}

function startApi({ port, dataDir, token, seed }) {
  const child = spawn(process.execPath, [join(ROOT, 'apps/control-api/dist/main.js')], {
    env: {
      ...process.env,
      ARC_PORT: String(port),
      ARC_HOST: '127.0.0.1',
      ARC_DATA_DIR: dataDir,
      ARC_OPERATOR_TOKEN: token,
      ARC_SEED_DEMO: seed ? 'true' : 'false',
      ARC_SCHEDULE: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  return { child, output: () => output };
}

const stop = (child) =>
  new Promise((resolveStop) => {
    if (child.exitCode !== null) return resolveStop();
    child.once('exit', () => resolveStop());
    child.kill('SIGTERM');
  });

async function json(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

async function exercise(base, token, agentKey) {
  const act = (amount) =>
    fetch(`${base}/v1/actions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${agentKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ tool: 'stripe.refund', parameters: { customer: 'customer_123', amount }, correlationId: 'deploy-smoke' }),
    }).then(json);
  const operator = { authorization: `Bearer ${token}`, 'x-arc-operator': 'deploy-smoke@harness' };

  const allowed = await act(120);
  check('an allowed refund executes', allowed.outcome === 'executed', allowed.outcome ?? JSON.stringify(allowed).slice(0, 120));
  const denied = await act(4200);
  check('the $4,200 refund is denied', denied.outcome === 'denied', denied.outcome ?? JSON.stringify(denied).slice(0, 120));
  const verify = await fetch(`${base}/v1/audit/verify`, { headers: operator }).then(json);
  check('the audit chain verifies', verify.valid === true, `${verify.recordsChecked ?? '?'} record(s)`);
  return { verify, evidenceIds: [allowed.evidenceId, denied.evidenceId].filter(Boolean), operator };
}

let healthyMs;
let restartHealthyMs;

if (options.base) {
  const base = String(options.base).replace(/\/$/, '');
  healthyMs = await waitHealthy(base);
  if (check('the instance becomes healthy', healthyMs !== undefined, healthyMs === undefined ? 'timed out' : `${healthyMs}ms`)) {
    await exercise(base, String(options['operator-token']), String(options['agent-key']));
  }
} else {
  const dataDir = await mkdtemp(join(tmpdir(), 'arc-deploy-smoke-'));
  const token = `smoke-${process.pid}-${Date.now()}`;
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  try {
    const first = startApi({ port, dataDir, token, seed: true });
    healthyMs = await waitHealthy(base);
    if (check('the API starts on a durable store and becomes healthy', healthyMs !== undefined, healthyMs === undefined ? first.output().slice(-400) : `${healthyMs}ms`)) {
      const agentKey = /finance-agent\s+(\S+)/.exec(first.output())?.[1];
      if (check('the seeded agent key is printed once at startup', Boolean(agentKey))) {
        const before = await exercise(base, token, agentKey);
        await stop(first.child);

        const second = startApi({ port, dataDir, token, seed: false });
        restartHealthyMs = await waitHealthy(base);
        if (check('it restarts on the same data directory', restartHealthyMs !== undefined, restartHealthyMs === undefined ? second.output().slice(-400) : `${restartHealthyMs}ms`)) {
          const after = await fetch(`${base}/v1/audit/verify`, { headers: before.operator }).then(json);
          check(
            'the audit chain still verifies after restart, against the recorded head',
            after.valid === true && after.checkedAgainstExpectation === true && (after.recordsChecked ?? 0) >= (before.verify.recordsChecked ?? 0),
            `${after.recordsChecked ?? '?'} record(s), anchored: ${String(after.checkedAgainstExpectation)}`,
          );
          const kept = [];
          for (const id of before.evidenceIds) kept.push((await fetch(`${base}/v1/evidence/${id}`, { headers: before.operator })).ok);
          check('evidence written before the restart is still there', kept.length > 0 && kept.every(Boolean), `${kept.filter(Boolean).length}/${kept.length}`);
        }
        await stop(second.child);
      }
    }
    await stop(first.child);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

const passed = checks.filter((entry) => entry.ok).length;
const ok = checks.length > 0 && passed === checks.length;
process.stdout.write(`\n${passed}/${checks.length} deployment checks passed\n`);
await writeResult(options.out, {
  skill: 'deploy',
  tool: 'deploy-smoke',
  ok,
  metrics: {
    checks_passed: passed,
    checks_total: checks.length,
    ...(healthyMs !== undefined ? { time_to_healthy_ms: healthyMs } : {}),
    ...(restartHealthyMs !== undefined ? { restart_to_healthy_ms: restartHealthyMs } : {}),
  },
  details: { checks, mode: options.base ? 'existing-instance' : 'process' },
});
if (!ok) process.exitCode = 1;
