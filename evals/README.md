# Evals

Evals are not unit tests.

A unit test asks whether a function does what its author intended. An eval asks
whether the control plane still upholds a property somebody is relying on:

- *A denied action never reaches the target system.*
- *Adding a policy can only tighten authorization, never loosen it.*
- *One authorization means one effect.*
- *A failure is reported as a failure.*
- *Every authentication failure is indistinguishable from the others.*

Those properties are the product. So they are asserted separately from the code
that implements them, in terms a reviewer can read without reading the
implementation.

```bash
npm run evals                    # everything
node evals/run.js policy         # one suite, by id substring
node evals/run.js authorization security
```

Exits non-zero if any property does not hold, so the suites can gate a release.

## The suites

| | |
|---|---|
| `authorization/identity` | Nothing reaches a tool without being attributed to a known, active agent |
| `policy/decisions` | Bands hold at their boundaries, layering only tightens, nothing broken ever allows |
| `security/boundaries` | Parameter smuggling, prototype probing, secret leakage, SSRF, tool poisoning, manifest drift |
| `reliability/guarantees` | One authorization one effect, honest failures, a chain that verifies and a chain that cannot |

## What they run against

The real gateway, the real policy engine, the real approval engine, the real
evidence builder and the real audit chain. Only the final side effect is
simulated, through `connectors/simulation`.

That matters: nothing about authorization is stubbed out, so an eval that
passes here is a statement about the shipped control path. A demo or a test
that faked the decision would prove nothing.

The simulation connector records every call it was asked to make, which lets a
case assert the stronger claim — not that a denial returned `denied`, but that
the action never reached the system at all:

```js
expect.equal(connector.callCount(), 0, 'a denied refund must not reach the system');
```

## Writing one

```js
export default {
  id: 'policy/decisions',
  title: 'Policy decides, and fails closed',
  rationale: 'Bands hold at their boundaries, layering only tightens.',
  cases: [
    {
      name: 'adding a permissive policy cannot loosen a denial',
      async run() {
        const { gateway, apiKey, connector } = await buildHarness({
          policies: [FINANCE_004, AAA_PERMISSIVE],
        });

        const result = await gateway.handle(apiKey, refund(4200));

        expect.equal(result.decision.effect, 'DENY', 'the strictest effect must win');
        expect.equal(connector.callCount(), 0, 'a denied refund must not reach the system');
      },
    },
  ],
};
```

Every assertion takes a `because` string. **An eval failure should explain what
guarantee broke, not just which values differed** — that string is what someone
reads at 2am when CI goes red.

Cases must be deterministic. One of these was briefly flaky because it forged a
credential by appending a fixed digit, which reproduced the real key whenever
the key already ended in that digit. If a case can pass or fail depending on
randomness, fix the case.

## Four bugs these found

Writing them for v0.1 found four real bugs, each fixed in the commit that
records it:

1. **The policy validator rejected dual control.** It compared `minApprovals`
   against the number of approver *selectors*, but `role:finance-manager` may
   match a whole team — so requiring two approvals from one role, the standard
   pattern, was refused.

2. **A credential-solicitation check could not match `~/.aws/credentials`.**
   The pattern anchored `\b` immediately before the path alternation, and a
   word boundary cannot match between a space and `~` or `.` — so the two paths
   it most needed to catch were exactly the ones it could not see.

3. **MCP manifest pinning was not enforced where it mattered.** A 60-second
   re-check window meant a poisoned call sailed through. The window now depends
   on the tool's effect.

4. **Audit log truncation was undetectable.** Deleting the *last* record left a
   chain that verified as intact, while the docs claimed removal was always
   caught. Hash chains genuinely cannot see truncation, so the fix was an
   expected head plus honest reporting when none is available.

That is the argument for the suites. Each bug was in code that passed its unit
tests, because each was a gap in a *guarantee* rather than in a function.
