# Agents

Fourteen agents, defined in `.claude/agents/`. Each file has the same sections —
Mission, Owns, Must, Must not, Done when, Hands off to, Report — so every role
is specified to the same depth and can be reviewed side by side. The shared
"Must not" list is identical across all of them.

## Roster

| Agent | Stage | Owns | Tools | Hands off to |
| --- | --- | --- | --- | --- |
| `arc-architect` | Plan | The plan; ADRs; the scope rule | read-only | engineers, `arc-security-reviewer` |
| `arc-gateway-engineer` | Build | `packages/gateway`, `packages/approvals`, `packages/execution` | read/write | `arc-security-reviewer` |
| `arc-policy-engineer` | Build | `packages/policy-engine`, the policy types, validator and schema | read/write | `arc-security-reviewer` |
| `arc-identity-engineer` | Build | `packages/agent-identity`, `packages/operator-identity` | read/write | `arc-security-reviewer` |
| `arc-evidence-engineer` | Build | `packages/evidence`, `packages/audit`, `packages/store` | read/write | `arc-security-reviewer` |
| `arc-connector-engineer` | Build | `connectors/`, `packages/mcp-security` | read/write | `arc-security-reviewer` |
| `arc-assurance-analyst` | Build | `packages/assurance`, the control catalogue | read/write | `arc-docs-steward` |
| `arc-client-onboarder` | Build | `clients/<id>/` | read/write | `arc-security-reviewer`, `arc-architect` |
| `arc-security-reviewer` | Review | Findings; `docs/THREAT_MODEL.md` | read-only | engineers, `arc-architect` |
| `arc-verifier` | Verify | Gate results | read-only | engineers, `arc-meridian-validator` |
| `arc-meridian-validator` | Validate | Independent Meridian results | read-only | `arc-architect`, `arc-docs-steward` |
| `arc-docs-steward` | Document | `docs/`, release notes, schemas' prose | read/write | `arc-verifier` |
| `arc-deployment-engineer` | Deploy | `infrastructure/`, the image, startup config, `tools/harness/deploy-smoke.mjs` | read/write | `arc-security-reviewer`, `arc-verifier` |
| `arc-harness-analyst` | Measure | Interpreting the scorecard; never the targets | read-only | owning agents, `arc-architect` |

"Read-only" agents have Read, Grep, Glob and Bash. They can run commands —
tests, the sandbox — but cannot edit files. `tools/harness/check-harness.mjs`
fails CI if a read-only role is given Edit or Write.

## Why these roles

The build agents follow the product's own boundaries — the packages in the
chain identity → authorization → policy → execution → evidence → security →
observability — so an agent's ownership matches the code a reviewer reads.
The rest are the controls around them:

- **Plan before build** (`arc-architect`): the most expensive defects found
  in this repository were ordering bugs that a plan naming the invariants
  would have caught.
- **Independent review** (`arc-security-reviewer`): the author of a change is
  the worst-placed person to find what it lets through.
- **Builders do not certify** (`arc-verifier`, `arc-meridian-validator`):
  results are reported by agents that cannot edit code.
- **Docs are part of done** (`arc-docs-steward`): a stale claim in a security
  document is itself a defect.
- **Clients are configuration, not forks** (`arc-client-onboarder`): every
  client is a validated profile against one codebase.
- **Deployment is owned** (`arc-deployment-engineer`): starting, persisting and
  restarting are checked by a script in CI, not assumed.
- **The harness measures itself** (`arc-harness-analyst`): breaches are explained
  and owned by an agent that cannot move the targets.

## Which agents start on their own

`.github/workflows/harness-agents.yaml` and `.github/workflows/harness-metrics.yaml`
start agents on events; see [README.md](./README.md#what-starts-automatically).
Any agent can also be started by hand from Claude Code.

## Adding an agent

1. Copy an existing agent file in `.claude/agents/`; keep every section.
2. Give it the narrowest tools that let it do its job.
3. Add it to the roster above and to the routing table in
   `.claude/skills/deliver/SKILL.md` if it owns an area.
4. Run `node tools/harness/check-harness.mjs`.

An agent earns its place by owning something no other agent owns. Two agents
with overlapping ownership is a design problem; resolve it by narrowing one.
