---
name: meridian-validate
description: Runs the independent Meridian synthetic-enterprise suite (aking-beep/arc-control-sandbox) against a local ARC Control checkout — sandbox unit tests, the 17 integration scenarios, the Phase 2 security checks and the stress presets — and collects the reports. Never modifies the sandbox. Use after local gates are green on any enforcement change.
---

# Validate against Meridian

Meridian is a separate repository on purpose: a harness that cannot be edited
alongside the code it tests. Its expected outcomes are never changed to make
ARC pass. A failing check is a finding.

## Setup

```bash
git clone https://github.com/aking-beep/arc-control-sandbox ../arc-control-sandbox
# Phase 2 lives on the integration branch until it merges:
git -C ../arc-control-sandbox checkout claude/meridian-validation-lab-integration-28bcpi
```

The ARC checkout must be built (`npm install && npm run build`). Ports 8787,
8788 and 8890 on 127.0.0.1 must be free.

## Run

```bash
.claude/skills/meridian-validate/run.sh <path-to-arc-checkout> <label> [path-to-sandbox]
```

It runs `npm test`, `npm run preflight`, starts the stack, runs
`npm run validate` (17 scenarios) and `npm run phase2` (Phase 2 + stress +
the 17 again), stops the stack, and writes everything to
`$MERIDIAN_OUT/<label>/` (default `./.meridian/<label>/`, git-ignored).

`npm run phase2` exits non-zero when any implemented check or stress preset
fails. That exit code is the result.

CI runs this in `.github/workflows/meridian.yaml` on every change to the
decision path and nightly, against a pinned sandbox commit. The run writes
`result.json` in the harness format, which `tools/harness/measure.mjs`
reads (`--meridian`).

## Report

- sandbox revision and ARC revision (`git rev-parse HEAD` in each)
- integration: `N/17`
- Phase 2: pass / fail / unsupported / not implemented
- stress: each preset and seed, pass or fail, with effect counts
- the verbatim text of every FAIL row

To compare, run once on the base checkout and once on the change, with
different labels.
