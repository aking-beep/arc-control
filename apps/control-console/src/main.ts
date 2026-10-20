import { createConsole } from './server.js';

/**
 * Entry point for `npm run console`.
 *
 *   ARC_CONSOLE_PORT        port to listen on (default 8788)
 *   ARC_CONSOLE_HOST        interface to bind (default 127.0.0.1)
 *   ARC_API_BASE            control API base URL (default http://127.0.0.1:8787)
 *   ARC_OPERATOR_TOKEN      operator token the console authenticates with
 *   ARC_OPERATOR_IDENTITY   identity recorded against approvals
 *   ARC_OPERATOR_ROLES      comma-separated roles used to match approver selectors
 */
async function main(): Promise<void> {
  const port = Number(process.env.ARC_CONSOLE_PORT ?? 8788);
  const host = process.env.ARC_CONSOLE_HOST ?? '127.0.0.1';
  const apiBase = process.env.ARC_API_BASE ?? 'http://127.0.0.1:8787';
  const operatorToken = process.env.ARC_OPERATOR_TOKEN;

  if (!operatorToken) {
    process.stderr.write(
      'arc-console: ARC_OPERATOR_TOKEN is required.\n' +
        '  The console reads everything through the control API with the operator\n' +
        '  credential, so without one it has nothing to show.\n',
    );
    process.exit(1);
  }

  const app = createConsole({
    apiBase,
    operatorToken,
    operatorIdentity: process.env.ARC_OPERATOR_IDENTITY ?? 'operator@localhost',
    operatorRoles: (process.env.ARC_OPERATOR_ROLES ?? 'finance-manager,platform-oncall')
      .split(',')
      .map((role) => role.trim())
      .filter(Boolean),
  });

  const address = await app.listen(port, host);

  process.stdout.write(
    [
      'ARC Control Console 0.1.0',
      `  console   http://${address.host}:${address.port}`,
      `  api       ${apiBase}`,
      `  identity  ${process.env.ARC_OPERATOR_IDENTITY ?? 'operator@localhost'}`,
      '',
    ].join('\n'),
  );

  const shutdown = async (): Promise<void> => {
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((cause: unknown) => {
  process.stderr.write(`arc-console: failed to start: ${cause instanceof Error ? cause.stack : String(cause)}\n`);
  process.exit(1);
});
