---
name: steward
description: How to drive an ARC Control pull request to mergeable — CI, review bots, human review, conflicts with main — in this repository's conventions. Use after opening a PR or when asked to watch one.
---

# Steward a pull request

## Conventions

- **Never merge.** A human merges. Never push to `main`.
- **Branches.** Work on a feature branch. On a branch you created you may
  rebase or force-push with `--force-with-lease`; on anyone else's, merge
  `main` in instead and never rewrite history.
- **Main moves.** Before resolving a conflict, read what landed on `main`. If
  `main` already fixed the same problem with a different design, stop and ask
  the user whether to narrow the PR to what `main` lacks; do not resolve two
  designs into one by picking lines.
- **CI.** The workflows are `.github/workflows/ci.yaml`, `security.yaml` and
  `docker.yaml`. Reproduce a failure locally with the `verify` skill before
  pushing a fix. Never skip, disable or loosen a test or eval to get green.
- **Review bots.** Cursor Bugbot reviews every push. Treat each finding as a
  claim: trace a real path from a caller to the failure. Fix and push when it
  is real and in proportion; otherwise reply on the thread with the path you
  traced and why. Reply once per thread and resolve it when addressed.
- **Human review.** Push small asks; reply with a proposal for anything that
  changes an API, a schema or a design, and let the author decide.
- **PR text.** Keep the description true after every push: scope, behaviour
  changes, verification numbers, limitations. Update it when scope changes.

## Checklist

`node tools/harness/pr-state.mjs --pr <n>` (needs `GITHUB_TOKEN`) prints
mergeability, the check rollup on the head, open review threads and draft
status as one checklist. CI writes it to the job summary of every PR. Steward
outcomes — green at merge, threads left unresolved, time to merge — are
measured by `tools/harness/measure.mjs`.

On a PR labelled `harness:autofix`, a red CI run starts this skill
automatically (`.github/workflows/harness-agents.yaml`, job `fix-ci`).

## Every event

Look at the whole PR on its current head: mergeability, CI on the latest
commit, open review threads. Act on every open item. A red or conflicted PR
is never "waiting on review".
