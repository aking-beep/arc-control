# Skills

Seven skills, defined in `.claude/skills/<name>/SKILL.md`. A skill is a
playbook the main session (or an agent) follows for a recurring kind of work.

## Maturity levels

Every skill is held to the same ladder. A level is a claim about the skill,
and `tools/harness/check-harness.mjs` checks the claims it can check.

| Level | Name | Means | Checked by the harness |
| --- | --- | --- | --- |
| L1 | Documented | A written playbook with gates and a "never" list. | Frontmatter, referenced paths and agents exist. |
| L2 | Scripted | The skill's core procedure is an executable script in the repository. | The evidence script exists. |
| L3 | Gated | That script runs in CI on every pull request. | The evidence appears in `.github/workflows/ci.yaml`. |
| L4 | Measured | Outcomes are tracked over time against a target. | Not yet — phase 4. |

Promotion is one level at a time, and a skill only moves up when the thing
that makes the level true is merged.

## Catalogue

| Skill | Level | Used for | Evidence |
| --- | --- | --- | --- |
| `deliver` | L1 | Any non-trivial change: routes stages to agents with exit gates | `.claude/skills/deliver/SKILL.md` |
| `verify` | L3 | Running every CI gate locally with exact counts | `evals/run.js` |
| `security-remediation` | L1 | Fixing a confirmed finding: reproduce, root cause, failing test first | `.claude/skills/security-remediation/SKILL.md` |
| `meridian-validate` | L2 | Running the independent Meridian suite against a checkout | `.claude/skills/meridian-validate/run.sh` |
| `client-onboarding` | L3 | Building and validating a client profile | `tools/harness/validate-client.mjs` |
| `steward` | L1 | Driving a pull request to mergeable without merging | `.claude/skills/steward/SKILL.md` |
| `release-notes` | L1 | Writing the release note for a change | `.claude/skills/release-notes/SKILL.md` |

## Next promotions

| Skill | To | What it takes |
| --- | --- | --- |
| `meridian-validate` | L3 | A CI job that checks out the sandbox and runs `run.sh`; needs the sandbox's Phase 2 branch merged so the job has a stable ref. |
| `security-remediation` | L2 | A script that scaffolds a finding: the release-note section, a failing test file named for the finding, and a checklist. |
| `release-notes` | L2 | A linter that fails when a release note is missing "Behaviour changes" or "What this does not establish". |
| `steward` | L2 | A script that prints a PR's full state (mergeability, checks, open threads) as one checklist. |
| `deliver` | L2 | A stage tracker that records each gate's result for a change. |

## Adding a skill

1. Create `.claude/skills/<name>/SKILL.md` with `name` and `description`
   frontmatter. The description is what an agent routes on: say when to use it.
2. Add a row to the catalogue above, starting at L1.
3. Run `node tools/harness/check-harness.mjs`.
