# Operating ARC Control

For the team running a 2.0 pilot. Covers deployment, the health model, backup
and restore, audit anchoring, and the four incidents worth having a runbook
for.

---

## Deployment

### Local, reproducible

```bash
npm install && npm run build && npm run verify     # 356 tests, 66 properties, 14 steps

export ARC_OPERATOR_TOKEN="$(openssl rand -hex 32)"
ARC_DATA_DIR=./data ARC_SEED_DEMO=true npm run api  # terminal 1
ARC_API_BASE=http://127.0.0.1:8787 npm run console  # terminal 2
```

### Container

`infrastructure/docker/` carries a Dockerfile and a compose file;
`infrastructure/kubernetes/` carries manifests with a network policy. Both
assume a single node and a volume for `ARC_DATA_DIR`.

### Configuration

| Variable | Effect |
|---|---|
| `ARC_PORT` / `ARC_HOST` | Listener. Defaults to `8787` on `127.0.0.1`. |
| `ARC_DATA_DIR` | Durable store. **Unset means in-memory and nothing persists.** |
| `ARC_OPERATOR_TOKEN` | The shared operator token. Unset means every operator endpoint refuses every request. |
| `ARC_SEED_DEMO` | Loads the worked example. Reported on `/health` so the console can label the environment as a demonstration. |

### Signing operators in

Three ways, and ARC records which one identified each person, because a real
deployment runs more than one at a time and an approval record has to say
which it was.

**Single sign-on (`authenticated`).** The one to use. ARC verifies an ID token
against your provider's published keys and opens a session. Approvals are
attributable to individuals.

```bash
export ARC_OIDC_ISSUER="https://login.example.com"
export ARC_OIDC_CLIENT_ID="arc-control-console"
export ARC_OIDC_CLIENT_SECRET="…"
export ARC_OIDC_REDIRECT_URI="https://arc.example.com/auth/callback"
export ARC_SESSION_SECRET="$(openssl rand -hex 32)"   # stable across restarts
```

Then grant roles. Two shapes, because a ten-person company and a hundred-person
company answer this differently and both are in range:

```bash
# A company with groups in its provider.
export ARC_OIDC_ROLE_CLAIM="groups"
export ARC_OIDC_ROLE_MAP="arc-finance=finance-manager|approver,arc-admin=admin"

# A company with four people and no group management.
export ARC_OPERATOR_DIRECTORY="cfo@example.com=finance-manager,cto@example.com=admin"
```

**Neither is optional in practice.** With no roles mapped, everyone who signs
in can read and approve nothing. That is the safe direction, and startup warns
about it, but it is not a working deployment.

**An identity-aware proxy (`asserted_by_proxy`).** If you already run
oauth2-proxy or Cloudflare Access, ARC can trust its header — but only with a
shared secret, because an identity header is worth nothing if anything that
can reach ARC directly can set it.

```bash
export ARC_TRUSTED_PROXY_SECRET="$(openssl rand -hex 32)"
export ARC_TRUSTED_PROXY_IDENTITY_HEADER="x-forwarded-email"
```

The attribution is sound only while nothing can reach the control API without
passing through that proxy. That is a property of your network, not something
ARC can check.

**The shared token (`claimed`).** Retained so a 2.0 deployment survives an
upgrade, and a fallback rather than a bypass: configure either mode above and
the token stops being accepted unless you set `ARC_ALLOW_SHARED_TOKEN=true`
deliberately. Anyone holding it can claim any identity, so an approval it
records establishes that the workflow ran — **not who ran it**.

ARC warns loudly at startup when the token is the only credential and the
listener is not on loopback. It does not refuse: a container has to bind
`0.0.0.0` or nothing outside it can connect, and whether that is genuinely
reachable depends on port publishing, ingress and a network policy that ARC
cannot see from inside the process. The accurate enforcement is elsewhere — the
console states the mode on every page, and ARC-AI-004 reports what the
approvals can actually support.

### What a control narrative may claim

