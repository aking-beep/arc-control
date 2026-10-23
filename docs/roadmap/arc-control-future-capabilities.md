# ARC Control — future console capabilities

The second Magic Patterns export,
`design-reference/magic-patterns/arc-control-proposed/`, holds six product
concepts. Each needs backend work this repository does not have. None is
implemented in the console, and none should be: the export itself renders every
frame as structure and empty states with no sample numbers, and labels the whole
set *"Proposed design · not supported by the code"*.

This document records what each concept is for, what it would take, and what it
would cost to get wrong. The designs stay in the export as the reference;
nothing here is a commitment.

Verified against `aking-beep/arc-control` at `d989f76`. Where a concept maps to
an existing phase in `docs/ROADMAP.md`, that phase is named — these are console
surfaces for work already planned, not a competing roadmap.

## Summary

| # | Concept | Blocker | Complexity | Priority | Roadmap phase |
| --- | --- | --- | --- | --- | --- |
| 1 | Policy simulator | `/v1/actions/explain` needs an **agent** credential | Medium | **High** | None — new |
| 2 | Agent run trace | No query by `correlationId` | Medium | **High** | v0.3 Observability |
| 3 | Historical trends | No time filter, no aggregation, full-table reads | Large | Medium | v0.3 Observability |
| 4 | Security findings inbox | Scans are stateless; no findings store | Large | Medium | v0.2 Scanner |
| 5 | Connector drift comparison | `detectDrift` has no HTTP surface | Small | **High** | v0.2 |
| 6 | Delegation chain | `delegatedFrom` is never populated | Large | Low | v0.4 Agent-to-agent |

Priority is read as *value per unit of backend work, given what already
exists*. Connector drift is the cheapest real improvement here — the
computation exists and only lacks a route. The policy simulator is the most
valuable and the most delicate, because it is the one that touches the
authorization boundary.

---

## 1. Policy simulator

**Design:** `arc-control-proposed/src/concepts/PolicySimulator.tsx`

### Intended functionality

An operator picks an agent, a tool and a set of parameters, and sees what policy
*would* decide — which policies match, which rule fires, the resulting effect,
and the approval requirement if there is one — without an action being recorded
or executed. The purpose is to let someone test a policy change before
publishing it, and to answer "why was this denied?" by reproducing the decision.

### Required backend work

`POST /v1/actions/explain` already does exactly this computation and records
nothing. The problem is the credential: it calls
`gateway.agents.authenticate(context.bearer)`, so it requires an **agent API
key**. The console holds an operator token, and must not hold an agent key —
an operator credential that could authenticate as an agent would collapse the
two principals the whole API is built to keep apart.

So the work is a *separate operator-facing explain route* that takes the agent
as a parameter rather than as the caller:

- `POST /v1/policies/simulate`, operator-authenticated, body
  `{ agentId, tool, parameters }`.
- Resolve the agent through `gateway.agents.require(agentId)` and build a
  principal-shaped input from the stored record, rather than from a credential.
- Call the existing `gateway.explain(principal, { tool, parameters })` and
  return its decision and trace unchanged.
- Audit the simulation as an operator read. A simulation reveals what policy
  will permit, which is worth knowing was asked for.

No change to the policy engine, and no change to `explain` itself.

### Required API contracts

```
POST /v1/policies/simulate            (operator)
  → { effect, policyId, policyVersion, ruleId, reason,
      approval?, evaluations[], trace[] }
```

Plus an SDK read, `simulatePolicy(agentId, tool, parameters)`.

### Security considerations

The sharp ones, in order:

1. **It must not become an execution path.** The route calls `explain`, which
   neither records evidence nor touches a connector. Any later refactor that
   lets it reach `gateway.handle` turns a read surface into a write one. This
   deserves a test that asserts no evidence record and no audit `action.*`
   event results from a simulation.
2. **It is an authorization oracle.** Anyone who can simulate can map the
   policy boundary — find the refund ceiling, discover which branch names are
   protected — without tripping a single denial. That is acceptable for an
   operator, who can already read every policy document on the Policies page.
   It would not be acceptable to widen this route to a weaker credential, and
   it is a reason to audit the call.
3. **Simulated parameters are operator input, not agent input.** They are
   evaluated by the real engine, so the engine's existing guarantees apply —
   total evaluation, no embedded code, reference resolution that cannot reach
   through the prototype chain. Nothing new is needed, but nothing may be
   loosened either.
4. **A simulation is not a promise.** Policy can change between the simulation
   and the action, and the strictest effect across matching policies wins at
   request time. The screen has to say that the result describes the policy set
   as of now.

