# The ARC Control delivery harness

**Status: L4 — every skill scripted, gated in CI and measured against targets
on a schedule.** Agents start on GitHub events once one secret is set (see
[Setup](#setup)).

## What it is

ARC Control governs AI agents. This harness governs the agents that **build,
verify, deploy and onboard clients onto ARC Control** — so the discipline the
product enforces on a customer's agents (declared roles, least privilege,
evidence, independent verification, measured outcomes) applies to the work on
the product itself.

| Part | Where | What it gives you |
| --- | --- | --- |
| **Operating contract** | `CLAUDE.md` | Invariants, commands, definition of done and never-list every agent works under. |
| **Agents** | `.claude/agents/` | Seventeen role-scoped agents with one shared structure. [AGENTS.md](./AGENTS.md). |
| **Skills** | `.claude/skills/` | Eight playbooks, each scripted, gated and measured (L4). [SKILLS.md](./SKILLS.md). |
| **Client profiles** | `clients/` | One validated JSON profile per client — how the harness scales to any client. [CLIENTS.md](./CLIENTS.md). |
| **Scripts** | `tools/harness/` | The skills' procedures as code, sharing one result format. |
| **Automation** | `.github/workflows/harness-*.yaml`, `meridian.yaml`, `ci.yaml` | What starts agents and runs the measurements. |
| **Metrics** | `tools/harness/metrics.json`, branch `harness-metrics` | Targets, and every measurement ever taken. |

## How a change flows

```
event ─┬─ PR opened ─────────────▶ CI: verify gates, delivery gates, steward checklist
       │                            meridian.yaml (decision path)  ─▶ independent check
       │                            harness-agents: arc-security-reviewer comments
       ├─ issue `finding` ───────▶ harness-agents: deliver + security-remediation ─▶ fix PR
       ├─ issue `client-onboarding` ▶ harness-agents: arc-client-onboarder ─▶ profile PR
       ├─ CI red on `harness:autofix` PR ▶ harness-agents: steward ─▶ fix pushed to that PR
       ├─ push to main / daily ──▶ harness-metrics: measure all skills ─▶ harness-metrics branch
       │                                       └─ breach ─▶ issue + arc-harness-analyst triage
       └─ by hand ───────────────▶ deliver skill in Claude Code
                                     1 baseline   arc-verifier
                                     2 plan       arc-architect
                                     3-4 build    owning engineer
                                     5 review     arc-security-reviewer
                                     6 verify     arc-verifier
                                     7 validate   arc-meridian-validator
                                     8 document   arc-docs-steward
                                     8a gates     pr-audit
                                     9 ship       steward (a human merges)
```

## What starts automatically

| Trigger | Workflow | What runs | Writes |
| --- | --- | --- | --- |
| Every pull request | `ci.yaml` | Build, tests, evals, harness check, client profiles, findings register, release-note lint, deployment smoke; delivery gates and steward checklist | Nothing (job summary) |
| Pull request on the decision path; nightly | `meridian.yaml` | The independent Meridian suite at a pinned sandbox commit | An artifact |
| Pull request on the decision path | `harness-agents.yaml` → `security-review` | `arc-security-reviewer` | One PR comment |
| Issue labelled `finding` | `harness-agents.yaml` → `remediate-finding` | `deliver` + `security-remediation` | A branch and a PR; an issue comment |
| Issue labelled `client-onboarding` | `harness-agents.yaml` → `onboard-client` | `arc-client-onboarder` | A branch and a PR; an issue comment |
| CI fails on a PR labelled `harness:autofix` | `harness-agents.yaml` → `fix-ci` | `steward` | Commits to that PR's branch, or a comment |
| `@claude` from an owner, member or collaborator | `harness-agents.yaml` → `mention` | The main session under `CLAUDE.md` | Comments, or a branch and PR |
| Push to main; daily; on demand | `harness-metrics.yaml` | `measure.mjs` over every skill, Meridian included | The `harness-metrics` branch; one `harness:metrics` issue on breach |
| A breach | `harness-metrics.yaml` | `arc-harness-analyst` | One issue comment |
| Push to main, tags | `docker.yaml` | Image build (tests and evals inside), smoke against the image | The image on GHCR |

Agents open pull requests and comments. **They never merge and never push to
main.** The metrics workflow writes only to the `harness-metrics` branch and to
issues.

Issue templates for the two labelled triggers are in `.github/ISSUE_TEMPLATE/`.

## Measurement (L4)

`tools/harness/measure.mjs` collects 22 metrics across all eight skills and the
harness itself, compares each with its target and records:

- `SCORECARD.md` — the latest table, with the change since the last run;
- `latest.json` — the same as data;
- `history.jsonl` — every snapshot ever taken, one per line.

These live on the `harness-metrics` branch, written only by the workflow. A
metric whose source is unavailable is **unmeasured**, never met. Run it
locally with:

```bash
npm run build
node tools/harness/measure.mjs --out-dir .harness            # GitHub metrics unmeasured without a token
GITHUB_TOKEN=... GITHUB_REPOSITORY=aking-beep/arc-control node tools/harness/measure.mjs --out-dir .harness
```

## Separation of duties in the harness

- **Builders cannot certify their own work.** Engineers write code; the
  verifier, Meridian validator and harness analyst have no Edit or Write
  tools. `check-harness.mjs` fails CI if a read-only role gains them.
- **Reviewers cannot fix what they find.** The security reviewer is read-only
  locally, and in CI it can only run `git` reads and post one comment.
- **The external check cannot be edited alongside the code.** Meridian lives in
  another repository, pinned by commit; its expectations are never changed here.
- **Nobody moves a target to go green.** Targets change only by pull request,
  and the analyst that explains breaches cannot edit them.
- **Nobody merges but a human.**

## Setup

One-time, by a repository admin:

1. **Enable the agents.** Add the repository secret `ANTHROPIC_API_KEY`
   (Settings → Secrets and variables → Actions). Without it every agent job
   logs that it is disabled and succeeds; CI, Meridian and measurement run
   regardless.
2. **Protect main.** Require pull requests and the CI checks ("Build, test and
   evals", "Delivery gates") before merging, and do not allow GitHub Actions to
   bypass it. This is what makes "agents never push to main" enforced rather
   than promised.
3. **Allow the metrics branch.** If branch rules apply to all branches, exempt
   `harness-metrics`, which the metrics workflow pushes to with `GITHUB_TOKEN`.
4. **Create the labels** `finding`, `client-onboarding` and `harness:autofix`
   (the metrics workflow creates `harness:metrics` itself).

## Using it by hand

In Claude Code, from the repository root: start any non-trivial task with the
`deliver` skill; delegate a stage by naming an agent ("use
`arc-security-reviewer` on this diff"); before pushing, run
`npm run verify && npm run harness`.

## What L4 does not mean

- **Measured is not good.** L4 says each skill's outcome is measured against a
  target over time. The scorecard says whether the target is met.
- **Automation is not autonomy.** Agents act on events and open pull requests;
  a human decides what merges and what ships.
- **Pull-request metrics start empty.** They count PRs merged after
  `measuredFrom` in `tools/harness/metrics.json`, and are unmeasured until
  there are some.
- **A deployment smoke test is not a production sign-off**, and a valid client
  profile is not proof a client's deployment is secure
  ([CLIENTS.md](./CLIENTS.md#what-a-profile-does-not-prove)).
- **The agent workflows run only with the API key set**, and were not
  exercised end to end before that secret existed.

## Roadmap

| Phase | Status | Adds |
| --- | --- | --- |
| 1 — Base | done | Contract, agents, skills, client profiles, self-checks in CI |
| 2 — Scripted | done | A script behind every skill |
| 3 — Gated | done | Every script run by a workflow; Meridian in CI at a pinned commit |
| 4 — Measured | done | 22 metrics with targets, scheduled measurement, history, breach issues and triage |
| 5 — Multi-client operations | next | Per-client deployment profiles beside policy profiles; drift detection between a client's profile and its running deployment; per-client scorecards |