ARC-AI-004 computes this rather than asserting it. Each assessment states the
attribution of the votes it actually examined: a deployment on single sign-on
reads "these approvals are attributable to individuals", naming the issuer; one
still on the token is told how many votes it cannot attribute and why; a mixed
window is counted honestly rather than rounded up. Read that limitation and
repeat it — do not improve on it.

### Ending someone's access

```bash
curl -X POST https://arc.example.com/v1/operator-sessions/revoke \
  -H 'content-type: application/json' \
  --cookie "$SESSION" \
  -d '{"subject":"<provider subject>","reason":"left the company"}'
```

Keyed on the provider's subject rather than the email, because an address can
be reassigned to a new hire and offboarding has to catch the person who left.
The console shows the subject beside each live session for this reason.
Sessions are server-side, so this takes effect immediately rather than when a
token expires.

---

## Health

Two endpoints, and the difference matters.

**`/health`** reports everything. Its top-level `status` describes
**enforcement only** — a caller gating traffic wants to know whether
authorization works, and folding a stale control assessment into that figure
would teach operators to treat `degraded` as routine. Assurance is reported in
its own object with its own status.

**`/health/enforcement`** reads nothing from the assurance layer. Probe this
from a load balancer or a deployment gate: it cannot be turned red by the
governance layer. 200 when healthy, 503 when a connector is unhealthy.

**`/health/ready`** answers a different question: *should traffic come here?*
It performs a real read against the store, because the failure it exists to
catch is a volume that has gone away, and a flag set at startup would still say
yes. Use it as a readiness probe and `/health` as a liveness probe — an
orchestrator that cannot tell them apart either restarts a healthy process or
routes agents at one that will fail every write.

A failing control, an unreachable connector and a broken webhook are
deliberately **not** part of readiness. Enforcement fails closed by denying,
not by refusing traffic.

### The failure model

Enforcement is **fail-closed** and does not depend on assurance.

The assurance engine holds no path into a decision: it reads agents, tools,
policies, actions, evidence and the audit log, and writes only to its own
collections. An assurance outage can stop ARC reporting on itself; it cannot
stop ARC deciding, and it cannot open the gateway.

This is tested rather than asserted. `evals/assurance/honesty.eval.mjs`
replaces every assurance collection with a proxy that throws on any read and
asserts the gateway still allows what policy allows and denies what it denies.

| Failure | Effect on authorization |
|---|---|
| Assurance storage unavailable | None. `/health` reports `assurance.status: unavailable`. |
| No policy matches an action | `DENY`, by default. Configurable; `/health` reports which. |
| A condition throws | The rule is recorded as not matching and the error kept in the trace. Never an `ALLOW`. |
| Connector unhealthy | That tool's actions fail at execution. Decisions are unaffected. |
| Rate limiter cannot read its counter | The action is refused. |
| Operator token unset | Every operator endpoint refuses. The agent surface still works. |

---

## Backup and restore

The file store is newline-delimited JSON in one directory. `audit.jsonl` is
true append-only; the rest are snapshots rewritten atomically on change.

### Backup

```bash
# Quiesce or accept a torn tail — the audit log tolerates an incomplete final
# line, and verification will report it.
tar -czf "arc-backup-$(date -u +%Y%m%dT%H%M%SZ).tar.gz" -C "$ARC_DATA_DIR" .
```

**Record the audit head with every backup, outside ARC.** This is the single
most valuable operational habit, because it is what makes truncation
detectable and what lets ARC-AI-006 pass:

```bash
arc audit verify --data "$ARC_DATA_DIR" | tee -a /secure/offsite/arc-audit-anchors.log
```

### Restore, and proving the restore

```bash
tar -xzf arc-backup-....tar.gz -C "$ARC_DATA_DIR"

# 1. The chain is internally intact.
arc audit verify --data "$ARC_DATA_DIR"

# 2. Nothing was lost from the end — the test a restore actually needs, and
#    the only one that uses the anchor you recorded above.
arc audit verify --data "$ARC_DATA_DIR" \
  --expect-head sha256:<recorded> --expect-records <recorded>
```

A restore that passes (1) and fails (2) is a **truncated** restore: internally
valid, and missing its tail. Without the anchor the two are indistinguishable,
which is the whole reason to record it.

Then confirm the governance layer came back:

