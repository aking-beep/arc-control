import { ArcError } from '@arc-control/schemas';
import type { ControlApiOptions } from './server.js';

/**
 * Reading a deployment's configuration, and refusing the dangerous ones.
 *
 * A control plane that starts in an unsafe configuration is worse than one
 * that will not start, because the first failure is silent and arrives later,
 * in production, as a security incident rather than a startup error. So this
 * module's job is less to parse the environment than to say no to it.
 *
 * Every refusal below describes a configuration somebody would plausibly
 * reach for, and names the variable that resolves it. A refusal an operator
 * cannot act on is just an outage.
 */

export interface LoadedConfig {
  readonly port: number;
  readonly host: string;
  readonly dataDir: string | undefined;
  readonly demoSeed: boolean;
  readonly options: ControlApiOptions;
  /**
   * Things that are legal and worth knowing, printed at startup.
   *
   * Separate from refusals on purpose: a deployment that prints six warnings
   * and starts has told the operator something; one that refuses to start over
   * a warning has told them to ignore the mechanism.
   */
  readonly warnings: readonly string[];
}

type Env = Readonly<Record<string, string | undefined>>;

function bool(value: string | undefined): boolean | undefined {
  if (value === undefined || value === '') return undefined;
  return value === 'true' || value === '1' || value === 'yes';
}

function csv(value: string | undefined): readonly string[] {
  return (value ?? '').split(/[\s,]+/).filter(Boolean);
}

/**
 * Parses a `key=value,value` mapping, as used for group-to-role mapping.
 *
 * `ARC_OIDC_ROLE_MAP="arc-finance=finance-manager|approver,arc-admin=admin"`
 */
