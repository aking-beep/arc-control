import { FileStore, MemoryStore, type ControlStore } from '@arc-control/store';
import { createControlApi, API_VERSION } from './server.js';
import { loadConfig } from './config.js';
import { seedDemo } from './seed.js';

/**
 * Entry point for `npm run api`.
 *
 * Configuration comes from the environment and is validated before anything
 * is opened — see `config.ts`, which refuses the configurations that would
 * start but should not. `arc-control: failed to start` with a list of
 * variables is a better morning than a silent security weakness.
 *
 *   ARC_PORT / ARC_HOST            listener (default 127.0.0.1:8787)
 *   ARC_DATA_DIR                   durable store; in-memory if unset
 *   ARC_SEED_DEMO                  "true" to load the worked example
 *
 *   ARC_OIDC_ISSUER                single sign-on; with CLIENT_ID,
 *   ARC_OIDC_CLIENT_ID             REDIRECT_URI and a SESSION_SECRET
 *   ARC_OIDC_REDIRECT_URI
 *   ARC_OIDC_CLIENT_SECRET
 *   ARC_SESSION_SECRET             at least 32 characters, stable across restarts
 *   ARC_OIDC_ROLE_CLAIM            claim holding groups, e.g. "groups"
 *   ARC_OIDC_ROLE_MAP              "group=role|role,group=role"
 *   ARC_OPERATOR_DIRECTORY         "email=role|role" for deployments with no groups
 *
 *   ARC_TRUSTED_PROXY_SECRET       an identity-aware proxy instead of OIDC
 *   ARC_OPERATOR_TOKEN             the legacy shared token; a fallback, not a bypass
 *   ARC_ALLOW_SHARED_TOKEN         accept the token knowingly on an exposed interface
 *
 *   ARC_CONSOLE_URL                so a notification can say where to act
 *   ARC_WEBHOOK_SIGNING_SECRET     signs generic webhook payloads
 *   ARC_SCHEDULE                   "false" to stop this instance ticking
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const { port, host, dataDir, demoSeed } = config;

  const store: ControlStore = dataDir ? await FileStore.open(dataDir) : new MemoryStore();

  const api = createControlApi({ ...config.options, store });

  const lines: string[] = [];

  // Install any baseline control the store does not already have. Idempotent
  // and non-destructive: a control an operator disabled or retuned keeps those
  // edits across restarts and upgrades, and only genuinely absent ones are
  // added. Done here rather than inside `createControlApi` so building the API
  // stays free of writes.
  const seeded = await api.assurance.seedBaseline();
  if (seeded.added.length > 0) {
    lines.push('', `Installed ${seeded.added.length} baseline control(s): ${seeded.added.join(', ')}`);
  }

  if (demoSeed) {
    const { apiKeys } = await seedDemo(api.gateway);
    lines.push('', 'Demo agents (simulated effects, real control path):');
    for (const [name, key] of Object.entries(apiKeys)) {
      lines.push(`  ${name.padEnd(20)} ${key}`);
    }
  }

  const address = await api.listen(port, host);

  const operatorAuth = api.operatorModes.length === 0 ? 'none' : api.operatorModes.join(', ');

  process.stdout.write(
    [
      `ARC Control API ${API_VERSION}`,
      `  listening     http://${address.host}:${address.port}`,
      `  store         ${dataDir ? `file (${dataDir})` : 'memory (nothing is persisted)'}`,
      `  operator auth ${operatorAuth}`,
      `  assurance     ${seeded.added.length + seeded.kept.length} control(s) in the library`,
      `  scheduler     ${config.options.schedule === false ? 'off' : `every ${String(Math.round(api.scheduler.intervalMs / 1000))}s`}`,
      ...lines,
      '',
      // Printed after the banner rather than before it, so the normal startup
      // line is the first thing in a log and the caveats are attached to it.
      ...config.warnings.flatMap((warning) => [`  ! ${warning}`, '']),
    ].join('\n'),
  );

  const shutdown = async (signal: string): Promise<void> => {
    process.stdout.write(`\narc-control: ${signal} received, shutting down\n`);
    await api.close();
    await store.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((cause: unknown) => {
  process.stderr.write(`arc-control: failed to start: ${cause instanceof Error ? cause.stack : String(cause)}\n`);
  process.exit(1);
});
