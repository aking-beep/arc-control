# ARC Control

**The trust and control layer between enterprise AI agents and the systems they
act upon.**

An agent that can call a tool can act on a real system — move money, change
infrastructure, send mail, close a ticket. The organization accountable for
that action needs to answer two questions: before it happens, *is this
permitted?*; afterwards, *what happened, and who authorized it?*

ARC Control answers both. **2.0 adds a third, which is the one that gets asked
in an audit:** *can you prove the first two worked?*

That is what ARC Assurance does — nine controls evaluated against the
gateway's own records, each result stating the window it covers and what it
does **not** establish, and an evidence export that verifies with ARC switched
off.

It is also why a fresh install does not show all green. A control ARC cannot
decide for itself reports `not_assessable` rather than passing, and that is the
product working. A governance tool that reports green where it has no evidence
converts an unexamined risk into a documented assurance, and the customer finds
out when an auditor disagrees.

```
                           AI agent
                              │
                              ▼
                   ┌──────────────────────┐
                   │  ARC Control Gateway │
                   └──────────┬───────────┘
                              │
                     identify the agent
                              │
                     inspect the action
                              │
                      evaluate policy
                              │
          ┌───────────────────┼───────────────────┐
          ▼                   ▼                   ▼
       ALLOW           REQUIRE_APPROVAL         DENY
          │                   │                   │
          │              human decides            │
          │                   │                   │
          └─────────┬─────────┘                   │
                    ▼                             │
              execute action                      │
                    │                             │
                    └──────────────┬──────────────┘
                                   ▼
                           capture evidence
                                   │
                             audit record
                                   │
                    ┌──────────────┴──────────────┐
                    ▼                             ▼
             Control Console                ARC Assurance
                                                  │
                                   ┌──────────────┼──────────────┐
                                   ▼              ▼              ▼
                            control results   findings    evidence bundle
                                                            (verifies offline)
```

Assurance reads enforcement and never writes it. There is no path from the
governance layer into a decision, which is why an assurance outage can stop
ARC reporting on itself but cannot open the gateway — asserted by an eval that
breaks every assurance collection and checks the gateway still decides
correctly.

---

## See it work

```bash
npm install
npx arc demo
```

```
ARC Control — refund workflow
Agent, policy and tool registered. Effects are simulated; the control path is real.

  amount            decision          outcome           rule / approver  evidence
  $120              ALLOW             executed          under-500        arc_ev_7a81a212…
  $1,800            REQUIRE_APPROVAL  pending approval  needs-approval   arc_ev_d0226d33…
    after approval  —                 executed          cfo@example.com  arc_ev_f28d85ac…
  $4,200            DENY              denied            over-ceiling     arc_ev_486db47b…

DENIED
  Agent        finance-agent
  Tool         stripe.refund
  Amount       $4,200
  Policy       FINANCE-004 (rule over-ceiling)
  Reason       exceeds autonomous refund authority
  Timestamp    2026-10-20T05:39:26.840Z
  Evidence ID  arc_ev_486db47b9acc8477672ab6e9431ab1c4

Audit chain  intact — 18 record(s)
Refunds that reached Stripe  2 of 3 attempted (the $4,200 refund never left ARC Control)
```

Only the refund itself is simulated. The gateway, policy engine, approval
engine, evidence builder and audit chain are the shipped implementations — a
demo that faked the decision would prove nothing.

---

## The worked example

A finance agent attempts a refund. The policy that governs it:

```json
{
  "id": "FINANCE-004",
  "version": 1,
  "name": "Autonomous refund authority",
  "enabled": true,
  "match": { "tools": ["stripe.refund"] },
  "rules": [
    {
      "id": "under-500",
      "when": { "lt": ["$.action.parameters.amount", 500] },
      "effect": "ALLOW",
      "reason": "within autonomous refund authority"
    },
    {
      "id": "needs-approval",
      "when": { "lte": ["$.action.parameters.amount", 2500] },
      "effect": "REQUIRE_APPROVAL",
      "reason": "above autonomous refund authority, below the hard ceiling",
      "approval": { "approvers": ["role:finance-manager"], "minApprovals": 1 }
    },
    {
      "id": "over-ceiling",
      "when": { "always": true },
      "effect": "DENY",
      "reason": "exceeds autonomous refund authority"
    }
  ],
  "fallback": { "effect": "DENY", "reason": "no refund rule matched" }
}
```

The agent makes one call. It does not know the policy, and it cannot reach
Stripe any other way:

