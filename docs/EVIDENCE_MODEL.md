# The evidence model

Evidence is the durable answer to one question:

> What did this agent try to do, who or what authorized it, and what actually
> happened?

One record per action. Written for every outcome — allowed, held, executed,
failed and **denied**.

---

## Why denials get records

A control plane that only records its successes cannot answer the question an
incident review actually asks.

When an agent attempts a $4,200 refund against a $2,500 ceiling, the
interesting artifact is the *attempt*. It might be a prompt injection, a
mis-specified workflow, or a genuine business need that policy has not caught
up with — and the only way to tell is to have the record. If denials vanish, a
sustained attack looks exactly like a quiet week.

So the gateway writes evidence on every path, including every error path, and
the eval suite asserts it:

```
allowed → executed    evidence (with execution)
allowed → failed      evidence (with the failure)
held    → pending     evidence (with the approval request)
held    → executed    evidence (with the approval and the votes)
denied                evidence (with the policy citation)
```

The one case without an evidence record is an action refused *before* a
decision — an unknown tool, or parameters that violate the tool contract. There
is no decision to evidence, and minting one would imply a policy looked at
something it never saw. Those are recorded in the audit log as `action.denied`
with the reason, so the attempt is still visible.

---

## What a record contains

```json
{
  "id": "arc_ev_82f3a1c4d5e6f708192a3b4c5d6e7f80",
  "schemaVersion": 1,
  "actionId": "arc_act_...",
  "organizationId": "default",
  "environment": "production",

  "agent": {
    "id": "arc_ag_...",
    "name": "finance-agent",
    "owner": "finance-ops@example.com",
    "roles": ["finance"],
    "credentialId": "arc_cred_..."
  },

  "tool": {
    "name": "stripe.refund",
    "system": "stripe",
    "effect": "irreversible",
    "riskTier": "critical",
    "connector": "stripe-sandbox"
  },

  "request": {
    "parameters": { "customer": "customer_123", "amount": 4200 },
    "parametersDigest": "sha256:...",
    "intent": "Refund customer_123: customer dispute",
    "correlationId": "run_2026_10_20_a",
    "requestedAt": "2026-10-20T05:46:28.901Z"
  },

  "decision": {
    "id": "arc_dec_...",
    "effect": "DENY",
    "policyId": "FINANCE-004",
    "policyVersion": 1,
    "ruleId": "over-ceiling",
    "reason": "exceeds autonomous refund authority",
    "decidedAt": "2026-10-20T05:46:28.915Z",
    "evaluationMs": 0.41,
    "traceDigest": "sha256:..."
  },

  "outcome": "denied",
  "obligations": [],
  "createdAt": "2026-10-20T05:46:28.918Z",
  "integrityDigest": "sha256:..."
}
```

With an `approval` block when a human was involved, and an `execution` block
when something ran. The machine-readable definition is
[`schemas/evidence.schema.json`](../schemas/evidence.schema.json).

### Design decisions worth naming

**It is self-contained.** Everything needed to understand the action is in the
record: the agent and its owner, the tool and its risk, the parameters, the
policy *and its version*, the rule, the reason, the approvers and their votes,
the execution outcome. A record can be handed to an auditor without granting
them access to ARC Control.

**It names the credential.** `agent.credentialId` means a leaked key can be
traced to every action taken with it — which is the first thing anyone asks
after a credential incident.

**It records the policy version.** A decision citing `FINANCE-004` version 1
remains explainable after the policy reaches version 7. The matching
`policy.created` / `policy.updated` audit record carries the document's digest,
so the exact text can be recovered.

**Parameters are redacted; the digest is not.** `request.parameters` has
sensitive values replaced with `[redacted]`, but `parametersDigest` is computed
over the **unredacted** submission. The record therefore proves what was
submitted without storing it. Redaction covers parameters a tool marked
`sensitive`, plus a list of names — `password`, `api_key`, `client_secret`,
`private_key`, `token`, `ssn`, `card_number` and others — redacted wherever
they appear at any depth, because a tool author who forgets to mark a field
should not be able to write credentials into the record.

