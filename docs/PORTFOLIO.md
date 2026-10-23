# The ARC Control portfolio

ARC Control is a division as well as this repository. This page lists every repository
that belongs to the division, so the boundary is written down rather than assumed. Its
counterpart for ARC Labs is `portfolio/products.yaml` in
[aking-beep/arc-labs](https://github.com/aking-beep/arc-labs).

Belonging to the division does not mean living in this repository. A product with its own
users, deployment and roadmap keeps its own repository; several below are private, and
listing one here does not publish its code.

| Repository | Role | Relationship to this repo |
| --- | --- | --- |
| `aking-beep/arc-control` | The control platform: gateway, policy, approvals, evidence, audit | **This repository.** The one canonical policy engine ([ADR-0001](./adr/0001-canonical-policy-engine.md)). |
| `aking-beep/tokenloop` | Spend control and chargeback for AI coding agents | Separate product, private. |
| `aking-beep/experience-intelligence-platform` | Evidence-backed CRO and UX assessment | Separate product, private. |
| `aking-beep/arc-cith-app` | The C.I.T.H. AI transformation readiness assessment | Separate product, private. |
| `aking-beep/aifit-engine` → `apps/teams` | AI Fit Teams: team-level AI capability mapping, calibrated by this platform's `GET /api/v1/calibration` | Separate product. Its code sits in `aifit-engine` beside AI Fit (an ARC Labs product); only `apps/teams` is Control's. |
| `aking-beep/arc-skills` | An open library of agent skills (`SKILL.md` packages) | Separate product, public. |
| `aking-beep/ai-workflow-templates` | An open catalog of AI workflows, most stopping at a human gate | Separate product, public. |
| `aking-beep/reference-architectures` | An open library of system blueprints and their trade-offs | Separate product, public. |
| `aking-beep/prompt-reviewer` | Static review of whether a system prompt is ready to ship | Separate product, public. |
| `aking-beep/connectivity-scanner` | Grades an endpoint for reachability, TLS, speed and security headers | Separate product, public. |
| `aking-beep/ark-ai-agent-platform` | A governed single-agent runtime on AWS | **Superseded.** Its useful parts are ported here under ADR-0001, then the repository is archived. |
| `aking-beep/ark` | The original ARK monorepo, whose Control app overlaps this one | **Legacy, migrating.** ADR-0001 steps 2–11 port its Control safeguards here; its AI Fit apps have moved to `aifit-engine` (AI Fit is an ARC Labs product; AI Fit Teams, in `apps/teams`, is Control's). |

## What belongs here

Three kinds of work:

- **Making autonomous systems trustworthy.** The ARC Labs charter's test: if the question
  is "can we make this autonomous system trustworthy", it is a Control question. This
  repository, TokenLoop and the superseded runtimes are this kind.
- **Enterprise assessment and readiness products** sold to organizations, such as the
  experience-intelligence platform, the C.I.T.H. assessment and AI Fit Teams.
- **Operator resources for running AI in production**: the free skills, workflow and
  reference-architecture libraries, and the prompt-review and connectivity-scanning tools.

Only the control platform lives in this repository; every other row is its own repository.
The README's scope rule still holds here: only what contributes to identity,
authorization, policy, execution, evidence, security or observability goes in.

Control work is not an experiment and does not enter the Labs pipeline.

## Changing this page

Add a row when a repository joins the division, and change its relationship when it
moves. A superseded repository keeps its row until it is archived, so the history of
where its code went stays readable.
