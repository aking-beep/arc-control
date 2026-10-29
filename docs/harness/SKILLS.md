# Skills

Eight skills, defined in `.claude/skills/<name>/SKILL.md`. A skill is a
playbook the main session (or an agent) follows for a recurring kind of work.
**Every skill is at L4.**

## Maturity levels

Every skill is held to the same ladder. A level is a claim about the skill,
and `tools/harness/check-harness.mjs` checks each claim in CI.

| Level | Name | Means | Checked by the harness |
| --- | --- | --- | --- |
| L1 | Documented | A written playbook with gates and a "never" list. | Frontmatter; referenced paths and agents exist. |
| L2 | Scripted | The skill's core procedure is an executable script in the repository. | The evidence script exists. |
| L3 | Gated | That script runs in a GitHub workflow. | A file in `.github/workflows/` runs the evidence script. |
| L4 | Measured | The skill's outcomes are measured against targets, on a schedule, with history kept. | The skill has metrics with numeric targets in `tools/harness/metrics.json`, from sources `tools/harness/measure.mjs` collects, every metric is listed below, and a scheduled workflow runs the measurement. |

A metric whose source is unavailable is reported as **unmeasured** — never as
met. L4 means the outcome is measured, not that it is good; the scorecard says
which.

## Catalogue

| Skill | Level | Used for | Evidence |
| --- | --- | --- | --- |
| `deliver` | L4 | Any non-trivial change: routes stages to agents with exit gates | `tools/harness/pr-audit.mjs` |
| `verify` | L4 | Running every CI gate locally with exact counts | `evals/run.js` |
| `security-remediation` | L4 | Fixing a confirmed finding: reproduce, root cause, failing test first, register | `tools/harness/findings.mjs` |
| `meridian-validate` | L4 | Running the independent Meridian suite against a checkout | `.claude/skills/meridian-validate/run.sh` |
| `client-onboarding` | L4 | Building and validating a client profile | `tools/harness/validate-client.mjs` |
| `steward` | L4 | Driving a pull request to mergeable without merging | `tools/harness/pr-state.mjs` |
| `release-notes` | L4 | Writing the release note for a change | `tools/harness/lint-release-notes.mjs` |
| `deploy` | L4 | Starting, enforcing, persisting and restarting a deployment | `tools/harness/deploy-smoke.mjs` |

## Where each skill is gated (L3)

| Skill | Workflow |
| --- | --- |
| `deliver` | `.github/workflows/ci.yaml`, job "Delivery gates", on every PR |
| `verify` | `.github/workflows/ci.yaml`, job "Build, test and evals" |
| `security-remediation` | `.github/workflows/ci.yaml`, step "Security findings register" |
| `meridian-validate` | `.github/workflows/meridian.yaml`, decision-path PRs and nightly |
| `client-onboarding` | `.github/workflows/ci.yaml`, step "Client profiles" |
| `steward` | `.github/workflows/ci.yaml`, job "Delivery gates", step "Steward checklist" |
| `release-notes` | `.github/workflows/ci.yaml`, step "Release notes state verification and limits" |
| `deploy` | `.github/workflows/ci.yaml`, step "Deployment smoke"; `.github/workflows/docker.yaml` against the image |

## Metrics (L4)

Defined in `tools/harness/metrics.json`, collected by `tools/harness/measure.mjs`,
run by `.github/workflows/harness-metrics.yaml` daily, on every push to main and
on demand. History lives on the `harness-metrics` branch (`history.jsonl`,
`latest.json`, `SCORECARD.md`). Pull-request metrics count only PRs merged after
`measuredFrom` in the definitions, so the harness is not scored on work that
predates it.

