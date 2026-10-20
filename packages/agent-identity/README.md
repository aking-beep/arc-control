# @arc-control/agent-identity

Agent registration, API-key credentials and principal resolution.

## Why this package exists

Identity is the gateway's first gate. Policy cannot bound an agent it cannot
name, and evidence cannot attribute an act to a principal that was never
established — so nothing downstream runs until this produces an
`AgentPrincipal`.

## The decisions worth knowing

**Every authentication failure is indistinguishable.** Absent key, malformed
key, unknown reference, wrong secret, revoked, expired — all raise the same
error with the same message. A caller learns that the key did not work and
nothing more, so the endpoint cannot be used to enumerate valid credentials.
An eval asserts the messages are identical.

Agent suspension is the one deliberate exception: an operator who has pulled an
agent's stop button wants that in the agent's own logs, and it leaks only the
status of an agent whose credential the caller already holds.

**Keys are `arck_<reference>_<secret>`.** The public reference locates the
credential in one lookup; the 256-bit secret is never stored. Only a salted
SHA-256 is kept, compared in constant time, and the plaintext is returned once
at issue and never recoverable.

**SHA-256 rather than a slow KDF, deliberately.** A slow KDF defends
low-entropy human passwords against offline guessing. These secrets are 256
bits of machine-generated randomness, so guessing is not the threat — and a
slow KDF would add latency to the hot path of every single agent action.

**Suspension is checked before policy.** It is the per-agent stop button the
console exposes, and the seam the v0.2 kill switch builds on.

## Usage

```ts
import { AgentRegistry } from '@arc-control/agent-identity';

const agents = new AgentRegistry(store);

const agent = await agents.register({
  name: 'finance-agent',
  owner: 'finance-ops@example.com',
  roles: ['finance'],
});

const { apiKey } = await agents.issueKey(agent.id); // shown once

const principal = await agents.authenticate(apiKey);
```

Prefer `gateway.admin.*` over calling the registry directly: those methods
write audit records, and registering an agent or issuing a credential changes
what can happen in the world.
