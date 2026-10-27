# Contributing

Thanks for looking at ARC Control.

This document is mostly about one thing: the bar for code that decides whether
an AI agent may act on a real system is higher than the bar for most code, and
a few of the conventions here will look strict until you know why.

---

## Working with agents

If you work in this repository with Claude Code or another coding agent, it
reads [`CLAUDE.md`](./CLAUDE.md) first. The agents, skills and client profiles
built on it are described in [docs/harness/README.md](./docs/harness/README.md);
`npm run harness` checks them.

---

## Getting set up

```bash
npm install          # also builds, via the prepare script
npm run verify       # build + 81 tests + 52 eval properties
```

Node 22 or later. No other toolchain, no services, no containers.

```bash
npm run build        # tsc -b across the workspace
npm test             # node:test on the compiled output
npm run evals        # control-plane properties
npm run demo         # the refund workflow, end to end
npm run examples     # both examples
npm run api          # the control API
npm run console      # the console (needs the API running)
npx arc help         # the CLI
```

Tests run against compiled JavaScript rather than through a loader, so there is
no transpile step in the test path and nothing to configure.

---

## The scope rule

Before writing a feature, check it against this:

> identity → authorization → policy → execution → evidence → security →
> observability

A tool earns its way into this repository only by contributing to that chain.
If it does not, it belongs elsewhere — most likely ARC Labs.

This is not gatekeeping for its own sake. The failure mode for a product like
this is not building the wrong feature; it is becoming a collection of
unrelated AI utilities that share a monorepo, at which point it stops being a
control plane and starts being a toolbox. A pull request that adds something
outside the chain will be declined on scope even if the code is good.

[ROADMAP.md](./docs/ROADMAP.md) lists what is planned, what phase it belongs
to, and what is deliberately not planned.

---

## What to expect in review

### Zero runtime dependencies

Packages on the decision path have **no runtime dependencies** — Node's
standard library only. That is why there is a hand-written router, a
hand-written argument parser and a hand-written MCP client.

It is a real cost, paid deliberately: a control plane's supply chain is part of
its threat model, and this is code a security team reads line by line before
putting it in front of their systems. A pull request adding a runtime
dependency needs to argue for it, and "there is a library for this" is not the
argument.

Development dependencies are TypeScript and `@types/node`.

### Fail closed

Any new path that could produce an authorization decision must deny when it
cannot decide. If you add a branch where an error, a missing value or an
unexpected type could lead to `ALLOW`, that is the bug — not a rough edge.

### Every decision is auditable

If you add a way to change what an agent may do, it must produce an audit
record. Administration lives on the gateway (`packages/gateway/src/admin.ts`)
precisely so that the API, the CLI and a seed script all go through one audited
path. Add the operation there, not in a route handler.

An earlier arrangement audited these in the route layer only, which meant
seeding a deployment left an empty audit log. That is the class of mistake the
layering is designed to prevent.

### Secrets do not reach the record

Anything that writes to evidence, audit or the console goes through
`redactParameters` or `redactDeep`. If you add a field that could carry a
secret, say so in the review.

### Comments explain *why*

The code is dense with comments, and they are nearly all about reasoning that
is not recoverable from the code:

```ts
// A numeric comparison against text is a policy bug that would otherwise
// silently compare a number against a string, so it is reported rather than
// coerced — a refund limit must never pass because the amount arrived as text.
```

Not:

```ts
// compare the operands
```

If a reviewer asks "why is it like this?", the answer belongs in the file.

---

## Tests and evals

Two kinds, with different jobs.

**Tests** (`*.test.ts`, `node:test`) ask whether a unit does what its author
intended. Put them beside the code.

**Evals** (`evals/**/*.eval.mjs`) ask whether the control plane still upholds a
property somebody is relying on:

- *A denied action never reaches the target system.*
- *Adding a policy can only tighten authorization.*
- *One authorization means one effect.*
- *A failure is reported as a failure.*

Those properties are the product, so they are asserted separately from the code
that implements them, in terms a reviewer can read without reading the
implementation. Evals run the real gateway, the real policy engine and the real
audit chain; only the final side effect is simulated.

Every assertion takes a `because` string. An eval failure should explain what
guarantee broke, not just which values differed:

```js
expect.equal(
  connector.callCount(),
  0,
  'a denied refund must not reach the system',
);
```

