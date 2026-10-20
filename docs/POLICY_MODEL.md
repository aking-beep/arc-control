# The policy model

A policy is a document an auditor can read.

That constraint shapes everything below. The alternative — authorization
expressed as code inside each agent — fails for a reason that has nothing to do
with engineering: nobody outside the team that wrote the agent can review it,
and nobody can say afterwards what rule was in force when something went wrong.

---

## Shape

```json
{
  "id": "FINANCE-004",
  "version": 1,
  "name": "Autonomous refund authority",
  "description": "Bounds how much a finance agent may refund without a human.",
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
      "approval": {
        "approvers": ["role:finance-manager"],
        "minApprovals": 1,
        "expiresInSeconds": 3600
      }
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

Evaluation is: does the policy `match` this action? If so, walk `rules` in
order and the first whose `when` holds decides. If none holds, `fallback`
decides. A matching policy therefore *always* produces an effect — there is no
path on which a policy matches and declines to answer.

The machine-readable definition is
[`schemas/policy.schema.json`](../schemas/policy.schema.json).

---

## Three effects

| Effect | Meaning |
|---|---|
| `ALLOW` | Execute now. |
| `REQUIRE_APPROVAL` | Hold. A named human decides; only then does it execute. |
| `DENY` | Refuse. Record the attempt. |

`REQUIRE_APPROVAL` is the one that earns its place. Without it, every judgement
call has to be decided in advance, which in practice means pre-approved — the
agent either can refund $4,200 or it cannot, and the organization picks the
answer that does not block work.

---

## Strictest wins

Every policy that matches an action is evaluated, and **the strictest effect
decides**: `DENY` over `REQUIRE_APPROVAL` over `ALLOW`.

The consequence is the single most useful property of the model: **adding a
policy can only ever tighten authorization, never loosen it.** A new policy is
therefore always safe to roll out. Nobody has to reason about ordering,
precedence numbers or override semantics to know that publishing a document
cannot accidentally grant something.

It also means a permissive policy cannot be used as an escape hatch. Given
`FINANCE-004` above and this:

```json
{
  "id": "AAA-PERMISSIVE",
  "version": 1,
  "name": "Permissive refunds",
  "enabled": true,
  "match": { "tools": ["stripe.*"] },
  "rules": [{ "id": "allow-all", "when": { "always": true }, "effect": "ALLOW", "reason": "permitted" }],
  "fallback": { "effect": "ALLOW", "reason": "permitted" }
}
```

a $4,200 refund is still `DENY`, and the decision still cites `FINANCE-004`.
This is asserted in `evals/policy/decisions.eval.mjs`.

### Layering in practice

The pattern this enables is a floor under everything else:

```json
{
  "id": "GLOBAL-001",
  "version": 1,
  "name": "Production irreversible actions",
  "enabled": true,
  "match": { "environments": ["production"], "effects": ["irreversible"] },
  "rules": [
    {
      "id": "irreversible-needs-a-human",
      "when": { "always": true },
      "effect": "REQUIRE_APPROVAL",
      "reason": "irreversible production actions require a named human",
      "approval": { "approvers": ["role:platform-oncall"], "minApprovals": 1 }
    }
  ],
  "fallback": { "effect": "DENY", "reason": "no rule matched" }
}
```

Published alongside `FINANCE-004`, this raises the $120 refund from `ALLOW` to
`REQUIRE_APPROVAL`, and leaves the $4,200 refund denied. That is the intended
behaviour, and it is why the shipped demo seed does *not* include this policy:
it would shadow the refund bands and the headline example would stop
demonstrating the three-way split. The layering is exercised in the evals
instead, where it can be read rather than tripped over.

### Ties

When two policies produce the same effect, the one whose id sorts first is
cited. This is arbitrary but **stable**: the same inputs always name the same
policy, so two auditors reading the same decision never disagree about which
document governed it.

---

## Fail closed

A policy that cannot be evaluated never allows anything.

- **No policy matches** → `DENY`, reason `no policy authorizes this action`. A
  control plane that allows what it has no policy for is not a control plane.
  (`PolicyEngine` accepts a `defaultEffect` of `ALLOW` for a monitor-only
  rollout. That is a deliberate, named choice, not a default.)
- **A condition throws** — unknown operator, malformed shape, a type mismatch —
  the rule is recorded as *not matching*, the error is kept in the trace, and
  the policy falls through to its fallback. An unevaluable rule can never
  authorize an action.
- **A referenced parameter is absent** → the comparison is false.
- **A numeric comparison receives a string** → an error, not a coercion. A
  refund limit must never pass because the amount arrived as `"10"` instead of
  `10`.

The last one matters more than it looks. Silent coercion is how a limit becomes
decorative: `"10" > 500` is `false` in JavaScript, and so is `"10" < 500`, so a
sloppier engine would deny the under-limit case and allow nothing — or worse,
with different operand types, allow everything. ARC Control refuses the
comparison and records why.

---

## Conditions

A small, closed expression language. No embedded code, no function calls, no
loops. Evaluation is total and side-effect free.

### Operators

| Operator | Form | Notes |
|---|---|---|
| `always` | `{"always": true}` | Matches unconditionally. |
| `eq`, `ne` | `{"eq": [a, b]}` | Structural equality; arrays compare element-wise. |
| `gt`, `gte`, `lt`, `lte` | `{"gt": [a, b]}` | Two numbers or two strings. Mixing types is an error. |
| `in`, `nin` | `{"in": [a, [x, y]]}` | Membership in a list. |
| `contains` | `{"contains": [a, b]}` | Array membership, or substring. |
| `startsWith`, `endsWith` | `{"startsWith": [a, b]}` | Strings. |
| `matches` | `{"matches": [a, "^re$"]}` | JavaScript regex. A leading `(?i)` is honoured. |
| `exists` | `{"exists": "$.path"}` | True when the path resolves to a non-null value. |
| `and`, `or` | `{"and": [c1, c2]}` | Non-empty arrays of conditions. |
| `not` | `{"not": c}` | Negation. |

Nesting is bounded at 16 levels. `matches` refuses input longer than 4096
characters, and a leading inline flag other than `(?i)` is rejected with a
message saying so rather than silently ignored.

### References

An operand is either a literal or a reference: a string beginning with `$.`
naming a path into the evaluation input.

```
$.agent.name                       finance-agent
$.agent.roles                      ["finance"]
$.agent.labels.tier                gold
$.tool.name                        stripe.refund
$.tool.effect                      read | write | irreversible
$.tool.riskTier                    low | medium | high | critical
$.action.parameters.amount         4200
$.action.parameters.tags.0         urgent
$.action.parameters.tags.length    2
$.context.environment              production
$.context.hourUtc                  0-23
$.context.dayOfWeekUtc             0-6
$.context.correlationId            run_2026_10_20_a
```

The path language is dot segments and numeric array indices. No wildcards, no
filters, no functions — a policy author can read it, and an auditor can confirm
what it points at.

**Only own properties resolve.** A reference can never reach `constructor`,
`__proto__`, `toString` or anything else inherited from `Object.prototype`;
such a path resolves to nothing. This is asserted in
`evals/security/boundaries.eval.mjs`.

### Why `intent` is not in the input

`ActionRequest` carries an optional `intent` string, and it is recorded in
evidence. It is deliberately **not** available to conditions.

An agent's own account of what it is doing is not evidence of what it is doing.
A policy that allowed a refund because the agent said
`intent: "routine duplicate charge"` would be authorizing a sentence the agent
chose. Policy decides on the parameters, the tool and the agent's established
identity — facts the agent cannot narrate its way around.

---

## Matching

```json
"match": {
  "agents": ["finance-agent", "role:finance", "label:tier=gold", "*"],
  "tools": ["stripe.refund", "stripe.*"],
  "systems": ["stripe"],
  "environments": ["production"],
  "effects": ["irreversible"]
}
```

An omitted selector matches everything. Every selector that *is* present must
match — so narrowing a policy can never widen what it governs.

Prefer `role:` over naming agents. A policy that names agents has to be edited
every time one is added, and the edit is the moment coverage gets missed.

---

## Approval requirements

Attached to a `REQUIRE_APPROVAL` rule, so the **policy** decides who holds the
authority — not the calling code, and not the console.

```json
"approval": {
  "approvers": ["role:finance-manager", "user:cfo@example.com", "owner"],
  "minApprovals": 2,
  "expiresInSeconds": 3600,
  "requireSeparationOfDuties": true
}
```

| Selector | Matches |
|---|---|
| `role:<role>` | Anyone holding that role. |
| `user:<identifier>` | One specific person. |
| `owner` | The agent's registered owner. |
| `*` | Anyone who can reach the console. |

**`minApprovals` is not bounded by the number of selectors.** `role:finance-manager`
may match a whole team, so requiring two approvals from one role selector is
both legitimate and the standard dual-control pattern. The validator only
rejects a threshold it can prove is unsatisfiable — when every selector is a
`user:` naming one individual and the threshold exceeds their count.

**`requireSeparationOfDuties`** bars the agent's registered owner from
approving, *however else they would match* — including through a role they
happen to hold. The point of the control is that nobody approves their own
agent's work, so matching by role must not be a way around it.

The approvals engine enforces authority, finality and single use:

- Only a named approver may vote.
- One approver cannot vote twice to reach a threshold alone.
- A single rejection resolves the request: when a named approver says no,
  waiting for the others cannot make the action safe.
- A granted approval is **consumed** when the action executes, so it can never
  authorize a second execution — including when two callers race to resume it.

---

## Versioning

Policies are versioned, not edited. Publishing a change requires a higher
`version` than the stored document, which stops two operators silently
overwriting one another's work.

Every `policy.created` and `policy.updated` audit record carries the document's
digest, so a decision citing `FINANCE-004` version 3 can be matched against the
exact text that was in force when it was made.

---

## Testing policy before trusting it

```bash
# Does the document hold together?
arc policy lint policies/finance.json

