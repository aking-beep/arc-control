---
name: security-remediation
description: The playbook for fixing a confirmed security finding in ARC Control (an ARC-SEC-NNN item, a Meridian failure, a review-bot finding on the decision path). Reproduce first, root-cause, fix without weakening controls, prove with a test that fails before, validate independently, document limits. Use whenever a finding is being remediated.
---

# Security remediation

Run inside the `deliver` pipeline. The rules below are additional, not
replacements.

## 1. Confirm it is still open

Findings go stale. Before anything else, check `main` — another change may
already have fixed it, partly or fully. Reproduce on the current base with
the original method (for Meridian: `meridian-validate`) and with a minimal
in-process probe. Record both. If it no longer reproduces, say so and stop.

## 2. Root cause, in writing

State the cause in terms of code: the function, the ordering, the missing
check. "Race condition" is not a root cause; "`submit()` records the action
and then searches for earlier evidence, and nothing serializes the two" is.
Look for siblings — the same shape elsewhere (another unguarded write to the
same field, another check-then-act on the same store).

## 3. Failing test first

Write the regression test so it fails on the current code for the stated
reason, and keep the failure output. Count effects at the connector. For
concurrency, use at least eight overlapping callers and repeat the race
(20+ rounds) where interleaving is nondeterministic. Prove the test bites:
revert the fix locally and watch it fail.

## 4. Fix without weakening anything

- Never change an existing test's or eval's expected outcome, or Meridian's.
- Fail closed on every new branch.
- Put the check where every caller passes through it (the registry, the
  gateway, the store), not in one route.
- State the consistency model: what is serialized, by which lock, and that
  shipped stores lock per process.

## 5. Verify and validate

`verify` skill (all gates, before and after), then `meridian-validate`
against the change and, where useful, against the base.

## 6. Document

Add to the current `docs/releases/` note: the finding id, what happened,
root cause, fix, behaviour changes, tests, and what the fix does **not**
establish. Update `docs/THREAT_MODEL.md` where a defence changed.

## Never

Declare enterprise readiness from local tests. Describe a per-process
guarantee as distributed. Close a finding without a test that failed before.
