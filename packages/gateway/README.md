# @arc-control/gateway

The decision point every agent action passes through.

## Why this package exists

Without a single place every action passes through there is no control plane —
only a library some agents remembered to call.

```
identify the agent → resolve the tool, validate parameters → evaluate policy
  → allow | hold for a human | deny → execute → capture evidence → audit
```

## The two invariants

Both hold on every path through this class, including every error path, and
both are covered by tests and asserted in the evals.

**Nothing executes without a decision.** The only call to the executor is
downstream of an `ALLOW`, or of an approval the policy itself demanded.

**Every action that reaches the gateway leaves evidence** — allowed, held,
executed, failed or denied. The attempt is itself the security signal, so there
is no path that discards it.

The one case without an evidence record is an action refused *before* a
decision: an unknown tool, or parameters that violate the tool contract. There
is no decision to evidence, and minting one would imply a policy looked at
something it never saw. Those are audited as `action.denied` with the reason.

## Administration is here, not in the API

`gateway.admin` carries registering an agent, defining a tool, publishing a
policy, issuing and revoking credentials, and suspending an agent. Each one
changes what agents may do, so each is audited.

They live on the gateway so **every entry point is audited by construction** —
the HTTP API, the CLI and a seed script all go through one path, and none can
forget. An earlier arrangement audited them in the route layer only, which
meant seeding a deployment left an empty audit log.

## Usage

```ts
import { Gateway } from '@arc-control/gateway';
import { MemoryStore } from '@arc-control/store';

const gateway = new Gateway({ store: new MemoryStore() });
gateway.addConnector(connector);

await gateway.admin.registerTool({ /* … */ }, actor);
await gateway.admin.publishPolicy(policy, actor);
const agent = await gateway.admin.registerAgent({ /* … */ }, actor);
const { apiKey } = await gateway.admin.issueKey(agent.id, actor);

// What an agent calls.
const result = await gateway.handle(apiKey, {
  tool: 'stripe.refund',
  parameters: { customer: 'customer_123', amount: 4200 },
});
// → { outcome: 'denied', decision: { policyId: 'FINANCE-004', … }, evidenceId: 'arc_ev_…' }

// After a human approves.
await gateway.resume(result.approvalId);

// What policy *would* do, recording nothing and executing nothing.
await gateway.explain(principal, request);
```
