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

### The operator-token limitation, stated plainly

Operator identity is a request header behind a single shared token. Anyone
holding that token can claim any identity. An approval therefore establishes
that the approval workflow ran — **not who ran it**.

Consequences to plan around:

- Put the console behind an identity-aware proxy that sets
  `x-arc-operator` from an authenticated session. The token then authenticates
  the *proxy*, not the person.
- Treat the token as a production secret: rotate it on personnel change, keep
  it out of shell history, never put it in a repository.
- Do not present ARC approvals as individually attributable in an audit until
  SSO ships. The product says this itself on the Settings page and in every
  evidence bundle; do not say otherwise in a control narrative.

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