```ts
import { ArcControlClient } from '@arc-control/sdk-typescript';

const arc = new ArcControlClient({
  baseUrl: 'https://control.example.com',
  apiKey: process.env.ARC_AGENT_KEY,
});

const result = await arc.act({
  tool: 'stripe.refund',
  parameters: { customer: 'customer_123', amount: 4200 },
  intent: 'Refund customer_123: customer dispute',
  correlationId: 'run_2026_10_20_a',
});
```

```json
{
  "actionId": "arc_act_36c30e3a3d2c6f1cc546f8e96a327339",
  "outcome": "denied",
  "decision": {
    "effect": "DENY",
    "policyId": "FINANCE-004",
    "ruleId": "over-ceiling",
    "reason": "exceeds autonomous refund authority"
  },
  "evidenceId": "arc_ev_e6a02dc39cb28d11a89681d3748d0d85",
  "error": { "code": "policy_denied", "message": "exceeds autonomous refund authority" },
  "completedAt": "2026-10-20T05:29:18.553Z"
}
```

A denial is a **successful call that returns `denied`**, not a thrown error.
The agent asked, policy answered, and the answer was no — making that an
exception encourages callers to swallow it. The agent learns the reason and the
policy, which is what lets it escalate to a human instead of retrying something
it will never be allowed.

---

## Run the full stack

```bash
# Terminal 1 — the control API, with the worked example loaded
ARC_OPERATOR_TOKEN=dev-operator-token ARC_SEED_DEMO=true npm run api

# Terminal 2 — the console
ARC_OPERATOR_TOKEN=dev-operator-token \
ARC_OPERATOR_IDENTITY=you@example.com \
ARC_OPERATOR_ROLES=finance-manager \
npm run console
```

The API prints an agent key for `finance-agent`. Then:

```bash
KEY=arck_...   # from the API output

# allowed
curl -s localhost:8787/v1/actions -H "authorization: Bearer $KEY" \
  -d '{"tool":"stripe.refund","parameters":{"customer":"customer_123","amount":120}}'

# held for a human — returns 202 with an approvalId
curl -s localhost:8787/v1/actions -H "authorization: Bearer $KEY" \
  -d '{"tool":"stripe.refund","parameters":{"customer":"customer_123","amount":1800}}'

# denied
curl -s localhost:8787/v1/actions -H "authorization: Bearer $KEY" \
  -d '{"tool":"stripe.refund","parameters":{"customer":"customer_123","amount":4200}}'
```

Open <http://127.0.0.1:8788>. The console has ten sections, grouped by what an
operator is doing:

| | |
| --- | --- |
| **Operate** | **Overview** — what needs a human, in order of consequence · **Approvals** — the queue, and one request per card |
| **Inventory** | **Agents** — who is authorized, and their credentials and activity · **Tools** — what may be asked for, at what risk |
| **Govern** | **Policies** — the decision ladder of every policy · **Access** — which policies govern which agent-and-tool pair |
| **Record** | **Evidence** — one record per attempt, with its timeline and digests · **Audit** — the hash chain, and what verifying it does and does not prove |
| **Assure** | **Security** — chain, connector posture, on-demand MCP scan · **Reports** — an operational snapshot over a stated window |

Approve the held refund from the console and it executes.

To watch the whole path without a browser — an agent asking, policy deciding, a
human approving, the action executing, the evidence recorded and the chain
verified, each step asserted:

```bash
npm run demo:console
```

---

## Putting ARC Control in front of an MCP server

MCP is where enterprise agents are gaining the ability to act, and the protocol
carries no notion of authorization: a client that can reach a server can call
anything the server advertises. ARC Control in front turns that tool list from
a set of capabilities into a set of *requests*.

```bash
node examples/protected-mcp-server/run.js
```

The example stands up a real MCP server — poisoned tool description and all —
and walks the sequence an operator actually goes through:

**1. Scan before exposing anything.**

```
  [CRITICAL] MCP-SEC-001 Tool description attempts to override agent instructions (export_report)
      The description of "export_report" contains instruction-override language:
      "ignore all previous instructions". An agent reads this text as guidance, so a
      server can steer a client's agent through metadata alone.
      → Do not expose this tool.

  [HIGH] MCP-SEC-010 Tool publishes no input schema (run_query)
```

The attack is in the *metadata*, not the arguments — so no amount of argument
inspection catches it.

**2. Register only what passed**, with explicit parameter contracts. An action
naming an unregistered tool is refused before policy runs.

**3. Policy decides every call.**

**4. The server rewrites an approved description.** Nothing in MCP tells a
client this happened:

```
  Pinned         sha256:07f90cce…
  Observed       sha256:c5fcdf3a…
  Modified       search_docs
  CRITICAL       MCP-SEC-030 A reviewed tool changed after registration

  search_docs    ALLOW → failed
  error          manifest_drift: "search_docs" changed on vendor-docs after it was
                 reviewed; refusing to call it
```

In CI:

```bash
arc mcp scan --endpoint https://mcp.vendor.example.com     # non-zero on high/critical
arc mcp diff --pinned pinned.json --endpoint https://mcp.vendor.example.com
```

---

## What makes the record trustworthy

**Every action leaves evidence** — allowed, held, executed, failed and
**denied**. A control plane that only records its successes cannot answer the
question an incident review asks. If denials vanish, a sustained attack looks
exactly like a quiet week.

**Evidence verifies without trusting the operator.** Each record carries a
digest over its own contents, and the audit log is hash-chained. Both verify
from an export, with no server and no credentials:

```bash
arc evidence verify export.json
arc audit verify --data ./arc-data
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

**And the limits are stated, not hidden.** Hash chaining gives tamper
*evidence*, not tamper *proofing*, and there are two gaps. An attacker who
controls the storage can rewrite the whole chain and recompute every digest.
And walking the records cannot detect **truncation** at all — remove entries
from the end and what remains is a shorter chain in which every digest and link
is still correct, so `INTACT` from a bare export means the records present are
self-consistent, not that the log is complete.

Both close with an expected head that did not come from the log:

```bash
arc audit verify --file audit.jsonl --expect-head sha256:9f2c… --expect-records 18
```

The durable store also keeps a head marker beside the log, so truncating the
log alone is caught. When nothing is available to check the head against, the
CLI and the console say so instead of reporting a clean result. See
[EVIDENCE_MODEL.md](./docs/EVIDENCE_MODEL.md#tamper-evidence-not-tamper-proofing).

---

## Design commitments

**Strictest policy wins.** Every matching policy is evaluated and the harshest
effect decides. Adding a policy can therefore only tighten authorization, never
loosen it — so a new policy is always safe to roll out, and a permissive policy
cannot be used as an escape hatch.

**Fail closed, everywhere.** No matching policy means deny. A malformed
condition is recorded as not matching and can never allow. A numeric comparison
against a string is an error, not a coercion — a refund limit must never pass
because the amount arrived as `"10"`.

**An agent cannot read or change the policy governing it.** The API has two
credentials: an agent key may submit an action and nothing else; everything else
needs the operator token. An agent that could edit its own policy would not be
governed.

**One authorization, one effect.** An approval is consumed when used, so a grant
can never authorize a second execution — including when two callers race.
Irreversible actions are never retried automatically; a timeout in particular
may already have taken effect.

**The agent's story is not evidence.** `intent` is recorded for humans and is
deliberately unavailable to policy conditions. A policy that allowed a refund
because the agent said it was routine would be authorizing a sentence the agent
chose.

**Zero runtime dependencies.** Node's standard library only — a hand-written
router, argument parser and MCP client. A control plane is the component a
security team reads line by line before putting it in front of their systems,
and its supply chain is part of its threat model.

---

## Repository

```
apps/
  control-api/          the primary API — node:http, no framework
  control-console/      the enterprise console — server-rendered, no build step
packages/
  gateway/              the decision point every action passes through
  policy-engine/        allow / require-approval / deny, with a full trace
  agent-identity/       registry, credentials, principal resolution
  approvals/            human-in-the-loop lifecycle, single-use grants
  execution/            connector contract, tool registry, executor
  evidence/             self-contained, digest-sealed records
  audit/                hash-chained append-only log
  mcp-security/         tool-poisoning checks, pinning, drift detection
  store/                storage contracts; memory and append-only file
  schemas/              the object model, canonical JSON, redaction
  sdk-typescript/       client for the API
  cli/                  arc — linting, scanning, verification
connectors/
  mcp/                  front an MCP server through the gateway
  generic-http/         HTTP execution, host-allowlisted
  simulation/           deterministic connector for examples and evals
schemas/                JSON Schema for agent, tool, policy, action, evidence, audit
evals/                  control-plane guarantees asserted as properties
examples/               runnable: approval-required agent, protected MCP server
docs/                   architecture, trust, threat, policy, evidence, roadmap
infrastructure/         docker, kubernetes, terraform
```

---

## Development

```bash
npm install
npm run build          # tsc -b across the workspace
npm test               # 81 tests on node:test
npm run evals          # 52 control-plane properties
npm run verify         # build, test and evals
```

The evals are not unit tests. A unit test asks whether a function does what its
author intended; an eval asks whether the control plane still upholds a property
somebody is relying on — *a denied action never reaches the target system*,
*adding a policy can only tighten authorization*, *one authorization means one
effect*. Writing them found four real bugs — including one in the headline
audit guarantee — each recorded in the commit that fixed it.

```
ARC Control — control-plane evals

