# Commercial terms

Drafts of the paperwork a paid engagement needs, listed in
`docs/COMMERCIAL_READINESS.md` §7 as "not drafted".

> **These are drafts, not legal advice, and none has been reviewed by a
> lawyer.** They exist so the first customer conversation is not the first time
> anyone thinks about indemnity. A solicitor or attorney must review and adapt
> every one of them before it is sent to a customer, and jurisdiction,
> liability caps and governing law are all left deliberately unresolved for
> that review.

## What these assume

They assume **ADR-0004 option A**: ARC Control's code stays Apache-2.0 and
public, and what a customer buys is support, implementation and accountability
— not permission to run the software, which Apache-2.0 already gives them for
free.

If the owner chooses a different option in ADR-0004, these drafts change
shape, and `SUBSCRIPTION_AGREEMENT.md` changes most.

They also assume **ADR-0003**: ARC is deployed in the customer's own
infrastructure, single-tenant. That is why `DATA_PROCESSING.md` is unusually
thin — in the normal deployment there is no processing by us to describe.

| Document | What it covers | State |
| --- | --- | --- |
| `SUBSCRIPTION_AGREEMENT.md` | What the customer pays for and what they get | Draft |
| `SUPPORT_TERMS.md` | Severities, response targets, escalation, what is out of scope | Draft |
| `DATA_PROCESSING.md` | Personal data, roles, and why there is usually none to process | Draft |
| `SECURITY_ADDENDUM.md` | The security wrapper; the substance is the questionnaire | Draft |

## What is deliberately not here

- **A software licence.** Apache-2.0 is the software licence. Writing another
  one would contradict `LICENSE` (ADR-0004).
- **Pricing numbers.** Untested, and blocked on ADR-0004.
- **A compliance claim of any kind.** ARC produces evidence; an assessor
  reaches conclusions. `docs/COMMERCIAL_READINESS.md` §5 puts this under "what
  is not for sale", and nothing here may contradict it.
