# The ARC control catalogue

Nine controls. Each one is a question a security team or an auditor actually
asks about an agent deployment, and each is answered — or explicitly not
answered — from ARC's own records.

The set is deliberately small. Nine controls that genuinely evaluate are worth
more than sixty that mostly report `not_assessable`, and a catalogue a customer
can read in one sitting is one they will argue with, which is the point.

The catalogue is seeded on API start and is then customer-owned: disable a
control, retune its frequency, add your own. Those edits survive restart and
upgrade. Changing a control's *procedure* bumps its version, because a result
is only interpretable against the procedure that produced it.

## Reading a status

| Status | Means | Does **not** mean |
|---|---|---|
| `pass` | An automated check ran against real records in the stated window and the assertion held. | That it will hold tomorrow, or that it held before the window. |
| `fail` | It ran and the assertion did not hold. | — |
| `not_assessable` | The question was asked and could not be answered. | Anything about whether the underlying thing is true. It is **not** a near-pass. |
| `not_applicable` | The scope is empty by design. | That the control is satisfied. |
| `attested` | A named human stated it, with an expiry. | That ARC verified it. |

Every result carries the window it covers and the control's stated
limitations. Both travel into exports, so the caveat arrives attached to the
result rather than in a document beside it.

## The three kinds of assurance

`automated` — ARC can decide it deterministically from its own records.
Seven of the nine.

`deployment` — the answer depends on facts outside ARC's records: network
routes, firewall rules, who holds which credential. ARC can describe what to
check and hold the answer, but cannot test it. It never reports `pass` on its
own. One of the nine (ARC-AI-009), and it is the one most likely to be wrong in
practice.

`manual` — a judgement a human makes and attests to. None in the baseline;
available for customer-defined controls.

---

## ARC-AI-001 · Every registered agent has a recorded identity and owner

**Automated · continuous · high**

An agent acting on enterprise systems can be traced to a named accountable
human and a stated business purpose.

For every agent that is not retired, assert it has an owner, and a governance
record stating its business purpose and criticality. Agents in `draft` are
included: an agent registered without an owner is a gap whether or not it has
been cleared to act.

What a pass does not tell you:

- That the named person knows they own it, or is still employed.
- Whether the business purpose is accurate or current. It is free text.

## ARC-AI-002 · High-impact tools have explicit active policy coverage

**Automated · continuous · critical**

No tool that moves money, destroys data or changes privilege is reachable
without a policy that deliberately governs it.

For every tool at risk tier high or critical, or declaring an irreversible
effect, assert at least one enabled policy selects it — checked per active
agent, using the gateway's own selector logic so coverage cannot disagree with
enforcement. A policy that matches everything counts as coverage and is
reported as such, because a blanket policy is coverage but rarely the coverage
anyone intended.

Finding severity follows the configuration rather than the catalogue: an
uncovered tool behind a `DENY` fallback is a governance gap (medium); behind an
`ALLOW` fallback it is an open door (critical). The observation names which.

What a pass does not tell you:

- That the policy is *correct*. One that matches the tool and allows everything
  satisfies this control.
- Anything about a tool registered at the wrong tier. Risk tier and effect are
  declared by whoever registered it.

## ARC-AI-003 · Actions without valid authorization are denied

**Automated · continuous · critical**

Nothing executed that policy did not permit.

For every action in the window, assert a decision exists, and that any
execution was preceded by an `ALLOW`, or by an approval the policy itself
demanded and which reached approved.

What a pass does not tell you:

- Anything about an action that bypassed the gateway entirely. That is
  ARC-AI-009, and ARC cannot see it.

## ARC-AI-004 · Required human approvals occur before execution

**Automated · continuous · critical**

Where policy demanded a human decision, a human made it — in time, and in
sufficient number.

For every approval-gated action that executed: an approval request exists, it
reached approved, the distinct approving votes met the minimum, **every vote
was cast before execution began**, separation of duties was honoured where
demanded, and the approval was consumed so it cannot be replayed.

The vote-timing check is the one this control exists for. A vote timestamped
after the action ran is the signature of an approval applied retrospectively.

