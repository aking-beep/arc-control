# Subscription agreement — draft

> **Draft. Not legal advice. Must be reviewed by counsel before use.**
> Square brackets mark every term that needs a decision or a lawyer.

**Parties.** ARC Transformation Group ("we") and the customer ("you").

## 1 · What this is, and what it is not

ARC Control is open-source software licensed under Apache License 2.0. **This
agreement does not grant you the right to use ARC Control — you already have
it, perpetually and at no cost, under that licence.** Nothing here reduces,
conditions or replaces your rights under Apache-2.0.

What this agreement provides is the part Apache-2.0 explicitly withholds:
somebody accountable. Specifically support, implementation, and the warranty
and indemnity that Apache-2.0 §7–8 disclaim.

This framing is deliberate and is explained in `docs/adr/0004-licensing-and-what-is-actually-sold.md`.

## 2 · What you receive

| | |
| --- | --- |
| **Support** | As set out in `SUPPORT_TERMS.md`, at the [tier] purchased. |
| **Named engineer** | A named individual who knows your deployment, reachable through the agreed channel. |
| **Implementation** | [Scoped separately as a fixed-fee statement of work.] |
| **Control-catalogue extension** | Authoring controls for risks specific to you, as a statement of work. |
| **Security correspondence** | Advance notice of security fixes affecting your deployed version, and help applying them. |
| **Warranty and indemnity** | As set out in §5 and §6. |

## 3 · What you are responsible for

ARC Control's guarantees hold only where the gateway is the agent's **only**
route to the system it acts on. That is a property of your deployment — network
policy and credential custody — and no code we ship can establish it. You are
responsible for:

- deploying ARC so agents cannot bypass it;
- the identity provider ARC authenticates operators against;
- recording the audit anchor, without which truncation of the audit log is not
  detectable (`docs/OPERATIONS.md`);
- the connector credentials, which live in your configuration and never reach us;
- deciding what your policies permit.

## 4 · Fees and term

[Fee], [annually/quarterly] in advance. Initial term [12 months], then
[auto-renewing/renewing by agreement] unless either party gives [notice] days'
notice.

Fees are for the services in §2. **They are not a licence fee and are not
charged per agent, per action or per environment** — metering authorization
decisions would make you hesitate before routing a borderline action through
ARC, which is backwards (`docs/COMMERCIAL_READINESS.md` §5).

Implementation and control authoring are quoted separately so that a long
control-authoring engagement does not read as expensive software.

## 5 · Warranty

We warrant that the support services will be performed with reasonable skill
and care.

We **do not** warrant that ARC Control is free of defects, and we make no
warranty about the software itself beyond what is in this section — the
software remains under Apache-2.0 "AS IS" (§7 of that licence).

**We specifically do not warrant any compliance outcome.** ARC Control produces
evidence. An assessor reaches conclusions. No statement by us, in this
agreement or elsewhere, should be read as a claim that deploying ARC Control
makes you compliant with any framework, standard or regulation.

[Counsel: the three sentences above are load-bearing and should survive
redlining. The product's own framework pages say the same thing, so a warranty
that contradicts them would be discoverable in a dispute.]

## 6 · Indemnity

[We indemnify you against third-party claims that ARC Control as supplied by us
infringes that third party's intellectual property, subject to §7.]

[Counsel: scope, caps, carve-outs, and the interaction with Apache-2.0 §3's
patent grant all need drafting. Note that a customer who obtained the software
from GitHub rather than from us received it under Apache-2.0 alone; whether the
indemnity attaches to the software or to the subscription needs a clear answer.]

## 7 · Liability

[Cap: the fees paid in the preceding 12 months.] Neither party excludes
liability for [death or personal injury caused by negligence, fraud, or
anything else that cannot lawfully be excluded in the governing jurisdiction].

[Counsel: jurisdiction-specific.]

## 8 · Data

See `DATA_PROCESSING.md`. In the standard deployment ARC Control runs entirely
in your infrastructure, sends no telemetry, and makes no outbound connection
other than the connectors you configure — so in the standard case we process no
personal data of yours at all.

## 9 · Confidentiality, publicity, termination

- **Confidentiality.** [Mutual, standard, surviving [3] years.]
- **Publicity.** We will not name you as a customer, or publish a case study,
  without your prior written agreement.
- **Termination.** Either party may terminate for material breach after
  [30] days' notice to remedy. **On termination you keep running ARC Control** —
  your Apache-2.0 rights are unaffected. You lose support, not software.

## 10 · Governing law

[To be decided. Likely [England and Wales] / [Delaware], depending on where the
entity sits and where the first customers are.]
