# Security questionnaire

Answers for a buyer's technical evaluation of ARC Control 2.3, written to be
handed over as-is.

Everything below is answered against what the code does today, with the
limitations stated rather than softened. Where the answer is "not yet", it says
so and names the release. A questionnaire that overstates gets found out during
the pilot, which is the most expensive moment for both sides to discover it.

For each claim, the release note in `docs/releases/` names the test or eval
that holds it up — `2.0.md` for the baseline, `2.3.md` for everything added
since.

---

## 1 · Architecture and data flow

**What is ARC Control?** An authorization gateway between AI agents and the
systems they act upon, plus an assurance layer that evaluates whether the
gateway's controls are operating.

**What does it sit in front of?** Tools, registered explicitly. An agent asks
to use a named tool; ARC identifies the agent, validates the parameters against
the tool's declared contract, evaluates policy, and either executes through a
connector, holds for a human approval, or denies. Every path writes an evidence
record.

**Is it in the data path?** Yes, for governed actions. ARC executes the
connector call. It is not a proxy for traffic it does not govern.

**What runs where?** Two processes: a control API and a console. The console
holds no state and no database connection — everything it shows it reads from
the API with the operator's own credential, so it cannot show an operator
anything the API would not have given them.

**Runtime dependencies?** None. Node 22+ and the standard library. A CI check
asserts every runtime dependency is a workspace sibling. This is a deliberate
supply-chain decision: the component a security team reads line by line before
putting it in front of their systems should be readable.

**Lines of code?** Around 42,700 of TypeScript including tests, across 22
workspace packages.

---

## 2 · Authentication and authorization

**How do agents authenticate?** A bearer API key. ARC stores a salted SHA-256
hash; the plaintext is returned once at issue and is not recoverable. Keys carry
an optional expiry and can be revoked or rotated.

**What can an agent do?** Submit an action for a decision, and ask what policy
*would* decide. That is the entire agent surface. An agent cannot read policy,
read evidence, approve anything, see other agents, or reach any governance
route. A test presents a valid agent key to all 35 governance routes and
asserts 401 on every one.

**How do operators authenticate?** OpenID Connect single sign-on against your
identity provider: authorization code with PKCE, ID token signatures verified
against the provider's published keys, server-side sessions, and roles taken
from verified claims rather than from any request header. An operator cannot
widen their own authority by setting a header.

Three modes exist, and ARC records which one identified each person, because a
real deployment runs more than one at once:

| Mode | How | Recorded as |
|---|---|---|
| Single sign-on | ARC verifies an ID token against the provider's keys | `authenticated` |
| Identity-aware proxy | A proxy ARC is configured to trust asserts it, with a shared secret | `asserted_by_proxy` |
| Shared token | The caller states a name alongside a token | `claimed` |

The shared token is retained so a 2.0 deployment survives an upgrade, and it is
a fallback rather than a bypass: configure either other mode and it stops being
accepted unless you opt in explicitly. ARC **refuses to start** with the token
as its only credential on an interface reachable from the network.

**Can an approval be attributed to a named person?** Where that person signed
in, yes. ARC does not assert this generally, because it is not generally true:
each ARC-AI-004 assessment computes the attribution of the votes it examined
and states it, naming the issuer where it can and counting what it cannot
attribute where it cannot. A mixed window is reported as mixed. A vote recorded
before 2.1 reads as `claimed`, since that is what the deployment which wrote it
could support.

**Can access be revoked immediately?** Yes. Sessions are server-side, so
sign-out and administrative revocation take effect on the next request rather
than when a token expires. Revocation is keyed on the provider's subject rather
than the email, because an address can be reassigned and offboarding has to
catch the person who left. There is an idle timeout as well as a lifetime.

**What happens if the identity provider is down?** Operators cannot sign in.
Enforcement is unaffected — agents keep being authorized — and ARC reports
`identity_provider_unavailable` (503) rather than an authentication failure, so
an on-call rota can tell an outage from a bad credential.

