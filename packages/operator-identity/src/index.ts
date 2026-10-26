/**
 * Human operator identity.
 *
 * The 2.0 release authenticated operators with one shared token and read their
 * name from a request header. This package replaces that with OpenID Connect
 * sign-in, server-side sessions, and roles derived from verified claims — and,
 * just as importantly, records *how* each identity was established, so an
 * approval record states what it can actually support.
 */
export { verifyIdToken, decodeBase64Url, encodeBase64Url } from './jwt.js';
export type { IdTokenClaims, JsonWebKey, JwtHeader, VerifyOptions } from './jwt.js';

export { OidcClient } from './oidc.js';
export type { OidcOptions, OidcProviderMetadata, StartedLogin } from './oidc.js';

export { SessionManager, newLoginNonce } from './sessions.js';
export type { SessionManagerOptions } from './sessions.js';

export { identifierFor, rolesFor } from './roles.js';
export type { RoleResolutionOptions } from './roles.js';
