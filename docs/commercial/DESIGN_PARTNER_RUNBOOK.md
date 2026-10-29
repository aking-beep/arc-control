# Design-partner runbook

The operational detail behind `docs/COMMERCIAL_READINESS.md` §4, which sets the
target at three organizations and the decision point at week 8.

## Who to approach

The five-part test in §1 is the filter. In practice the signal is one person:
**somebody who has already asked "what is that agent allowed to do?" and did
not get a satisfying answer.** That person is usually a security engineer, a
head of platform, or whoever owns the agent that touches money.

Do not approach an organization because it is large or because it uses AI.
Approach it because that question has been asked there.

### Where that person is findable

| Channel | Why it works here | Effort |
| --- | --- | --- |
| Your own network | Warm, and the ICP is narrow enough that a referral beats any list | First |
| Teams shipping agents with write permissions, found through their own engineering writing | They have published the problem; you are answering it | Second |
| Security communities where agent authorization is being argued about | The counter-positioning argument lands with this audience specifically | Third |
| Paid advertising | **Not yet** — see below | — |

### Why not ads yet

Three reasons, in order of weight:

1. **Nothing to convert to.** No validated price, no terms to sign
   (ADR-0004 is unresolved), no reference customer.
2. **The differentiator does not compress.** ARC's argument is that it reports
   `not_assessable` where competitors report green. That needs a conversation.
   An ad forces a green claim, which is the one thing the product refuses to
   make.
3. **The ICP is too narrow to buy.** Paid acquisition finds this buyer
   expensively, if at all.

Revisit after the first reference customer, not before.

## The approach

Lead with the question, not the product. The opening that fits the evidence:

> Can you prove what your agents were allowed to do last quarter, and that the
> controls saying so were actually operating?

Then the demo (§3): `npm run demo:console`, 14 steps, ~10 seconds. Two moments
carry it:

- **Step 12** — a decision inside an exported bundle is rewritten from
  `REQUIRE_APPROVAL` to `ALLOW`, the bundle digest is recomputed to match, and
  the record's own integrity digest catches it anyway.
- **Step 10** — three controls decline to pass. This is the one that converts
  a sceptic, and it is the one a salesperson will be tempted to skip.

The static capture at `npm run showcase` (133 pages of real console output) is
the leave-behind.

## What to say, and what not to

**Say:** nothing executes without a current decision; every action leaves
evidence whatever the outcome; one authorization means at most one effect;
adding a policy can only tighten; the bundle verifies with ARC switched off.
Each is asserted in `evals/` and a prospect can run them.

**Do not say**, until the thing in brackets changes:

| Claim | Blocked by |
| --- | --- |
| "Approvals are attributable to individuals" | The pentest (`PENTEST_BRIEF.md`) |
| Any compliance outcome | Permanent — not for sale |
| Anything distributed, HA or multi-region | Per-process by design (ADR-0003) |
| "Multi-tenant" or "until v0.5" | ADR-0003 removes the promise |
| A per-environment licence fee | ADR-0004 — the code is Apache-2.0 and public |
| "SOC 2" in any form | We hold none |

Saying so early costs one deal and saves three failed pilots (§1). That is not
modesty, it is the counter-positioning argument: a product that overstates is
exactly what ARC exists to make detectable.

## The engagement

Milestones are §4's. What makes them work:

| Week | What must actually happen |
| --- | --- |
| 0 | Deployed behind **their** IdP, one real agent governed, policies written. Not a sandbox agent — §4 is explicit. |
| 2 | First assessment run. **Expect failures; they are the point.** First findings triaged. |
| 4 | Their security review returned, questionnaire answered, findings logged. Second agent. First bundle exported. |
| 8 | The bundle in front of whoever signs. Go/no-go. |

Week 8 is the programme. Everything before it is setup.

## What we are testing, and what would falsify it

From §4, with the observable restated:

| Hypothesis | Falsified if |
| --- | --- |
| The missing capability is evidence, not enforcement | Partners configure policies and never run an assessment |
| `not_assessable` is reassuring, not alarming | Partners ask us to make it pass, or stop assessing because the output looks bad |
| Offline bundle verification matters to a real auditor | Nobody runs `arc bundle verify`, or the auditor wants a PDF |
| The nine controls are the right nine | Partners add more than three of their own before finding value |
| SSO is enough to make the audit trail worth buying | A partner's review finds auth defects, or demands an independent test |
| **Agents are registered honestly** | Partners register tools they do not use, or route around ARC for awkward ones |

The last row is the real risk to the whole thesis and the hardest to observe,
which is why ARC-AI-009 exists and cannot be automated. Watch for it directly:
ask each partner, at week 4 and week 8, which agents are *not* behind ARC and
why.

## Before the first conversation

Blocking:
- [ ] ADR-0004 decided — what is actually being sold
- [ ] ADR-0003 accepted — deployment model, so the pitch is stable
- [ ] GitHub default branch set to `main`

Before a **paid** engagement:
- [ ] Pentest commissioned, findings closed, retest passed
- [ ] `docs/commercial/` reviewed by counsel
- [ ] Price decided
