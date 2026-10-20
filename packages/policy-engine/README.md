# @arc-control/policy-engine

Deterministic allow / require-approval / deny evaluation, with a full decision
trace.

## Why this package exists

This is where authorization is decided. It is also the only package in the
product that is completely pure: it takes a policy list and a plain-data input
and returns a decision. It cannot read the store, call a connector, or observe
anything that was not captured in its input — which is what makes a decision
reproducible from an evidence record a year later.

## The three properties

**Strictest wins.** Every matching policy is evaluated and the harshest effect
decides: DENY over REQUIRE_APPROVAL over ALLOW. So adding a policy can only
tighten authorization, never loosen it, and a new policy is always safe to roll
out. A permissive policy cannot be used as an escape hatch.

**Fail closed.** No matching policy means deny. A malformed condition, a
missing parameter or a thrown error is recorded as *not matching*, with the
error kept in the trace, and the policy falls through to its fallback. An
unevaluable rule can never authorize anything.

**Type mismatches are errors, not coercions.** `gt` between a number and a
string throws rather than comparing. A refund limit must never pass because the
amount arrived as `"10"` instead of `10` — silent coercion is how a limit
becomes decorative.

## Other decisions worth knowing

**References resolve own properties only.** `$.action.parameters.constructor`
resolves to nothing, never to a function inherited from `Object.prototype`.

**Ties are broken by policy id.** Arbitrary, but stable: the same inputs always
name the same policy, so two auditors reading the same decision never disagree
about which document governed it.

**`intent` is not in the evaluation input.** An agent's own account of what it
is doing is not evidence of what it is doing. A policy that allowed a refund
because the agent said it was routine would be authorizing a sentence the agent
chose.

## Usage

```ts
import { PolicyEngine, buildPolicyInput } from '@arc-control/policy-engine';

const engine = new PolicyEngine();          // defaults to DENY when nothing matches
const decision = engine.evaluate(policies, buildPolicyInput({ principal, tool, action }));

decision.effect;    // 'ALLOW' | 'REQUIRE_APPROVAL' | 'DENY'
decision.policyId;  // 'FINANCE-004'
decision.reason;    // 'exceeds autonomous refund authority'
decision.trace;     // every rule examined, in order, with any error
```

`new PolicyEngine({ defaultEffect: 'ALLOW' })` enables a monitor-only
rollout. That is a named, deliberate choice, not a default.

The language is documented in [POLICY_MODEL.md](../../docs/POLICY_MODEL.md).
