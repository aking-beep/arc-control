import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IdTokenClaims } from './jwt.js';
import { identifierFor, rolesFor } from './roles.js';

function claims(overrides: Record<string, unknown> = {}): IdTokenClaims {
  return {
    iss: 'https://login.example.com',
    sub: 'provider-subject-1',
    aud: 'arc',
    exp: 0,
    iat: 0,
    email: 'CFO@Example.com',
    email_verified: true,
    ...overrides,
  } as IdTokenClaims;
}

describe('identifierFor', () => {
  it('uses the verified email, lowercased, since that is the name colleagues know', () => {
    assert.equal(identifierFor(claims()), 'cfo@example.com');
  });

  /**
   * An unverified email is self-asserted at the provider. Recording it would
   * look like attribution while proving less than it appears to, so the
   * opaque subject is used instead — unhelpful to read and honest.
   */
  it('refuses an unverified email and falls back to the subject', () => {
    assert.equal(identifierFor(claims({ email_verified: false })), 'provider-subject-1');
  });

  it('falls back to preferred_username, then to the subject', () => {
    assert.equal(identifierFor(claims({ email: undefined, preferred_username: 'cfo' })), 'cfo');
    assert.equal(identifierFor(claims({ email: undefined })), 'provider-subject-1');
  });
});

describe('rolesFor', () => {
  /**
   * The safe direction. A deployment whose role configuration is missing or
   * wrong produces an operator who can read and approve nothing — rather than
   * one holding authority nobody granted, at exactly the moment somebody has
   * misconfigured it.
   */
  it('grants nothing when nothing is configured', () => {
    assert.deepEqual(rolesFor(claims({ groups: ['finance'] })), []);
  });

  it('maps a provider group to the ARC roles it is configured for', () => {
    const roles = rolesFor(claims({ groups: ['arc-finance', 'all-staff'] }), {
      roleClaim: 'groups',
      roleMap: { 'arc-finance': ['finance-manager', 'approver'] },
    });

    assert.deepEqual(roles, ['approver', 'finance-manager']);
  });

  /**
   * An unmapped group contributes nothing, so a mailing list that happens to
   * be called `finance-manager` cannot become an ARC role.
   */
  it('ignores a group the map does not mention', () => {
    assert.deepEqual(
      rolesFor(claims({ groups: ['finance-manager'] }), { roleClaim: 'groups', roleMap: { other: ['x'] } }),
      [],
    );
  });

  it('will take claim values directly only when told to explicitly', () => {
    assert.deepEqual(
      rolesFor(claims({ groups: ['finance-manager'] }), { roleClaim: 'groups', trustClaimDirectly: true }),
      ['finance-manager'],
    );
  });

  it('reads a claim that arrives as a string, an array, or a delimited string', () => {
    const options = { roleClaim: 'roles', trustClaimDirectly: true };
    assert.deepEqual(rolesFor(claims({ roles: 'approver' }), options), ['approver']);
    assert.deepEqual(rolesFor(claims({ roles: ['a', 'b'] }), options), ['a', 'b']);
    assert.deepEqual(rolesFor(claims({ roles: 'a b' }), options), ['a', 'b']);
    assert.deepEqual(rolesFor(claims({ roles: 'a,b' }), options), ['a', 'b']);
  });

  /**
   * The ten-person case: no groups in the identity provider at all, four
   * people named in configuration.
   */
  it('grants roles to people named in the directory, matching email case-insensitively', () => {
    const roles = rolesFor(claims(), { directory: { 'cfo@EXAMPLE.com': ['finance-manager'] } });
    assert.deepEqual(roles, ['finance-manager']);
  });

  it('combines directory and group grants without duplicating them', () => {
    const roles = rolesFor(claims({ groups: ['arc-finance'] }), {
      roleClaim: 'groups',
      roleMap: { 'arc-finance': ['finance-manager', 'reader'] },
      directory: { 'cfo@example.com': ['finance-manager', 'admin'] },
    });

    assert.deepEqual(roles, ['admin', 'finance-manager', 'reader']);
  });

  it('gives a person not in the directory nothing from it', () => {
    assert.deepEqual(rolesFor(claims(), { directory: { 'someone-else@example.com': ['admin'] } }), []);
  });
});
