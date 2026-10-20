# @arc-control/mcp-security

MCP server and tool manifest validation, drift detection and tool-poisoning
checks.

## Why this package exists

A tool's *description* is model-facing text an agent reads and acts on. A
server operator — or anyone who has compromised one — can therefore attempt to
steer a client's agent purely through metadata, **without ever being called**.
That is tool poisoning, and no amount of argument inspection catches it,
because the attack is not in the arguments.

Nothing in MCP tells a client when a description changes, either. A tool that
passed review can silently become a poisoned one.

## The checks

| | |
|---|---|
| `MCP-SEC-001` | Instruction override — "ignore all previous instructions" |
| `MCP-SEC-002` | Credential or transcript solicitation |
| `MCP-SEC-003` | Instructions to chain into another tool |
| `MCP-SEC-004` | No usable description |
| `MCP-SEC-005` | Description long enough to bury text a reviewer will not read |
| `MCP-SEC-006` | Zero-width or bidirectional characters hiding text from a human while an agent still reads it |
| `MCP-SEC-010/011/012` | Missing, empty or unconstrained input schema |
| `MCP-SEC-020/021` | Invalid endpoint; plaintext HTTP off loopback |
| `MCP-SEC-022/023` | Duplicate tool name that could shadow a reviewed definition; empty tool list |
| `MCP-SEC-030/031/032` | A reviewed tool changed, a new tool appeared, a tool disappeared |

## The honest limit

Every check is a heuristic over text. They will miss a careful attacker and
they will occasionally flag innocent prose. **None of them is an authorization
control** — a finding is an operator signal, and policy remains the thing that
decides. Their value is that the common, mechanical attacks are caught at
review time by something that does not get tired.

## Manifest pinning

`manifestDigest` seals a server's advertised surface — names, descriptions and
schemas, canonically ordered — so a description that changes after review is
detectable. `detectDrift` reports what changed and rates a silently rewritten
description as critical.

## Usage

```ts
import { scanManifest, manifestDigest, detectDrift } from '@arc-control/mcp-security';

const report = scanManifest(manifest);
report.passed;          // false if anything is high or critical
report.findings;

const drift = detectDrift(pinnedManifest, await client.listTools());
drift.modified;         // tools whose description or schema changed
```

`arc mcp scan` exits non-zero on a high or critical finding, so a poisoned
description fails a pipeline rather than reaching production. `arc mcp diff`
catches a server that changed after review.
