import { createConsole } from './server.js';

/**
 * Entry point for `npm run console`.
 *
 *   ARC_CONSOLE_PORT        port to listen on (default 8788)
 *   ARC_CONSOLE_HOST        interface to bind (default 127.0.0.1)
 *   ARC_API_BASE            where the console reaches the API
 *                           (default http://127.0.0.1:8787)
 *   ARC_PUBLIC_API_BASE     where a browser reaches the API, for the sign-in
 *                           redirect (default ARC_API_BASE)
 *
 * Only for a deployment with no identity provider configured:
 *
 *   ARC_OPERATOR_TOKEN      shared operator token
 *   ARC_OPERATOR_IDENTITY   identity recorded against approvals
 *   ARC_OPERATOR_ROLES      comma-separated roles used to match approver selectors
 */
async function main(): Promise<void> {
  const port = Number(process.env.ARC_CONSOLE_PORT ?? 8788);
  const host = process.env.ARC_CONSOLE_HOST ?? '127.0.0.1';
  const apiBase = process.env.ARC_API_BASE ?? 'http://127.0.0.1:8787';
  const publicApiBase = process.env.ARC_PUBLIC_API_BASE;
  const operatorToken = process.env.ARC_OPERATOR_TOKEN;
  const operatorIdentity = process.env.ARC_OPERATOR_IDENTITY;
  const operatorRoles = (process.env.ARC_OPERATOR_ROLES ?? '')
    .split(',')
    .map((role) => role.trim())
    .filter(Boolean);

  /**
   * The console carries no credential of its own when operators sign in: it
   * forwards the visitor's session. So there is nothing here to require, and
   * requiring one would have made this binary unable to start against the
   * authentication mode 2.1 exists to provide.
   */
  const warnings: string[] = [];

  if (publicApiBase === undefined && !isLoopback(apiBase)) {
    warnings.push(
      `ARC_PUBLIC_API_BASE is unset, so a visitor with no session is redirected to ${apiBase}/auth/login. ` +
        'That address resolves for this process, not necessarily for a browser. Set ARC_PUBLIC_API_BASE to the ' +
        'API address people reach from outside the deployment.',
    );
  }

  if (operatorToken !== undefined) {
    warnings.push(
      'ARC_OPERATOR_TOKEN is set, so this console can read the API even when nobody is signed in. The API ' +
        'refuses that token once an identity provider is configured, and until then every approval it records ' +
        'is attributed to the token rather than to a person.',
    );
  }

  if (operatorToken === undefined && operatorIdentity !== undefined) {
    warnings.push(
      'ARC_OPERATOR_IDENTITY is set but ARC_OPERATOR_TOKEN is not, so it is ignored. Identity comes from the ' +
        "signed-in session; the console does not name its own operator.",
    );
  }

  const app = createConsole({
    apiBase,
    ...(publicApiBase === undefined ? {} : { publicApiBase }),
    ...(operatorToken === undefined ? {} : { operatorToken }),
    ...(operatorIdentity === undefined ? {} : { operatorIdentity }),
    ...(operatorRoles.length > 0 ? { operatorRoles } : {}),
  });

  const address = await app.listen(port, host);

  process.stdout.write(
    [
      'ARC Control Console 2.1.0',
      `  console   http://${address.host}:${address.port}`,
      `  api       ${apiBase}`,
      `  sign-in   ${publicApiBase ?? apiBase}/auth/login`,
      `  identity  ${operatorToken === undefined ? 'from the signed-in session' : `${operatorIdentity ?? 'operator'} (shared token)`}`,
      '',
      ...warnings.flatMap((warning) => [`  ! ${warning}`, '']),
    ].join('\n'),
  );

  const shutdown = async (): Promise<void> => {
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

/** A loopback API is reached by the same address from the console and a browser. */
function isLoopback(base: string): boolean {
  try {
    const { hostname } = new URL(base);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
  } catch {
    return false;
  }
}

main().catch((cause: unknown) => {
  process.stderr.write(`arc-console: failed to start: ${cause instanceof Error ? cause.stack : String(cause)}\n`);
  process.exit(1);
});
