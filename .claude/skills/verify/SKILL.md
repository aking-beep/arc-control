---
name: verify
description: Runs every verification gate ARC Control's CI runs, in order, and reports exact counts and exit codes. Use before every push, to establish a baseline before a change, and whenever someone asks whether the build is green.
---

# Verify

Run from the repository root on Node 22 or later. Record each gate's exit
code and its counts; report them as a table. Never summarise a red gate as
green, and never re-run a failure hoping it passes.

| # | Gate | Command | Report |
| --- | --- | --- | --- |
| 1 | Install | `npm ci --ignore-scripts` (or `npm install` locally) | exit code |
| 2 | Build | `npm run build` | exit code; first compiler error verbatim |
| 3 | Unit tests | `node --test "packages/*/dist/**/*.test.js" "connectors/*/dist/**/*.test.js" "apps/*/dist/**/*.test.js"` | `# tests`, `# pass`, `# fail` lines |
| 4 | Evals | `node evals/run.js` | `N/M properties hold`; every FAIL line |
| 5 | Runtime dependencies | `node .github/scripts/check-dependencies.mjs` | exit code |
| 6 | Infrastructure | `node .github/scripts/check-infrastructure.mjs` | exit code |
| 7 | Published schemas | `node .github/scripts/check-schemas.mjs` | `N schema(s) OK` |
| 8 | Examples | `node examples/approval-required-agent/run.js && node examples/protected-mcp-server/run.js` | exit code |
| 9 | Console walkthrough | `node examples/console-walkthrough/run.js > /dev/null` | exit code |
| 10 | Showcase links | `node tools/showcase/build.mjs --out "$(mktemp -d)"` | exit code |
| 11 | Policy lint | `node .github/scripts/export-demo-policies.mjs /tmp/demo-policies.json && node packages/cli/dist/bin.js policy lint /tmp/demo-policies.json` | exit code |
| 12 | Harness | `node tools/harness/check-harness.mjs` | `N agent(s), M skill(s)`; every problem |
| 13 | Client profiles | `node tools/harness/validate-client.mjs` | `N/M client profile(s) valid`; every error and warning |

Gates 2–4 and 5–7 are what `npm run verify` and `npm run harness` wrap.
The CI job "CLI commands work against a real store" in
`.github/workflows/ci.yaml` drives the real binary against a `FileStore`
directory; run it when a change touches `packages/store` or `packages/cli`.

## Baseline and comparison

When verifying a change, run the same gates on the base commit first (a
`git worktree` keeps it separate) and report both columns. A failure that
exists on the base is reported as pre-existing, not as caused by the change.

## Output

```
| Gate | Base | Change |
| Unit tests | 672/672 | 680/680 |
| Evals | 82/82 | 83/83 |
...
```

Then the verbatim output of anything red.