What a pass does not tell you:

- **Who** approved it. Approver identity comes from a configured console header
  rather than an authenticated user in this release, so the control establishes
  that the workflow ran, not who ran it.

## ARC-AI-005 · Relevant actions and denials leave audit evidence

**Automated · continuous · high**

Every attempt, allowed or refused, is recoverable afterwards.

For every action in the window, assert an evidence record exists and its
recorded parameter digest matches the action as stored. Denials are included
deliberately: a refused attempt is the more interesting security signal, and a
system that only evidences successes cannot be used to investigate anything.

What a pass does not tell you:

- That the evidence is complete in every field. It checks existence and
  internal consistency.

## ARC-AI-006 · Audit-chain integrity is checked, with its limitations disclosed

**Automated · continuous · critical**

The audit log has not been altered, and the limits of that statement are
stated.

Verify the hash chain end to end. A broken or edited chain fails. A chain
verified against an **externally recorded** head passes. A chain verified only
against itself reports `not_assessable`.

That last clause is the whole control, and it is deliberate:

> Walking the records cannot detect truncation. Remove entries from the end and
> what remains is a shorter, perfectly valid chain. ARC verifying its own log
> against its own copy of the head proves nothing to a reader who does not
> trust ARC.

So **this control cannot pass on a default install**, and that is the intended
behaviour rather than a defect. It is also what creates pressure to anchor the
head somewhere ARC does not control — which is the only thing that actually
closes the gap.

What a pass does not tell you:

- The store's head-marker file is defence against *accidental* truncation: a
  crash mid-write, a partial restore, a log rotation that dropped the tail. An
  attacker who can rewrite the log can usually rewrite that file too.

## ARC-AI-007 · MCP tool manifests are reviewed and changes detected

**Automated · daily · high**

A tool an agent can call does not silently change what it does.

For every tool executed by an MCP connector, assert a manifest digest is pinned
in its connector configuration, so upstream change is detectable rather than
invisible. Reports `not_applicable` when no MCP-backed tool is registered.

What a pass does not tell you:

- A pinned digest makes drift *detectable*; it does not detect it. That needs a
  scan, which ARC performs on demand rather than on a schedule in this release.
- A server that lies about its own tool descriptions is not caught by reading
  them.

## ARC-AI-008 · Agent and tool permissions receive periodic review

**Automated · monthly · medium**

Somebody has recently looked at what each agent is allowed to do and confirmed
it is still right.

For every active agent, assert a permission review is recorded within the
interval its governance record specifies, defaulting to 90 days. An agent with
no review ever recorded **fails**: the absence of a review is an answerable
question, not an unanswerable one.

What a pass does not tell you:

- That the review was thorough. The reviewer's note is stored verbatim and is
  the only evidence of depth.

## ARC-AI-009 · Protected connectors cannot be bypassed through other routes

**Deployment · quarterly · critical**

The systems ARC governs are reachable by agents only through ARC, so a policy
decision cannot be sidestepped.

ARC cannot test this from inside itself. Whether an agent can call Stripe
directly depends on network routes, firewall rules and who holds which
credential — none of which are in ARC's records. The control therefore requires
a dated attestation from a named reviewer confirming that, for each governed
system, no agent-reachable credential permits direct access. Without a current
attestation it reports `not_assessable`, never a pass.

What an attestation does not tell you:

- This is the control most likely to be wrong in practice and the one ARC can
  say least about. A product reporting it green from its own records would be
  lying.
- An attestation is a statement by a person at a point in time. It goes stale,
  and ARC reverts the control to `not_assessable` when it does rather than
  carrying the old answer forward.

---

## Adding your own

A control with no implemented evaluator reports `not_assessable` with
"No automated evaluator is implemented for this control, and no current
attestation is on file." It never reports a pass. Record an attestation against
it, or implement an evaluator in `packages/assurance/src/evaluate.ts` and
register it in `EVALUATORS`.

The honest answer to "how is this control doing?" when nothing evaluates it is
"nobody checked", and the model has no way to spell anything else.
