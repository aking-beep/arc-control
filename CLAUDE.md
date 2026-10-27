# ARC Control — operating contract for agents

This file is read by every agent working in this repository, human-directed
or delegated. It is short on purpose: it states what must always be true and
where to look. The harness that builds on it — agents, skills, client
profiles — is described in `docs/harness/README.md`.

## What this is

ARC Control is the trust and control layer between enterprise AI agents and
the systems they act on. Every agent action passes through one chain:

> identity → authorization → policy → execution → evidence → security → observability

A change belongs here only if it serves that chain (`CONTRIBUTING.md`, "The
scope rule").

## Invariants — never break these

1. **Nothing executes without a current decision.** The only path to a
   connector is an ALLOW, or an approval that current policy still honours.
2. **Every action that reaches the gateway leaves evidence**, whatever the
   outcome.
3. **One authorization means at most one effect** — approvals are single-use,
   an idempotency key admits one request, writes are never retried.
4. **Fail closed.** An error, a missing value or an unexpected type never
   produces ALLOW.
5. **Strictest wins.** Adding a policy can only tighten authorization.
6. **Retirement is terminal.** A retired agent is never reactivated or
   credentialled.
7. **Assurance never changes enforcement**, and `not_assessable` is never
   reported as `pass`.
8. **Secrets never reach a record.** Evidence, audit and the console go
   through `redactParameters` / `redactDeep`.

`docs/ARCHITECTURE.md` and `docs/THREAT_MODEL.md` explain each one.

## Commands

```bash
npm install            # Node 22+, builds via prepare
npm run build          # tsc -b across the workspace
npm test               # unit tests (node:test, compiled output)
npm run evals          # control-plane properties
npm run verify         # build + tests + evals + dependency/infra checks + walkthrough
npm run harness        # harness self-check, client profiles, findings, release notes, script tests
node tools/harness/deploy-smoke.mjs    # start, enforce, restart, persist (after a build)
node tools/harness/measure.mjs --out-dir .harness   # every skill's metrics against targets
```

The full gate list, matching CI, is `.claude/skills/verify/SKILL.md`.

## Definition of done

- A defect has a regression test that **failed before** the fix.
- Tests count effects at the connector, not only responses.
- A changed guarantee has an eval in `evals/`.
- `npm run verify` and `npm run harness` pass.
- Enforcement changes are validated against Meridian
  (`.claude/skills/meridian-validate/SKILL.md`) with its expectations untouched.
- Docs and the current `docs/releases/` note say what changed and what it does
  **not** establish.
- A security finding is in `docs/security/findings.json`, and a fixed one names
  its regression test.
- `node tools/harness/pr-audit.mjs` passes, or the PR states a visible
  `Harness-Exempt: D<n> <reason>`.

## Never

- Weaken a control, or skip, delete or loosen a test or eval to get green.
- Edit an eval's or the Meridian sandbox's expected outcome to make it pass.
- Add a runtime dependency to a package on the decision path.
- Commit secrets, agent keys, operator tokens or real client data.
- Merge a pull request, push to `main`, or rewrite someone else's branch.
- Describe a per-process guarantee as distributed, or local test results as
  enterprise readiness.
- Change a target in `tools/harness/metrics.json` to make a scorecard green.

## Where things are

| Need | Look at |
| --- | --- |
| Which agent does what | `docs/harness/AGENTS.md`, `.claude/agents/` |
| How to deliver a change end to end | `.claude/skills/deliver/SKILL.md` |
| Fixing a security finding | `.claude/skills/security-remediation/SKILL.md` |
| Onboarding a client | `.claude/skills/client-onboarding/SKILL.md`, `clients/` |
| Deploying | `.claude/skills/deploy/SKILL.md`, `infrastructure/` |
| What starts automatically, and the scorecard | `docs/harness/README.md` |
| Layout and conventions | `CONTRIBUTING.md` |
| Known limitations | `SECURITY.md`, the newest `docs/releases/` note |