### Complexity

**Medium.** One route, one SDK method, one console screen, and a principal
builder that does not exist yet. The engineering is small; the review is not,
because the route sits on the authorization boundary.

### Recommended priority

**High.** It is the most requested thing an operator cannot do today, and the
"why was this denied?" question currently has no answer short of reading the
policy document and evaluating it by hand.

---

## 2. Agent run trace

**Design:** `arc-control-proposed/src/concepts/RunTrace.tsx`

### Intended functionality

One agent run, reconstructed: every action the agent attempted under a single
`correlationId`, in order, with each decision, approval and execution, and the
total elapsed time. Today the Evidence page can filter by agent and by outcome,
so a run of eleven actions is eleven unrelated rows.

### Required backend work

`correlationId` is already carried end to end — accepted on `POST /v1/actions`,
stored on the action, and written into `EvidenceRecord.request.correlationId`.
Nothing populates it automatically, and nothing can query by it:

- `Gateway.listEvidence` filters on `agentId` and `outcome` only, and does it by
  reading every evidence record into memory (`store.evidence.list()`) and
  slicing. That is adequate for a filter applied to a bounded console page and
  is not a query layer.
- Add `correlationId` to the evidence filter, and to the `GET /v1/evidence`
  query parameters.
- Give the store an index on `correlationId` rather than scanning. Without one
  this gets slower in exact proportion to how much the deployment is used,
  which is the wrong shape for a feature whose value grows with traffic.
- Decide whether the gateway should *generate* a correlation id when a caller
  omits one. Probably not: an id the control plane invented does not group a
  run, it groups one call, and a trace of one is worse than no trace because it
  implies the run was one action.

### Required API contracts

```
GET /v1/evidence?correlationId=…     (operator)   existing shape, new filter
GET /v1/runs/:correlationId          (operator)   optional convenience
  → { correlationId, agentId, startedAt, finishedAt,
      records[], outcomes: { executed, denied, pending_approval, failed } }
```

### Security considerations

- `correlationId` is **agent-supplied**. An agent can send any value, including
  one belonging to another agent's run, and so can stitch its actions into
  someone else's trace or split its own. The screen must scope a trace to one
  agent and say that the grouping is the agent's own claim, not an
  attribution the control plane made. This is the same discipline the console
  already applies to `intent`, which it labels "advisory, not used by policy".
- It must stay a read. Grouping records changes nothing about what they say.
- A correlation id may carry whatever the agent put in it, so it is
  operator-visible text from an untrusted source and is escaped like any other.

### Complexity

**Medium.** The filter is a few lines; the store index and the honest handling
of an agent-supplied grouping key are the work.

### Recommended priority

**High.** It is the cheapest large improvement to the record, and `docs/ROADMAP.md`
already places agent traces in v0.3 and notes that the data is captured
already.

---

## 3. Historical trends

**Design:** `arc-control-proposed/src/concepts/Trends.tsx`

### Intended functionality

Decision outcomes, approval latency and execution failures over time, with a
real time axis: denial rate by week, approval turnaround, which policy started
firing more often after a change.

### Required backend work

This is the one with no foundation at all. The console's Reports page is
deliberately a snapshot over a bounded window of recent records, and prints
that window, precisely because none of the following exists:

- **No time filter on anything.** Evidence has no `from`/`to`; audit pages by
  `afterSequence`, which is an ordering, not a clock.
- **No aggregation.** Every count the console shows it computed itself from
  records it had already fetched. An aggregation over all of history cannot be
  done that way.
- **No retention or rollup model.** Trends over a year need either a year of
  evidence records or a rollup, and the store has no concept of either.
- **No time-series storage.** `ControlStore` is a document store.

Honest sequencing:

1. Time filters on evidence and audit (`from`, `to`), with store indexes.
2. A bucketed aggregation endpoint — count by outcome, policy, rule, tool per
   interval — computed in the store, not in the console.
3. A retention and rollup policy, so the series survives evidence ageing out.
4. Only then the screen.

### Required API contracts

```
GET /v1/evidence?from=&to=                              (operator)
GET /v1/metrics/decisions?from=&to=&interval=day&groupBy=outcome|policy|rule|tool
  → { interval, from, to, buckets: [{ start, counts: {…} }] }
GET /v1/metrics/approvals?from=&to=&interval=day
  → { buckets: [{ start, requested, approved, rejected, expired, medianLatencyMs }] }
```

### Security considerations

- **Aggregates leak.** A denial-rate series exposes behaviour that individual
  records, read one at a time, do not — and it is the kind of thing that ends
  up in a dashboard shared more widely than the console. Whatever authorization
  model v0.5 brings has to cover metrics explicitly, not inherit operator-reads-
  everything by default.
