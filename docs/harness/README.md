# The ARC Control delivery harness

**Status: base harness (phase 1).** This is the structure every later phase
builds on. It is versioned, checked in CI, and deliberately small.

## What it is

ARC Control governs AI agents. This harness governs the agents that **build,
verify and deploy ARC Control** — so the same discipline the product enforces
on a customer's agents (declared roles, least privilege, evidence, independent
verification) applies to the work on the product itself.

It has four parts, each in the repository:

| Part | Where | What it gives you |
| --- | --- | --- |
| **Operating contract** | `CLAUDE.md` | The invariants, commands, definition of done and never-list every agent works under. |
| **Agents** | `.claude/agents/` | Twelve role-scoped agents, one per area of the product or stage of delivery, each with the same structure. See [AGENTS.md](./AGENTS.md). |
| **Skills** | `.claude/skills/` | Seven playbooks — deliver, verify, security remediation, Meridian validation, client onboarding, PR stewardship, release notes — each with a maturity level. See [SKILLS.md](./SKILLS.md). |
| **Client profiles** | `clients/` | One JSON profile per client, validated against the real gateway in CI. This is how the harness scales to any client. See [CLIENTS.md](./CLIENTS.md). |

And two tools that keep it honest:

- `tools/harness/check-harness.mjs` — fails if an agent or skill has bad
  frontmatter, points at a file that does not exist, hands off to an agent that
  does not exist, is missing from these docs, or claims a maturity level it has
  not earned.
- `tools/harness/validate-client.mjs` — loads each client profile into a real
  in-memory gateway and checks its policies, coverage, separation of duties,
  scenario outcomes, effect counts and evidence.

Both run in CI (`.github/workflows/ci.yaml`, steps "Delivery harness" and
"Client profiles") and locally with `npm run harness`.

## How a change flows

```
request ─▶ deliver skill (main session)
             │
             ├─ 1 baseline ─────────▶ arc-verifier
             ├─ 2 plan ─────────────▶ arc-architect
             ├─ 3 reproduce, 4 build ▶ owning engineer
             │                          (gateway / policy / identity /
             │                           evidence / connector / assurance /
             │                           client-onboarder)
             ├─ 5 review ───────────▶ arc-security-reviewer
             ├─ 6 verify ───────────▶ arc-verifier
             ├─ 7 validate ─────────▶ arc-meridian-validator  (independent repo)
             ├─ 8 document ─────────▶ arc-docs-steward
             └─ 9 ship ─────────────▶ steward skill (PR; never merge)
```

The main session orchestrates because subagents cannot start other
subagents. Each stage has an exit gate, defined in
`.claude/skills/deliver/SKILL.md`.

## Separation of duties in the harness

The roles mirror the controls the product sells:

- **Builders cannot certify their own work.** The engineers write code; the
  `arc-verifier` and `arc-meridian-validator` report results and have no
  Edit or Write tools. `check-harness.mjs` enforces that.
- **Reviewers cannot fix what they find.** `arc-security-reviewer` is
  read-only, so a finding cannot be quietly "fixed" in a way nobody reviews.
- **The external check cannot be edited alongside the code.** Meridian lives in
  `aking-beep/arc-control-sandbox`; its expected outcomes are never changed to
  make ARC pass.
- **Nobody merges.** Agents open and steward pull requests; a human merges.

## Using it

In Claude Code, from the repository root:

- Start any non-trivial task with the `deliver` skill.
- Delegate a stage to an agent by name, e.g. "use `arc-security-reviewer` on
  this diff".
- Before pushing: `npm run verify && npm run harness`.

The agents and skills are plain Markdown. Another agent runtime can use them
by reading `CLAUDE.md`, the agent file for the role, and the skill.

## What the base harness does not do yet

Stated so nobody assumes it:

- It does not run itself. Agents run when someone starts them; nothing
  triggers the pipeline on a schedule or on an incoming finding.
- It does not deploy. There is no deployment agent or skill, because ARC
  Control has no deployment target owned by this repository beyond the
  container image built in `.github/workflows/docker.yaml`.
- Client profiles prove a configuration against this build of ARC, in
  process. They do not prove a client's deployment: network isolation, real
  identity providers, real connectors, load. See
  [CLIENTS.md](./CLIENTS.md#what-a-profile-does-not-prove).
- Skill maturity is tracked by hand in [SKILLS.md](./SKILLS.md) and checked
  for consistency, not measured from outcomes (that is level 4).

## Roadmap

| Phase | Adds | Exit criterion |
| --- | --- | --- |
| **1 — Base (this)** | Contract, 12 agents, 7 skills, client profiles, self-checks in CI | `npm run harness` green in CI |
| 2 — Scripted | Every L1 skill gets a script (finding intake template, release-note linter, PR checklist generator); Meridian runs in CI against the sandbox | No skill below L2 |
| 3 — Gated | Meridian Phase 2 as a required CI job; client profiles versioned with a changelog per client; per-client policy diff on every PR | Enforcement changes cannot merge without independent validation |
| 4 — Measured | Outcome tracking per skill: defects escaped, findings reopened, time from finding to fix; client onboarding lead time | Each skill has a measured outcome and a target |
| 5 — Multi-client operations | Client deployment profiles (environment, connectors, identity provider) beside policy profiles; drift detection between a client's profile and its running deployment | A client's running configuration is checked against its profile |
