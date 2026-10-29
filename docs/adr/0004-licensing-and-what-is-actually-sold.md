# ADR-0004: ARC Control is Apache-2.0 and public — decide what is actually sold

**Status:** Proposed on 2026-10-29. **Blocks any priced offer.** Awaiting the owner's decision.
**Date:** 2026-10-29
**Scope:** Licensing and monetisation. No code changes. Needs legal advice before anything here is quoted to a customer.

## Context

`docs/COMMERCIAL_READINESS.md` §5 recommends pricing option C: "a flat annual
licence per environment, unlimited agents and actions, tiered by company size."

That offer cannot be made for ARC Control as it stands, and the reason is not
subtle:

| Fact | Evidence |
| --- | --- |
| The repository is **public** | `aking-beep/arc-control`, `visibility: public` |
| It is licensed **Apache-2.0** | `LICENSE`, `README.md` ("Apache 2.0 — see LICENSE"), and `"license": "Apache-2.0"` in all 20 package manifests |
| Apache-2.0 grants perpetual, irrevocable, royalty-free rights to use, modify and distribute, **including commercially** | Apache-2.0 §2 |

Everything published through 2.3 is therefore available to anyone, in
production, commercially, for free, permanently. A prospect who asks "what
happens if we just run it?" has a complete and correct answer: *nothing, that
is allowed.*

This is not a defect in the licence choice. Apache-2.0 is a reasonable, even
strategically strong, choice for a control plane a security team must read
before trusting — and `SECURITY.md` leans on exactly that readability. The
defect is that **the commercial material prices something the licence gives
away**, and nobody has written down which one wins.

### What cannot be un-done

Apache-2.0 is irrevocable for versions already published. Relicensing affects
**future** versions only. Every commit through 2.3 stays Apache-2.0 for anyone
who has it, and the repository being public means everyone can have it. Any
plan that depends on withdrawing 2.3 does not work.

### What is still genuinely sellable

Copyright is wholly owned here (no outside contributors in the history), so all
of these remain open:

1. **Support and SLA.** A named engineer, response times, an escalation path.
   Nothing in Apache-2.0 obliges anyone to answer the phone.
2. **Implementation and control-catalogue extension.** Already recommended as
   a separate line item in `docs/COMMERCIAL_READINESS.md` §5.
3. **Indemnity and warranty.** Apache-2.0 ships "AS IS" with no warranty
   (§7–8). An enterprise buyer frequently needs someone on the hook; that is a
   real product and only the copyright holder can sell it.
4. **Operating it for them.** Blocked today by ADR-0003 (single-tenant), but a
   dedicated single-tenant managed instance is compatible with it.
5. **Future proprietary or source-available versions.** Dual-licensing from
   2.4 onward, or an open-core split.

## Options

### A · Stay fully open source; sell support, services and indemnity

The code stays Apache-2.0. Revenue is a subscription to *being helped*, not to
*being allowed*.

- **For:** No contradiction to explain. The security-team readability argument
  stays intact and is a differentiator. Shortest path to a first invoice.
- **Against:** Caps price at what support is worth. A capable customer can
  always self-serve. Hardest to raise money against.
- **Honest view:** this is the lowest-risk option and the one the material
  already half-describes.

### B · Open core

Decision path and evidence stay Apache-2.0. New enterprise surface — SSO
integrations beyond generic OIDC, SIEM export, multi-deployment management,
per-client scorecards (Phase 5) — ships under a commercial licence.

- **For:** A real licence to sell. Keeps the readable, auditable core open,
  which is the trust argument.
- **Against:** Every feature now needs an open-or-closed call, and that call
  will leak into architecture. Risks the control plane becoming "the free bit".
- **Honest view:** workable, but it taxes every future decision.

### C · Relicense from 2.4 (BSL or similar source-available)

Future versions become source-available with a production-use restriction that
converts to open source after a delay.

- **For:** Preserves readability; makes the licence enforceable again going
  forward.
- **Against:** 2.3 stays free forever, so the competitive fork already exists
  the day it is announced. Relicensing is reputationally costly for a product
  sold on trust and candour, which is this product's entire differentiator.
- **Honest view:** the worst fit here, specifically because of what ARC claims
  to be.

### D · Close the repository

Not viable. The code is already public; making the repository private removes
the shop window and the security-team readability argument, and changes nothing
about what is already distributed.

## Recommendation

**A now, with B kept open for Phase 5.**

Sell support, implementation and indemnity against an Apache-2.0 core, and
reserve the option to ship Phase 5 multi-deployment management commercially. Do
not relicense the core. The thing being sold to the stated buyer is not
permission to run the software — it is somebody accountable when the audit
trail is questioned, which is precisely what §4 of the commercial doc says is
not yet established and what ADR-0005's pentest is meant to establish.

If option A is chosen, `docs/COMMERCIAL_READINESS.md` §5 needs rewriting:
options A, B and C there are all framed as licence fees, and none of them can
be charged as such.

## Consequences either way

1. **No priced offer, quote or landing-page pricing until this is decided.**
   Quoting a per-environment licence against an Apache-2.0 public repository is
   a claim that will not survive the first technically literate buyer.
2. **The landing page cannot imply the software is proprietary** — no "request
   a licence", no "contact sales for access". The honest call to action is a
   pilot.
3. **Counsel must review** before any agreement is signed. Nothing in this ADR
   or in `docs/commercial/` is legal advice.

## Separate, and smaller

The repository's GitHub **default branch is `claude/elegant-curie-o8tgs9`**, not
`main`. Every visitor to a public repository lands on a stale agent branch, and
new pull requests default to it. Worth fixing before anyone is pointed at the
repository; it is a settings change, not a code change.
