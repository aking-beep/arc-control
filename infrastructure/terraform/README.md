# Terraform

Deploys ARC Control onto an existing Kubernetes cluster — the same shape as
`infrastructure/kubernetes`, for teams whose clusters are managed with
Terraform.

```hcl
module "arc_control" {
  source = "github.com/aking-beep/arc-control//infrastructure/terraform?ref=v0.1.0"

  namespace         = "arc-control"
  image             = "ghcr.io/arc-transformation-group/arc-control:0.1.0"
  storage_size       = "50Gi"
  operator_identity = "platform@example.com"
  operator_roles    = ["platform-oncall"]
}

output "arc_control_api" {
  value = module.arc_control.api_endpoint
}
```

```bash
terraform init
terraform plan
terraform apply
```

## The operator token is in state

Supplied or generated, `operator_token` ends up in Terraform state. Encrypt the
backend and control access to it. Where a secret manager is available, create
the secret there and pass a reference instead.

## What this module does not do

**It does not segment the network.** That omission is deliberate, and it is the
most important thing to read here.

ARC Control's guarantees hold only while the gateway is an agent's *only* path
to the systems it acts on. If an agent holds a Stripe credential of its own,
policy and evidence are decoration. Deciding which pods may reach which systems
depends on how your cluster is segmented, so this module does not guess —
see `infrastructure/kubernetes/networkpolicy.yaml` for the shape the rules need
to take, in particular the third policy, which stops a governed agent reaching
a target system directly.

**It does not configure an identity provider.** The module has no opinion about
whose provider you use, so as applied it leaves the deployment on the shared
token, attributing every approval to `operator_identity` and recording that as
`claimed`. Set the OpenID Connect variables to get individual sign-in and roles
from verified claims; otherwise put an identity-aware proxy in front of the
console Service. See
[TRUST_MODEL.md](../../docs/TRUST_MODEL.md#what-an-operator-is-trusted-with-and-how-far-that-trust-is-established).

**It does not back up the volume.** The audit chain and every evidence record
live on `data_volume_claim`, which is marked `prevent_destroy` so a careless
`terraform destroy` does not take the record with it. Snapshotting is a cluster
concern.

## One API replica

The v0.1 store is a single-node, append-only file store. Two writers on one
volume would interleave appends and fork the hash chain, so the API Deployment
is one replica with a `Recreate` strategy. The console is stateless and
`console_replicas` is free to raise.

Horizontal scale for the API waits for the clustered store in v0.5.
