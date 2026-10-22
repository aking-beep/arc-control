# ADR-0001: One canonical policy engine for agent authorization

**Status:** Accepted (Option A) on 2026-10-21 — the owner's consolidation plan names `arc-control` the one canonical enterprise platform. The open questions below remain open.
**Date:** 2026-10-21
**Scope:** `arc-control` (this repo), `ark` (`@ark/core` governance kernel, `@ark/guard`, `@ark/db` receipts, ARK Control app), `ark-ai-agent-platform` (`src/permissions`, `src/approvals`, `src/audit.py`).

## Context

Three codebases answer the same question — *may this agent perform this action, now?* — with three engines, three record formats and three approval stories.

1. **ARC Control (this repo).** A network gateway. Every action enters `Gateway.submit` (`packages/gateway/src/gateway.ts`): authenticate the agent, resolve and validate the tool, evaluate policy, allow / hold / deny, execute through a connector, write evidence, append to a hash-chained audit log.
2. **ARK guard.** An in-process wrapper, `guardTool` (`ark/packages/guard/src/guard.ts`), around one consequential tool. It calls a pure kernel, `decideAction` (`ark/packages/core/src/governance/action.ts`), and writes one *action receipt* per attempt (`ark/packages/core/src/governance/receipt.ts`, stored by `ark/packages/db/src/action-receipts.ts`). ARK ADR-0009 makes this the wedge and refuses to put a network service in the request path.
3. **ark-ai-agent-platform.** A Python, single-agent runtime. `PermissionEngine.authorize` (`src/permissions/engine.py`) walks a fixed ten-rung ladder over `config/tools.yaml`; `ApprovalService` (`src/approvals/service.py`) queues and executes writes; `emit_audit` (`src/audit.py`) logs structured events.

ARK also has two *other* things called policy that are not action authorization and are out of scope here: manifest posture (`ark/packages/core/src/governance/policy.ts`) and the model-call gate (`enforce.ts`, where `unknown` passes and an empty list allows). Neither should be confused with the engine this ADR selects.

The two TypeScript designs disagree on a principle, not only on code. ARC Control's `docs/ARCHITECTURE.md` says that without a gateway there is "only a library some agents remembered to call". ARK ADR-0009 §2 says the guard runs in the customer's process so that "ARK being down cannot authorize anything" and no tool call waits on a round trip. Picking one engine means deciding how both statements can be true at once.

## Comparison

All claims below were read from code. Test counts are from runs on 2026-10-21.