**Is there RBAC?** Not per-operator. The boundary that exists and is enforced
is between *agents* and *operators*, and it is absolute. Policy-level
separation of duties is enforced where a rule demands it — the approving
operator cannot be the agent's owner.

**MFA? Password policy? Session management?** ARC has no user store and issues
no sessions. These are properties of the identity-aware proxy you place in
front of it.

---

## 3 · The authorization model

**How are decisions made?** A closed expression language over a recorded
snapshot of the action. No embedded code, no function calls, no network access
during evaluation. Evaluation is total, side-effect free, and identical every
time — which is what makes a decision reproducible from its evidence record.

**Can a policy loosen authorization?** No. Every matching policy is evaluated
and the **strictest** effect wins, always. Adding a policy can only tighten.

**What happens when no policy matches?** `DENY`, by default and
configurably. `/health` reports which is in force, and ARC-AI-002 reports
coverage gaps with a severity that follows this setting — a gap behind `ALLOW`
is ranked critical.

**What happens when policy evaluation errors?** The rule is recorded as not
matching, the error is kept in the trace, and the policy goes to its fallback —
or to `DENY` if the fallback would allow. A malformed condition can never
produce an `ALLOW`.

**Can the assurance layer affect a decision?** No. It has no write path into
enforcement. Tested by replacing every assurance collection with one that
throws and asserting decisions are unchanged.

**Can a budget authorize anything?** No. A budget can refuse an action policy
would allow, or hold one for approval, and it can never do the reverse: a
budget with room to spare cannot soften a `DENY`, and an exhausted budget
cannot turn a `DENY` into a hold. Spend an agent reports about itself counts
toward its own budgets only, is dated by the server, and cannot be negative. A
budget ARC cannot read refuses rather than lifting. Asserted in
`evals/spend/budgets.eval.mjs`.

**If a policy and a budget both hold an action, who releases it?** Both sets of
approvers, independently. The policy's approvers alone cannot release it
(ARC-SEC-013). One person who qualifies for both groups satisfies both with one
vote — two groups is not the same claim as two people, and we do not make the
second one.

**Can a policy pack grant anything?** No. Packs are `PACK-` prefixed policies
that match on roles only and never fall back to `ALLOW`; four ship, each
validated against the real gateway in CI, and none is published to a deployment
unless an operator asks for it.

**Can risk classification authorize anything?** No. It is computed
deterministically and exposed to policy as `$.action.risk.*` so a rule may
consult it; nothing in the gateway consults it to permit anything. One
authorization path.

**Is an LLM involved in any decision?** No. Not in authorization, not in
classification, not in control evaluation. Every decision path in ARC is
deterministic code over recorded data.

---

## 4 · Audit and evidence

**What is recorded?** One evidence record per action — allowed, denied, held or
failed — carrying the agent, the parameters and their digest, the decision with
the policy and rule cited, the approval with its votes, the execution outcome,
and a digest over all of it. Separately, an append-only hash-chained audit log.

**Can records be altered?** The log is tamper-**evident**, not tamper-proof,
and the distinction is load-bearing:

- Editing a record changes its digest and breaks every link after it.
- Removing a record from the middle leaves a sequence gap.
- **Removing records from the end is undetectable from the records alone** — a
  truncated chain is internally valid. Detecting it needs the head digest
  recorded outside ARC.
- An attacker who controls the storage can rewrite the whole chain and
  recompute every digest.

ARC-AI-006 does not pass until the head is externally anchored, specifically so
this limitation cannot be papered over.

**Can an auditor verify an export without trusting us?** Yes, and this is the
design centre. An evidence bundle carries the primary records, each with its
expected digest, plus a manifest digest. `arc bundle verify` recomputes every
digest from the file — no store, no network, no ARC instance.

