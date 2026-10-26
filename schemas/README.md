# Schemas

JSON Schema (draft 2020-12) for the ARC Control object model. These are the
contract for consumers in other languages, and they mirror the TypeScript types
in [`packages/schemas`](../packages/schemas).

| | |
|---|---|
| [`agent.schema.json`](./agent.schema.json) | The principal ARC Control authorizes |
| [`tool.schema.json`](./tool.schema.json) | A capability an agent may ask to use, and its parameter contract |
| [`policy.schema.json`](./policy.schema.json) | Match, ordered rules, the condition language, approval requirements |
| [`action.schema.json`](./action.schema.json) | One thing an agent asked to do |
| [`evidence.schema.json`](./evidence.schema.json) | What was requested, who authorized it, what happened |
| [`audit.schema.json`](./audit.schema.json) | One link in the hash chain |
| [`control.schema.json`](./control.schema.json) | A governance control, and whether ARC can decide it at all |
| [`assessment.schema.json`](./assessment.schema.json) | One evaluation of one control, over a stated window |
| [`risk.schema.json`](./risk.schema.json) | A risk on the register, with inherent and reviewed-residual ratings |
| [`finding.schema.json`](./finding.schema.json) | A failed control against a specific subject |

CI parses all ten, checks that each keeps its `$schema`, `$id`, `title`,
`description` and `type`, that no two share an `$id`, and that every internal
`$ref` resolves — a schema whose `$ref` dangles makes a consumer's validator
fail on a document ARC Control considers valid.

## Parsing is not enough

`packages/schemas/src/contract.test.ts` validates fully-populated, real 2.0
objects against these files with a small dependency-free validator, and it
exists because of a bug it would have caught.

During the 2.0 work the agent, evidence and tool schemas drifted from the
TypeScript model: the agent lifecycle gained `draft` and `retired`, agents
gained a `governance` record, evidence gained a `risk` classification and tools
gained a kill switch — and all three schemas declare
`additionalProperties: false`. The published contract would therefore have
rejected objects ARC itself produces. CI was green throughout, because parsing
a schema says nothing about whether it describes anything real.

The validator covers only the keywords these schemas use. It is strict about
the one that matters: an undescribed property under
`additionalProperties: false` is an error.

## Version

The `$id` of every schema moved from `v0.1` to `v2.0` with this release. The
object model's own `SCHEMA_VERSION` is 2, and a 1.x data directory opens
without migration — every added field is optional and the new collections start
empty.

## Reading the policy schema

`policy.schema.json` is the interesting one. Two parts are worth knowing:

**The condition language** (`$defs/condition`) permits exactly one operator per
object. It is a closed set — no embedded code, no function calls — so
evaluation is total and side-effect free.

**`$defs/policyRule`** carries an `allOf` that makes `approval` required on a
`REQUIRE_APPROVAL` rule and forbidden on any other. A rule requiring approval
from nobody could never be satisfied, and an approval requirement on an `ALLOW`
rule would be silently ignored.

Note what the schema **cannot** express: that `minApprovals` is satisfiable.
`role:finance-manager` may match a whole team, so requiring two approvals from
one role selector is legitimate — and the standard dual-control pattern. Only
`validatePolicy` in `packages/schemas` can judge that, and it rejects a
threshold only where every selector names one individual. `arc policy lint`
runs that check.

## Versioning

The `$id` carries `v0.1`. These are pre-1.0 and may change with the model; a
breaking change bumps the path segment, and `SCHEMA_VERSION` in
`packages/schemas` tracks the object model's own version.
