---
name: deploy
description: Builds, starts and checks an ARC Control deployment — in process on a durable store, or against a running instance such as the container image — and states what a deployment check does not prove. Use before a release, after any change to startup, configuration, the store or infrastructure, and when standing ARC up for a client.
---

# Deploy

Owner: `arc-deployment-engineer`. Script: `tools/harness/deploy-smoke.mjs`.

## Check a build

```bash
npm run build
node tools/harness/deploy-smoke.mjs --out .harness/deploy.json
```

This starts `apps/control-api/dist/main.js` on a temporary `FileStore` with
the demo seed, then checks, in order:

1. it becomes healthy (and how long that took);
2. an allowed refund executes and the $4,200 refund is denied;
3. the audit chain verifies over the API;
4. after SIGTERM and a fresh start on the same directory, the chain verifies
   against the head the store recorded, and evidence written before the restart
   is still readable.

## Check a running instance

```bash
node tools/harness/deploy-smoke.mjs --base https://arc.example.internal \
  --operator-token "$ARC_OPERATOR_TOKEN" --agent-key "$AGENT_KEY"
```

Steps 1–3 only; a remote instance is not restarted. CI runs this against the
container image in `.github/workflows/docker.yaml`.

## Release checklist

- `verify` skill green; `node .github/scripts/check-infrastructure.mjs` passes.
- Deploy smoke passes in process and against the image.
- `docs/OPERATIONS.md` matches the artefacts in `infrastructure/`.
- The release note says what changed for operators (new variables, defaults).

## What this does not prove

That a cluster, load balancer, TLS termination, identity provider or network
policy is correct; anything under load or across several API processes; that
the audit head is anchored outside ARC. Those are checked per deployment and
stated in the client's README.

## Never

Deploy with a shared operator token on an exposed interface without
`ARC_ALLOW_SHARED_TOKEN` set knowingly. Put credentials in the repository.
Treat a passing smoke test as a production sign-off.
