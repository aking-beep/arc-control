# Architecture

ARC Control is the trust and control layer between enterprise AI agents and the
systems they act upon.

That sentence is a position, not a slogan. An agent that can call a tool can
act on a real system — move money, change infrastructure, send mail, close a
ticket. The organization accountable for that action needs to be able to say,
before it happens, whether it is permitted, and afterwards, what happened and
who authorized it. ARC Control is the component that answers both questions.

---

## The one thing it does

Every agent action passes through one decision point:

```
                           AI agent
                              │
                              ▼
                   ┌──────────────────────┐
                   │  ARC Control Gateway │
                   └──────────┬───────────┘
                              │
                    1. identify the agent          agent-identity
                              │
                    2. resolve the tool            execution
                       validate parameters
                              │
                    3. evaluate policy             policy-engine
                              │
          ┌───────────────────┼───────────────────┐
          ▼                   ▼                   ▼
       ALLOW           REQUIRE_APPROVAL         DENY
          │                   │                   │
          │              human decides            │
          │              (approvals)              │
          │                   │                   │
          └─────────┬─────────┘                   │
                    ▼                             │
            4. execute the action                 │
               (connectors)                       │
                    │                             │
                    └──────────────┬──────────────┘
                                   ▼
                        5. capture evidence        evidence
                                   │
                        6. append audit record     audit
                                   │
                                   ▼
                           Control Console
```

Two invariants hold on every path through the gateway, including every error
path. They are covered by tests in `packages/gateway/src/gateway.test.ts` and
asserted as properties in `evals/`:

1. **Nothing executes without a decision.** The only call to the executor is
   downstream of an `ALLOW`, or of an approval the policy itself demanded.
2. **Every action that reaches the gateway leaves evidence** — allowed, held,
   executed, failed or denied. A control plane that only records its successes
   cannot answer the question an incident review actually asks.

---

## Why these seven components

Each one exists because removing it would break a guarantee, not because it
rounds out a feature list. The first six make the diagram above true; the
seventh makes it checkable.

| Component | Without it |
|---|---|
| **Gateway** (`packages/gateway`) | There is no single place every action passes through, so there is no control plane — only a library some agents remembered to call. |
| **Agent identity** (`packages/agent-identity`) | Policy cannot bound an agent it cannot name, and evidence cannot attribute an act to a principal that was never established. |
| **Policy engine** (`packages/policy-engine`) | Authorization becomes code review: the rules live in whoever wrote the agent, not in a document an auditor can read. |
| **Approvals** (`packages/approvals`) | The only answers are yes and no, so every judgement call has to be pre-decided — which in practice means pre-approved. |
| **Evidence** (`packages/evidence`) | "What did this agent do?" is answered from logs that were not designed to answer it. |
| **Audit** (`packages/audit`) | Records can be edited after the fact, so the evidence is only as trustworthy as the person holding it. |
| **Assurance** (`packages/assurance`) | Nobody can answer "are these controls actually operating?" except by reading logs by hand, quarterly, and taking somebody's word for the result. |

---

## Layering

Dependencies point one way. Nothing below depends on anything above it.

```
  apps/control-console          reads the API with the operator's credential
  apps/control-api              HTTP surface; two credentials, two audiences
        │
  packages/cli                  policy linting, MCP scanning, verification
        │
  packages/gateway              orchestration + audited administration
        │                        policy history, simulation, rate limiting
        │
        ├── packages/agent-identity
        ├── packages/policy-engine
        ├── packages/approvals
        ├── packages/evidence    records + offline-verifiable bundles
        ├── packages/audit
        ├── packages/assurance   controls, assessments, risks, findings, coverage
        └── packages/execution   ◄── connectors/* implement its Connector contract
                │
        packages/store           storage contracts, memory + append-only file
                │
        packages/schemas         the object model, canonical JSON, redaction
```

**Assurance sits beside the gateway, not above it, and that placement is the
point.** It depends on `store` and `schemas` and reads the same records the
gateway writes — but the gateway does not depend on it, and there is no path
from assurance into a decision. So a broken assurance layer can fail to report
and cannot fail open. The audit log is *lent* to it as a single `append` verb
rather than imported, which keeps the dependency graph acyclic and makes the
one-way relationship explicit in the constructor signature.

Three consequences of this shape are worth stating:

**The policy engine is pure.** It takes a policy list and a plain-data input
and returns a decision. It cannot read the store, call a connector, or observe
anything that was not captured in its input. That is what makes a decision
reproducible from evidence a year later.

**Connectors are the dumbest layer, deliberately.** A connector receives the
action, the tool and the principal — and not the policy, the decision or the
approval. By the time it is called, authorization has already happened, and a
connector cannot second-guess, reinterpret or bypass it.