Identity is the first gate (authorization/identity)
  PASS an action with no credential never reaches the tool
  PASS every authentication failure reports the same thing
  PASS suspending an agent stops it before policy is consulted
  …

52/52 properties hold.
```

---

## Status

**2.0 — Control + Assurance.** The workflow above end to end, plus the
governance layer that evidences it. 356 tests, 66 asserted properties, a
14-step end-to-end demonstration.

| | |
|---|---|
| Shipped | Gateway, policy engine, approvals, evidence, hash-chained audit, MCP security, agent lifecycle, credential inventory, kill switches, rate limits, risk classification, policy history and simulation, nine ARC-AI controls, risk register, findings, coverage analysis, NIST AI RMF mappings, offline-verifiable evidence bundles, a fifteen-section console, 35 assurance routes, SDK and CLI |
| **Not** shipped | SSO and RBAC — 2.0 still uses a single operator token and takes identity from a header, so an approval proves the workflow ran and **not who ran it**; PostgreSQL and HA; OpenTelemetry and SIEM export; external anchoring as a scheduled job; penetration testing; a Python SDK |

Two limitations worth knowing before you evaluate anything else:

**Operator identity is not authenticated.** Anyone holding the operator token
can claim any identity. Put the console behind an identity-aware proxy. The
product says this on its own Settings page and in every evidence bundle.

**ARC-AI-006 does not pass by default.** The audit chain verifies internally,
but walking records cannot detect truncation, and ARC checking its own log
against its own copy of the head proves nothing to a reader who does not trust
ARC. Anchor the head outside ARC and it passes. This is deliberate.

[releases/2.0.md](./docs/releases/2.0.md) states the release boundary —
everything that shipped, and everything deferred with the reason.
[ROADMAP.md](./docs/ROADMAP.md) has the longer phasing.

---

## Documentation

| | |
|---|---|
| [ARCHITECTURE.md](./docs/ARCHITECTURE.md) | The components, the layering, and why each exists |
| [TRUST_MODEL.md](./docs/TRUST_MODEL.md) | Who trusts whom, and what each party cannot do |
| [THREAT_MODEL.md](./docs/THREAT_MODEL.md) | 15 threats, the defence for each, and what is not defended |
| [POLICY_MODEL.md](./docs/POLICY_MODEL.md) | The policy language and why it is shaped this way |
| [EVIDENCE_MODEL.md](./docs/EVIDENCE_MODEL.md) | What a record contains and how to verify one |
| [releases/2.0.md](./docs/releases/2.0.md) | **The 2.0 release boundary**: what shipped, what is deferred and why |
| [CONTROL_CATALOGUE.md](./docs/CONTROL_CATALOGUE.md) | The nine ARC-AI controls, and what a pass does not tell you |
| [ASSURANCE_MODEL.md](./docs/ASSURANCE_MODEL.md) | How assurance works, and the rules that keep it honest |
| [OPERATIONS.md](./docs/OPERATIONS.md) | Deployment, health, backup and restore, audit anchoring, five runbooks |
| [SECURITY_QUESTIONNAIRE.md](./docs/SECURITY_QUESTIONNAIRE.md) | Buyer technical evaluation, answered against what the code does today |
| [COMMERCIAL_READINESS.md](./docs/COMMERCIAL_READINESS.md) | Ideal customer, differentiation, design partners, pricing hypothesis |
| [ROADMAP.md](./docs/ROADMAP.md) | The longer phasing |
| [PORTFOLIO.md](./docs/PORTFOLIO.md) | Every repository in the ARC Control division, and how each relates to this one |
| [SECURITY.md](./SECURITY.md) | Reporting a vulnerability |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | How to work in this repository |

---

## Scope

A tool earns its way into this repository only by contributing to:

> identity → authorization → policy → execution → evidence → security →
> observability → **assurance**

Anything else belongs elsewhere. The failure mode for a product like this is
not building the wrong thing — it is becoming a collection of unrelated AI
utilities that share a monorepo, at which point it stops being a control plane
and starts being a toolbox.

---

## License

Apache 2.0 — see [LICENSE](./LICENSE).

---

ARC Control is built by [ARC Transformation Group](https://arctransformationgroup.com).

**ARC Control** — we make AI agents trustworthy enough to act.
**ARC Labs** — we explore what humans can do with emerging technology.
