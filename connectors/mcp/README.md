# @arc-control/connector-mcp

Front an MCP server so every tool call is authorized, executed and evidenced by
ARC Control.

## Why this package exists

MCP is where enterprise agents are gaining the ability to act, and the protocol
carries no notion of authorization: a client that can reach a server can call
anything the server advertises. ARC Control in front turns that tool list from
a set of capabilities into a set of *requests*.

## The decisions worth knowing

**Scanning happens at `connect()`, before any tool is registered.** An
operator should see a poisoned description while deciding whether to expose the
server — not once agents are already calling it.

**Pin verification depends on the tool's effect.** A `read` tool trusts a
verified surface for 60 seconds: re-listing before every query would double the
latency ARC Control adds, and a stale pin on a read means one query ran against
a changed description. A `write` or `irreversible` tool is verified
**before every call**, because a stale pin there means taking an irreversible
action on behalf of a description nobody approved, and no latency saving
justifies that.

`manifestRecheckMs` overrides this with one window for every effect; `0`
always verifies.

**Generated tool definitions are pessimistic.** `toToolRegistrations()`
marks everything `write` / `high` risk unless the server annotates the tool
`readOnlyHint`. Guessing low on an unknown remote capability is the one
mistake that cannot be walked back, so an operator lowers it deliberately.

**A tool-level failure is raised, not returned.** MCP reports one in the result
body rather than as a JSON-RPC error; treating that as success would write a
false evidence record.

**The client is hand-written against built-in `fetch`.** No MCP SDK, so the
control plane has no dependency it cannot audit, and the request ARC Control
actually sends is visible in `client.ts`. HTTP only for now; stdio is in the
roadmap.

## Usage

```ts
import { McpConnector } from '@arc-control/connector-mcp';

const connector = new McpConnector({ endpoint: 'https://mcp.vendor.example.com' });
const { manifest, report } = await connector.connect();

if (!report.passed) throw new Error('do not expose this server as advertised');

gateway.addConnector(connector);
for (const tool of connector.toToolRegistrations({ prefix: 'vendor' })) {
  await gateway.admin.registerTool(tool, actor);
}

const drift = await connector.checkForDrift();
```

A worked end-to-end example, including a poisoned server:
[`examples/protected-mcp-server`](../../examples/protected-mcp-server).