- **An unbounded range is a denial of service** against the control plane.
  Maximum range and interval must be enforced server-side.
- **A rollup is a derived record, not evidence.** It carries no integrity digest
  and cannot be verified the way an evidence record can. It must never be
  presented as, or exported as, evidence.

### Complexity

**Large.** Storage, indexing, retention and a new endpoint family. Realistically
the biggest item in this document.

### Recommended priority

**Medium.** High demand, but it depends on time filters and indexes that items 2
and 4 also want. Build those first and this gets much cheaper.

---

## 4. Security findings inbox

**Design:** `arc-control-proposed/src/concepts/FindingsInbox.tsx`

### Intended functionality

Scanner findings as a worklist rather than a one-shot report: findings
accumulate across scans, each carries a state (new, acknowledged, suppressed,
fixed), suppressions carry a reason and an owner, and the inbox shows what
changed since the last scan.

### Required backend work

`POST /v1/mcp/scan` computes a `ScanReport` and returns it. Nothing is stored —
the Security page says so, and says a reload scans again and leaves no trace.
A worklist needs most of a subsystem:

- **A findings store.** `ControlStore` gains a findings collection keyed by a
  stable finding identity. That identity is the hard part: a finding is
  `(check id, server, tool, the specific observation)`, and it has to survive a
  tool being renamed or a description being edited, or every scan produces a
  fresh inbox.
- **Scan history**, so "what changed" has something to compare against.
- **Triage state and transitions**, each audited. Suppressing a critical
  finding is a security decision and belongs in the audit log beside a policy
  change.
- **Suppression expiry.** A suppression with no end date is how a finding gets
  lost, which is worse than never having triaged it.
- **A scheduled or triggered scan.** An inbox that only fills when a human
  pastes a manifest is not an inbox. This is also what makes the drift work in
  item 5 continuous rather than on demand.

`docs/ROADMAP.md` v0.2 already plans `packages/scanner` for CI; this is its
console surface and should follow it rather than lead it.

### Required API contracts

```
GET  /v1/security/findings?state=&severity=&server=     (operator)
GET  /v1/security/findings/:id                          (operator)
POST /v1/security/findings/:id/acknowledge              (operator)
POST /v1/security/findings/:id/suppress                 (operator)
  body { reason, expiresAt }   → both audited
GET  /v1/security/scans?server=                         (operator)
POST /v1/security/scans                                 (operator) persisting
```

Note the last one is a *different route* from today's stateless
`POST /v1/mcp/scan`. Keep both: an operator checking a manifest before
registering anything should still be able to do so without writing a record.

### Security considerations

- **Suppression is the risk.** It is the one operation here that makes a real
  finding stop being visible. Reason, owner, expiry and an audit record are not
  optional, and the inbox should show suppressed findings rather than hide them.
- **Findings quote third-party text.** A poisoned tool description is the
  finding, so the text that triggered it is on the screen. The console escapes
  it (and a test covers that today), but a persisted finding also has to be
  escaped wherever else it travels — an export, a webhook, a Slack message.
- **A scan result is an assertion about a point in time.** A stored finding
  that is not re-verified becomes stale and quietly wrong; "last confirmed"
  belongs on the record.

### Complexity

**Large.** New storage, new identity model, new state machine, new audit events.

### Recommended priority

**Medium.** Valuable, but it should follow `packages/scanner`, and item 5
delivers a good part of the operational value for far less.

---

## 5. Connector drift comparison

**Design:** `arc-control-proposed/src/concepts/DriftDiff.tsx`

### Intended functionality

For an MCP connector whose advertised tool surface has drifted from its pinned
manifest: which tools were added, which were removed, and which were modified,
with the before and after of each change. Today the Security page can only
report *that* a connector is unhealthy and print the message it gave.

### Required backend work

The least of any item here, because the computation is already written and
already called:

- `detectDrift(pinned, observed)` in `packages/mcp-security` returns a
  `DriftReport`.
- `McpConnector.checkForDrift()` in `connectors/mcp` already calls it, and the
  connector refuses execution when a tool was rewritten after registration.
- `arc mcp diff` exposes it on the command line.

What is missing is only an HTTP surface:

- `GET /v1/connectors` listing connectors with their kind and pinned manifest
  digest.
- `GET /v1/connectors/:name/drift` calling `checkForDrift()` on a connector that
  supports it, and answering a clear "this connector has no pinned manifest"
  for one that does not.
