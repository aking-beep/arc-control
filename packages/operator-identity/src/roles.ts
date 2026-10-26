import type { IdTokenClaims } from './jwt.js';

/**
 * Turning provider claims into ARC roles.
 *
 * Two sources, because a ten-person company and a hundred-person company
 * answer this differently. The larger one has groups in its identity provider
 * and wants ARC to read them. The smaller one often has no groups at all —
 * Google Workspace without a directory policy, say — and needs to name four
 * people in configuration without standing up group management first.
 *
 * Supporting only the first would make ARC unsellable to the smaller half of
 * the range; supporting only the second would not scale past a handful of
 * people and would drift out of date the moment someone changed teams.
 *
 * Both sources are additive, and the result is deliberately allowed to be
 * empty. An authenticated operator with no roles can sign in and read, and can
 * approve nothing. That is the safe direction: the alternative — defaulting to
 * some role when configuration is silent — grants authority nobody conferred,
 * and would do it at exactly the moment a deployment is misconfigured.
 */

export interface RoleResolutionOptions {
  /**
   * Claim to read group or role membership from, e.g. `groups` or `roles`.
   * Accepts a string, a space-separated string, or an array.
   */
  readonly roleClaim?: string;
  /**
   * Maps a provider group to one or more ARC roles. A group absent from the
   * map contributes nothing, so an unrelated directory group cannot become an
   * ARC role by accident.
   */
  readonly roleMap?: Readonly<Record<string, readonly string[]>>;
  /**
   * Roles granted to named people, keyed by email, lowercased on comparison.
   * For deployments with no groups to read.
   */
  readonly directory?: Readonly<Record<string, readonly string[]>>;
  /**
   * When true, a group named in the claim becomes a role of the same name even
   * if `roleMap` does not mention it. Off by default: it makes every directory
   * group in the company an ARC role name, which is convenient until somebody
   * creates a group called `finance-manager` for a mailing list.
   */
  readonly trustClaimDirectly?: boolean;
}

/** Reads a claim that may be a string, a space-separated string, or an array. */
function claimValues(value: unknown): readonly string[] {
  if (typeof value === 'string') return value.split(/[\s,]+/).filter(Boolean);
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string');
  return [];
}

/** The identifier ARC shows and records for a verified identity. */
export function identifierFor(claims: IdTokenClaims): string {
  // Email where the provider says it is verified, because that is the name
  // colleagues recognise in an approval record. An unverified email is not
  // used: it is self-asserted at the provider, and an approval naming it
  // would look like attribution while proving less than it appears to.
  if (typeof claims.email === 'string' && claims.email.length > 0 && claims.email_verified !== false) {
    return claims.email.toLowerCase();
  }
  if (typeof claims.preferred_username === 'string' && claims.preferred_username.length > 0) {
    return claims.preferred_username;
  }
  return claims.sub;
}

/** Resolves the ARC roles for a verified identity. Possibly none. */
export function rolesFor(claims: IdTokenClaims, options: RoleResolutionOptions = {}): readonly string[] {
  const roles = new Set<string>();

  if (options.roleClaim !== undefined) {
    for (const group of claimValues(claims[options.roleClaim])) {
      const mapped = options.roleMap?.[group];
      if (mapped) {
        for (const role of mapped) roles.add(role);
      } else if (options.trustClaimDirectly === true) {
        roles.add(group);
      }
    }
  }

  const identifier = identifierFor(claims).toLowerCase();
  for (const [email, granted] of Object.entries(options.directory ?? {})) {
    if (email.toLowerCase() === identifier) {
      for (const role of granted) roles.add(role);
    }
  }

  return [...roles].sort();
}
