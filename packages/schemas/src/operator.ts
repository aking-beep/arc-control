/**
 * Human operators, and how much their names are worth.
 *
 * ARC's approval records answer "who authorized this". Until 2.1 that answer
 * was a request header behind a shared token, so the honest reading was "the
 * workflow ran" rather than "this person ran it" — and the limitation was
 * stated on the control rather than hidden, which was right but not useful to
 * anyone who needed the attribution.
 *
 * Adding single sign-on alone would not have fixed it. A real deployment is
 * mixed: a console session behind the identity provider, a CI job behind a
 * trusted proxy, an automation holding the legacy token during migration. If
 * every one of those produced the same record, a reader could not tell a
 * verified approval from an asserted one, and the strongest claim the whole
 * set could support would be the weakest link in it.
 *
 * So the provenance of an identity is recorded alongside the identity itself,
 * on the vote and in the audit chain. That is what lets ARC-AI-004 report the
 * truth about a specific deployment instead of carrying a blanket caveat.
 */

/** How an operator's identity came to be known. */
export type IdentityAssurance =
  /**
   * ARC verified an OpenID Connect ID token's signature against the keys the
   * provider publishes, checked its issuer, audience and expiry, and took the
   * identity from its claims. The provider vouches for the person.
   */
  | 'authenticated'
  /**
   * An identity-aware proxy asserted the identity in a header, and ARC is
   * configured to trust that specific proxy. The attribution is only as good
   * as the network path to it, which is why it is recorded distinctly rather
   * than counted as authenticated.
   */
  | 'asserted_by_proxy'
  /**
   * The caller stated who they were alongside a shared token. Anyone holding
   * the token can state anything, so this proves the workflow ran and not who
   * ran it.
   */
  | 'claimed';

/** Strongest first. The order a mixed set should be judged by its weakest member. */
export const IDENTITY_ASSURANCE_ORDER: readonly IdentityAssurance[] = [
  'authenticated',
  'asserted_by_proxy',
  'claimed',
] as const;

/**
 * Whether an identity can be attributed to a person.
 *
 * `claimed` cannot: the name is an assertion by whoever held the token. Both
 * other modes can, with different strength, and the distinction between them
 * belongs in the record rather than in this predicate.
 */
export function isAttributable(assurance: IdentityAssurance): boolean {
  return assurance !== 'claimed';
}

/**
 * The assurance of a set of identities, which is its weakest member.
 *
 * One claimed vote in an otherwise authenticated approval makes the approval
 * as a whole unattributable, because that is the vote someone would dispute.
 */
export function weakestAssurance(values: readonly IdentityAssurance[]): IdentityAssurance | undefined {
  let weakest: IdentityAssurance | undefined;
  for (const value of values) {
    if (weakest === undefined || IDENTITY_ASSURANCE_ORDER.indexOf(value) > IDENTITY_ASSURANCE_ORDER.indexOf(weakest)) {
      weakest = value;
    }
  }
  return weakest;
}

/**
 * A record written before 2.1 carries no assurance, and cannot retroactively
 * acquire one. It reads as `claimed`, which is what the deployment that wrote
 * it could actually support — not as a gap to be filled in later with a
 * better answer than the evidence allows.
 */
export function assuranceOf(record: { readonly assurance?: IdentityAssurance }): IdentityAssurance {
  return record.assurance ?? 'claimed';
}

/** An operator acting through the console or the API, as resolved for one request. */
export interface OperatorIdentity {
  /** What the person is called, usually their email. Shown in the console and recorded on votes. */
  readonly identifier: string;
  /** Roles ARC enforces against. Derived from verified claims, never read from a request header. */
  readonly roles: readonly string[];
  readonly assurance: IdentityAssurance;
  /** The issuer that vouched for the identity. Present when authenticated. */
  readonly issuer?: string;
  /**
   * The provider's stable subject claim, which survives an email change.
   * Present when authenticated, and the right key for "is this the same
   * person" questions that `identifier` cannot answer.
   */
  readonly subject?: string;
  /** The session this request arrived on, so a specific sign-in can be revoked. */
  readonly sessionId?: string;
}

/**
 * A signed-in console session.
 *
 * Kept server-side rather than living entirely in a cookie so that a sign-out
 * is real and a departing employee's access can be ended now. A stateless
 * token would stay valid until it expired, which is not an answer a security
 * questionnaire accepts.
 */
export interface OperatorSession {
  readonly id: string;
  readonly identifier: string;
  /** The provider's stable subject claim. */
  readonly subject: string;
  readonly issuer: string;
  readonly roles: readonly string[];
  readonly createdAt: string;
  readonly expiresAt: string;
  /** Updated as the session is used, so an idle timeout can be enforced and stale sessions shown. */
  readonly lastSeenAt: string;
  /** Set when the session was ended deliberately rather than by expiry. */
  readonly revokedAt?: string;
  /** Who ended it: the operator themselves on sign-out, or an administrator. */
  readonly revokedBy?: string;
  readonly revokedReason?: string;
}

/** Whether a session may still authenticate a request. */
export function isSessionLive(session: OperatorSession, now: number): boolean {
  if (session.revokedAt !== undefined) return false;
  return Date.parse(session.expiresAt) > now;
}
