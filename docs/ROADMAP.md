# Roadmap

ARC Control is the trust and control layer between enterprise AI agents and the
systems they act upon. The initial wedge is authorization, auditable execution,
and MCP/A2A security. Observability, governance and broader runtime
functionality expand from there.

Each phase below is scoped to be useful on its own. A phase ships when its
guarantees hold and are asserted in `evals/`, not when its surface area looks
complete.

---

## The scope rule

A tool earns its way into this repository only by contributing to:

> identity → authorization → policy → execution → evidence → security →
> observability → assurance

Anything that does not is somebody else's repository. This rule exists because
the failure mode for a product like this is not building the wrong thing — it
is becoming a collection of unrelated AI utilities that happen to share a
monorepo, at which point it stops being a control plane and starts being a
toolbox.

---

## 2.0 — Control + Assurance ✅ shipped

The release that renumbered the project. 1.0's capabilities are the baseline;
2.0 adds the governance layer that evidences them, and answers the question an
audit actually asks: *can you prove the authorization controls are operating?*

[releases/2.0.md](./releases/2.0.md) is the authoritative boundary — what
shipped, and what is deferred with the reason. In summary:

**Shipped.** Agent lifecycle and governance records, credential inventory and
rotation, policy coverage analysis, policy simulation against recorded traffic,
policy version history, action risk classification, tool and connector kill
switches, rate limiting, the nine ARC-AI controls with deterministic
evaluators, assessment runs, a findings register, a risk register with
reviewed-only residual ratings, coverage analysis, NIST AI RMF mappings,
offline-verifiable evidence bundles, five new console sections, 35 assurance
routes, SDK methods and four CLI commands.