**Administration lives on the gateway, not in the API.** Registering an agent,
defining a tool and publishing a policy all change what agents may do, so each
is audited. Putting those operations on the gateway means the HTTP API, the
CLI and a seed script all go through one audited path, and none of them can
forget. An earlier arrangement audited them in the route layer only, which
meant seeding a deployment left an empty audit log.

---

## The two credentials

The API has two audiences, and the distinction is load-bearing.

**Agents** present an agent API key and may do exactly one thing: submit an
action for a decision (`POST /v1/actions`), or ask what policy would do without
anything happening (`POST /v1/actions/explain`). They cannot read policy, read
evidence, approve anything, or see other agents. *An agent that could edit the
policy governing it would not be governed.*

**Operators** present the operator token and manage everything else — agents,
tools, policy, approvals, evidence, audit.

v0.1 authenticates operators with one shared token and takes their identity
from a request header. That is adequate for a pilot behind an existing
identity-aware proxy and inadequate for anything else: the token carries no
individual accountability, and a caller who holds it can claim any identity.
`apps/control-api/src/operator.ts` is the seam that real RBAC and SSO replace in
v0.5. Because the claimed identity is recorded on every approval and in the
audit log, a disputed approval can at least be traced to the token and the
claim that was made.

---

## Storage

`ControlStore` is an interface, with two implementations shipped:

- **`MemoryStore`** — for tests, evals and examples.
- **`FileStore`** — newline-delimited JSON in one directory. Mutable
  collections are snapshot files rewritten atomically; the audit log is a true
  append-only file, so a record that has been written is never rewritten. This
  is the single-node target: enough for a pilot, an air-gapped install or a
  laptop, and small enough to read with `cat`.

A clustered store (Postgres, with the audit chain anchored externally) is v0.5
work. The interface exists now so that change does not reach the gateway.

---

## Where assurance fits

The gateway answers *may this happen?* Assurance answers *can you prove the
first answer was produced correctly, over this window, by this procedure?*

```
  enforcement writes          assurance reads
  ──────────────────          ───────────────
  actions                 ┐
  decisions               │
  evidence                ├──►  nine control evaluators
  approvals               │           │
  audit records           ┘           ▼
                              assessments ──► findings
                                   │
                                   ├──► coverage: what is not governed at all
                                   ├──► framework mappings (reviewed only)
                                   └──► evidence bundles (verify with ARC off)
```

The arrow never reverses. See [ASSURANCE_MODEL.md](./ASSURANCE_MODEL.md) for
the rules that keep the output honest — chiefly that a question which cannot be
answered returns `not_assessable` and never `pass`.

---

## What is deliberately absent

ARC Control is not a place to put AI utilities. A tool earns its way into this
repository only by contributing to the chain:

> identity → authorization → policy → execution → evidence → security →
> observability

Specifically out of scope for v0.1, with the phase that picks each up:

- **Risk scoring and kill switches** — v0.2. The seam exists: a tool carries a
  `riskTier`, and an agent carries a status that is checked at authentication
  before policy runs.
- **Traces, cost and latency analytics** — v0.3. Evidence already records
  execution duration, and the audit log is ordered and append-only, which is
  what a trace store would build on.
- **Agent-to-agent delegation** — v0.4. `AgentPrincipal` carries an optional
  `delegatedFrom` chain that nothing populates yet.
- **RBAC, organizations, SIEM export, retention** — v0.5. Every object already
  carries `organizationId`.

See [ROADMAP.md](./ROADMAP.md) for what each phase contains and why it comes
when it does.

---

## Dependencies

ARC Control has **no runtime dependencies**. Node's standard library only:
`node:http`, `node:crypto`, `node:fs/promises`, built-in `fetch`.

This is a cost — a hand-written router, a hand-written argument parser, a
hand-written MCP client — paid deliberately. A control plane is the component
an enterprise security team reads line by line before putting it in front of
their systems, and its supply chain is part of its threat model. Every line of
the decision path is in this repository.

The only development dependencies are TypeScript and `@types/node`. Tests run
on `node:test`.

---

## Further reading

- [TRUST_MODEL.md](./TRUST_MODEL.md) — who trusts whom, and what each party can
  and cannot do
- [THREAT_MODEL.md](./THREAT_MODEL.md) — what ARC Control defends against, and
  what it does not
- [POLICY_MODEL.md](./POLICY_MODEL.md) — the policy language and why it is
  shaped this way
- [EVIDENCE_MODEL.md](./EVIDENCE_MODEL.md) — what a record contains and how to
  verify one
- [ROADMAP.md](./ROADMAP.md) — v0.1 through v1.0
