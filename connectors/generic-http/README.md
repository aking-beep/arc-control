# @arc-control/connector-generic-http

Execute authorized actions against arbitrary HTTP APIs.

## The decision worth knowing

**The host allowlist is mandatory, and it is not optional security theatre.**

This connector holds real credentials for the target API and is driven by
parameters an agent chose. Without an allowlist, a templated URL is a
server-side request forgery primitive pointed at the cloud metadata service —
from code holding those credentials. An empty allowlist refuses everything.

Five rules follow from that:

- **Templates fill the path and the body, never the host.** An agent chooses
  *what* to act on, never *where*.
- **Parameter values are percent-encoded as single path segments**, so a
  parameter cannot introduce a new segment, a query string or a scheme.
- **The final URL is re-checked against the allowlist**, not the template,
  because only the final URL is what gets requested.
- **Plaintext HTTP is refused** except on loopback.
- **Redirects are reported, not followed.** Following one would leave the
  allowlist behind.

A host entry beginning with `.` matches a whole domain
(`.example.com` matches `example.com` and any subdomain); anything else is
an exact match.

## Usage

```ts
import { GenericHttpConnector } from '@arc-control/connector-generic-http';

const connector = new GenericHttpConnector({
  allowedHosts: ['api.stripe.com'],
  headers: { authorization: `Bearer ${process.env.STRIPE_KEY}` },
});

await gateway.admin.registerTool({
  name: 'stripe.refund',
  description: 'Refund a charge.',
  effect: 'irreversible',
  connector: connector.name,
  connectorConfig: {
    url: 'https://api.stripe.com/v1/refunds',
    method: 'POST',
    bodyTemplate: { charge: '$chargeId', amount: '$amount' },
  },
  parameters: [
    { name: 'chargeId', type: 'string', required: true },
    { name: 'amount', type: 'integer', required: true, minimum: 0 },
  ],
}, actor);
```

The credential belongs to the connector. It must never appear in a tool
definition, and the agent must never see it.
