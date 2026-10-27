---
name: client-onboarding
description: Onboards a new client onto ARC Control or changes an existing client's controls — builds clients/<id>/profile.json from the template, validates it against the real gateway with tools/harness/validate-client.mjs, and records accepted warnings and unmet requirements. Use for any client-specific configuration work.
---

# Onboard a client

Owner: `arc-client-onboarder`. Reviewer: `arc-security-reviewer`.
Format and checks: `docs/harness/CLIENTS.md`.

## Steps

1. **Discover.** Collect, from the client: the systems agents will act on and
   what each action does (read, write, irreversible); the agents and who owns
   each; who may approve what, and whether separation of duties is required;
   monetary or volume thresholds; environments. Record open questions; do not
   invent answers.
2. **Scaffold.** `cp -r clients/_template clients/<client-id>` and set `id`,
   `name`, `organizationId`, `environment`.
3. **Tools.** One entry per action, with an honest `effect` and every
   parameter declared. Keep `connector` as the logical connector name; real
   URLs and credentials are deployment configuration, never in git.
4. **Agents.** One per workload, owner set to an accountable human or team,
   `declaredTools` limited to what it needs.
5. **Policies.** Default deny. Guard each tool to the agents allowed to use
   it, then ALLOW / REQUIRE_APPROVAL / DENY bands. Approvals on irreversible
   tools set `requireSeparationOfDuties: true` unless the client accepts the
   risk in writing.
6. **Scenarios.** For every write or irreversible tool: at least one positive
   scenario (executed, or approved with `approveAs`) and one negative (denied,
   refused or held). Add a wrong-agent scenario per guarded tool.
7. **Validate.**
   `node tools/harness/validate-client.mjs clients/<client-id>/profile.json`
   Zero errors required. Each warning is either fixed or written into the
   client README as accepted, with who accepted it.
8. **README.** `clients/<client-id>/README.md`: client context, accepted
   warnings, open questions, and the client's requirements ARC does not meet
   today (see `docs/harness/CLIENTS.md#what-a-profile-does-not-prove`).
9. **Review and ship** through the `deliver` pipeline.

## Triggered

An issue labelled `client-onboarding` (template:
`.github/ISSUE_TEMPLATE/client-onboarding.yml`) starts this skill through
`.github/workflows/harness-agents.yaml`, which opens a profile PR for review.

## Never

Commit secrets, real hostnames, real personal data or production credentials.
Copy another client's profile as a starting point. Present a valid profile as
proof the client's deployment is secure.
