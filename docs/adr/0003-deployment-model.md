# ADR-0003: ARC Control is deployed software, licensed per environment — not a hosted multi-tenant service

**Status:** Proposed on 2026-10-29. Awaiting the owner's decision.
**Date:** 2026-10-29
**Scope:** The product's deployment model, and what that forecloses. No code changes.

## Context

Everything downstream of go-to-market — pricing, the landing page, the security
questionnaire, what a pilot looks like, whether SOC 2 matters — depends on one
question nobody has answered in writing: **is ARC Control software a customer
runs, or a service we run for them?**

Both answers are currently half-true in the material, which is the problem.
`docs/COMMERCIAL_READINESS.md` recommends a per-deployment enterprise licence
and says "ARC is deployed software, not a hosted service". `SECURITY.md` says
"one deployment serves one organization until v0.5", which reads as a promise
that hosted multi-tenancy is coming. A buyer reading both cannot tell which
product they are evaluating.

### What the code actually supports today

Verified against the tree at 2.3.0, not from memory:

| Capability | State | Evidence |
| --- | --- | --- |
| Tenant isolation | **Absent.** `organizationId` is recorded on agents, actions, decisions and evidence, and `budgets` scope by it, but nothing on the decision path refuses an action for crossing an organization boundary. | `packages/gateway/src/gateway.ts`, `packages/policy-engine/src/` |
| Horizontal scale | **Absent.** Every guarantee is per-process. Idempotency, the approval single-use rule and the audit chain head are held in one process over one store. | `docs/releases/2.3.md`, "Anything distributed" |
| Durable store | Single-node file store, writes serialized per collection by a mutex. | `packages/store/src/file.ts`, `packages/store/src/mutex.ts` |
| Operator identity | OpenID Connect against **the customer's** provider. | `packages/operator-identity/` |
| Telemetry / phone-home | **None.** No outbound connection but the connectors the customer configures. | `docs/SECURITY_QUESTIONNAIRE.md` §5 |

Turning this into a hosted multi-tenant service is not a feature. It is tenant
isolation enforced on the decision path, distributed idempotency, a shared
audit chain with a consistent head, an HA store, and our own SOC 2 — because at
that point we operate the thing. That is quarters of work, and it replaces the
part of the product most load-bearing for trust.

### What the intended buyer wants

`docs/COMMERCIAL_READINESS.md` §1 defines the ideal customer as an organization
with a security function, agents holding consequential permissions, and 50–5,000
employees. That buyer:

- already runs an identity provider, and wants ARC behind it;
- will ask where evidence lives, and prefers "your infrastructure";
- is reassured, not disappointed, that ARC sends nothing anywhere;
- is buying because an auditor will eventually ask a question.

The "no telemetry, no phone-home" property is a **selling point to exactly this
buyer** and it is only true because ARC is deployed software. Hosting it would
spend the asset to reach a buyer we have explicitly excluded.

## Decision

**ARC Control is deployed software, licensed per environment.** Single-tenant by
construction: one deployment, one organization.

Consequences we accept deliberately:

1. **No hosted signup, no free tier, no self-serve.** Evaluation is a pilot
   with a named engineer, per `docs/COMMERCIAL_READINESS.md` §4.
2. **Pricing is option C** — flat annual licence per environment, unlimited
   agents and actions, tiered by company size. It is the only shape that never
   penalises governing more agents.
3. **Multi-tenancy is not on the roadmap.** It is removed as a "until v0.5"
   promise rather than deferred, because a deferred promise still shapes a
   buyer's expectations.
4. **`organizationId` stays a recorded attribute, not a boundary.** It is
   useful for reporting and for budgets. Anything that reads as an isolation
   guarantee must say it is not one.
5. **SOC 2 describes our corporate posture, not the customer's deployment.**
   Worth starting for procurement reasons; it does not become a blocker for the
   security of the thing itself.
6. **Phase 5 ("multi-client operations") means per-client *profiles and
   deployments we help operate*** — `clients/<id>/`, drift detection between a
   profile and a running deployment, per-client scorecards. It does not mean
   one deployment serving many clients. `docs/harness/README.md` already
   describes it this way; this ADR makes that reading binding.

## What this forecloses

Stated plainly, because the point of writing it down is to be able to change
our minds on purpose rather than by drift:

- A product-led growth motion. There is no self-serve funnel to build.
- Usage-based pricing on actions. We would not be in the data path to meter it
  reliably, and §5 of the commercial doc argues metering authorization
  decisions is backwards anyway.
- Any customer who will not run software. That is a real, permanent segment we
  are choosing not to serve.

## Reversing this

The cheapest reversal point is before tenant isolation is needed anywhere.
Nothing in this decision adds code that a hosted model would have to unwind —
it is a decision not to build. If a design partner's week-8 conversation turns
on "we will not run this ourselves", that is the signal to revisit, and the
cost of revisiting is the quarters named above, not rework.

## Status and approval

This ADR is **proposed**, not accepted. It records a recommendation and the
evidence behind it so the owner can decide once, in writing, rather than having
the decision made implicitly by whatever the landing page happens to say.

Accepting it means: `SECURITY.md`'s multi-tenancy limitation stops reading as a
roadmap promise (already updated to match this ADR), pricing option C is the
quoted model, and the landing page sells a deployment.
