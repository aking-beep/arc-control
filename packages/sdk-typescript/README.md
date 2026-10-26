# @arc-control/sdk-typescript

TypeScript client for the ARC Control API.

## The decision worth knowing

The client mirrors the API's two-credential split, because the distinction is
load-bearing. An agent integration constructs it with `apiKey` alone and gets
exactly one capability: submitting an action for a decision. An agent that
could read or edit the policy governing it would not be governed.

**A denial is a successful call**, returning `outcome: 'denied'` rather than
throwing. The agent asked, policy answered, and the answer was no — making that
an exception encourages callers to swallow it. The agent learns the reason and
the policy, which is what lets it escalate to a human instead of retrying
something it will never be allowed.

## Usage

```ts
import { ArcControlClient } from '@arc-control/sdk-typescript';

// An agent. One capability.
const arc = new ArcControlClient({
  baseUrl: 'https://control.example.com',
  apiKey: process.env.ARC_AGENT_KEY,
});

const result = await arc.act({
  tool: 'stripe.refund',
  parameters: { customer: 'customer_123', amount: 4200 },
  intent: 'Refund customer_123: customer dispute',
  correlationId: 'run_2026_10_20_a',
});

if (result.outcome === 'denied') {
  escalate(result.decision.reason, result.evidenceId);
}

// An operator, signed in. Everything else.
//
// The session is the one the API issued at the end of the sign-in flow. The
// identity and roles come with it, so there is nothing to assert here: a vote
// cast on this client is recorded as `authenticated`.
const operator = new ArcControlClient({
  baseUrl: 'https://control.example.com',
  operatorSession: sessionCookieFromTheBrowser,
});

const me = await operator.whoami();  // { identity, roles, assurance }

// An operator, on the shared token. A fallback for a deployment with no
// identity provider: the API knows the request is authorized but not who sent
// it, so a vote is recorded as `asserted_by_proxy` and the console says so.
// Configure single sign-on and the API stops accepting this.
const unattributed = new ArcControlClient({
  baseUrl: 'https://control.example.com',
  operatorToken: process.env.ARC_OPERATOR_TOKEN,
  operatorIdentity: 'cfo@example.com',
  operatorRoles: ['finance-manager'],
});

const { approvals } = await operator.listApprovals({ mine: true });
await operator.vote(approvals[0].id, 'approve', 'verified with the customer');
await operator.executeApproved(approvals[0].id);
```

Errors arrive as `ArcError` with the API's own code preserved across the
wire, so a caller can branch on `error.code` rather than on a message.
