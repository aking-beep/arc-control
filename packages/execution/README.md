# @arc-control/execution

The connector contract, the tool registry and the executor.

## Why this package exists

This is the last link in the chain and deliberately the dumbest. It does not
consult policy, does not decide whether an action is permitted, and cannot be
reached except through the gateway.

## The decisions worth knowing

**A connector sees the action, the tool and the principal — and not the policy,
the decision or the approval.** By the time it is called, authorization has
already happened. A connector cannot second-guess, reinterpret or bypass it.

**Unregistered tools are refused before policy runs.** ARC Control will not
reason about a capability nobody declared. Undeclared parameters are rejected
rather than dropped: dropping would let a request succeed with the attack
invisible to both policy and the audit record.

**Retry depends on the tool's effect.** A `read` may be retried once on a
failure the connector marked retryable. A `write` or `irreversible` action
is attempted exactly once — one authorization, one effect. A timeout is never
retried whatever the effect, because a request that timed out may well have
taken effect upstream.

**Retryability is tracked separately from the error code.** An earlier version
overwrote a connector's code with `retryable`, which lost the real cause in
the evidence record.

**Connectors are trusted to be honest about failure.** One that swallows an
error and returns success writes a false evidence record — worse than no
evidence, because people act on records they believe. That trust is stated in
the contract; see [TRUST_MODEL.md](../../docs/TRUST_MODEL.md).

## Writing a connector

```ts
import { ConnectorError, type Connector } from '@arc-control/execution';

export class MyConnector implements Connector {
  readonly name = 'my-system';

  supports(tool) {
    return tool.connector === this.name;
  }

  async execute({ action, tool, signal }) {
    const response = await fetch(url, { signal });
    if (!response.ok) {
      throw new ConnectorError('http_error', `HTTP ${response.status}`, {
        retryable: response.status >= 500,
      });
    }
    return { output: await response.json() };
  }
}
```

If it takes a URL, require a host allowlist, fill templates in the path and
body but never the host, re-check the final URL rather than the template, and
refuse redirects. See `connectors/generic-http`.