# What would it do to these actions?
arc policy test --policy policies/finance.json --input tests/refunds.json

# Show the rule-by-rule trace even when cases pass
arc policy test --policy policies/finance.json --input tests/refunds.json --trace
```

A case file is an assertion suite:

```json
[
  {
    "name": "routine refund",
    "expect": "ALLOW",
    "input": {
      "agent": {
        "id": "arc_ag_1", "name": "finance-agent", "kind": "autonomous",
        "environment": "production", "owner": "finance@example.com",
        "roles": ["finance"], "labels": {}
      },
      "tool": {
        "name": "stripe.refund", "system": "stripe",
        "effect": "irreversible", "riskTier": "critical", "labels": {}
      },
      "action": { "id": "arc_act_1", "parameters": { "customer": "c_1", "amount": 120 } },
      "context": {
        "environment": "production", "requestedAt": "2026-01-15T14:00:00.000Z",
        "hourUtc": 14, "dayOfWeekUtc": 4
      }
    }
  }
]
```

`arc policy test` exits non-zero when any case produces an unexpected effect,
so a policy change that moves a boundary fails CI rather than production.

Against a running deployment, `POST /v1/actions/explain` answers the same
question with real policy and real agent identity, and records nothing: no
evidence is written and nothing executes.

---

## Writing a good policy

**Put the reason in the reason.** It is required because a decision without one
is not auditable. `"exceeds autonomous refund authority"` tells an operator
what happened; `"denied by rule 3"` does not.

**Order rules from specific to general, and end with a catch-all.** The
`{"always": true}` final rule in `FINANCE-004` is what makes the three bands
exhaustive. Without it the policy would fall through to its fallback, which
works, but reads as an accident rather than a decision.

**Set the band boundaries deliberately.** `lt 500` then `lte 2500` means $500
needs approval and $2,500 still does. Write cases for the boundaries; a
boundary that drifts is a boundary nobody can rely on.

**Let the tool's `effect` carry the risk.** `"effects": ["irreversible"]` is a
better selector than enumerating the tools that happen to be irreversible
today.

**Scope to `environment`.** The same policy id can be stricter in production
than in staging, which is usually what people mean when they ask for a
"staging exception".