**The trace is referenced, not duplicated.** `decision.traceDigest` is a digest
over the full rule-by-rule trace. The trace itself lives on the decision
(`GET /v1/decisions/{id}`, or the console's evidence detail page), so a
tampered trace is detectable without storing it twice.

**`intent` is recorded and never used.** The agent's own account of what it was
doing is useful context for a human reading the record afterwards, and is
deliberately unavailable to policy conditions. An agent's narration is not
evidence of its behaviour.

---

## Verifying a record

`integrityDigest` is a SHA-256 over the canonical JSON of every other field.
Canonical means object keys sorted and `undefined` members dropped, so two
structurally equal records always produce the same digest regardless of
language or key order.

```bash
arc evidence verify export.json
```

No server. No credentials. No network. The check is a pure function over the
record, which is the point: the party verifying does not have to trust the party
that produced it.

```
Evidence verification
  source   export.json
  records  3
  result   ALL VERIFIED

  evidence                                  tool           outcome   integrity
  arc_ev_94f986d97ccd716b117f93fa2da50982   stripe.refund  denied    verified
  arc_ev_a9e0be1d5a7c662da1cda14934e06c95   stripe.refund  executed  verified
  arc_ev_7a81a212c492402676fc47edaa7b4aca   stripe.refund  executed  verified
```

It accepts a single record, a JSON array, an API response body with an
`evidence` key, or a JSONL export.

What this catches: rewriting a denial as an execution, changing the amount,
editing the reason, swapping the policy id, adding a vote that never happened.
Any single-field edit invalidates the digest.

What it does not catch: a record that was never written. The audit chain is the
defence there — `evidence.recorded` is appended for every record, so a missing
record leaves a chain entry pointing at nothing.

---

## The audit chain

Evidence answers "what happened to this action?". The audit log answers "what
happened, in order, and has the record been altered?".

Every record carries the digest of its predecessor:

```
record 1   previousDigest: sha256:000…000   digest: sha256:a1b2…
record 2   previousDigest: sha256:a1b2…      digest: sha256:c3d4…
record 3   previousDigest: sha256:c3d4…      digest: sha256:e5f6…
```

Editing record 2 changes its digest, so record 3's `previousDigest` no longer
matches — and so on for every record after it. Removing record 2 leaves a
sequence gap. Either way the break is reported at the first affected record.

```bash
arc audit verify --data ./arc-data
arc audit verify --file audit.jsonl

# The stronger check: against a head recorded out of band earlier.
arc audit verify --file audit.jsonl \
  --expect-head sha256:9f2c… --expect-records 18
```

```
Audit chain verification
  source           ./arc-data/audit.jsonl
  records          18
  checked against  the store's head marker (audit.head.json)
  result           INTACT

Head digest — record this outside ARC Control, then pass it back with --expect-head
  sha256:9f2c…  (sequence 18)
```

The log covers configuration as well as actions, because "who widened this
policy, and when?" is the first question any incident review asks:

```
agent.registered     credential.issued    policy.created
agent.suspended      credential.revoked   policy.updated
agent.resumed        tool.registered      policy.disabled

action.requested     approval.requested   evidence.recorded
action.allowed       approval.voted
action.denied        approval.approved
action.executed      approval.rejected
action.failed        approval.expired
```

Administration is audited on the gateway rather than in the API layer, so the
HTTP API, the CLI and a seed script all produce the same records. An earlier
arrangement audited them in the route layer only, which meant seeding a
deployment left an empty audit log.

### Tamper evidence, not tamper proofing

Stated plainly, because the distinction decides what the chain is worth. There
are two limits, and the second is the one that is easy to miss.

**An attacker who controls the storage can rewrite the entire chain.** Change a
record, recompute every digest from that point forward, and verification
passes.

**Walking the records cannot detect truncation.** Remove records from the *end*
and what remains is a shorter chain in which every digest and every link is
still correct. There is no gap, because the gap would have been after the last
remaining record. So `result: INTACT` from a bare export means *the records
present are self-consistent* — not *the log is complete*. An attacker who wants
a denial gone, and who can only append or truncate, removes everything from
that denial onwards.

What the chain detects on its own, then, is an edited record, a reordering, and
a record missing from the **middle**.

Both limits close the same way: an expected head that did not come from the log.

| | |
|---|---|
| `verifyChain(records, { headDigest, headSequence })` | The pure function takes an expectation. |
| `arc audit verify --expect-head <digest> --expect-records <n>` | What an auditor runs against an export. |
| `GET /v1/audit/verify?headDigest=…` | The same check through the API. |
| `FileStore` head marker (`audit.head.json`) | Written beside the log on every append, so truncating the log alone is caught. Defence in depth, not a guarantee — whoever can rewrite the log can usually rewrite the marker. What it reliably catches is the accidental case: a crash mid-write, a partial restore, a rotation that dropped the tail. |

The real guarantee needs the head anchored somewhere ARC Control cannot reach —
a write-once bucket, a timestamping authority, a transparency log, or a
signature from a key the control plane does not hold. That is v0.5 work.
Until then `arc audit verify` prints the head digest specifically so it can be
recorded by hand, and both the CLI and the console say when nothing was
available to check it against, rather than reporting a clean result and leaving
the reader to assume more than was tested.

`evals/reliability/guarantees.eval.mjs` asserts all of this, including that a
truncated chain verifies against itself — so the limit is pinned down by a test
rather than only described here.

---

## Reading the record

**For one action**, the console's evidence detail page shows the record and the
full decision trace side by side — every rule the engine examined, in order,
with the reason each did or did not match.

**For a timeline**, `GET /v1/audit` returns records in sequence order;
`AuditLog.forSubject(actionId)` narrows to one action's lifecycle.

**For a correlated agent run**, `request.correlationId` ties every action in one
run together. Pass it on every call from an agent loop; it is the difference
between investigating one refund and reconstructing a session.

**For export**, `GET /v1/evidence?outcome=denied&limit=...` returns records
ready to hand to an auditor, who can verify them with `arc evidence verify`
without any access to the deployment.

---

## Retention

v0.1 retains everything, forever, in whichever store is configured. There is no
expiry, no archival tier and no deletion API.

That is the right default for a control plane and the wrong one for a
production deployment under a retention obligation. Retention policy, archival
and defensible deletion — deletion that leaves the chain verifiable, which
means storing a tombstone rather than removing a record — are v0.5. The
`FileStore` layout is deliberately plain JSONL so an operator can archive and
prune by hand before then.
