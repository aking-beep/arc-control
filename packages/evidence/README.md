# @arc-control/evidence

Self-contained, digest-sealed records of what an agent requested and what
happened.

## Why this package exists

Evidence is the durable answer to "what did this agent try to do, who or what
authorized it, and what actually happened?".

One record per action, written for **every** outcome — including a denial. A
control plane that only records its successes cannot answer the question an
incident review asks: if denials vanish, a sustained attack looks exactly like
a quiet week.

## The decisions worth knowing

**A record is self-contained.** It names the agent and its owner, the
credential that authenticated it, the tool and its risk, the parameters, the
policy *and its version*, the rule, the reason, the approvers, their votes and
the execution outcome — so it can be handed to an auditor without granting them
access to ARC Control itself.

**Parameters are redacted; the digest is not.** `request.parameters` has
sensitive values replaced with `[redacted]`, while `parametersDigest` is
computed over the *unredacted* submission. The record therefore proves what was
submitted without storing it.

**The trace is referenced, not duplicated.** `decision.traceDigest` seals the
rule-by-rule trace, which lives on the decision. A tampered trace is detectable
without storing it twice.

**`verifyEvidence` is pure.** No server, no credentials, no network — so the
party checking does not have to trust the party that produced it.

## Usage

```ts
import { buildEvidence, verifyEvidence } from '@arc-control/evidence';

const record = buildEvidence({ action, principal, tool, decision, outcome: 'denied' });

verifyEvidence(record);                                  // true
verifyEvidence({ ...record, outcome: 'executed' });      // false
```

`arc evidence verify export.json` runs the same check over an export.
[EVIDENCE_MODEL.md](../../docs/EVIDENCE_MODEL.md) documents the record.
