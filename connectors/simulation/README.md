# @arc-control/connector-simulation

A deterministic in-process connector for examples, evals and tests.

## Why this package exists

So the control path can be exercised honestly.

The examples and eval suites run the real gateway, the real policy engine, the
real approval engine, the real evidence builder and the real audit chain. Only
the final side effect is fictional. Nothing about authorization is stubbed out,
which is the whole point: **a demo that fakes the decision proves nothing.**

## The useful part

It records every call it was asked to make, which lets a test assert the
stronger claim — not that a denial returned `denied`, but that the action
never reached the system at all:

```ts
assert.equal(connector.callCount('stripe.refund'), 0);
```

That assertion appears throughout `evals/`, and it is the one that actually
matters.

## Usage

```ts
import { SimulationConnector } from '@arc-control/connector-simulation';

const connector = new SimulationConnector()
  .handle('stripe.refund', (parameters) => ({
    refundId: 're_simulated',
    amount: parameters.amount,
  }));

gateway.addConnector(connector);

connector.calls;       // every call that reached the connector, in order
connector.callCount(); // how many
connector.reset();
```