```bash
arc assurance evaluate --data "$ARC_DATA_DIR"
arc assurance coverage --data "$ARC_DATA_DIR"
```

### What restore cannot recover

Agent API key plaintexts. ARC stores a salted hash; the secret is shown once at
issue. A restore gives you the credential *records* — rotate the keys.

---

## Audit anchoring

Until the head digest lives somewhere ARC cannot write, ARC-AI-006 reports
`not_assessable` and the audit log is tamper-*evident* only against an
attacker who cannot reach the storage.

The mechanism is implemented; the scheduled job is the customer's to point at a
target they control. Minimum viable version:

```bash
# Hourly, to append-only object storage, a different cloud account, or a
# physical log. Anywhere ARC's credentials do not reach.
arc audit verify --data "$ARC_DATA_DIR" --json \
  | jq -c '{at: now|todate, headDigest, headSequence}' \
  >> /secure/offsite/arc-audit-anchors.jsonl
```

Then supply it when exporting a bundle, which is what turns the bundle from
internally consistent into genuinely anchored:

```json
{ "scope": { "kind": "window" },
  "anchor": { "headDigest": "sha256:...", "headSequence": 12480,
              "recordedAt": "s3://arc-audit-anchors/2026-10",
              "recordedBy": "secops@example.com" } }
```

---

## Runbooks

### 1 · An agent is misbehaving

```bash
# Stop it. Refused at authentication, before policy is consulted.
curl -XPOST "$API/v1/agents/$ID/suspend" -H "authorization: Bearer $TOKEN" -H "x-arc-operator: $YOU"
```

Then: `/activity?agentId=$ID` for what it did, and the evidence record for each
action. Every attempt is recorded, including the refused ones — the refusals
are usually the more informative half.

**In-flight limitation.** Suspension stops *new* actions. An action already
executing is not recalled, because ARC cannot un-send a connector call. The
evidence record for it still exists.

### 2 · A tool or connector must be stopped

```bash
# One tool. Refused at resolution, before any policy — no rule ordering,
# fallback effect or policy edit can undo it.
curl -XPOST "$API/v1/tools/$ID/disable" -H "..." -d '{"reason":"duplicate refunds observed"}'

# Everything on a connector.
curl -XPOST "$API/v1/connectors/stripe/disable" -H "..." -d '{"reason":"vendor incident"}'
```

The reason is audited. **The gap, stated because it is real:** a tool
registered on that connector *afterwards* is not covered. Registering a tool
takes an operator credential and is audited, so the gap is narrow — but re-run
the connector switch after registering anything new. The audit record for the
switch says so.

### 3 · An agent credential has leaked

```bash
curl -XPOST "$API/v1/credentials/$CRED/rotate" -H "..."   # issues, then revokes
```

Issue-then-revoke is deliberate: the reverse opens a window with no working
credential and fails an agent mid-run. Both keys are briefly valid, which is
the lesser problem.

If the agent itself is compromised rather than just its key, retire it —
`POST /v1/agents/$ID/retire` revokes every credential it holds and cannot be
undone. Then: `/activity?agentId=$ID` for the blast radius, and
`arc assurance evaluate` to see whether ARC-AI-003 or ARC-AI-004 noticed
anything.

### 4 · Audit verification fails

**This is the serious one.** `arc audit verify` reporting `BROKEN` means the
log has been altered. Treat every record at and after the first failure as
untrustworthy.

```bash
arc audit verify --data "$ARC_DATA_DIR"          # which sequence, and how
```

| Problem | Reading |
|---|---|
| `digest_mismatch` | A record's content was edited. |
| `broken_link` | A record was replaced or reordered. |
| `sequence_gap` | A record was removed from the middle. |
| `truncated` | Records removed from the end — **only visible with an anchor**. |
| `head_mismatch` | The chain was rewritten wholesale. |

Then:

1. Preserve the directory before touching it. Copy, do not move.
2. Compare against the last backup and the last recorded anchor to bound when
   it happened.
3. Assume the storage credential is compromised: an attacker who can rewrite
   `audit.jsonl` can usually rewrite `audit.head.json` beside it.
