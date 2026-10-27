# ADR-0002: Five portfolio capabilities, rebuilt natively on the decision path

**Status:** Accepted on 2026-10-27, for build in the order below.
**Date:** 2026-10-27
**Scope:** `arc-control` only. The portfolio products named here stay separate products. Nothing is imported from their repositories.

## Context

ARC Transformation Group runs several free tools next to ARC Control. Each one reports on part of the risk ARC Control exists to govern:

| Product | What it does on its own | What ARC Control lacked |
| --- | --- | --- |
| TokenLoop | Watches AI spend per developer, flags runaways, cuts off keys | Any notion of cost. An agent could run up an unbounded bill under policies that were correct about every action. |
| MCP Conformance Scanner | Grades an MCP server's conformance and security | A threshold. `scanManifest` reported findings, and registration went ahead whatever they said. |
| Prompt Reviewer | Grades a system prompt for ambiguity, missing guardrails and injection exposure | Any look at the instructions an agent runs under before it is cleared to act. |
| AI Workflow Templates | Ready-made approval and review workflows | Starting policy. Every deployment wrote its first policies by hand. |
| Connectivity Scanner | Checks an endpoint's TLS, redirects and exposure | Any check on a `generic-http` tool's endpoint when it is registered. The host allowlist checked the name, not what answered. |

A report you can ignore is advice. In ARC Control each of these becomes a **control**: a budget enforces, a grade gates registration or activation, a pack is published policy.

## Decision

Build the five capabilities natively in this repository, in this order, each through the delivery harness: plan, failing tests first, security review, Meridian validation, release note.

1. **Spend control.** Budgets that enforce, and spend as a policy input.
2. **MCP gate at registration.** A minimum grade before an MCP server's tools can be registered.
3. **Prompt review on activation.** A minimum prompt grade before an agent leaves `draft`.
4. **Policy packs.** Starting policy as validated, versioned documents.
5. **Endpoint vetting.** A `generic-http` tool's endpoint is checked before it is registered.

### Rules every capability follows

1. **Tightening only.** A budget, a grade or an endpoint check can refuse, hold or flag something. None can make an action, a registration or an activation succeed that would otherwise fail. That is invariant 5 (strictest wins) applied beyond policy documents.
2. **Off until configured.** An upgrade does not start refusing an existing deployment's traffic. The same rule `RateLimiter` follows. A deployment opts in to each one.
3. **Fail closed once configured.** If a configured budget's state can't be read, the decision is DENY. If a configured gate can't compute a grade, the gate refuses. A probe that can't reach an endpoint fails the vetting.
4. **No runtime dependencies on the decision path.** Every check is reimplemented in TypeScript with Node built-ins only. The portfolio code is a reference, not a dependency.
5. **Everything leaves a record.** Budget refusals are decisions with evidence. Gate refusals and spend incidents go into the audit chain.

### Spend control: how a budget joins the decision

The tempting design is to synthesize a policy per budget. It is wrong. A synthesized policy that applies to an agent needs a fallback. With an `ALLOW` fallback it would authorize actions that the default `DENY` refuses today, which is a loosening. With a `DENY` fallback it would refuse everything the agent does.

So budgets are evaluated **beside** policy, not as policy:

- The policy engine decides as it always has.
- `tighten(decision, evaluations)` in `packages/policy-engine/src/tighten.ts` then folds in one evaluation per budget. It replaces the decision's effect only when a budget is **strictly** stricter, and it never changes a stricter decision. Both the budget evaluations and their trace entries are kept in the decision, so the evidence shows the budgets were checked.
- The same fold runs again at release (`resume`), so a held action whose budget ran out while it waited is re-decided against the budget as it is now.

Spend is also exposed to policy as `$.agent.spend.dayUsd`, `$.agent.spend.monthUsd` and `$.agent.spend.maxBudgetPercent`, so a policy can hold actions at, say, 80% of budget.

**Self-reported spend is unverified, and still counts.** An agent or operator can report spend. Such records are marked `verified: false`. A provider adapter (Anthropic first, behind `SpendProvider`) records `verified: true`. Unverified spend counts toward budgets, because over-reporting can only tighten. Negative amounts are refused, because a negative report would loosen.

**This is detect-and-cut, not pre-pricing.** ARC can't know an action's cost before it runs. A budget refuses the next action once spend has reached the limit, so the action that crosses the limit is not stopped. Provider data is only as fresh as the provider makes it: Anthropic's cost report is bucketed by day.

### Gates at registration and activation

- **MCP.** `gradeScan(report)` maps a scan to a letter grade. `McpRegistrationGate` refuses tools from a server below the configured minimum, audits the refusal, and records the grade on each tool that does register.
- **Prompts.** A new package, `@arc-control/prompt-review`, holds static checks with no dependencies. The prompt's grade and digest go on the agent's governance record and reach policy as `$.agent.promptGrade`. Once a minimum is configured, activation refuses an agent whose reviewed prompt is missing or graded below it.
- **Endpoints.** `vetEndpoint` checks that the endpoint uses HTTPS (except on loopback), that it does not resolve to a private or metadata address, and that it does not redirect off host. It also checks that the TLS certificate is valid and not close to expiry. Resolution and probing are injected, so the checks are tested without the network.

### Policy packs

A pack is a set of policies in `policy-packs/<id>/pack.json`, with expected-outcome scenarios in the client-profile format. CI loads each pack into a real gateway and runs its scenarios. `tools/policy-packs/apply.mjs` publishes a pack through the audited administration API. A pack is a starting point that an operator publishes and owns. It is never applied implicitly.

## Consequences

- `Decision.evaluations` and `trace` can now carry entries whose `policyId` starts with `budget:`. They are not policies, and nothing looks them up as one.
- Two new collections, `spend` and `budgets`. Older data directories open without migration, with both collections empty.
- New audit event types: `budget.created`, `budget.updated`, `spend.reported`, `spend.ingested`, `spend.incident`, `mcp.registration_refused`, `agent.activation_refused` and `tool.registration_refused`.

## What this does not establish

- That a budget bounds spend at the limit. It bounds actions **after** the limit is reached, as fresh as the spend data is.
- That a passing MCP or prompt grade means safe. Static checks catch known patterns. The grade raises the floor; it does not certify.
- That an endpoint that passed vetting stays as it was. Vetting is a point-in-time check at registration. The host allowlist and the redirect refusal at execution remain the controls that hold on every call.
- Anything distributed. Every guarantee here is per process, like the rest of ARC Control.