| Concern | ARC Control | ARK guard + kernel | ark-ai-agent-platform |
|---|---|---|---|
| Deployment | Network gateway (`apps/control-api`, `/v1/actions`); `Gateway` class is also usable in-process | In-process library at one tool boundary; no service in the path (ADR-0009 §2) | In-process Python registry |
| Policy representation | JSON document: `match` selectors (agents, roles, labels, tools with `*` prefix, systems, environments, effects) + ordered `rules` + `fallback` (`packages/schemas/src/policy.ts`, `schemas/policy.schema.json`) | zod `ActionPolicy`: `orgId`+`tool`+`action`+`currency`, ordered rules, `defaultEffect: 'deny'` literal, `decisionTtlMs` | YAML per tool: `risk`, `permission`, `approval_required`, `enabled` (`config/tools.yaml`) |
| Condition language | Closed expression language, 17 operators incl. `and/or/not`, `in`, `matches` (bounded regex), `$.`-references into agent/tool/action/context (`packages/policy-engine/src/condition.ts`) | Amount (minor units, `gt/gte/lt/lte`) and currency only | None. Arguments are deliberately not read (`AuthorizationRequest` docstring) |
| Rule ordering | First matching rule within a policy; across policies, strictest effect wins, ties by policy id (`engine.ts` `selectStrictest`) | First matching rule within a policy; governing policies that disagree → `deny policy_conflict` | Fixed ladder; first rung decides |
| Fail-closed | No match → `DENY` (configurable to `ALLOW` for monitor mode). Erroring condition → rule treated as not matching | Never throws; any unreadable input → `unknown`; invalid policy claiming the action → `unknown policy_invalid`; no fallback allow exists | Undeclared, malformed, approval-without-gate → deny |
| Decision values | `ALLOW`, `REQUIRE_APPROVAL`, `DENY` + prose `reason`, full rule `trace` | `allow`, `deny`, `require_approval`, `unknown` + closed `reasonCode` enum | `allow`, `require_approval`, `deny` + closed `ReasonCode` enum |
| Decision identity | Random id (`newId`), trace digested into evidence | Deterministic content hash of request digest, policy digests, expiry (not an authenticator, stated in module doc) | None |
| Decision lifetime | None. An approved request never expires (`#expireIfDue` only touches `pending`) | `expiresAt = now + min(decisionTtlMs)`; re-checked before and after the claim | Pending requests expire after 24h |
| Approval model | `ApprovalEngine` (`packages/approvals/src/engine.ts`): approver selectors (`role:`, `user:`, `owner`, `*`), `minApprovals` quorum, one vote per approver, single reject resolves, separation of duties, expiry, `consume()` under lock = single use | None. `require_approval` is terminal (`pending_approval`); `apps/control/src/lib/receipts.ts` says "there is no approval service" | State machine (`src/approvals/models.py`); approver is any non-empty string; `execute` re-enters the permission engine |
| Sender-forged approval | Not addressed; parameters are validated against tool schema | Approval-like keys detected at any depth, stripped at top level, flagged on the receipt | Not addressed |
| Idempotency | Optional key; `#findReplay` is find-then-act and only finds a replay once evidence exists, so two concurrent submits can both execute | Required key; atomic claim via `INSERT ... ON CONFLICT DO NOTHING` on a partial unique index (`ark/packages/db/src/sql.ts`); digest-checked replay | None; `execute` dispatches before marking `EXECUTED` |
| Execution status | `ExecutionAttempt` `succeeded`/`failed`, written after the connector returns | `not_attempted` → `attempted` (written *before* the handler) → `completed`/`failed`/`outcome_unknown`; never retried | `EXECUTED`/`FAILED` after dispatch |
| Record format | `EvidenceRecord` v1 (`packages/schemas/src/evidence.ts`): agent, tool, redacted params + digest, decision + `traceDigest`, approval votes, execution, `integrityDigest` over all fields | `ActionReceipt`: ids, decision, reason code, request digest, execution status, key hash, amount/currency. No arguments, no PII by contract | Flat `AuditEvent` dict to log/CloudWatch sink |
| Tamper evidence | Audit log is a SHA-256 hash chain over canonical JSON, with sequence-gap and expected-head (truncation) checks (`packages/audit/src/log.ts`, `packages/schemas/src/audit.ts`); evidence self-verifies (`verifyEvidence`) | None. Receipts are mutable rows (`finish` updates status) | None |
| Agent identity | Registered agents, `arck_<ref>_<secret>` keys, salted SHA-256, constant-time verify, expiry, revocation, suspension (`packages/agent-identity/src/credentials.ts`, `registry.ts`) | Trusts the host's `resolveContext()` for `orgId`/`agentId`/`principal`; no credential of its own | Operator identity passed as a string |
| Delegating user | Not modelled | `principal` (opaque user id the agent acts for) | `requested_by` (audit only) |
| Tenancy | `organizationId` recorded but not enforced; one deployment = one org (`docs/ROADMAP.md`) | Org-scoped everywhere: policies selected by `orgId`, every store method org-scoped | Single tenant |
| Storage | `MemoryStore`, `FileStore` (NDJSON, append-only audit file) (`packages/store`) | In-memory store; libSQL/SQLite in `@ark/db` | SQLite approvals store |
| Hardening | Regex input cap, nesting depth cap, typed comparisons | Input snapshotting (own data props only, no getters/Proxies), frozen normalized request executed verbatim, timeouts on every store/policy/handler call, policy version pin | — |
| Protocol coverage | MCP connector + MCP manifest scanner/pinning (`packages/mcp-security`, `connectors/mcp`) | Evidence normalisers for MCP, A2A, AG-UI, A2UI, UCP, AP2 (`ark/packages/protocols`) — observation only, not enforcement | GitHub tools only |
| Dependencies | None at runtime (Node stdlib) | `zod`, `@ark/core`, `@ark/sdk` | pydantic, PyYAML |
| Tests | 91 unit tests pass (`npm test`); 52/52 eval properties hold (`evals/run.js`) | `@ark/guard` 68 pass; `@ark/core` 218 pass (49 in `action.test.ts`); `@ark/db` 111 pass (13 receipts) | 34 tests in permissions/approvals/audit; not run (pytest not installed in this environment) |