**Deferred, with reasons.** SSO and RBAC (a real identity integration, not a
flag — and roles without authenticated identities are decoration);
PostgreSQL and HA (the storage contract is implemented twice already, but a
third needs migration tooling and a concurrency suite of its own, and HA on a
single-node store would be a false claim); OpenTelemetry and SIEM export
(small once the trace model is settled, and it should be settled by a design
partner's stack rather than guessed); external anchoring as a scheduled job
(the model is implemented, the job needs a target the customer chooses);
penetration testing (a service, not a commit); ISO 42001 and EU AI Act
mappings (publishing an unreviewed mapping for a framework with legal
consequences invites someone to rely on it).

**The next release is the enterprise identity release.** SSO, RBAC and
separation of duties across the governance workflow, in that order, because
each depends on the one before it. Everything else in the P1 list is smaller
and can follow a design partner's priorities.

---

## v0.1 — Control ✅ shipped

One workflow, end to end:

```
agent → gateway → identify → inspect → evaluate policy
      → allow | hold for a human | deny → execute → evidence → audit → console
```

- **Gateway** — the single decision point every action passes through
- **Agent identity** — registry, API-key credentials, principal resolution,
  per-agent suspension
- **Policy engine** — closed-expression evaluation, strictest-wins layering,
  fail-closed, full decision trace
- **Approvals** — human-in-the-loop with authority, finality, separation of
  duties and single-use grants
- **Execution** — connector contract, tool registry, parameter validation,
  effect-aware retry
- **Evidence** — self-contained, digest-sealed records for every outcome
- **Audit** — hash-chained append-only log with independent verification
- **MCP security** — tool-poisoning checks, manifest pinning, drift detection
- **Connectors** — MCP, generic HTTP (host-allowlisted), simulation
- **Surfaces** — control API, control console, TypeScript SDK, `arc` CLI

Verification: 81 tests, 52 eval properties, zero runtime dependencies.

---

## v0.2 — Security

The theme: make the risk of an action a first-class input, and make stopping one
immediate.

**Risk engine.** Tool and action risk classification that policy can select on
beyond the operator-declared `riskTier` — derived from the tool's effect, its
blast radius, the parameters of the specific call, and the agent's recent
behaviour. The point is policy that reads
`{"gte": ["$.risk.score", 70]}` rather than enumerating tools.

**Kill switch.** Suspend an agent, a tool, a connector or a whole class of
action, taking effect on in-flight evaluation rather than at the next restart.
v0.1 has the per-agent half of this: an agent's status is checked at
authentication, before policy runs. What is missing is tool- and
connector-level suspension, and propagation across a clustered deployment.

**Credential and permission analysis.** What a connector's credential can
actually do, compared against what the registered tools need. The common
finding will be a connector holding far more authority than any tool uses,
which is the blast radius nobody measured.

**Prompt and tool injection defences.** Extending `packages/mcp-security`
beyond static description checks: content inspection of connector *responses*
for instruction-shaped text, and a documented pattern for marking
agent-reachable text as data. Stated carefully — this reduces a class of
attack, it does not close it, and policy remains the control.

**Scanner.** `packages/scanner` — static and configuration scanning of agent
deployments: overly broad tool grants, missing policy coverage for a registered
tool, tools registered with no parameter contract, connectors without host
allowlists. Intended for CI.

---

## v0.3 — Observability

The theme: answer "what are our agents actually doing?" from the record that
already exists.

Evidence already carries execution duration and the audit log is ordered and
append-only, so this phase is largely a query and presentation layer over data
ARC Control is already capturing — not new instrumentation.

- **Agent traces** — an agent run reconstructed from `correlationId`, including
  the decisions, not just the calls
- **Execution graphs** — which agents call which tools against which systems,
  and where the approvals bottleneck
- **Latency and failure analysis** — per tool, per connector, per policy, with
  the control-plane overhead reported separately from the target system's
- **Cost attribution** — per agent, per team, per tool
- **Policy violation analytics** — denial rates by policy and rule, which is
  the signal that a policy is either mis-calibrated or catching something real
- **Alerting and SIEM-shaped export** — denial spikes, approval timeouts,
  manifest drift, chain verification failures

---

## v0.4 — Agent-to-agent

The theme: an agent acting on behalf of another agent, without losing the chain
of accountability.

`AgentPrincipal` already carries an optional `delegatedFrom` chain that nothing
populates. Until this phase, an agent calling another agent is outside the
model: it appears as two unrelated principals and the connection between them
does not appear in evidence.

- **Delegation** — agent A invoking agent B with a derived, *narrower*
  authority, where narrowing is enforced rather than requested
- **Delegation chains in evidence** — the full chain recorded, so an action
  taken four hops from the originating request is still attributable to it
- **Agent-to-agent permissions** — which agents may invoke which, as policy
- **Trust boundaries** — explicit boundaries between agent groups, so crossing
  one is a decision rather than a side effect
- **A2A protocol security** — `packages/a2a-security`, the equivalent of the
  MCP work for agent-to-agent protocols as they stabilize

The hard problem here is not plumbing. It is that delegation is where
authorization models usually leak: a chain that can widen authority at any hop
is not a chain, and the enforcement has to be on the derivation, not on the
caller's good intentions.

---

## v0.5 — Enterprise governance

The theme: everything v0.1 deferred in order to ship one workflow honestly.

**RBAC and SSO.** Replacing the v0.1 operator model — one shared token,
identity from a header — with real individual accountability. This is the
largest honesty gap in v0.1 and is documented as such in
[TRUST_MODEL.md](./TRUST_MODEL.md). `apps/control-api/src/operator.ts` is the
seam.

**Organizations and environments.** Every object already carries an
`organizationId`; v0.1 does not enforce boundaries on it, so one deployment
serves one organization. This phase makes multi-tenancy real.

**Policy templates and a policy catalogue.** Starting policies for common
domains — finance, infrastructure, customer data, code — so an organization's
first policy is an edit rather than a blank page.

**Compliance export.** Evidence bundles mapped to the frameworks people are
actually audited against, with the mapping stated rather than implied.

**Retention and defensible deletion.** v0.1 retains everything forever.
Deletion must leave the chain verifiable, which means a tombstone rather than a
removed record.

**External chain anchoring.** The one change that turns tamper *evidence* into
tamper *proofing*: periodically publishing the head digest somewhere ARC
Control does not control. `arc audit verify` already prints the head digest so
this can be done by hand today.

**Clustered storage.** A Postgres-backed `ControlStore`. The interface exists
now specifically so this change does not reach the gateway.

**SIEM integration.** Splunk, Sentinel, Chronicle, generic syslog.

---

## v1.0 — ARC Control Platform

At this point ARC Control is a control plane for enterprise agentic systems:
every agent action authorized against readable policy, held for a human when it
should be, executed through a credential the agent never holds, and recorded in
a chain that an auditor can verify without trusting the operator.

---

## Deliberately not planned

- **Agent frameworks or orchestration.** ARC Control governs agents; it does not
  build them.
- **Model hosting, routing or evaluation.** Different product.
- **A general-purpose policy engine.** The condition language stays small and
  readable on purpose. If a policy needs a Turing-complete language, the policy
  is wrong.
- **An agent marketplace.**
- **Anything from the rest of the ARC portfolio.** AI Fit, MIRROSU, CLIMB UP,
  Steady Move, ARC Travel and Culture Context belong in ARC Labs. The scope
  rule at the top of this document is what keeps that true.
