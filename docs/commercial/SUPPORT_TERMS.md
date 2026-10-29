# Support terms — draft

> **Draft. Not legal advice. Must be reviewed by counsel before use.**

`docs/COMMERCIAL_READINESS.md` §6 says defining escalation and SLAs before
there is anything to escalate "would be theatre". That is right for three
design partners, where the answer is a named engineer and a shared channel.
This document is what replaces it at the first **paid** engagement, and not
before.

## Severities

Severity is set by effect on the control plane, not by how it feels.

| | Definition | Example |
| --- | --- | --- |
| **S1** | ARC is failing **open**, or evidence is not being recorded. | Actions reaching connectors without a decision; the audit chain not extending. |
| **S2** | ARC is failing **closed** and blocking legitimate work; or the console is unavailable. | Every action denied after an upgrade. Operators cannot sign in. |
| **S3** | A control behaves incorrectly without failing open. | A policy matches when it should not, in a way that only tightens. |
| **S4** | Question, documentation defect, or feature request. | "Does the budget count a held action?" |

**S1 is the one that matters.** ARC exists so that nothing executes without a
decision; a failure of that is the only kind that makes the product actively
worse than not having it. An S1 is handled before anything else, including
other customers' S2s.

## Response targets

| | First response | Then | Target resolution |
| --- | --- | --- | --- |
| S1 | [1 hour], [24/7] | Continuous until mitigated | Mitigation first, fix after |
| S2 | [4 business hours] | Daily | [2 business days] |
| S3 | [1 business day] | [Weekly] | Next release |
| S4 | [2 business days] | — | Best effort |

These are **response** targets. We do not commit to a repair time for a defect
we have not seen, and will not quote one.

## What support covers

- Diagnosing behaviour of ARC Control as deployed.
- Applying and verifying security fixes.
- Reading your policies with you when a decision is not what you expected.
- Interpreting evidence and audit output, including for your auditor.
- A quarterly review of your control results and findings.

## What support does not cover

Stated plainly, because an unstated boundary gets discovered during an incident:

- **Your agents' behaviour.** ARC bounds what an agent may do. It does not
  make the agent do the right thing.
- **Prompt injection inside your agent.** Out of scope by design
  (`SECURITY.md`).
- **Connectors you wrote.** A connector is trusted to report outcomes honestly;
  one that lies produces false evidence and we cannot detect it.
- **Agents that bypass the gateway.** If an agent holds its own credentials,
  no ARC guarantee applies to what it does with them.
- **Availability of your deployment.** ARC is software you run. We do not
  operate it, do not monitor it, and have no access to it unless you give us
  some for a specific incident.
- **Any compliance outcome.**

## Escalation

1. Named engineer, through the shared channel.
2. [Engineering lead], after [4 hours] on an S1 with no mitigation.
3. [Owner], after [24 hours] on an S1.

A customer may escalate without waiting for the clock.

## Security reports

Security issues go to **security@arctransformationgroup.com**, not through
support. `SECURITY.md` is the published policy: acknowledgement within 2
business days, assessment within 10, and if a fix will take longer we say so
rather than going quiet.
