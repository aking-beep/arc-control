import { FileStore, MemoryStore, type ControlStore } from '@arc-control/store';
import { createControlApi, API_VERSION } from './server.js';
import { seedDemo } from './seed.js';

/**
 * Entry point for `npm run api`.
 *
 * Configuration comes from the environment:
 *
 *   ARC_PORT             port to listen on (default 8787)
 *   ARC_HOST             interface to bind (default 127.0.0.1)
 *   ARC_DATA_DIR         directory for the durable store; in-memory if unset
 *   ARC_OPERATOR_TOKEN   shared operator token; operator endpoints are
 *                        refused when unset
 *   ARC_SEED_DEMO        "true" to load the worked example
 */
async function main(): Promise<void> {
  const port = Number(process.env.ARC_PORT ?? 8787);
  const host = process.env.ARC_HOST ?? '127.0.0.1';
  const dataDir = process.env.ARC_DATA_DIR;
  const operatorToken = process.env.ARC_OPERATOR_TOKEN;

  const store: ControlStore = dataDir ? await FileStore.open(dataDir) : new MemoryStore();

  const demoSeed = process.env.ARC_SEED_DEMO === 'true';

  const api = createControlApi({
    store,
    demoSeed,
    ...(operatorToken ? { operatorToken } : {}),
  });

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

  process.stdout.write(
    [
      `ARC Control API ${API_VERSION}`,
      `  listening     http://${address.host}:${address.port}`,
      `  store         ${dataDir ? `file (${dataDir})` : 'memory (nothing is persisted)'}`,
      `  operator auth ${operatorToken ? 'enabled' : 'DISABLED — operator endpoints will refuse every request'}`,
      `  assurance     ${seeded.added.length + seeded.kept.length} control(s) in the library`,
      ...lines,
      '',
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
