---
name: release-notes
description: Writes or extends the release note in docs/releases/ for a change to ARC Control, in this repository's format — what happened, root cause, fix, behaviour changes, verification, and what the change does not establish. Use when a change is ready to ship.
---

# Release notes

Owner: `arc-docs-steward`. Release notes live in `docs/releases/<version>.md`.
Read the newest one first and extend it if the release is unreleased; start a
new file only for a new version.

## Per change

1. **What happened** — the observed failure or the need, with its id
   (ARC-SEC-NNN, a Meridian check id, an issue).
2. **Root cause** — in terms of code.
3. **The fix** — what changed and where; the consistency model if concurrent.
4. **Behaviour changes** — every response, status code, field or default a
   caller can observe changing. Additive fields are listed too.
5. **Verification** — test and eval counts before and after, the tests that
   fail without the fix, Meridian results with revisions.
6. **What this does not establish** — limits, per-process bounds, anything a
   reader might over-read. Never claim enterprise readiness.

`node tools/harness/lint-release-notes.mjs` fails a note without a
Verification section or a stated-limits section, or one that claims enterprise
readiness. CI runs it on every change.

Write for someone investigating a decision in two years. Cite files and tests.
