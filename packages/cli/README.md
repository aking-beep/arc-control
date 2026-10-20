# @arc-control/cli

`arc` — the ARC Control command line.

## Why this package exists

Two jobs, both of which need to happen outside a running deployment.

**Making policy trustworthy before it governs anything.** `arc policy lint`
catches a document that cannot decide; `arc policy test` answers "what would
this do to that action?" in CI, where it is cheap, rather than in production,
where it is not. `arc mcp scan` exits non-zero on a poisoned tool
description, so it fails a pipeline instead of reaching an agent.

**Verification an auditor can run themselves.** `arc audit verify` and
`arc evidence verify` work on an export, with no server, no credentials and
no network — so the party checking does not have to trust the party that
produced the record.

## Commands

```
arc policy lint <file...>                      Validate policy documents
arc policy test --policy <f> --input <f>       Evaluate actions; --trace for the rule trace

arc mcp scan --endpoint <url>                  Scan a live MCP server
arc mcp scan <manifest.json>                   Scan a captured manifest
arc mcp diff --pinned <f> --endpoint <url>     Detect drift from a pinned manifest

arc audit verify --data <dir>                  Verify a store's audit chain
arc audit verify --file <audit.jsonl>          Verify an exported chain
    --expect-head <digest>                     Head recorded from an anchor
    --expect-records <count>                   Sequence the chain should reach
arc evidence verify <evidence.json>            Verify exported evidence records

arc demo                                       The refund workflow, end to end
```

Exit codes: `0` success, `1` a check failed, `2` used incorrectly. Every
command is designed to gate a pipeline.

## Two things worth knowing

**`arc audit verify` says what it checked against.** Walking a hash chain
cannot detect truncation, so without a recorded head the command reports that
truncation would not have been detected rather than printing a clean result.
Pass `--expect-head` with a digest anchored outside ARC Control for the real
check.

**`bin/arc.js` is a committed launcher, not the CLI.** npm links a
workspace's `bin` entries during installation — before any `prepare` script
has compiled anything — so a `bin` pointing straight at `dist/` is skipped
on a fresh clone and `npx arc` reports that it cannot find an executable.
Pointing at a file that always exists gets the symlink created.