Evidence and assessments carry **two** digests: the bundle digest catches
alteration after export, and the record's own integrity digest, written when
ARC stored it, catches alteration before export that a recomputed bundle digest
would accept. Both are demonstrated being defeated-and-caught in the
walkthrough.

**Retention?** ARC does not prune. Audit history, policy version history and
attestation history are append-only and never deleted by the product, because a
retention decision about who authorized a permission change belongs to the
customer. Configurable retention is P1.

---

## 5 · Secrets and data handling

**Where do connector credentials live?** In connector configuration, by
reference. `connectorConfig` never contains secrets, and a test asserts no
credential material reaches evidence or audit.

**Sensitive parameters?** A tool may mark a parameter `sensitive`. Those values
are redacted before the parameter set reaches evidence or audit — and
redaction also applies by name, so a secret in a field nobody marked is caught
too. Two eval properties cover this.

**What does ARC store about end users?** Nothing, unless an agent puts it in a
tool parameter. ARC stores what it was asked to act on; it has no user model of
its own.

**Data residency / encryption at rest?** The file store writes plain JSON to a
directory. Encryption at rest is the volume's job. Multi-region is P2.

**Is any data sent to ARC or Anthropic?** No. There is no telemetry, no
phone-home, and no outbound connection ARC makes that is not a connector call
the customer configured.

---

## 6 · Supply chain

**Dependencies?** Zero runtime. `typescript` and `@types/node` for the build,
pinned exactly.

**Is the MCP supply chain covered?** Partly, and the limits are stated. ARC
scans a server's manifest for poisoned tool descriptions, pins a manifest
digest, and detects drift on a pinned tool at execution. It cannot detect a
server that lies about its own tool descriptions, because reading them is all
it can do. ARC-AI-007 asserts pinning and carries both limitations.

**Can a bad MCP server be registered?** It is graded first. A server below
`ARC_MCP_MIN_GRADE` registers none of its tools — the batch is validated in one
critical section, so a failure cannot leave earlier tools registered. The grade
is a static, pattern-based check: it raises the floor on what can be
registered, and a server that grades A can still be malicious. Policy remains
what decides.

**Are tool endpoints checked?** With `ARC_ENDPOINT_VETTING=true`, a
`generic-http` tool whose endpoint fails DNS, TLS, certificate-expiry, redirect
or address-class checks is not registered, and the refusal is audited. Vetting
is point-in-time: DNS can change afterwards, so the connector's allowlist, its
HTTPS requirement and its refusal to follow redirects are what hold on every
call.

**Is the agent's prompt reviewed?** Optionally. An agent below
`ARC_PROMPT_MIN_GRADE` cannot become active, and an active agent whose review
later falls below the gate is suspended and the suspension audited. ARC sees
only the prompt it was given; nothing forces the running agent to use it.

**SBOM?** Derivable from `package-lock.json`; with no runtime dependencies it
is short.

---

## 7 · Availability and operations

**Single point of failure?** Yes, today. The file store is single-node and
explicitly so. PostgreSQL and HA are P1; shipping HA on a single-node store
would be a false claim.

**What happens under load?** Policy evaluation is in-process with no I/O. The
store serializes writes per collection with a mutex. Benchmarking against a
realistic load profile is P1 — we have not measured it, and will not quote a
number we have not measured.

**Rate limiting?** Available, off unless configured. A safety valve against a
runaway agent rather than a quota system: it counts recorded actions so it
survives restart, and fails closed if it cannot read its counter.

**Kill switches?** Per-agent suspension, per-tool and per-connector disable,
and permanent retirement. Tool and connector switches are enforced at
resolution before any policy is consulted, so no policy can undo them. The
in-flight limitation is documented: a switch stops new actions and does not
recall one already executing.

**Backup and restore?** Documented in [OPERATIONS.md](./OPERATIONS.md),
including the restore test that actually matters — verifying against a recorded
anchor, which is the only way to tell an intact restore from a truncated one.

---

## 8 · Compliance

