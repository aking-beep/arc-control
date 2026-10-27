# Meridian Commerce Group (synthetic)

Meridian is a fictional enterprise used to validate ARC Control. Its full
harness — a business backend that records real effects, an HTTP scenario
runner, Phase 2 security checks and stress presets — lives in
`aking-beep/arc-control-sandbox`. This profile mirrors that sandbox's
configuration (`src/start.mjs`) so the same tools, agents and policies are
also checked in ARC's own CI, in process.

## Context

Six departments, one agent each: finance (refunds), support (tickets), IT
(deployments), sales (CRM exports), HR (salary reads), security (quarantine).
Every policy guards its tool to one agent and defaults to deny. Environment:
`sandbox`.

## Scenarios

Sixteen, covering the deterministic in-process subset of the sandbox's 17
integration scenarios (allowed, held, approved-and-released, denied, wrong
agent, unknown tool, malformed input, protected deployment, CRM export,
quarantine) plus a wrong-agent check on support tickets. The sandbox scenarios
that need HTTP or process state — suspension, kill switch, idempotency,
operator isolation, direct backend bypass, approval replay — stay in the
sandbox.

## Accepted warnings

None.

## Unmet requirements

From the sandbox's Phase 2 report: cross-tenant isolation, an audit head
anchored outside ARC, network segmentation of the internal endpoints, and MCP
drift enforced at runtime are not provided by this build of ARC.
