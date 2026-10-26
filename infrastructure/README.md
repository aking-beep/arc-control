# Infrastructure

Three deployment targets for the same single-node shape.

| | |
|---|---|
| [`docker/`](./docker) | A Dockerfile and a Compose file. The quickest honest deployment. |
| [`kubernetes/`](./kubernetes) | Manifests plus a Kustomization, including the network policy that makes the whole thing mean anything. |
| [`terraform/`](./terraform) | The same shape, for clusters managed with Terraform. |

## The three things that make a correct control plane useless

Read these before deploying, because none of them is something the code can fix
about itself.

**1. An agent that can reach the target system directly.**

ARC Control's guarantees hold only while the gateway is the agent's *only*
route. If an agent holds a Stripe credential of its own, policy and evidence
are decoration. This is a deployment property — network segmentation and
credential custody — and it is the single most important control.

`kubernetes/networkpolicy.yaml` shows the shape: agents may reach the control
API and nothing else outbound; only the API may reach target systems. The
Terraform module deliberately does not guess at this.

**2. An unconfigured identity provider.**

Nothing here points ARC Control at one. Until you do, the deployment falls back
to the shared operator token and attributes every approval to whatever
`ARC_OPERATOR_IDENTITY` says — recorded honestly as `claimed`, which is not the
evidence an auditor wants. Configure OpenID Connect (`ARC_OIDC_ISSUER`,
`ARC_OIDC_CLIENT_ID`, `ARC_OIDC_CLIENT_SECRET`, `ARC_SESSION_SECRET`) and the
API stops accepting the token at all. Failing that, put an identity-aware proxy
in front and treat the operator token as a shared administrative secret. See
[TRUST_MODEL.md](../docs/TRUST_MODEL.md#what-an-operator-is-trusted-with-and-how-far-that-trust-is-established).

**3. An unbacked-up volume.**

The audit chain and every evidence record live on it. Snapshot it, and record
the head digest somewhere outside the deployment — that anchor is what turns
tamper *evidence* into tamper *proofing*, and it is also the only thing that
makes truncation of the log detectable:

```bash
arc audit verify --data /var/lib/arc-control
# → prints the head digest; store it, then pass it back with --expect-head
```

## Why one API replica everywhere

The v0.1 store is a single-node append-only file store. Two writers on one
volume would interleave appends and fork the audit hash chain, so the API runs
as one replica with a `Recreate` strategy — a rolling update would briefly run
two pods against the same ReadWriteOnce volume.

The console is stateless and scales freely.

Horizontal scale for the API waits for the clustered store in v0.5. The
`ControlStore` interface exists now so that change does not reach the gateway.

## Operator token

Every target requires one, and operator endpoints refuse every request without
it. That is the correct default: an unauthenticated control plane is worse than
none, because people believe it.

```bash
openssl rand -hex 32
```