**Does ARC make us compliant with anything?** No, and we will not say
otherwise. ARC produces evidence relevant to a compliance programme. Any
conclusion about conformity is the organization's own to reach with its own
assessor.

**Framework mappings?** NIST AI RMF 1.0, covering all four functions. **Every
mapping ships as `proposed`, not `reviewed`.** ARC's engineers can draft a
mapping; only someone accountable for your compliance programme can accept
one. Coverage counts only reviewed mappings, so the figure starts at zero and
rises as real review happens.

ISO/IEC 42001 and the EU AI Act are P1 and deliberately not shipped as data:
publishing an unreviewed mapping table for a framework with legal consequences
invites someone to rely on it.

**Can we add our own controls?** Yes. A control with no implemented evaluator
reports `not_assessable` — never a pass — until you attest it or implement an
evaluator.

**Are you SOC 2 / ISO 27001 certified?** ARC Control is software you deploy,
not a service we operate, so those certifications would describe our corporate
posture rather than your deployment. Ask us about it separately.

---

## 9 · Testing and assurance of ARC itself

| | |
|---|---|
| Unit and integration tests | 812 |
| Security and reliability properties | 95, in a separate eval suite |
| End-to-end demonstration | 14 steps, real gateway and real HTTP |
| Independent adversarial harness | [arc-control-sandbox](https://github.com/aking-beep/arc-control-sandbox) — a synthetic enterprise we do not control, which found two authorization defects our own suite missed |
| Threat model | [THREAT_MODEL.md](./THREAT_MODEL.md) |
| Trust model, including what ARC does *not* protect against | [TRUST_MODEL.md](./TRUST_MODEL.md) |

The eval suite is the artefact to read first. It asserts the product's claims
in terms a reviewer can check without reading the implementation — "a denied
action never reaches the target system", "adding a policy cannot loosen
authorization", "an assurance storage failure does not open the gateway".

**Penetration testing?** Not yet performed. P1, and it is a service rather than
a commit. We would rather say that than imply otherwise.

**Has anything been found this way?** Yes, and the honest version is worth
hearing. An independent harness driving ARC over HTTP found two authorization
defects while our own suite was fully green: eight concurrent refunds sharing
one idempotency key produced eight refunds, and an approved action released
after a deny policy was published still executed. Both were ordering bugs that
only appear under concurrency or across time, and neither was reachable by the
sequential tests we had. They are fixed, with regression cover at both the
in-process and HTTP levels, and the limits of each fix are stated in
[releases/2.2.md](./releases/2.2.md). A green internal suite is evidence about
the paths its authors thought to exercise, and nothing more.

---

## 10 · The short version of what we do not do

Stated together, because a buyer should not have to assemble this list
themselves:

1. **Role-based access control is coarse.** Roles gate who may approve what,
   through policy approver selectors. There is no per-object permission model
   and no delegation.
2. **One writer.** `transact` is an in-process mutex, so exactly one process
   may write. No HA, no multi-region, and a restart is a brief outage in which
   enforcement denies rather than mis-authorizes. A Postgres-backed store with
   a cross-process lock is the upgrade path and is not built.
3. The audit log is tamper-evident, not tamper-proof, and cannot detect
   truncation without an external anchor you hold.
4. No penetration test has been performed.
5. ARC cannot see an action that bypassed it. ARC-AI-009 is attestation-based
   for exactly this reason, and reports `not_assessable` without a current
   attestation rather than passing.
6. ARC observes authorization and evidence. It does not observe model
   behaviour — no accuracy, bias, drift or output quality.
7. Notifications go to a webhook or a chat workspace. There is no email or
   paging integration, and no on-call escalation.
8. Performance is measured on a single container (see OPERATIONS.md) and has
   not been load-tested against a production workload.
9. Framework mappings are drafts until your team reviews them.
10. Simulated connector effects in the demo seed are labelled as simulated,
    everywhere they appear.
