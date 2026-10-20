# The trust model

Who trusts whom, what each party can do, and — more usefully — what each party
cannot do.

---

## The parties

| Party | What it is |
|---|---|
| **Agent** | Software that wants to act on a system. Authenticates with an agent API key. Never a human. |
| **Operator** | A human managing ARC Control: policy, approvals, agents, tools. |
| **Approver** | An operator a policy has named as able to authorize a specific held action. |
| **Connector** | Code that turns an authorized action into a real effect, holding the credential for the target system. |
| **Target system** | Stripe, GitHub, AWS, an MCP server — whatever actually changes. |
| **Auditor** | Someone who needs to establish what happened, possibly without access to ARC Control. |

---

## What an agent can and cannot do

An agent is the party ARC Control exists to bound, so this is the important
row.

**An agent can:**

- Submit an action for a decision.
- Ask what policy *would* decide, without anything happening.
- See the decision it received, including the policy id, rule id and reason —
  so it can do something sensible instead, such as escalating to a human rather
  than retrying a refund it will never be allowed.

**An agent cannot:**

- **Read or change policy.** An agent that could edit the policy governing it
  would not be governed.
- **Read evidence or audit records**, its own included. It cannot discover what
  other agents attempted, and it cannot check whether its denial was recorded.
- **Approve anything**, including its own held actions.
- **Reach a connector directly.** Connectors are registered with the gateway,
  not exposed. The only path to a target system is through a decision.
- **Call a tool that is not registered.** An action naming an unknown tool is
  refused before policy runs; ARC Control will not reason about a capability
  nobody declared.
- **Send a parameter the tool does not declare.** Undeclared parameters are
  *rejected*, not dropped — silently dropping them would hide a
  confused-deputy attempt from both policy and the audit record.
- **Claim a different identity.** The principal comes from the credential, so
  there is no field in a request an agent could set to become someone else. An
  `agentId` or `roles` in a request body is ignored.
- **Narrate its way past policy.** The `intent` field is recorded and is
  deliberately unavailable to conditions. An agent's own account of what it is
  doing is not evidence of what it is doing.
- **Cause two effects from one authorization.** An approval is consumed on use;
  an idempotency key returns the original outcome; an irreversible action is
  never retried automatically.

---

## What an operator can and cannot do

**An operator can** register agents and tools, publish policy, suspend an
agent, issue and revoke credentials, vote on approvals, release an approved
action, and read everything.

**An operator cannot:**

- **Alter or delete evidence or audit records.** There is no API for it. The
  audit log is append-only and the evidence record is digest-sealed.
- **Execute an action that policy denied.** There is no override path. An
  operator who wants an action to be permitted must change the policy — which
  is itself an audited event carrying the new document's digest.
- **Approve an action they were not named for.** The approvals engine checks
  authority against the policy, not against the console.
- **Approve their own agent's action** where the policy sets
  `requireSeparationOfDuties`, however else they would match.
- **Recover an issued credential.** The plaintext is returned once; ARC Control
  stores a salted hash.

The absence of an override path is a choice. Breaking glass is a real
operational need, and the honest way to meet it is a policy change that is
itself recorded — not a button that produces an effect with no decision behind
it.

### What an operator *is* trusted with, and the v0.1 gap

v0.1 authenticates operators with a **single shared token** and takes their
identity from the `x-arc-operator` header.

This means: anyone holding the token can claim any identity. An approval
attributed to `cfo@example.com` proves that *someone with the operator token
said they were the CFO*, which is weaker than it reads.

It is adequate for a pilot behind an existing identity-aware proxy — where the
proxy establishes identity and ARC Control records it — and inadequate for
anything else. The claimed identity is recorded on every vote and in every
audit record, so a disputed approval can be traced to the token and the claim
that was made, but the claim itself is not independently verified.

`apps/control-api/src/operator.ts` is the module real RBAC and SSO replace in
v0.5. Until then, treat the operator token as a shared administrative secret
and put a proxy that authenticates humans in front of the console.

---

## What a connector is trusted with

A connector holds the credential for a target system. That makes it the most
sensitive component after the policy store, and the trust is deliberately
one-directional.

**A connector receives** the action, the tool definition and the agent
principal.

**A connector does not receive** the policy, the decision or the approval. By
the time it is called, authorization has already happened. A connector cannot
second-guess it, reinterpret it, or decide to proceed anyway.

