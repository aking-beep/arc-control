# Commercial readiness

Section 12 of the 2.0 specification, which opens by saying these are "not code
features". They are not, and this document does not pretend otherwise — it is
the argument and the material, not an implementation.

Everything here is a **hypothesis to test with design partners**, written down
so it can be falsified rather than quietly revised. Where a claim depends on
something the product does not yet do, it says so.

---

## 1 · The ideal customer

**Engineering and security teams deploying agents that hold consequential tool
permissions.**

Concretely, an organization where all five are true:

1. At least one agent can take an action that costs money, deletes data, or
   changes access — not just one that reads and summarises.
2. Somebody has already asked "what is that thing allowed to do?" and not got a
   satisfying answer.
3. There is a security or risk function that will eventually be asked to sign
   something.
4. The agents are built in-house or assembled from frameworks, so the tool
   surface is theirs to register.
5. 50–5,000 employees. Below that, nobody is asking the question yet; above
   it, procurement will want the SSO and RBAC that are P1.

**Who this is not for, yet.** Anyone who needs per-operator RBAC on day one,
anyone with a hard multi-region or HA requirement, anyone whose primary concern
is model behaviour rather than agent *actions*, and anyone who needs a
certification ARC does not have. Saying so early costs one deal and saves three
failed pilots.

---

## 2 · The differentiation argument

The one-sentence version: **agent authorization, plus continuous evidence that
the authorization controls are actually operating.**

The second half is the part nobody else has, and it is worth being precise
about why, because "we also do governance" is what every competitor says.

| What a buyer already has | What it cannot tell them |
|---|---|
| An agent framework's own permissions | Whether a policy change broke something, who authorized the change, or what the agent attempted and was refused. |
| An API gateway or service mesh | Anything about *why* a call was permitted. There is no policy an auditor can read, no approval workflow, no evidence record. |
| A GRC platform | Anything about runtime. Controls are evidenced by screenshots and attestations, on a quarterly cadence, by hand. |
| Observability and tracing | What happened, in enormous detail, with no notion of what was *authorized*. |
| An LLM gateway | Prompts, tokens and cost. Not actions. |

ARC's wedge is the join: a control result that cites the specific evidence
records behind it, over a stated window, with what it does not establish
attached — and an export that verifies with ARC switched off.

### The counter-positioning

The sharpest thing about ARC commercially is also the most uncomfortable:
**it reports `not_assessable` where competitors report green.**

A fresh install shows three controls as not-assessable or attested rather than
passing. That will lose demos against a product whose dashboard is all green.

It is still the right call, and the sales argument is straightforward: the
green dashboard is green because nobody checked. Ask the vendor what their
audit-integrity control does when the log has been truncated, and what their
bypass control checks. If the answer is "it passes", the control is decoration.

This only works if the salesperson can say it with a straight face, which is
why the product refuses to let them say anything else.

---

## 3 · The demonstration

One workflow, real throughout, labelled where it is simulated.

```bash
npm run demo:console      # 14 steps, ~10 seconds
```

A refund request above an agent's autonomous ceiling is held for a human, a
finance manager approves it, the action executes once and the approval is
consumed. Then nine controls are evaluated against what actually happened, an
evidence bundle is exported, and the bundle is tampered with and caught.

What is real: the gateway, the policy engine, the approval engine, the evidence
records and their digests, the hash chain, the control evaluation, the API over
HTTP and the console over HTTP.

What is simulated: the connector effect. No money moves. The console labels the
environment as a demonstration on every page, driven by the API reporting its
own seed — not by a flag in the demo script.

**The moment that sells it** is step 12: a decision inside an exported bundle
is rewritten from `REQUIRE_APPROVAL` to `ALLOW`, the bundle digest is
recomputed to match, and the record's own integrity digest catches it anyway.

**The moment that sells it to a sceptic** is step 10, where three controls
decline to pass.

