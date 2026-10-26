# Security

ARC Control decides whether AI agents may act on real systems. A vulnerability
here is not a bug in a feature — it is a gap in somebody's authorization
boundary. We would rather hear about one awkwardly than not at all.

---

## Reporting a vulnerability

**Email:** security@arctransformationgroup.com

Please do not open a public issue for a security report.

If you can, include:

- What an attacker can do that they should not be able to do
- The smallest reproduction you have — a policy document, a request body, a
  tool definition, an MCP manifest
- Which version or commit you tested
- Whether you believe it is already being exploited

You will get an acknowledgement within **2 business days** and an assessment
within **10**. If a fix is going to take longer than that, we will say so and
why, rather than going quiet.

We will credit you in the release notes unless you would rather we did not.

---

## What we consider a vulnerability

Anything that breaks one of these, which are the guarantees the product is
built on:

| Guarantee | A break looks like |
|---|---|
| **Nothing executes without a decision** | Reaching a connector without an `ALLOW`, or with an approval the policy did not require |
| **Policy cannot be loosened by adding one** | A policy that makes a previously-denied action allowed |
| **Fail closed** | A malformed condition, a type confusion or a crafted parameter producing `ALLOW` |
| **Agents cannot read or change policy** | An agent key reaching an operator endpoint, or learning policy it was not told |
| **Identity cannot be forged** | Authenticating without a valid credential, or acting as a different agent |
| **One authorization, one effect** | An approval authorizing two executions, or a retry causing a second effect |
| **Approvals cannot be subverted** | Voting without being named, voting twice toward a threshold, bypassing separation of duties |
| **Secrets stay out of the record** | A credential appearing in evidence, the audit log or the console |
| **The record is tamper-evident** | Editing a record, or removing one from the middle, without verification failing; or truncation passing a check against an anchored head |
| **Connectors cannot be redirected** | Reaching a host outside the allowlist, or the cloud metadata service |

Also in scope: credential enumeration through the authentication endpoint,
anything that lets an agent reach a tool it was not registered for, and any
path that produces a *false* evidence record — a record that says something
happened when it did not, or did not happen when it did.

---

## What is already known and documented

These are not vulnerabilities; they are v0.1 limits, written down because a
threat model that only lists wins is marketing. Reports about them are welcome
as design discussion rather than as security reports.

- **The shared operator token is still accepted where no identity provider is
  configured**, with identity taken from a request header, so anyone holding
  that token can claim any identity. 2.1 closed the gap for deployments that
  configure OpenID Connect — individual sign-in, server-side sessions, roles
  from verified claims — and the token survives only as a fallback: configure a
  provider and the API stops accepting it. What does not close is the
  provenance question itself, which is why every recorded identity carries the
  assurance it was established with (`authenticated`, `asserted_by_proxy`,
  `claimed`) and the console reports it rather than presenting all three alike.
  A deployment left on the token is a deployment whose approvals are
  attributable to the token, not to a person. See
  [TRUST_MODEL.md](./docs/TRUST_MODEL.md#what-an-operator-is-trusted-with-and-how-far-that-trust-is-established).
- **The audit chain is tamper-evident, not tamper-proof.** Two parts. An
  attacker who controls the storage can rewrite the whole chain and recompute
  every digest. And walking the records cannot detect truncation at all —
  removing entries from the end leaves a shorter, internally valid chain.
  Edits and interior deletions are detectable without help. Both gaps close
  with an expected head: `arc audit verify --expect-head`, the `FileStore`
  head marker, and ultimately an anchor outside ARC Control. See
  [EVIDENCE_MODEL.md](./docs/EVIDENCE_MODEL.md#tamper-evidence-not-tamper-proofing).
- **MCP security checks are heuristics, not controls.** They catch the common
  mechanical attacks on tool descriptions. They will miss a careful attacker.
  Policy remains the thing that decides. See
  [THREAT_MODEL.md](./docs/THREAT_MODEL.md#t3--a-poisoned-mcp-tool-description-steers-the-agent).
- **No rate limiting, quota or concurrency control.** An agent in a loop can
  fill the audit log. Deploy behind something that limits it.
- **No multi-tenant isolation.** Objects carry an `organizationId`; v0.1 does
  not enforce boundaries on it. One deployment serves one organization until
  v0.5.
- **An agent with its own credentials bypasses everything.** ARC Control's
  guarantees hold only where the gateway is the agent's only route to the
  system. That is a deployment property — network policy, credential custody —
  and no code here can establish it. See
  `infrastructure/kubernetes/networkpolicy.yaml`.
- **Prompt injection inside an agent is not detected.** ARC Control bounds what
  a manipulated agent can *do* rather than trying to recognize manipulation.
  That is a narrower claim and a more defensible one.
- **A lying connector produces false evidence.** Connectors are trusted to be
  honest about outcomes. The mitigation is that they are a small, reviewable
  surface in this repository, not that the code can detect a liar.

The full list, with the defence for each threat and the code that implements
it, is in [THREAT_MODEL.md](./docs/THREAT_MODEL.md).

---

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x | ✅ |

ARC Control is pre-1.0. Until 1.0, security fixes land on `main` and in the
next minor release; there is no backport branch.

---

## How we think about this code

Some choices in this repository exist for security reasons and will look like
over-engineering until you know why. Changing them needs a reason.

**Zero runtime dependencies.** Node's standard library only. A hand-written
router, argument parser and MCP client are a real cost, paid because a control
plane's supply chain is part of its threat model, and because this is the code
a security team reads line by line before putting it in front of their systems.
A pull request adding a runtime dependency to a package on the decision path
needs to argue for it.

**Undeclared parameters are rejected, not dropped.** Dropping is the more
obvious implementation and the wrong one: the request would succeed and the
attack would be invisible to both policy and the audit record.

**Type mismatches in comparisons are errors, not coercions.** A refund limit
must never pass because the amount arrived as `"10"`.

**Authentication failures are indistinguishable.** Every way a credential can
fail produces the same error with the same message, so the endpoint cannot be
used to enumerate valid credentials. Agent suspension is the one deliberate
exception, and it leaks only the status of an agent whose credential the caller
already holds.

**Secrets are redacted by name as well as by declaration.** A tool author who
forgets `sensitive: true` should not be able to write credentials into the
audit log.

**Digests are over unredacted values.** The record proves what was submitted
without storing it.

**Policy references resolve own properties only.** `$.action.parameters.constructor`
resolves to nothing, not to a function.

**Irreversible actions are never retried.** A timeout in particular may already
have taken effect.

---

## If you are deploying this

The three things that most often make a correct control plane useless:

1. **An agent that can reach the target system directly.** Segment the network.
   `infrastructure/kubernetes/networkpolicy.yaml` shows the shape.
2. **An unauthenticated console.** Put an identity-aware proxy in front of it,
   and treat the operator token as a shared administrative secret.
3. **An unbacked-up volume.** The audit chain and all evidence live on it.
   Snapshot it, and record the head digest somewhere outside the deployment.
