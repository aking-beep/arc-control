---
name: deliver
description: The end-to-end delivery pipeline for any change to ARC Control — a feature, a security finding, a client request or a doc fix. Routes each stage to the right harness agent and defines the gate between stages. Use at the start of any non-trivial task in this repository.
---

# Deliver a change

Subagents cannot start other subagents, so the main session runs this
pipeline and delegates each stage. Every stage has an exit gate; do not start
the next stage until the gate is met.

| # | Stage | Agent | Exit gate |
| --- | --- | --- | --- |
| 0 | Intake | main session | The request restated in one paragraph: what, for whom, which guarantee. Ambiguity resolved with the user, not assumed. |
| 1 | Baseline | `arc-verifier` | Gates run on the unmodified branch (`verify` skill). Pre-existing failures recorded, so they are not attributed to the change. |
| 2 | Plan | `arc-architect` | Written plan: chain stage, owning agents, files, invariants and threats touched, tests and evals to add. |
| 3 | Reproduce | owning engineer | For a defect: a test or eval that fails on the current code for the stated reason. For a feature: the acceptance tests, failing. |
| 4 | Implement | owning engineer(s) | The stage-3 tests pass; no existing test or eval was weakened. |
| 5 | Review | `arc-security-reviewer` | Required for anything in `packages/gateway`, `approvals`, `agent-identity`, `operator-identity`, `policy-engine`, `execution`, `evidence`, `audit`, `store` or `connectors/`. Every confirmed finding fixed (back to stage 4) or recorded with the user's decision. |
| 6 | Verify | `arc-verifier` | All gates green. Before/after numbers recorded. |
| 7 | Validate | `arc-meridian-validator` | For enforcement changes: Meridian integration, Phase 2 and stress results, with sandbox and ARC revisions. Expected outcomes untouched. |
| 8 | Document | `arc-docs-steward` | Release note, threat/trust model, runbooks and schemas match the code. Limitations stated. |
| 9 | Ship | main session | Branch pushed; PR opened **only when the user asked for one**; then the `steward` skill. Never merge. |

## Routing by area

| Area touched | Owning agent |
| --- | --- |
| submit / resume, idempotency, approvals, executor | `arc-gateway-engineer` |
| policy model, conditions, matching, validation | `arc-policy-engineer` |
| agent or operator identity, credentials, lifecycle | `arc-identity-engineer` |
| evidence, audit chain, bundles, stores | `arc-evidence-engineer` |
| connectors, MCP security | `arc-connector-engineer` |
| assurance controls and reporting | `arc-assurance-analyst` |
| a client's configuration | `arc-client-onboarder` |

A change spanning several areas gets one owner per area and one plan.

## Before delegating

Write each brief so the agent can work from it alone: the goal, the files,
what has been ruled out, the test that must fail first, and what "done"
means. The agent sees only the brief and `CLAUDE.md`.

## Small changes

A typo, a comment or a doc-only change can skip stages 2, 3, 5 and 7. Nothing
on the decision path is a small change.