| Skill | Metric | Target | Source | Measures |
| --- | --- | --- | --- | --- |
| `verify` | `verify.main_ci_success_rate` | >= 0.95 | `github-ci` | Share of the last 30 completed CI runs on main that succeeded. |
| `verify` | `verify.main_ci_runs` | >= 1 | `github-ci` | Completed CI runs on main in the sample (the rate is meaningless without them). |
| `verify` | `verify.claim_problems` | <= 0 | `claims` | Statements ARC makes about itself that `tools/harness/check-claims.mjs` finds contradicted by the code: version incoherence, or a document denying a capability whose implementation is present. |
| `deliver` | `deliver.gate_pass_rate` | >= 1 | `github-prs` | Share of PRs merged since measurement began that passed the delivery gates (tools/harness/pr-audit.mjs), waivers counting as passes. |
| `deliver` | `deliver.waiver_rate` | <= 0.2 | `github-prs` | Share of merged PRs that waived a delivery gate. Waivers are allowed; a rising rate means the gates are wrong or being avoided. |
| `security-remediation` | `security.oldest_open_days` | <= 14 | `findings` | Age in days of the oldest open or in-progress finding. |
| `security-remediation` | `security.open_critical` | <= 0 | `findings` | Open critical findings. |
| `security-remediation` | `security.fixed_with_tests_rate` | >= 1 | `findings` | Share of fixed findings that name an existing regression test. |
| `security-remediation` | `security.median_days_to_fix` | <= 7 | `findings` | Median days from a finding being found to being fixed. |
| `meridian-validate` | `meridian.integration_failed` | <= 0 | `meridian` | Meridian's original 17 integration scenarios that failed. |
| `meridian-validate` | `meridian.phase2_fail` | <= 0 | `meridian` | Meridian Phase 2 implemented checks that failed. |
| `meridian-validate` | `meridian.stress_failed_presets` | <= 0 | `meridian` | Meridian stress presets (100/500/1000 x 3 seeds) that failed. |
| `client-onboarding` | `clients.profiles_invalid` | <= 0 | `client-profiles` | Client profiles that do not validate against this build. |
| `client-onboarding` | `clients.scenario_pass_rate` | >= 1 | `client-profiles` | Share of client scenarios producing their expected outcome and effect count. |
| `client-onboarding` | `clients.warnings_total` | <= 0 | `client-profiles` | Validator warnings across all client profiles. Each one is fixed or accepted in the client's README. |
| `steward` | `steward.green_at_merge_rate` | >= 1 | `github-prs` | Share of PRs merged since measurement began whose head checks were green. |
| `steward` | `steward.unresolved_threads_at_merge` | <= 0 | `github-prs` | Review threads left unresolved on PRs when they merged. |
| `steward` | `steward.median_hours_to_merge` | <= 72 | `github-prs` | Median hours from a PR opening to merging. |
| `release-notes` | `release.notes_passing_rate` | >= 1 | `release-notes` | Share of release notes with a Verification section and a stated-limits section. |
| `release-notes` | `release.decision_prs_with_note_rate` | >= 1 | `github-prs` | Share of merged decision-path PRs that updated a release note. |
| `deploy` | `deploy.checks_passed_rate` | >= 1 | `deploy` | Share of deployment smoke checks passing: start, enforce, verify, restart, persist. |
| `deploy` | `deploy.time_to_healthy_ms` | <= 10000 | `deploy` | Milliseconds from process start to a healthy /health on a durable store. |
| `harness` | `harness.problems` | <= 0 | `harness` | Problems tools/harness/check-harness.mjs finds in the agents, skills and catalogue. |

## When a target is breached

The metrics workflow opens (or comments on) one issue labelled
`harness:metrics` with the scorecard, and, when agents are enabled, the
`arc-harness-analyst` agent comments a triage: cause, whether the work or the
target is wrong, owner, next action. Targets change only by pull request, with
the reason in the description — never to turn a scorecard green.

## Adding a skill

1. Create `.claude/skills/<name>/SKILL.md` with `name` and `description`
   frontmatter. The description is what an agent routes on: say when to use it.
2. Add a row to the catalogue at L1, and promote it one level at a time:
   a script (L2), a workflow running it (L3), metrics with targets (L4).
3. Run `node tools/harness/check-harness.mjs`; it refuses a level the skill has
   not earned.
