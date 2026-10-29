# Data processing terms — draft

> **Draft. Not legal advice. Must be reviewed by counsel before use.**
> Whether a formal DPA is required at all depends on the deployment and the
> jurisdiction. That is a question for a lawyer, not for this document.

## The short version

In the standard deployment, **we process none of your data.**

ARC Control runs in your infrastructure. It has no telemetry, no phone-home,
and makes no outbound connection other than the connectors you configure
(`docs/SECURITY_QUESTIONNAIRE.md` §5). Evidence records, the audit chain,
policies, agent registrations and operator sessions are all written to storage
you control and are never transmitted to us.

Most of a normal data-processing agreement therefore describes something that
does not happen. The parts below are the parts that can.

## 1 · Roles

For data inside your ARC Control deployment, **you are the controller and we
are not a processor**, because we neither receive nor have access to it.

We become a processor only in the specific, bounded circumstances in §3.

## 2 · What ARC Control stores about people

ARC records **operators** — the humans who approve, deny and administer:

| Data | Why | Where |
| --- | --- | --- |
| Identifier (email or subject claim) | To attribute an approval to a person | Your store |
| Roles | To decide who may approve what | Your store |
| Session records | To make revocation immediate | Your store |
| Vote records, with the assurance the identity was established at | So an approval means what it says | Your audit chain, permanently |

It records **nothing about your end users** unless one of your agents puts it
in an action parameter. If it does, that parameter is in evidence and in the
audit chain. Parameters a tool marks `sensitive` are redacted before any record
is written (`redactParameters` / `redactDeep`, invariant 8); parameters that
are not marked are recorded as given. **Marking them is your decision and your
responsibility.**

### Retention, and a caveat worth reading

ARC does not prune. Audit history is append-only and hash-chained, which is
what makes it tamper-evident — and that property is in direct tension with a
deletion request. Personal data written into the audit chain **cannot be
deleted without breaking the chain**.

[Counsel: this is the one genuinely hard question in this document. The
mitigation is to keep personal data out of the chain in the first place, via
`sensitive` parameter marking and operator identifiers that are pseudonymous
subject claims rather than emails. Whether that is sufficient under the
applicable regime needs an actual answer before a customer in a regulated
sector signs.]

## 3 · When we do process your data

Only these, and only with your instruction:

1. **Support.** If you send us logs, an evidence bundle or a policy document to
   diagnose a problem, we process whatever you chose to send. We ask you to
   redact first; we cannot know what is in it.
2. **Incident access.** If you grant temporary access to a deployment for a
   specific incident, for the duration of that incident.
3. **Business contact details** of your staff, for running the relationship —
   where we are the controller, not a processor.

For (1) and (2): [purpose, duration, sub-processors, deletion on request,
security measures, breach notification, and international transfer terms all to
be drafted by counsel.]

## 4 · Sub-processors

[List. Expected to be short: email, support channel, billing. None has access
to a customer deployment.]

## 5 · Your audit rights

You may audit our handling of anything under §3. For the deployment itself
there is nothing to audit on our side — you hold it. What you can verify
instead is the software: the repository is public, the eval suite asserts the
guarantees, and an evidence bundle verifies offline with ARC switched off.
