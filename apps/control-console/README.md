# @arc-control/control-console

The enterprise console: agents, tools, policies, access, approvals, evidence,
audit, security and reports.

## The sections

Ten, grouped by what an operator is doing rather than by which package serves
them. Three of them — Access, Security and Reports — are computed in the
console from reads it already performs, and each says so on the page.

| Group | Section | What it answers |
| --- | --- | --- |
| Operate | **Overview** | Does anything need me? Ordered by consequence: a broken chain, then approvals waiting, then an unhealthy connector. |
| | **Approvals** | What is a human being asked to authorize, by which policy, and under what requirement. |
| Inventory | **Agents** | Who is authorized, what they declare, what credentials they hold, what they have done. |
| | **Tools** | What may be asked for, at what risk, through which connector, and which agents and policies relate to it. |
| Govern | **Policies** | Each policy as a decision ladder: rules in evaluation order, conditions in words, and the fallback. |
| | **Access** | Which enabled policies govern each agent-and-tool pair, and which effects their rules can produce. |
| Record | **Evidence** | One record per attempt, with its timeline, trace and integrity digests. |
| | **Audit** | The hash chain, its failures, and precisely what verifying it does and does not prove. |
| Assure | **Security** | Chain integrity, connector posture, and an on-demand MCP manifest scan. |
| | **Reports** | An operational snapshot over a window the page always states. |

## Where the design came from

`design-reference/magic-patterns/arc-control-prototype/` — the approved visual
reference. It ships its own integration spec in `src/data/mapping.ts`: every
screen mapped to the console source that renders it, the endpoints it reads,
the writes it performs and the SDK methods it needs. The export is also
explicit that React was the canvas and not the delivery mechanism, which is why
this remains server-rendered: its own `PrototypeBar.tsx` says *"Ships as
server-rendered templates, not React."*

Its design tokens were the previous `render.ts` tokens plus additive ones, so
the port changed no existing colour.

## The decisions worth knowing

**It holds no state of its own.** Everything shown is read through the control
API with the operator's own credential, so the console cannot surface anything
the API would withhold, and an approval cast here is audited identically to one
cast through the API.

**Server-rendered, no client framework, no build step.** The console displays
evidence about security decisions, and a page whose source an auditor can read
is worth more here than a richer one they cannot. It also prints legibly,
because these pages end up in audit reports.

**Every interpolation is escaped at the template level.** The `html` tagged
template escapes by default and only accepts pre-rendered markup through an
explicit `raw()`. Everything the console shows — tool names, policy reasons,
approval comments, audit summaries — originated outside it, and some of it came
from an agent, so a tool description must not be able to become script in an
operator's browser. The response also carries a strict
`content-security-policy` with no script source at all.

**Mutations are form posts that redirect.** A reload never repeats a vote. The
three disruptive ones — rejecting a request, suspending an agent, disabling a
policy — go through a render-only confirmation page first, which is a GET that
changes nothing and whose form posts to the unchanged POST path.

**Access reports scope, never permission.** A cell naming a policy in scope is
not a grant: which rung of that policy fires depends on a real request's
parameters, and the strictest effect across every matching policy wins. The
matrix calls the policy engine's own `matchSelectors`, so what it shows as "in
scope" is exactly what the engine matches — a second implementation here would
eventually disagree with the engine, and a disagreeing access matrix is worse
than none.

**Reports states its window on every figure.** Record count, and the first and
last timestamp in it. No time axis, no rate, no trend arrow: no endpoint could
support one, and a snapshot that looks like a trend is a claim the data cannot
carry.

**A broken audit chain is reported as broken.** `GET /v1/audit/verify` answers
409 when the chain does not verify, which is the verification succeeding and
saying "no" — not a failed call. The SDK returns that body rather than throwing,
so the console can never tell an operator the API is unreachable when what has
actually happened is that the record has been tampered with.

**The verification caveat is never shortened.** The difference between
"verified against an anchored head" and "verified against itself" is the
difference between detecting truncation and not, and both branches keep their
full text. It is a trust commitment, not copy.

**Approving does not execute.** The console votes, and releases the action as a
separate call, only once the request is actually approved.

## Running it

```bash
ARC_API_BASE=http://127.0.0.1:8787 \
ARC_OPERATOR_TOKEN=… \
ARC_OPERATOR_IDENTITY=you@example.com \
ARC_OPERATOR_ROLES=finance-manager \
npm run console
```

## Testing it

`src/console.test.ts` drives every page against a stub API rather than a live
one, which buys the payloads a real deployment produces rarely: a broken audit
chain, a hostile tool description, a credential record whose salt must not
reach the page, an endpoint that is down. 141 tests cover rendering,
navigation, the 409 path, escaping, empty states, API failures, both themes and
accessibility.

`src/sso.test.ts` does the opposite, and is the one test a stub cannot stand in
for: it starts the real control API with single sign-on configured, signs in
against a stub identity provider that mints genuinely signed ID tokens, and
drives this console on the resulting session alone. It exists because the
console was briefly unable to use the authentication the API had just gained —
every page returned 401 — and nothing in a stub-driven suite could have noticed.

`npm run demo:console` walks the whole workflow over HTTP through this console
and asserts each step.

## Who the console thinks you are

The console holds no identity of its own. It forwards the visitor's session to
the control API, asks `/v1/whoami` who that is, and displays the answer — so
the name on an approval is the one the API resolved, never one the console was
configured with. A visitor with no session is sent to the API's sign-in flow
and returned to the page they were going to.

That means the attribution shown on screen matches the attribution recorded in
the audit log, including when it is weak. Where a deployment runs on the shared
token instead of an identity provider, the console says so on every page that
turns on who you are, rather than printing a configured name as though it had
been verified. See
[TRUST_MODEL.md](../../docs/TRUST_MODEL.md#what-an-operator-is-trusted-with-and-how-far-that-trust-is-established).
