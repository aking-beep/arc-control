# @arc-control/schemas

The ARC Control object model: agents, tools, policies, actions, approvals,
evidence and audit records — plus the three utilities everything else depends
on.

## Why this package exists

Every other package agrees on these types, and three of the guarantees in the
product are implemented here rather than anywhere else.

**Canonical JSON** (`canonicalize`, `digest`). Object keys sorted,
`undefined` dropped. Two structurally equal values always produce the same
digest, regardless of language, process or key insertion order — which is what
makes an evidence digest verifiable by a party who did not produce it.

**Redaction** (`redactParameters`, `redactDeep`). A tool may mark a
parameter `sensitive`, and a list of names — `password`, `api_key`,
`client_secret`, `private_key`, `token`, `ssn`, `card_number` and
others — is redacted wherever it appears at any depth, regardless of the tool
definition. A tool author who forgets to mark a field should not be able to
write credentials into the audit log.

**Validation** (`validateParameters`, `validatePolicy`). Undeclared
parameters are *rejected*, not dropped: silently dropping them would hide a
confused-deputy attempt from both policy and the audit record.

## The decision worth knowing

`compilePattern` in `regex.ts` is the only place a policy regular
expression is compiled, and both the validator and the evaluation engine call
it. That is deliberate: if they compiled patterns separately,
`arc policy lint` and the running gateway could disagree about whether a
policy works — the validator would pass a document the engine then refuses at
decision time, failing closed on every action it governs.

It also honours a leading `(?i)` as a case-insensitive flag. JavaScript has
no inline flag syntax, so an operator arriving from Go, Python or PCRE writes
the thing everyone writes; without this they got "policy is not valid" and
nothing to explain it.

## Usage

```ts
import {
  ArcError,
  digest,
  newId,
  redactParameters,
  validatePolicy,
  type Policy,
} from '@arc-control/schemas';

const id = newId('evidence');              // arc_ev_82f3a1c4…
const seal = digest({ outcome: 'denied' }); // sha256:…

const result = validatePolicy(policy);
if (!result.valid) throw new ArcError('invalid_request', 'policy is not valid', {
  details: { issues: result.issues },
});
```

The published JSON Schemas in [`schemas/`](../../schemas) mirror these types
for consumers in other languages.
