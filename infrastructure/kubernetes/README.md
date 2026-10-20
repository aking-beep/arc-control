# Kubernetes

A single-node ARC Control deployment.

```bash
# 1. The operator token. Operator endpoints refuse every request without it.
kubectl create namespace arc-control
kubectl -n arc-control create secret generic arc-control-operator \
  --from-literal=operator-token="$(openssl rand -hex 32)"

# 2. Everything else.
kubectl apply -k infrastructure/kubernetes

# 3. Check it came up.
kubectl -n arc-control get pods
kubectl -n arc-control port-forward svc/arc-control-console 8788:8788
```

## What to change before trusting this

**Put something that authenticates humans in front of the console.** v0.1
takes the operator's identity from configuration, not from an authenticated
session, so the console as deployed here attributes every approval to
`operator@cluster.local`. See
[TRUST_MODEL.md](../../docs/TRUST_MODEL.md#what-an-operator-is-trusted-with-and-the-v01-gap).

**Narrow the egress rules.** `networkpolicy.yaml` allows the API to reach
anything on 443 because it cannot know which systems you connect. The
connector holds real credentials, so replace that with explicit CIDRs or an
egress gateway.

**Apply the agent policy.** The third policy in `networkpolicy.yaml` is the one
that makes ARC Control's guarantee true: it stops a governed agent reaching a
target system directly. Without it, an agent holding its own credential
bypasses the gateway and every guarantee in this repository is void. Adjust the
namespace and pod selector to your agents.

**Back up the volume.** The audit chain and all evidence live on it. Snapshot
it, and record the head digest somewhere outside the cluster:

```bash
kubectl -n arc-control exec deploy/arc-control-api -- \
  node packages/cli/dist/bin.js audit verify --data /var/lib/arc-control
```

## Why one API replica

The v0.1 store is a single-node, append-only file store. Two writers on one
volume would interleave appends and fork the hash chain, so the Deployment is
`replicas: 1` with a `Recreate` strategy — a rolling update would briefly run
two pods against the same ReadWriteOnce volume.

The console is stateless and scales freely.

Horizontal scale for the API waits for the clustered store in v0.5. The
`ControlStore` interface exists now so that change does not reach the gateway.
