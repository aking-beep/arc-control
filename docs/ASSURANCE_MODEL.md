# The assurance model

How ARC Assurance works, and the rules that keep its output worth reading.

For the controls themselves see
[CONTROL_CATALOGUE.md](./CONTROL_CATALOGUE.md). For what shipped and what did
not, [releases/2.0.md](./releases/2.0.md).

---

## The distinction the whole module rests on

**Enforcement** objects — actions, decisions, evidence, audit records — record
what happened.

**Assurance** objects — controls, assessments, risks, findings — record what
somebody asserted *about* what happened, who asserted it, and how strong the
assertion is.

Keeping those apart is the entire design. A control result is a claim with a
provenance, not a fact, and the model refuses to let the two blur: there is no
way to record a passing control without also recording whether a machine
proved it or a human asserted it, and no way to record a pass at all when the
evidence needed to decide was absent.

---

## Three structural guarantees

### 1 · Assurance reads enforcement and never writes it

The engine reads agents, tools, policies, actions, evidence, approvals and the
audit log. It writes only to its own collections: controls, assessments, runs,
findings, risks, attestations.

Two things follow, and both are tested rather than asserted:

- A bad assessment cannot weaken the gateway. There is no path from here into a
  decision.
- An assurance outage is harmless to authorization. `/health/enforcement`
  reads nothing from the assurance layer, and an eval replaces every assurance
  collection with a proxy that throws on any read and asserts the gateway
  still allows what policy allows and denies what it denies.

The reverse dependency is real and stated: assurance depends entirely on
enforcement's records. `/health` reports both directions explicitly, because
an operator looking at a red figure needs to know which way the arrow points.

### 2 · A question that cannot be answered returns `not_assessable`

There is no path through `packages/assurance/src/evaluate.ts` that reports
success for want of anything to look at. An empty window reports an empty
window. A deployment fact ARC cannot see reports that it cannot see it. An
evaluator that throws reports that it threw.

This costs green ticks in demos and is the only reason the output is worth
anything. The runner has a test asserting that an empty store produces **zero**
passes, and an eval property asserting the same.

### 3 · Every result carries its window and its limitations

`window` is mandatory on every assessment. "Six controls passing" means nothing
without it, and a reader shown the number without the window will assume
"always". The console renders it above every status total and a test asserts
the sentence is there.

`limitations` are copied from the control definition onto every result, so they
travel into exports. The caveat arrives attached to the green tick rather than
in a document beside it.

---

## The status vocabulary

| Status | Reached when |
|---|---|
| `pass` | An automated evaluator ran against real records and every observation held. |
| `fail` | It ran and at least one observation did not hold. |
| `not_assessable` | The question could not be answered: an empty window, a missing or expired attestation, an unanchored chain, an evaluator that threw, or no evaluator at all. |
| `not_applicable` | The scope is empty by design — no MCP-backed tool registered, for instance. |
| `attested` | A named human stated it, within an unexpired attestation. |

`attested` is deliberately not `pass`. A reader scanning a column of statuses
must be able to see at a glance how much of the posture rests on human
statements, which is why the summary reports `attestedOrUnassessable` as its
own figure.

---

## How an assessment run works

```
load one snapshot  →  evaluate each enabled control against it
                   →  persist each result with a digest
                   →  reconcile findings
                   →  persist the run with the audit head
                   →  audit the run
```

**The snapshot is loaded once** and handed to every evaluator, so all the
controls in a run describe the same moment. Evaluating them against separately
loaded views would let two controls in the same report contradict each other,
which is the kind of inconsistency that makes a reader distrust the whole
document.

**Evaluators are pure functions** from that snapshot to a status, a sentence
and a list of observations. They may not read anything they were not handed,
may not call a connector, and may not depend on the clock beyond the window
they were given. That shape is forced by what the results are for: an
assessment has to be reproducible from the records it cites.

**Each result carries an integrity digest** over its own content, computed when
ARC stores it. An exported assessment is checked against this *as well as*
against its bundle digest, so a record altered before export is caught by a
digest the exporter did not control.

**The audit head is recorded on the run**, tying the run to a chain position.

---

## Findings are reconciled, not replaced

A run does not wipe the findings register and write a new one. It matches what
it observes against what is open, keyed by control **and subject**:

- A subject still failing → `occurrences` increments, `lastSeenAt` moves.
- A new failing subject → a new finding, audited.
- A subject no longer failing → resolved, with the assessment that cleared it
  named in the resolution.

Remediation history is the part customers actually care about, and replacing the
register each run would destroy it.

### The subject must be a stable name, not a value

This is a real bug the end-to-end run surfaced and the unit tests did not.

ARC-AI-006 originally keyed its finding on the audit chain's head digest. That
value moves every time a record is appended, so every run saw a "new" subject:
it opened a fresh finding and resolved the previous one, every run, forever —
around 720 findings a month for one unchanged condition.

A finding's subject is a stable name for the thing being observed. The moving
value belongs in the detail. There is a regression test that runs four
assessments against a moving head and asserts exactly one finding with four
occurrences.

### Closing a finding

`resolved`, `accepted` and `false_positive` stay distinct: fixed, chosen to
live with, and never true are three different statements, and collapsing them
makes the register useless for arguing about any of them. Every closure records
who closed it, when, and why.

---

## Attestations

The mechanism for controls ARC cannot decide itself.

An attestation carries the control, the attester, the statement, and an
**expiry**. All four are required:

- The **statement** is what the person claims to have checked. A checkbox would
  be worse than nothing: the value of an attestation is the sentence an auditor
  reads, not the fact that a box was ticked.
- The **expiry** exists because the alternative — a statement that stays true
  forever — is how a control nobody has looked at in three years keeps
  reporting green. Expiry is evaluated at read time, so an attestation goes
  stale on its own and the control reverts to `not_assessable` without anyone
  having to remember to retract it.

Attestations are never replaced, only added. The register of who said what and
when is the point, and overwriting last quarter's statement with this
quarter's would destroy exactly the history an auditor asks for.

---

## The risk register

**Inherent** risk is the position before ARC's controls are credited.
Impact × likelihood on 1–5 ordinal bands, because nobody can honestly put a
probability on "an agent exfiltrates customer data this quarter", and a model
demanding one produces false precision that then gets multiplied.

**Residual** risk is deliberately *not computed*. Crediting a control
automatically would mean the platform grading its own homework: the number
would improve because a control exists, not because anyone checked it works. It
is absent until a named human reviews it, and carries their name, the date and
their rationale. Linking two controls to a risk produces no residual rating,
and an eval property asserts that.

**Acceptance** is dated and expires. An acceptance with no end date is a
decision nobody revisits.

---

## Coverage: what is not governed at all

A different question from "are the controls passing", and in sales
conversations the more dangerous one. A deployment can have every control green
and twelve agents nobody has written a policy for — because a control can only
assess what is in scope, and an ungoverned agent is by construction out of
scope.

Coverage closes that gap by reporting the **denominators**: agents with an
incomplete governance record, high-impact tools no enabled policy selects,
active agents no policy selects, controls never assessed or assessed too long
ago, and actions missing evidence.

That last one should always be empty. The gateway writes evidence on every
path including every error path, so a non-empty list is not a governance gap
but a defect in ARC itself — which is why it is reported separately and the CLI
exits non-zero on it.

**Nothing here produces a percentage.** A single number invites a target, a
target invites gaming it, and "94% covered" tells a reader nothing about
whether the missing 6% is a dormant test agent or the one with production
database credentials. The report lists the gaps by name.

Coverage uses the **gateway's own selector logic** to decide whether a policy
matches a tool, rather than reading `policy.match` by hand. A coverage report
that disagreed with the enforcement path about what a policy covers would be
worse than none.

---

## Framework mappings

A mapping says: "evidence from these ARC controls is relevant to this framework
reference." It does not say the reference is satisfied, and it certainly does
not say the customer is compliant. Those are conclusions only the customer's
own assessor can reach.

**Every mapping ships as `proposed`, not `reviewed`.** ARC's engineering team
can draft a mapping; only someone accountable for the customer's compliance
programme can accept one, and a framework table marked reviewed at the factory
is precisely the artefact that ends up in a board pack.

**Coverage counts only reviewed mappings**, so the figure starts at zero and
rises as real review happens rather than starting at 100% because we shipped a
table.

`evidenced` is deliberately hard to earn. A reviewed mapping whose controls are
`not_assessable` is not evidenced, because an unanswerable question is not
supporting evidence; and an unreviewed mapping is never evidenced whatever its
controls say.

---

## Evidence bundles

The artefact an auditor is handed, designed around one constraint: **it must be
checkable by someone who does not trust ARC.**

That rules out the obvious shape — a signed report from the system under audit
proves only that the system under audit says so. A bundle instead carries the
primary records, each with the digest it is expected to hash to, plus a
manifest digest over all of them. `verifyBundle` recomputes every digest from
the bundle's own bytes and contacts nothing.

### Two digests, not one

Evidence records and assessments carry both:

- The **bundle digest**, computed at export, catches alteration after export.
- The record's own **integrity digest**, written when ARC stored it, catches
  alteration *before* export — which a recomputed bundle digest would
  otherwise accept.

The walkthrough demonstrates the second attack being caught: a decision is
rewritten from `REQUIRE_APPROVAL` to `ALLOW`, the bundle digest is recomputed
to match, and the stored integrity digest still disagrees.

### A slice, not the whole chain

A bundle holds the audit records for its window, not the chain from genesis —
exporting the whole log for a one-week window would be absurd. So bundle
verification checks linkage and sequence contiguity *within* the slice, and
applies the genesis check only when the slice really does start at sequence 1.
The store's `verifyChain` assumes genesis and would report spurious breaks on
every windowed export.

### `failures` and `limitations` are separate

`failures` means something is wrong. `limitations` means the bundle is intact
but proves less than a reader might assume — chiefly the absence of an external
anchor.

Conflating them would be actively harmful: telling someone their evidence was
tampered with, when in fact it merely cannot rule out truncation, would destroy
their trust in the tool that told them.

---

## Where to look in the code

| | |
|---|---|
| `packages/assurance/src/catalogue.ts` | The nine controls, with their limitations |
| `packages/assurance/src/evaluate.ts` | One deterministic evaluator per control |
| `packages/assurance/src/engine.ts` | Runs, findings reconciliation, risks, attestations |
| `packages/assurance/src/coverage.ts` | What is not governed at all |
| `packages/assurance/src/frameworks.ts` | NIST AI RMF mappings |
| `packages/evidence/src/bundle.ts` | Bundle assembly and offline verification |
| `evals/assurance/honesty.eval.mjs` | Every rule above, asserted as a property |

Read the eval suite first. It states the module's claims in terms a reviewer
can check without reading the implementation.