**A connector is trusted to be honest about failure.** A connector that
swallows an error and returns success writes a false evidence record, which is
worse than no evidence: people act on records they believe. The `Connector`
contract says so, and `Executor` records whatever actually came back.

**A connector is not trusted with the network.** `GenericHttpConnector`
requires a host allowlist; templates fill the path and the body but never the
host; a redirect is reported rather than followed, because following one would
leave the allowlist behind. Without this, a templated URL driven by
agent-chosen parameters is a server-side request forgery primitive pointed at
the cloud metadata service — while holding real credentials.

---

## What an auditor is trusted with, and needs no trust for

The design goal is that an auditor should not have to trust ARC Control, or
the organization running it, to establish what happened.

**Evidence verifies independently.** Each record carries a digest over its own
contents. `arc evidence verify export.json` recomputes it with no server, no
credentials and no network. Rewriting a denial into an execution, or editing
the reason, fails verification.

**The audit chain verifies independently.** Each record carries the digest of
its predecessor. `arc audit verify --file audit.jsonl` recomputes the whole
chain and reports the first break and every one after it.

**Evidence is self-contained.** A record names the agent, its owner, the
credential that authenticated it, the tool, the parameters, the policy, the
rule, the reason, the approvers, the votes and the execution outcome — without
requiring access to the system that produced it.

### The limit, stated plainly

Hash chaining gives **tamper evidence, not tamper proofing**.

An attacker who controls the storage can rewrite the entire chain: recompute
every digest from the point they changed, and verification passes. What the
chain guarantees is that a *partial* edit — one record, one deletion, a
reordering — is detectable, and that the log cannot be silently amended by
anything that does not have write access to all of it.

Closing that gap requires anchoring the head digest somewhere ARC Control does
not control: a write-once bucket, a timestamping authority, a transparency log,
a signature from a key the control plane cannot reach. That is v0.5 work, and
`arc audit verify` prints the head digest specifically so it can be anchored by
hand in the meantime.

The console says this on the audit page rather than implying something
stronger.

---

## Trust boundaries

```
┌─────────────────────────────────────────────────────────────────┐
│ UNTRUSTED                                                       │
│   Agent requests        — may be adversarial, may be confused   │
│   MCP tool descriptions — model-facing text from a third party   │
│   Connector responses   — data from the target system            │
└─────────────────────────────┬───────────────────────────────────┘
                              │  authenticate, validate, decide
┌─────────────────────────────▼───────────────────────────────────┐
│ TRUSTED CONTROL PLANE                                           │
│   Gateway, policy engine, approvals, evidence, audit            │
│   Policy documents      — written by operators                  │
│   Tool definitions      — written by operators                  │
└─────────────────────────────┬───────────────────────────────────┘
                              │  execute, holding credentials
┌─────────────────────────────▼───────────────────────────────────┐
│ TARGET SYSTEMS                                                  │
│   Stripe, GitHub, AWS, MCP servers                              │
└─────────────────────────────────────────────────────────────────┘
```

Two crossings deserve naming.

**MCP tool descriptions cross from untrusted to trusted as text an agent
reads.** A server operator — or anyone who has compromised one — can attempt to
steer a client's agent purely through metadata, without ever being called. That
is why `packages/mcp-security` scans descriptions before a tool is registered,
and why a manifest is pinned so a description that changes after review is
caught. The protocol gives a client no notification of such a change.

**Connector responses cross back.** A response is recorded and returned to the
agent; it is redacted on the way into evidence, and it is never interpreted as
an instruction by ARC Control. What the *agent* does with it is the agent's
own prompt-injection surface, which ARC Control bounds by deciding the agent's
next action rather than by inspecting the text.

---

## Assumptions

ARC Control's guarantees hold only while these do.

1. **The agent cannot reach the target system by another route.** If an agent
   holds Stripe credentials of its own, ARC Control is a suggestion. This is a
   deployment property — network policy, credential custody — not something the
   code can enforce.
2. **The operator token is secret**, and the console sits behind something that
   authenticates humans.
3. **The storage layer is not writable by an attacker.** See the tamper-evidence
   limit above.
4. **Connectors are honest about outcomes.** A lying connector produces false
   evidence.
5. **Tool definitions are accurate.** A tool declared `read` that actually
   writes will be governed as a read. `effect` is operator-supplied, and
   getting it wrong mis-governs every policy that selects on it.
6. **Clocks are roughly right.** Approval windows and credential expiry depend
   on it.

Assumption 1 is the one that gets violated in practice. ARC Control is worth
deploying only where the agent's only path to the system runs through it.