A published static capture of the console lives at
[arctransformationgroup.com/control](https://arctransformationgroup.com/control)
— 133 pages of the real console's real output, captured rather than mocked.
Rebuild it with `npm run showcase`; the page count is whatever that run
reports, and this number is checked against the capture rather than
remembered.

---

## 4 · Design-partner programme

**Target: three organizations.** Three is enough to tell a general problem from
a specific one and few enough to serve properly.

### What a partner gets

- The 2.3 pilot, deployed and supported, free for the engagement.
- Direct influence on the P1 order. The SSO provider, the SIEM format and the
  trace model should be settled by a partner's existing stack rather than
  guessed — all three are explicitly waiting on this.
- A control catalogue extended to their actual risks, with their controls
  implemented as evaluators.
- An evidence bundle they can hand to their own auditor, and a named engineer
  on the call when they do.

### What we need back

- One agent with real tool permissions. Not a sandbox.
- Access to whoever will be asked to sign something — the pilot's real test is
  whether that person finds the evidence sufficient.
- A security review, including the questionnaire, and the findings.
- Permission to be a reference, or a redacted case study, on success.

### What we should pay for before selling this on its audit trail

**An independent security review of the operator authentication path.** This is
a recommendation against our own interest and it is the honest one.

The 2.1 authentication work — OpenID Connect sign-in, sessions, the redirect
back to the console, the assurance recorded against every vote — went through
four rounds of automated review. The first round found six defects in the
original implementation. The next three found four more, every one of them
introduced *while fixing the previous round*, and every one in the
authentication path:

- a sign-in flow that returned the operator to the API instead of the console,
  which was the default configuration this repository ships;
- the shared operator token written into a pod spec, readable by anyone who
  could describe the pod;
- an open redirect reachable through a tab character in `returnTo`;
- a malformed console URL producing a redirect to the literal string `null`.

All are fixed, each with a regression test that fails when the fix is reverted.
That is not the point. The point is the rate: on a surface where a defect means
an approval attributed to the wrong person, four of eleven findings were
self-inflicted inside one working session, and three of our own verification
steps returned a convincing wrong answer along the way.

The product's entire proposition is that an approval record means what it says.
A buyer whose reason for wanting ARC is the audit trail is relying on exactly
this code. Our test suite and an automated reviewer are not a substitute for
somebody whose job is attacking it, and we should not present the attribution
guarantee as settled until that has happened.

This does not block a pilot. It blocks the sentence "approvals are
cryptographically attributable to individuals" appearing in a contract.

### What we are testing

| Hypothesis | Falsified if |
|---|---|
| The missing capability is evidence, not enforcement. | Partners configure policies and never run an assessment. |
| `not_assessable` is reassuring, not alarming. | Partners ask us to make it pass, or stop running assessments because the output looks bad. |
| Offline bundle verification matters to a real auditor. | Nobody runs `arc bundle verify`, or the auditor wants a PDF instead. |
| The nine controls are the right nine. | Partners add more than three of their own before finding value. |
| Single sign-on is enough to make the audit trail worth buying. | A partner's security review finds defects in the authentication path, or will not accept it without an independent one. |
| Agents are registered honestly. | Partners register tools they do not use, or route around ARC for the awkward ones. |

That last row is the real risk to the whole thesis and the hardest to observe,
which is why ARC-AI-009 exists and why it cannot be automated.

### Milestones

| | |
|---|---|
| Week 0 | Deployment, one agent governed, policies written. |
| Week 2 | First assessment run, governance records recorded, first findings triaged. |
| Week 4 | Security review returned. Second agent. First bundle exported. |
| Week 8 | Bundle in front of their auditor or risk committee. Go/no-go on paying. |

Week 8 is the point of the programme. Everything before it is setup.

---

## 5 · Pricing hypothesis

**Untested.** Three shapes, with what each gets wrong.

### A · Platform subscription by governed agent

Annual, banded on agents under governance. Perhaps $2,000–4,000 per governed
agent per year, with a floor.

Aligns with value and is easy to forecast. Its failure mode is that it taxes
exactly the behaviour we want: a customer who governs ten agents pays more than
one who governs two and routes the rest around ARC. Since ARC cannot see what
bypassed it, this is a pricing model that pays for its own blind spot.

### B · Platform fee plus consequential-action volume

A base fee, plus a charge on actions classified `sensitive` or `severe`.

Tracks the thing that actually matters, and the classification is already
computed and recorded. But metering authorization decisions makes a customer
hesitate before routing a borderline action through ARC, which is precisely
backwards.

### C · Per-deployment enterprise licence

A flat annual licence per environment, unlimited agents and actions, tiered by
company size.

The only one of the three that never penalises governing more. Probably the
right answer, and probably underprices a large customer — which is the error to
prefer at this stage.

**Current recommendation: C, with A as the fallback if partners find a
flat fee hard to justify internally.** A and B are both easy to move to later;
moving *away* from volume pricing after a customer has learned to avoid it is
much harder.

### Priced separately

Implementation and control-catalogue extension, as fixed-fee engagements. Not
bundled: a customer who needs three weeks of control authoring should see it as
a line item rather than inferring the software is expensive.

### What is not for sale

Compliance outcomes. ARC produces evidence; the assessor reaches the
conclusion. Any pricing or packaging implying otherwise would contradict what
the product itself says on its own framework pages, which is a bad place to be
in a renewal.

---

## 6 · Onboarding and support

The pilot path, in the order it actually happens:

1. **Deploy** — `infrastructure/docker/`, behind an identity-aware proxy.
   [OPERATIONS.md](./OPERATIONS.md).
2. **Register** — tools first, then agents, then governance records. The
   governance records are usually the first real conversation, because somebody
   has to decide who owns each agent.
3. **Write policy** — [POLICY_MODEL.md](./POLICY_MODEL.md). Start with the
   highest-impact tool and the `DENY` default.
4. **Point one agent at ARC** — the SDK, or the MCP front door.
5. **Run an assessment** — `arc assurance evaluate`. Expect failures; they are
   the point.
6. **Record the audit anchor** — the one operational habit that matters most,
   and what lets ARC-AI-006 pass.
7. **Export a bundle** and put it in front of whoever will be asked to sign.

Escalation, on-call rotation and SLAs are not defined. For three design
partners the answer is a named engineer and a shared channel; defining more
before there is anything to escalate would be theatre.

---

## 7 · Commercial terms

Not drafted. Required before a paid engagement, and listed so it is not
forgotten:

- Licence agreement. ARC is deployed software, not a hosted service, which
  simplifies most of it.
- Data-processing terms — thin, because ARC sends nothing anywhere. Worth
  stating explicitly: no telemetry, no phone-home, no outbound connection other
  than the connector calls the customer configured.
- Support terms, once there is support to describe.
- Security addendum. The questionnaire is the substance; this is the wrapper.

---

## 8 · The honest summary

**Ready:** the product. 2.0 does what this document says it does, the limits
are stated in the product itself as well as in the docs, and the eval suite
backs the claims.

**Not ready:** everything that needs a customer. No design partners, no
pricing validation, no reference, no commercial terms, no support function, and
no penetration test.

The next action is not more code. It is three organizations with one real agent
each, and the week-8 conversation with whoever has to sign.