4. Any evidence bundle exported after the alteration is suspect. Bundles
   exported *before* it still verify from their own bytes — that is what they
   are for.

### 5 · A control starts failing

A failing control is working. Read the finding, not the status: it names the
subject and what was observed.

```bash
arc assurance evaluate --data "$ARC_DATA_DIR"    # exits 1 on a failure
```

`ARC-AI-001` or `ARC-AI-008` failing on a fresh install means nobody has
recorded who owns the agents or reviewed their permissions. That is a real
finding, not a configuration error.

A control moving to `not_assessable` is different: ARC lost the ability to
answer. The usual cause is an attestation expiring, which is the mechanism
working — re-attest, or accept that the control is unproven.

---

## What to monitor

| Signal | Why |
|---|---|
| `/health/enforcement` | The only probe that gates traffic. |
| `arc audit verify` exit code | A non-zero exit is an integrity incident. |
| Denial rate per agent | A spike is a misconfigured agent or an attack. |
| `rate_limited` responses | A runaway, or a limit set too tight. |
| Open findings by severity | `GET /v1/findings?status=open`. |
| Assessment age | A control library nobody runs reports nothing. `arc assurance coverage` lists stale controls. |
| Credentials expiring | `GET /v1/credentials?expiringWithinDays=30`, plus never-used keys. |
| `assurance.status` on `/health` | Reporting is down. Not an authorization incident. |

---

## Backups

```bash
# Stop the deployment first.
arc backup create --data /var/lib/arc-control --to /backups/arc-2026-10-26
arc backup verify --data /backups/arc-2026-10-26
```

`create` copies the directory and records a digest per file plus the audit
chain's head. `verify` checks every digest and then verifies the chain inside
the copy. **Run `verify` after every restore.** A backup nobody has verified is
a belief about a backup.

Verification does not modify the backup — `FileStore` opens read-only for this,
which is the same reason an auditor can check an evidence bundle without
altering it. Running `verify` twice gives the same answer.

Take backups from a stopped deployment. A copy taken while ARC is writing may
catch a collection mid-compaction; `create` detects that, says so, and exits
non-zero rather than handing you a backup that looks fine.

---

## The unattended work

One process ticks by default: it warns before an approval window closes,
lapses the ones that have, assesses controls on their own interval, notifies
about overdue findings, retries failed notifications and prunes dead sessions.

```bash
export ARC_SCHEDULE=false   # on a second replica, which must not also tick
```

A pass that hit problems is written into the audit chain, because a scheduler
that quietly stops working looks exactly like one with nothing to do. Check
`POST /v1/scheduler/run` to force a pass, and the `problems` array in its
response.

---

## Capacity

Measured on a single container with a local volume, writing to the durable
store:

| Records | Write time | Per record | File | Reopen |
|---|---|---|---|---|
| 1,000 | 342ms | 342µs | 0.3MB | 14ms |
| 5,000 | 1.6s | 319µs | 1.3MB | 41ms |
| 20,000 | 5.4s | 268µs | 5.3MB | 102ms |

Per-record cost is flat, which is the property that matters: 2.0 rewrote each
collection file on every write, so cost grew with history.

Reading that as a deployment envelope. One governed action writes roughly five
records (action, decision, execution, evidence, audit), so ~270µs per record is
on the order of **700 actions per second** sustained, against a few hundred to
a few thousand per day for a company of ten to a hundred people. The whole
collection is held in memory, so plan on a gigabyte of RAM per few hundred
thousand records, and startup time grows linearly with history — 20,000 records
open in 100ms.

### Where this stops

**One process, not one node.** `transact` is an in-process mutex. Two replicas
would each hold their own, which breaks the single-use approval guarantee and
the audit chain's single-writer assumption. Run exactly one writer. For
zero-downtime deploys, accept the restart: enforcement fails closed, so
in-flight agent calls are denied rather than mis-authorized, and the window is
the ~100ms of reopening plus process start.

This is a deliberate architecture for this range rather than an oversight, and
it is the first thing to replace if you outgrow it: a Postgres-backed store
with a cross-process lock and the audit chain anchored externally. It is not
built, and ARC does not pretend otherwise.
