# Clients

The harness scales to a new client by adding **configuration, not code**.
Each client is a directory under `clients/` holding one `profile.json` and a
`README.md`. Every profile is validated against the real gateway in CI, so a
change to ARC that breaks a client's configuration fails the pull request
that made it.

| Client | Purpose |
| --- | --- |
| `clients/_template/` | The starting point for every new client. Valid on its own. |
| `clients/meridian/` | Meridian Commerce Group — the synthetic enterprise from `aking-beep/arc-control-sandbox`, six departments, sixteen scenarios. |

Onboarding procedure: `.claude/skills/client-onboarding/SKILL.md`.
Owner: `arc-client-onboarder`.

## Profile format

```jsonc
{
  "id": "acme",                         // lowercase, matches the directory
  "name": "Acme Corp",
  "organizationId": "acme",             // recorded on every action and evidence record
  "environment": "production",          // the agents' environment
  "classification": { "monetaryEscalationThreshold": 1000 },  // optional
  "requirements": {
    "separationOfDutiesForIrreversible": true   // makes the SoD check an error, not a warning
  },
  "tools":     [ /* ToolRegistration — packages/schemas/src/tool.ts */ ],
  "agents":    [ /* AgentRegistration — packages/schemas/src/agent.ts */ ],
  "approvers": [ { "identifier": "cfo@acme.example", "roles": ["finance-manager"] } ],
  "policies":  [ /* Policy — packages/schemas/src/policy.ts, docs/POLICY_MODEL.md */ ],
  "scenarios": [
    {
      "id": "routine-refund",
      "agent": "billing-agent",
      "tool": "billing.refund",
      "parameters": { "customer": "c-1", "amount": 50 },
      "expect": "executed",             // executed | denied | pending_approval | refused
      "policyId": "ACME-BILLING-001",   // optional: the decision must cite this policy
      "approveAs": "cfo@acme.example"   // optional, with pending_approval: vote, release, expect one effect
    }
  ]
}
```

Tools keep their logical `connector` name. The validator rebinds every tool to
a simulated connector, so nothing in a profile can reach a real system, and
real URLs and credentials belong in deployment configuration, never in git.

## What the validator checks

`node tools/harness/validate-client.mjs [clients/<id>/profile.json]`

1. **Structure** — required fields, unique names, every agent, tool and
   approver reference resolves.
2. **Policy** — every policy passes `validatePolicy`, the check `arc policy
   lint` runs.
3. **Registration** — tools, policies and agents register through the audited
   admin path of a real gateway.
4. **Coverage** — every tool is matched by an enabled policy (warning: an
   uncovered tool is denied by default); every write or irreversible tool has
   a **negative** scenario (error) and a positive one (warning); every agent is
   exercised (warning).
5. **Separation of duties** — an approval rule on an irreversible tool without
   `requireSeparationOfDuties` (error when the profile requires it).
6. **Scenarios** — each produces its expected outcome **and** its expected
   number of effects at the connector: one for `executed` or an approved
   release, zero otherwise. An optional `policyId` must be the one cited.
7. **Evidence** — every decided scenario's evidence record verifies, and the
   audit chain verifies after the run.

Errors fail the run. Warnings are for the reviewer; any the client accepts are
written into the client's README with who accepted them.

## What a profile does not prove

A valid profile shows the client's configuration is internally consistent and
behaves as specified **against this build of ARC, in one process, with
simulated effects**. It does not show:

- that the client's agents can reach their systems **only** through ARC
  (network isolation, credential custody);
- that the approvers in the profile are who they say they are (operator
  identity is configured per deployment);
- that the client's real connectors behave like the simulation — timeouts,
  partial effects, rate limits;
- anything under load, across several gateway processes, or across tenants —
  ARC's idempotency and revalidation guarantees are per process, and one
  deployment serves one organization;
- that the audit head is anchored outside ARC.

List the ones a client needs in their README as unmet requirements.

## Scaling to many clients

- **One codebase.** Clients never fork ARC. A client need that configuration
  cannot express is a product gap: route it to `arc-architect`.
- **Profiles are reviewed like code.** A policy change for a client is a pull
  request with a passing validator and a security review.
- **Every profile runs on every change.** A change to ARC that alters a
  client's outcome fails CI, so behaviour changes are seen per client before
  they ship.
- **Templates over copies.** New clients start from `_template`, never from
  another client, so one client's exceptions do not become another's
  defaults.
