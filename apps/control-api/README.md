# @arc-control/control-api

The primary ARC Control HTTP API.

## Two credentials, two audiences

The distinction is load-bearing.

**Agents** present an agent API key and may do exactly two things:

```
POST /v1/actions           submit an action for a decision
POST /v1/actions/explain   ask what policy would do, recording nothing
```

They cannot read policy, read evidence, approve anything or see other agents.
*An agent that could edit the policy governing it would not be governed.*

**Operators** present the operator token and manage everything else: agents,
tools, policies, approvals, evidence, audit, MCP scanning.

## Status codes worth knowing

| | |
|---|---|
| `200` | A decision was made. **Including a denial** — the agent asked, policy answered, and the answer was no. |
| `202` | Held for a human. The body carries an `approvalId`. |
| `403` | Policy denied *the caller*, or the agent is suspended. |
| `409` | A conflict: a reused idempotency key with different parameters, an approval already consumed, or an audit chain that failed verification. |

## The v0.1 operator gap

Operators authenticate with **one shared token**, and identity comes from the
`x-arc-operator` header. Anyone holding the token can claim any identity.

That is adequate for a pilot behind an existing identity-aware proxy — where
the proxy establishes identity and ARC Control records it — and inadequate for
anything else. `src/operator.ts` is the seam real RBAC and SSO replace in
v0.5. The claimed identity is recorded on every vote and in every audit record,
so a disputed approval can be traced to the token and the claim made.

Operator endpoints refuse every request when no token is configured. That is
the correct default: an unauthenticated control plane is worse than none,
because people believe it.

## Running it

```bash
ARC_OPERATOR_TOKEN=$(openssl rand -hex 32) \
ARC_DATA_DIR=./arc-data \
ARC_SEED_DEMO=true \
npm run api
```

| | |
|---|---|
| `ARC_PORT` / `ARC_HOST` | default `8787` / `127.0.0.1` |
| `ARC_DATA_DIR` | durable store; in-memory if unset |
| `ARC_OPERATOR_TOKEN` | operator endpoints refuse everything without it |
| `ARC_SEED_DEMO` | `true` loads the worked example |

## No web framework

Built on `node:http` with a hand-written router in `src/http.ts`. A control
plane's supply chain is part of its threat model, and this is the component a
security team reads line by line before putting it in front of their systems —
so every line of the request path is in this directory.