**If your change touches a guarantee, add an eval.** Writing them for v0.1
found four real bugs: a validator that rejected dual control, a regex that
could not match the paths it most needed to, MCP pinning that was not enforced
where it mattered, and — found by running the CLI against a real store — audit
log truncation going undetected while the docs claimed removal was always
caught. Each is recorded in the commit that fixed it.

Note what those have in common: every one was in code that passed its unit
tests, because every one was a gap in a *guarantee* rather than in a function.

Evals must be deterministic. One of the v0.1 evals was briefly flaky because it
forged a credential by appending a fixed digit, which happened to reproduce the
real key when the key already ended in that digit. If a case can pass or fail
depending on randomness, fix the case.

---

## Working with policy

If you change the policy model, three things must move together or they will
disagree:

1. `packages/schemas/src/policy.ts` — the types
2. `packages/schemas/src/validate.ts` — what `arc policy lint` rejects
3. `schemas/policy.schema.json` — the published JSON Schema

Add the behaviour to `packages/policy-engine/src/engine.ts` or `condition.ts`,
and document it in [POLICY_MODEL.md](./docs/POLICY_MODEL.md).

Regex compilation lives in one place — `packages/schemas/src/regex.ts` — which
the validator and the engine both call, so `arc policy lint` and the running
gateway can never disagree about whether a pattern works. Keep it that way.

---

## Writing a connector

A connector turns an authorized action into a real effect. Implement
`Connector` from `@arc-control/execution` and put it in `connectors/`.

The contract is narrow on purpose. A connector receives the action, the tool
and the principal — and **not** the policy, the decision or the approval. By
the time it is called, authorization has already happened, and a connector must
not be able to second-guess, reinterpret or bypass it.

Three requirements:

**Be honest about failure.** A connector that swallows an error and returns
success writes a false evidence record, which is worse than no evidence,
because people act on records they believe. Throw `ConnectorError` with a code.

**Do not trust the network.** If the connector takes a URL, require a host
allowlist. Templates fill the path and the body, never the host. Re-check the
final URL, not the template. Refuse redirects. Without this, a templated URL
driven by agent-chosen parameters is a server-side request forgery primitive —
from code holding real credentials.

**Hold the credential yourself.** The agent must never see it, and a tool
definition must never contain it.

---

## Commits and pull requests

Write the commit message for someone investigating a decision in two years.
Say what changed and *why*; when a change fixes something subtle, say what the
failure actually was:

```
Add MCP security, connectors, and the control API

MCP is attached first because it is where enterprise agents are gaining
the ability to act, and the protocol itself carries no authorization: a
client that can reach a server can call anything it advertises.
...
Administration moved onto the gateway so registering an agent, defining a
tool or publishing a policy is audited whatever the entry point.
Previously only the HTTP layer audited these, so seeding left an empty log.
```

Before opening a pull request:

```bash
npm run verify
```

In the description, say which guarantee the change touches, if any, and point
at the eval that covers it.

Security-relevant changes get a closer read, and that is not a judgement of the
work — it is the nature of the code.

---

## Reporting a vulnerability

Do not open a public issue. See [SECURITY.md](./SECURITY.md).

---

## Layout

```
apps/control-api/         HTTP surface; two credentials, two audiences
apps/control-console/     server-rendered console, no build step
packages/gateway/         the decision point + audited administration
packages/policy-engine/   pure: policies in, decision out
packages/agent-identity/  registry, credentials, principals
packages/approvals/       human-in-the-loop lifecycle
packages/execution/       Connector contract, tool registry, executor
packages/evidence/        digest-sealed records
packages/audit/           hash-chained log
packages/mcp-security/    tool-poisoning checks, pinning, drift
packages/store/           storage contracts; memory + file
packages/schemas/         object model, canonical JSON, redaction, regex
packages/sdk-typescript/  API client
packages/cli/             arc
connectors/               mcp, generic-http, simulation
schemas/                  published JSON Schema
evals/                    control-plane properties
examples/                 runnable demonstrations
docs/                     architecture, trust, threat, policy, evidence, roadmap
infrastructure/           docker, kubernetes, terraform
```

Dependencies point one way: nothing in `packages/` depends on `apps/`, and
nothing below the gateway depends on it. The policy engine depends on
`schemas` alone, which is what keeps it pure — it cannot read the store, call a
connector or observe anything outside its input, and that is what makes a
decision reproducible from evidence a year later.