- `Gateway.tools.connectors()` already enumerates them; the route needs a
  capability check rather than assuming every connector is an MCP connector.

### Required API contracts

```
GET /v1/connectors                       (operator)
  → { connectors: [{ name, kind, healthy, detail?, pinnedDigest? }] }
GET /v1/connectors/:name/drift           (operator)
  → { server, pinnedDigest, observedDigest, drifted,
      added[], removed[], modified: [{ tool, field, pinned, observed }] }
  → 409 when drifted, matching the audit-verify convention
```

### Security considerations

- **It reaches the MCP server.** Unlike every other read the console performs,
  this one causes an outbound call to a third party, which makes it an
  amplification vector and a way to probe whether a server is reachable. Rate
  limit it, and prefer a cached last-observed manifest with an explicit
  refresh.
- **The response is attacker-controlled.** The observed manifest is whatever
  the MCP server sent. It is diffed and displayed, so every field is untrusted
  text and must be escaped — this is the same material the scanner already
  treats as hostile.
- **Drift is already enforced, and that must not change.** The connector
  refuses to execute a tool whose manifest moved. A console that merely
  *reports* drift must not become the place where someone re-pins it without
  review; re-pinning is a separate, audited decision.
- **If the 409 convention is used, the SDK must accept it** the way
  `verifyAudit` now does, or the console will report a drifted connector as an
  unreachable API — the exact bug this integration fixed on the audit path.

### Complexity

**Small.** Two routes over an existing function, one SDK method, one screen.

### Recommended priority

**High.** Best value-to-effort ratio in this document, and it completes a
security story the product already enforces but cannot show.

---

## 6. Delegation chain

**Design:** `arc-control-proposed/src/concepts/DelegationChain.tsx`

### Intended functionality

When one agent acts on behalf of another, the chain: who originated the
request, which agents it passed through, and the authority at each hop — so an
action taken four hops from the originating request is still attributable to
it.

### Required backend work

`AgentPrincipal.delegatedFrom` exists in `packages/schemas/src/agent.ts` and is
written by nothing in the repository. The console cannot show a chain because
there is no chain; this is a product phase, not a screen.

`docs/ROADMAP.md` v0.4 scopes it, and states the hard part plainly: delegation
is where authorization models leak, a chain that can widen authority at any hop
is not a chain, and enforcement has to be on the derivation rather than on the
caller's good intentions.

In rough order:

1. A delegation grant: agent A may invoke agent B, as policy.
2. Credential derivation that produces a *narrower* principal, with narrowing
   enforced rather than requested.
3. `delegatedFrom` populated through authentication, and the chain carried into
   `EvidenceRecord`.
4. Policy selectors that can match on the chain, so "no agent more than two
   hops from a human may refund" is expressible.
5. Only then the screen.

### Required API contracts

Not yet determinable. The contract follows the delegation model, and designing
the endpoint before the model is how the model ends up shaped by the endpoint.
What the console would eventually read is the chain already present on an
evidence record, so it may need no new endpoint at all.

### Security considerations

This is the highest-risk item in the document, and the risk is not in the
console:

- **Authority must only narrow.** A derivation that can widen authority at any
  hop makes every policy above it advisory.
- **Accountability must survive the chain.** The point of recording it is that
  the originating human or agent stays attributable; a chain that can be
  truncated or forged defeats the evidence model rather than extending it.
- **Loops and depth.** A → B → A has to be refused, and depth bounded, or
  delegation is a resource-exhaustion path.
- **Displaying a chain asserts it.** A console that draws a delegation chain is
  telling an auditor the chain is true. It must not render one until the chain
  is enforced, which is the strongest reason not to build this screen early.

### Complexity

**Large.** An authorization model change, not a feature.

### Recommended priority

**Low** — meaning "not before v0.4", not "unimportant". It is the only item
here that cannot be delivered incrementally, and the only one where shipping
the screen early would actively mislead.

---

## What this means for the console today

The console in `apps/control-console` implements the ten sections the
operational prototype specifies, against capabilities that exist. It does not
implement any of the six concepts above, and the three places where it comes
closest are deliberately bounded:

- **Access** shows which policies are in scope for an agent-and-tool pair and
  which effects their rules can produce. It never evaluates a rule, because
  evaluating one would need parameters — which is concept 1, and needs the
  route concept 1 describes.
- **Reports** describes a window of recent records and prints that window on
  every figure. It has no time axis and no rate, because concept 3's endpoints
  do not exist.
- **Security** runs a scan and says the result is not saved, because concept 4's
  store does not exist.

Each of those boundaries is a statement about the backend, and each is written
on the page where an operator will read it.
