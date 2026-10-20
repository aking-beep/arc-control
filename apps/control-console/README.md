# @arc-control/control-console

The enterprise console: agents, policies, approvals, evidence and audit.

## The decisions worth knowing

**It holds no state of its own.** Everything shown is read through the control
API with the operator's own credential, so the console cannot surface anything
the API would withhold, and an approval cast here is audited identically to one
cast through the API.

**Server-rendered, no client framework, no build step.** The console displays
evidence about security decisions, and a page whose source an auditor can read
is worth more here than a richer one they cannot. It also prints legibly,
because these pages end up in audit reports.

**Every interpolation is escaped at the template level.** The `html` tagged
template escapes by default and only accepts pre-rendered markup through an
explicit `raw()`. Everything the console shows — tool names, policy reasons,
approval comments, audit summaries — originated outside it, and some of it came
from an agent, so a tool description must not be able to become script in an
operator's browser. The response also carries a strict
`content-security-policy` with no script source at all.

**Mutations are form posts that redirect.** A reload never repeats a vote.

**Approving does not execute.** The console votes, and releases the action as a
separate call, only once the request is actually approved.

## Running it

```bash
ARC_API_BASE=http://127.0.0.1:8787 \
ARC_OPERATOR_TOKEN=… \
ARC_OPERATOR_IDENTITY=you@example.com \
ARC_OPERATOR_ROLES=finance-manager \
npm run console
```

## Put something in front of it

v0.1 takes the operator's identity from configuration, not from an
authenticated session, so every approval through this console is attributed to
`ARC_OPERATOR_IDENTITY`. Deploy it behind an identity-aware proxy. See
[TRUST_MODEL.md](../../docs/TRUST_MODEL.md#what-an-operator-is-trusted-with-and-the-v01-gap).
