import { timingSafeEqual } from 'node:crypto';
import { ArcError } from '@arc-control/schemas';
import type { RequestContext } from './http.js';

/**
 * A human operator acting through the console or the API.
 *
 * v0.1 authenticates operators with a single shared token and takes their
 * identity from a request header. That is adequate for a pilot behind an
 * existing identity-aware proxy and inadequate for anything else: the token
 * carries no individual accountability, and a caller who holds it can claim
 * any identity. Real RBAC, organizations and SSO are v0.5, and this module is
 * the seam they replace.
 *
 * Because the claimed identity is only as trustworthy as whatever fronts this
 * API, every approval records the identity it was given, and the audit log
 * keeps it — so a disputed approval can at least be traced to the token and
 * the claim that was made.
 */
export interface Operator {
  readonly identifier: string;
  readonly roles: readonly string[];
}

export interface OperatorAuthOptions {
  /** The shared operator token. When unset, operator endpoints are refused outright. */
  readonly token?: string;
  /** Identity used when the request names none. */
  readonly defaultIdentifier?: string;
}

export class OperatorAuth {
  readonly #token: string | undefined;
  readonly #defaultIdentifier: string;

  constructor(options: OperatorAuthOptions = {}) {
    this.#token = options.token;
    this.#defaultIdentifier = options.defaultIdentifier ?? 'operator';
  }

  get configured(): boolean {
    return this.#token !== undefined && this.#token.length > 0;
  }

  /** Authenticates an operator request, or throws. */
  authenticate(context: RequestContext): Operator {
    if (!this.configured) {
      throw new ArcError(
        'unauthenticated',
        'operator endpoints are disabled because no operator token is configured; set ARC_OPERATOR_TOKEN',
      );
    }

    const presented = context.bearer ?? '';
    if (!constantTimeEquals(presented, this.#token!)) {
      throw new ArcError('unauthenticated', 'the presented operator token is not valid');
    }

    const claimed = header(context, 'x-arc-operator') ?? this.#defaultIdentifier;
    const roles = (header(context, 'x-arc-operator-roles') ?? '')
      .split(',')
      .map((role) => role.trim())
      .filter(Boolean);

    return { identifier: claimed, roles };
  }
}

function header(context: RequestContext, name: string): string | undefined {
  const value = context.headers[name];
  if (Array.isArray(value)) return value[0];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function constantTimeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