### A defect found while comparing

`docs/POLICY_MODEL.md` ("Fail closed") says an erroring condition makes "the policy fall through to its fallback". The engine instead `continue`s to the **next rule** (`packages/policy-engine/src/engine.ts`, `#evaluatePolicy`). Probe: a policy `[deny-big: gt($.action.parameters.amount, 1000) → DENY, allow-rest: always → ALLOW]` evaluated with `amount: "50000"` returns `ALLOW` via `allow-rest`, with the type error recorded in the trace. Tool-schema validation in the gateway usually rejects the string first, which is why no test catches it, but the engine on its own does not do what the document says. This matters more under Option A, because an embedded mode may not have the same tool-schema validation in front of it. It should be fixed (an erroring rule ends evaluation of that policy with the strictest of the rule's effect and the fallback, or with `DENY`) before either engine is declared canonical.

## Options

### A. ARC Control's engine is canonical; the ARK guard becomes its in-process deployment mode

One policy document format (`policy.schema.json`), one evaluator (`@arc-control/policy-engine`), one evidence schema, and two ways to deploy them:

- **Gateway mode** (today): the agent holds an ARC credential; the tool's real credential lives with the connector. Enforcement is unavoidable.
- **Embedded mode** (new, `@arc-control/guard`): the ARK guard's execution boundary — trusted context, sender-approval stripping, input snapshotting, required idempotency key with an atomic claim, `attempted`/`outcome_unknown` statuses, timeouts — wrapped around `PolicyEngine.evaluate` instead of `decideAction`. Evidence is written locally and shipped to the control plane asynchronously. No network call sits in the request path, so ADR-0009 §2 holds.

The policy engine is already pure, synchronous and dependency-free, so embedding it costs nothing at runtime. What embedded mode gives up is stated plainly in its evidence: the agent can still hold the tool's credential and bypass the guard, so the guarantee is "every *guarded* call is decided and recorded", not "every call passes through".

### B. The ARK kernel and guard are canonical

Keep `decideAction` and receipts; add an approval service, hash-chained audit, agent credentials and a richer condition language to ARK.

This throws away the more complete half. The kernel's policy language is amount and currency on one `tool.action`; making it general means rebuilding `condition.ts`, `match.ts`, the approval engine, the audit chain and the credential registry — all of which already exist, are tested, and have evals here. ARK's strongest work is at the execution boundary, and that work does not depend on which evaluator sits behind it.

### C. Keep both (and the Python engine)

Rejected. Three engines means three meanings of "approved", two of which (`ark` guard: none; Python: any non-empty string) are weaker than the third. Policies would be written twice and drift; an auditor would be shown different record formats depending on which product the customer bought; and every hardening fix — the ARK atomic claim, the ARC hash chain — would have to be made three times. The owner's question exists because this cost is already being paid.

## Recommendation

**Option A.** Reasoning:

1. **The policy model is the asset an auditor reads.** ARC Control's document format, rule trace, strictest-wins combination and closed operator set are the most expressive of the three, and the only one that can say "refunds over 500 need a finance manager who is not the agent's owner".
2. **Approvals only exist here.** Quorum, named authority, separation of duties, expiry and single-use consumption are implemented and tested in `packages/approvals`. ARK has none; Python's does not check who the approver is.
3. **Tamper evidence only exists here.** The audit hash chain with truncation detection and self-verifying evidence have no counterpart in either other repo.
4. **ARK's best ideas port as features, not as an engine.** The atomic idempotency claim, execution status written before the side effect, decision TTL, forged-approval stripping, input snapshotting and `unknown` as a distinct outcome are each a fix to a gap in ARC Control (see the table). They improve the gateway as much as the embedded mode.
5. **The deployment disagreement dissolves.** Both modes evaluate the same document with the same code. ADR-0009's refusal and ARCHITECTURE.md's warning describe two modes with different guarantees, which the evidence record can name.

## Migration plan

Ordered so each step is shippable and nothing is deleted before its replacement runs.

1. ✅ **Done 2026-10-21.** **Fix the fall-through defect** above, and correct `POLICY_MODEL.md` to match. Add an eval: an erroring DENY rule followed by an `always` ALLOW rule must not allow.
2. **Close the ARC Control gaps ARK already solved**, in the gateway, with tests and evals:
   - atomic idempotency claim (unique `(agentId, tool, idempotencyKey)` reservation taken *before* execution; `FileStore` under its mutex, a SQL store via conditional insert);
   - `ExecutionAttempt.status` gains `attempted` (written before the connector call) and `outcome_unknown` (connector threw or timed out; never retried);
   - approved requests get an execution deadline; `resume()` re-checks agent suspension and re-evaluates policy, refusing if the effect is now stricter (the Python `execute` already re-enters its engine — keep that property);
   - detect approval-like keys in parameters and record `senderReportedApproval` on the evidence.
3. **Extend the schemas for what ARK models and ARC does not**, as optional fields so evidence v1 records still verify: `decision.reasonCode` (closed enum, union of ARK `ActionReasonCode`, `GuardReasonCode` and Python `ReasonCode`), `decision.contentDigest` (ARK's deterministic decision id, kept alongside the random id), `decision.expiresAt`, `request.principal` (delegating user), `request.resource {type,id}`, `request.idempotencyKeyHash`, `deployment: 'gateway' | 'embedded'`. Bump `EvidenceRecord.schemaVersion` to 2.
4. **Map receipts to evidence.** Write `receiptToEvidence()` and a one-off importer for existing `action_receipts` rows:

   | `ActionReceipt` | `EvidenceRecord` v2 |
   |---|---|
   | `orgId` | `organizationId` |
   | `id` (kernel decision id) | `decision.contentDigest`; new `decision.id` minted |
   | `traceId` | `request.correlationId` |
   | `agentId`, `principal` | `agent.id`, `request.principal` |
   | `tool` + `action` | `tool.name` = `${tool}.${action}` |
   | `resourceType`, `resourceId`, `amountMinor`, `currency` | `request.resource`, `request.parameters` |
   | `policyId`, `policyVersion` | `decision.policyId`, `decision.policyVersion` |
   | `decision` (`unknown` included) | `decision.effect` (`unknown` → `DENY`) + `decision.reasonCode` (original preserved) |
   | `reasonCode` | `decision.reasonCode` |
   | `requestDigest` | `request.parametersDigest` (preimage differs; mark `digestScheme: 'ark-kernel-v1'`) |
   | `executionStatus` | `outcome` + `execution.status` |
   | `idempotencyKeyHash`, `senderReportedApproval` | same-named v2 fields |
   | `createdAt`/`updatedAt` (epoch ms) | ISO-8601 `createdAt`, `execution.finishedAt` |

   Imported records are appended to the audit chain as `evidence.recorded` with `source: 'ark-import'`; they gain integrity from the import onward, not retroactively, and the import says so.
5. **Map policies.** `ActionPolicy` → `Policy`: `match.tools: ['<tool>.<action>']`, each rule's `amountMinor` bound → `gt/gte/lt/lte` on `$.action.parameters.amountMinor`, `currency` → `eq`, `defaultEffect` → `fallback: DENY`. Python `tools.yaml` → one policy per tool: `prohibited` → `DENY`, `approval_required` → `REQUIRE_APPROVAL`, otherwise `ALLOW`, with `match.effects` derived from `permission`. Add golden tests: every existing ARK kernel test case and Python permission test case evaluated through both engines must agree, before cut-over.
6. **Ship `@arc-control/guard` (embedded mode).** Port `guardTool`'s boundary from `ark/packages/guard/src/guard.ts` and its hardening tests (`guard-hardening.test.ts`), replacing `decideAction` with `PolicyEngine.evaluate`. Keep ARK's `ActionReceiptStore.claim` contract. Evidence is written to a local store and forwarded to `/v1/evidence` (new ingest route) with at-least-once delivery; the control plane appends it to its chain on receipt.
7. **Org scoping.** Add `organizationId` to `Policy` and `PolicyInput`, and filter by it in the gateway. ARK is multi-tenant today; without this step ARK cannot cut over. (This is the multi-tenancy item in `docs/ROADMAP.md`, pulled forward.)
8. **Protocol adapters.** ARK's `@ark/protocols` normalisers (MCP, A2A, AG-UI, A2UI, UCP, AP2) stay observation-only, per ARK ADR-0007. They move under ARC as `@arc-control/protocols` feeding evidence, not decisions. Enforcement over a protocol happens only through a connector (`connectors/mcp`) or the embedded guard.
9. **Cut over ARK.** `@ark/guard` becomes a re-export of `@arc-control/guard`; ARK Control's `/actions` page (`ark/apps/control/src/app/actions/page.tsx`, `lib/receipts.ts`) reads evidence v2. The `action_receipts` table becomes read-only, then is dropped after one release.
10. **Python platform.** Either call the gateway through an HTTP client (the `sdk-typescript` contract, in Python) or embed a port of the evaluator. Until then, its `tools.yaml` is generated from ARC policy documents so there is one source.
11. **Out of scope, unchanged.** ARK Control's calibration contract `GET /api/v1/calibration` (`ark/apps/control/src/app/api/v1/calibration/route.ts`, consumed by `ark/packages/core/src/calibration/client.ts`) is telemetry for the team-assessment product, not authorization. It stays in ARK Control with its bearer-token org derivation and per-org snapshot interval. Manifest posture (`policy.ts`) and the model-call gate (`enforce.ts`) also stay in ARK.

## Open questions for the owner

1. **Is embedded mode a product guarantee or a pilot convenience?** It cannot stop an agent that holds the tool's real credential. If customers will be told "ARC controls your agents", only gateway mode supports that sentence.
2. **Does ARK ADR-0009 §2 still bind?** Option A satisfies it through embedded mode. If it no longer binds, step 6 can wait and ARK can call the gateway directly.
3. **`unknown` as a fourth effect.** ARK distinguishes "could not decide" from "decided no". Option A records it as `DENY` plus a reason code. Should it instead be a first-class effect in `PolicyEffect`, with its own severity above `DENY`?
4. **Conflict semantics.** ARC: strictest wins. ARK: any disagreement denies. Strictest-wins lets a broad `REQUIRE_APPROVAL` policy and a narrow `ALLOW` policy coexist; ARK's rule forbids that. Which is intended?
5. **Deterministic decision ids.** Keep ARK's content-addressed id as a secondary field (proposed), or make all decision ids deterministic?
6. **Who owns the canonical repo and name?** `arc-control` and `ark` are different products under similar names; the calibration client says "MY AI for teams", the request says "AI Fit Teams". Settle the names before the packages move.
7. **Python platform.** Port the evaluator to Python, or require the gateway? A port means two implementations of one spec, held together only by the golden tests in step 5.
8. **Chain anchoring.** Imported ARK history and embedded-mode evidence both arrive after the fact. Is the v0.5 external anchoring (`docs/ROADMAP.md`) a prerequisite for embedded mode, or can it follow?