function mapping(value: string | undefined): Readonly<Record<string, readonly string[]>> | undefined {
  if (!value) return undefined;

  const result: Record<string, readonly string[]> = {};
  for (const pair of value.split(',')) {
    const index = pair.indexOf('=');
    if (index <= 0) continue;
    const key = pair.slice(0, index).trim();
    const roles = pair
      .slice(index + 1)
      .split('|')
      .map((role) => role.trim())
      .filter(Boolean);
    if (key && roles.length > 0) result[key] = roles;
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

/** Whether the listener is reachable from somewhere other than this machine. */
function isExposed(host: string): boolean {
  return host !== '127.0.0.1' && host !== 'localhost' && host !== '::1';
}

export function loadConfig(env: Env = process.env): LoadedConfig {
  const warnings: string[] = [];
  const refusals: string[] = [];

  const port = Number(env.ARC_PORT ?? 8787);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    refusals.push(`ARC_PORT="${String(env.ARC_PORT)}" is not a port number`);
  }

  const host = env.ARC_HOST ?? '127.0.0.1';
  const exposed = isExposed(host);
  const dataDir = env.ARC_DATA_DIR;
  const demoSeed = bool(env.ARC_SEED_DEMO) === true;

  // --- operator identity ---------------------------------------------------

  const issuer = env.ARC_OIDC_ISSUER;
  const clientId = env.ARC_OIDC_CLIENT_ID;
  const redirectUri = env.ARC_OIDC_REDIRECT_URI;
  const sessionSecret = env.ARC_SESSION_SECRET;
  const operatorToken = env.ARC_OPERATOR_TOKEN;
  const proxySecret = env.ARC_TRUSTED_PROXY_SECRET;
  const allowSharedToken = bool(env.ARC_ALLOW_SHARED_TOKEN);

  if (issuer !== undefined) {
    for (const [name, value] of [
      ['ARC_OIDC_CLIENT_ID', clientId],
      ['ARC_OIDC_REDIRECT_URI', redirectUri],
    ] as const) {
      if (!value) refusals.push(`ARC_OIDC_ISSUER is set but ${name} is not; single sign-on needs both`);
    }

    // Caught here rather than at the callback, which is the worst moment to
    // discover it: the operator has already left for the identity provider.
    if (!sessionSecret) {
      refusals.push(
        'ARC_OIDC_ISSUER is set but ARC_SESSION_SECRET is not; generate one with `openssl rand -hex 32`',
      );
    }
  }

  if (sessionSecret !== undefined && sessionSecret.length < 32) {
    refusals.push('ARC_SESSION_SECRET must be at least 32 characters; generate one with `openssl rand -hex 32`');
  }

  const authConfigured = issuer !== undefined || proxySecret !== undefined || operatorToken !== undefined;
  if (!authConfigured) {
    warnings.push(
      'No operator authentication is configured, so every operator endpoint will refuse every request. ' +
        'Agents can still be governed; nobody can administer the deployment. Set ARC_OIDC_ISSUER.',
    );
  }

  /**
   * The refusal that matters most.
   *
   * A deployment reachable from the network whose only operator credential is
   * a shared token has no individual accountability at all, and the token is
   * one leaked environment variable away from being everyone's. On loopback
   * that is a reasonable way to try the product; on an exposed interface it is
   * the configuration somebody will still be running in a year.
   */
  const tokenOnly = operatorToken !== undefined && issuer === undefined && proxySecret === undefined;
  if (tokenOnly && exposed && allowSharedToken !== true) {
    refusals.push(
      `This deployment binds ${host}, which is reachable from outside this machine, and its only operator ` +
        'credential is the shared token in ARC_OPERATOR_TOKEN. Anyone holding that token can claim any identity, ' +
        'so no approval it records can be attributed to a person. Configure ARC_OIDC_ISSUER for single sign-on, ' +
        'or set ARC_ALLOW_SHARED_TOKEN=true to accept this knowingly.',
    );
  }

  const secureCookies = bool(env.ARC_SECURE_COOKIES);
  if (secureCookies === false && exposed) {
    refusals.push(
      `ARC_SECURE_COOKIES=false sends session cookies over plain HTTP, and this deployment binds ${host}. ` +
        'That setting exists for local development only.',
    );
  }

  // --- durability ----------------------------------------------------------

  if (dataDir === undefined && !demoSeed) {
    warnings.push(
      'ARC_DATA_DIR is unset, so this deployment keeps everything in memory and loses every policy, ' +
        'approval, evidence record and audit entry when it stops. Set it to a directory on a durable volume.',
    );
  }

  if (demoSeed) {
    warnings.push(
      'ARC_SEED_DEMO is on, so the worked example is loaded and the console labels this as a demonstration. ' +
        'Do not point a real agent at it.',
    );
  }

  // --- the unattended half -------------------------------------------------

  const schedule = bool(env.ARC_SCHEDULE);
  if (schedule === false) {
    warnings.push(
      'ARC_SCHEDULE=false: nothing will run unattended. Approvals will not lapse, assessments will not run, ' +
        'and failed notifications will not be retried until something asks.',
    );
  }

  const consoleUrl = env.ARC_CONSOLE_URL;
  if (consoleUrl === undefined) {
    warnings.push(
      'ARC_CONSOLE_URL is unset, so notifications can say what happened but not where to act on it.',
    );
  }

  if (refusals.length > 0) {
    throw new ArcError(
      'invalid_request',
      `arc-control will not start with this configuration:\n${refusals.map((line) => `  - ${line}`).join('\n')}`,
      { details: { refusals } },
    );
  }

  const roleMap = mapping(env.ARC_OIDC_ROLE_MAP);
  const directory = mapping(env.ARC_OPERATOR_DIRECTORY);
  const roleClaim = env.ARC_OIDC_ROLE_CLAIM;

  if (issuer !== undefined && roleMap === undefined && directory === undefined) {
    warnings.push(
      'Single sign-on is configured but no roles are mapped, so everyone who signs in will be able to read and ' +
        'to approve nothing. Set ARC_OIDC_ROLE_MAP or ARC_OPERATOR_DIRECTORY.',
    );
  }

  const options: ControlApiOptions = {
    // The store is attached by the caller, which owns opening it.
    store: undefined as never,
    demoSeed,
    ...(operatorToken ? { operatorToken } : {}),
    ...(allowSharedToken !== undefined ? { allowSharedToken } : {}),
    ...(sessionSecret ? { sessionSecret } : {}),
    ...(secureCookies !== undefined ? { secureCookies } : {}),
    ...(consoleUrl ? { consoleUrl } : {}),
    ...(env.ARC_WEBHOOK_SIGNING_SECRET ? { webhookSigningSecret: env.ARC_WEBHOOK_SIGNING_SECRET } : {}),
    ...(schedule !== undefined ? { schedule } : {}),
    ...(env.ARC_DEFAULT_ORGANIZATION_ID ? { defaultOrganizationId: env.ARC_DEFAULT_ORGANIZATION_ID } : {}),
    ...(issuer && clientId && redirectUri
      ? {
          oidc: {
            issuer,
            clientId,
            redirectUri,
            ...(env.ARC_OIDC_CLIENT_SECRET ? { clientSecret: env.ARC_OIDC_CLIENT_SECRET } : {}),
            ...(csv(env.ARC_OIDC_SCOPES).length > 0 ? { scopes: csv(env.ARC_OIDC_SCOPES) } : {}),
          },
        }
      : {}),
    ...(roleClaim || roleMap || directory
      ? {
          roles: {
            ...(roleClaim ? { roleClaim } : {}),
            ...(roleMap ? { roleMap } : {}),
            ...(directory ? { directory } : {}),
            ...(bool(env.ARC_OIDC_TRUST_CLAIM) === true ? { trustClaimDirectly: true } : {}),
          },
        }
      : {}),
    ...(proxySecret
      ? {
          trustedProxy: {
            sharedSecret: proxySecret,
            identityHeader: env.ARC_TRUSTED_PROXY_IDENTITY_HEADER ?? 'x-forwarded-email',
            ...(env.ARC_TRUSTED_PROXY_ROLES_HEADER ? { rolesHeader: env.ARC_TRUSTED_PROXY_ROLES_HEADER } : {}),
            ...(env.ARC_TRUSTED_PROXY_SECRET_HEADER ? { secretHeader: env.ARC_TRUSTED_PROXY_SECRET_HEADER } : {}),
            ...(roleMap ? { roleMap } : {}),
          },
        }
      : {}),
  };

  return { port, host, dataDir, demoSeed, options, warnings };
}
