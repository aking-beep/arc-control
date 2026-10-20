# @arc-control/audit

A hash-chained, append-only log with independent verification.

## Why this package exists

Evidence answers "what happened to this action?". The audit log answers "what
happened, in order, and has the record been altered?" — including configuration
changes, because "who widened this policy, and when?" is the first question any
incident review asks.

## What the chain does and does not prove

Each record carries the digest of its predecessor. Editing one changes its
digest and breaks the link every later record depends on; removing one from the
middle leaves a sequence gap.

**It cannot detect truncation on its own.** Remove records from the *end* and
what remains is a shorter chain in which every digest and every link is still
correct. There is no gap, because the gap would have been after the last
remaining record. So `valid: true` from a bare export means *the records
present are self-consistent* — not *the log is complete*.

That matters: an attacker who wants a denial gone, and who can only append or
truncate, removes everything from that denial onwards.

**And it is tamper evidence, not tamper proofing.** Whoever controls the
storage can rebuild the whole chain and recompute every digest.

Both gaps close the same way — an expected head that did not come from the log:

```ts
await audit.verify({ headDigest, headSequence });
```

`FileStore` keeps a head marker beside the log, so truncating the log alone is
caught; `arc audit verify --expect-head` takes a head anchored outside ARC
Control, which is the real check. When nothing is available to check against,
`checkedAgainstExpectation` is false and the CLI, API and console all say so
rather than reporting a clean result.

## Usage

```ts
import { AuditLog, verifyChain } from '@arc-control/audit';

const audit = new AuditLog(store);

await audit.append({
  type: 'policy.updated',
  organizationId: 'default',
  actor: 'platform@example.com',
  subject: 'FINANCE-004',
  summary: 'raised the approval ceiling to $5,000',
  data: { version: 2 },
});

const verification = verifyChain(await audit.read(), { headDigest, headSequence });
```
