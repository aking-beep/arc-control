# Magic Patterns integration — compatibility report

Written before implementation, against `aking-beep/arc-control` at `24eff86`
(branch `feature/magic-patterns-integration`) and the two Magic Patterns
exports now in `design-reference/magic-patterns/`.

## 1. What the exports turned out to be

The exports were not at `design-reference/magic-patterns/arc-control-prototype/`
and `.../arc-control-proposed/`. Commit `87d1435` uploaded both of them to the
**repository root as one flat directory**, 70 files with no subdirectories.

Two consequences had to be dealt with before anything could be built:

- The upload **overwrote the root `README.md`** (456 lines → 8) **and the
  workspace root `package.json`**. The root `package.json` is what declares the
  npm workspaces and every `npm run` script, so at `87d1435` the repository
  could not install, build, typecheck, test or run its evals. Both are restored
  from `f68c4d2`.
- The two exports were **merged into one namespace**. Where both contained a
  file of the same name the second upload won, so the prototype export's
  `App.tsx`, `index.html`, `index.tsx`, `package.json` and `vite.config.ts` are
  unrecoverable. The prototype tree is therefore source only and will not
  `npm run dev`; the proposed tree is complete.

Structure was reconstructed from the relative import paths in the source, which
pin every surviving file to exactly one directory. `src/screens/*` is the one
group nothing surviving imports (the prototype's `App.tsx` held those routes),
so those seventeen screens are placed by elimination.

## 2. Existing capabilities

| Package | What it provides |
| --- | --- |
| `packages/schemas` | The contracts: `Agent`, `Tool`, `Policy`, `Condition` (17 operators), `ApprovalRequest`, `EvidenceRecord`, `AuditRecord`, `ChainVerification`, `ArcError`. Canonical JSON, redaction, id generation. |
| `packages/policy-engine` | Evaluation, and separately `matchSelectors` / `policyApplies` — matching is deliberately split from evaluation so a caller can ask "which policies govern this?" without deciding anything. |
| `packages/approvals` | Approval requests, vote thresholds, separation of duties, expiry, single-use consumption. |
| `packages/evidence` | One record per action with an integrity digest over every field. |
| `packages/audit` | Append-only hash chain; verification with or without an anchored head. |
| `packages/execution`, `packages/gateway` | The authorize → execute → record path. |
| `packages/mcp-security` | `scanManifest`, `manifestDigest`, `detectDrift`, severity-ranked `Finding`s with remediation text. |
| `packages/sdk-typescript` | `ArcControlClient`, separate agent and operator surfaces. |
| `apps/control-api` | HTTP API, operator token auth, demo seed. |
| `apps/control-console` | Server-rendered console: 6 sections, no client JavaScript, `default-src 'none'`. |

## 3. Existing APIs the console can read

Everything below already exists and needs no backend change.

| Endpoint | Credential | Used by |
| --- | --- | --- |
| `GET /health` | none | Overview, Security, Reports, masthead |
| `GET /v1/agents`, `GET /v1/agents/:id`, `GET /v1/agents/:id/keys` | operator | Agents, Agent detail |
| `POST /v1/agents/:id/suspend` \| `/resume` | operator | Agents |
| `GET /v1/tools` | operator | Tools, Access |
| `GET /v1/policies`, `GET /v1/policies/:id` | operator | Policies, Policy detail, Access |
| `POST /v1/policies/:id/enable` \| `/disable` | operator | Policies |
| `GET /v1/approvals[?mine=true]`, `GET /v1/approvals/:id` | operator | Approvals, Approval detail |
| `POST /v1/approvals/:id/vote`, `POST /v1/approvals/:id/execute` | operator | Approvals |
| `GET /v1/evidence?agentId=&outcome=&limit=`, `GET /v1/evidence/:id` | operator | Evidence, Evidence detail, Agent detail |
| `GET /v1/decisions/:id` | operator | Evidence detail (trace) |
| `GET /v1/audit?limit=&afterSequence=&order=` | operator | Audit |
| `GET /v1/audit/verify[?headDigest=&headSequence=]` | operator | Overview, Audit, Security |
| `POST /v1/mcp/scan` | operator | Security |
| `POST /v1/actions`, `POST /v1/actions/explain` | **agent** | not reachable from the console |

## 4. Exported UI components

The prototype export ships its own integration spec in
`arc-control-prototype/src/data/mapping.ts`: 17 screens mapped to console
source, endpoints, writes and SDK methods, each tagged `IMPLEMENTED` /
`API-ONLY` / `DERIVED`; plus 38 components each mapped to the server-side
helper it is meant to ship as. The export is unusually explicit that React is
the canvas and not the delivery mechanism —
`components/PrototypeBar.tsx` states *"Ships as server-rendered templates, not
React."*

| Screen status | Count | Meaning |
| --- | --- | --- |
| `IMPLEMENTED` | 9 | Renders from endpoints the console already calls |
| `API-ONLY` | 4 | Endpoint exists; the console has no route and the SDK no method |
| `DERIVED` | 2 | Computed in the console from existing reads; no new endpoint |

The design tokens in `arc-control-prototype/src/index.css` are the existing
`render.ts` tokens **plus** additive ones (`--surface-sunk`, `--border-strong`,
`--accent-ink`, `--focus`, `--info`, `--info-bg`, `--proto`, `--proto-bg`). No
existing token value changed, so the port is additive.

## 5. Components requiring adaptation

| From | To | Why |
| --- | --- | --- |
| React + react-router + Tailwind v4 + framer-motion | `html` tagged template in `render.ts`, server routing in `server.ts` | The console ships no client JavaScript and `default-src 'none'`. Tailwind utility classes become real CSS in the `STYLES` block. |
| `useState` forms (Security scan, vote comment, audit anchor) | `GET` with query params; `POST` → 303 for mutations | No client JS. The scan form posts and re-renders. |
| Row-click navigation (`onClick={() => navigate(...)}`) | A real `<a>` in the row | Clickable rows need JS; a link does not, and is better for keyboard and screen readers. |
| `ProtoContext` (theme toggle, scenario switcher, banner nonce) | `prefers-color-scheme`, real API data, `?notice=` | The theme switch and scenario dropdown are canvas review tools. Both themes ship via the media query, which the console already does. |
| `PrototypeBar`, `screens/Mapping.tsx`, `MappingPanel` | dropped | Canvas chrome; the export marks them `Canvas only`. |
| `lib/digest.ts` (`fakeDigest`), `data/seed.ts` | dropped | Fabricated values. Real digests come from the API. |
| `lib/match.ts` | import `matchSelectors` from `@arc-control/policy-engine` | The prototype hand-ported it; the real one is exported and takes a `PolicyInput`. Use the real one so Access can never drift from the engine. |
| `concepts/*` + `components/ConceptFrame` | not implemented | See §7. |

## 6. Missing backend dependencies

**For the ten sections: none.** Every supported screen reads an endpoint that
already exists. What is missing is on the client side of the contract:

1. **SDK read methods.** `getApproval`, `getAgent`, `listAgentKeys`,
   `getPolicy`, `scanMcp` — all five back onto endpoints that exist. Additive
   reads only.
2. **A bug in `verifyAudit`.** `GET /v1/audit/verify` answers **409** when the
   chain is broken (`routes.ts`), and the SDK's transport throws on any non-OK
   status except 202. So a broken chain makes `verifyAudit()` throw, the
   console's catch-all turns it into a 502, and the operator is told *"The
   control API could not be reached"* — exactly backwards. The chain being
   broken is the single most important thing the console has to say. This is a
   real defect on `main`, not something the integration introduces, and the
   export flags it: `mapping.ts` S2 note R4.
3. **`/v1/approvals` returns pending only.** `gateway.approvals.listPending()`,
   so "approval history" cannot be listed. Resolved requests remain reachable
   individually via `GET /v1/approvals/:id`, and their outcome is in evidence
   and audit. Approval history is shown from evidence and audit, not invented.
4. **No persistence for scans.** `POST /v1/mcp/scan` computes and returns;
   nothing is stored. The Security screen must say so.
5. **Connector drift detail is CLI-only.** `detectDrift` is reachable through
   `arc mcp diff`; `/health` exposes only a connector's health message. The
   Security screen shows the message and names the CLI.

## 7. The proposed export

Six concepts, none implementable against this backend. The export states the
blocker for each, and all six check out:

| Concept | Blocker |
| --- | --- |
| Policy simulator | `POST /v1/actions/explain` requires an **agent** key. The console holds an operator token and must not hold an agent key. |
| Agent run trace | No query by `correlationId`; evidence filters on `agentId` and `outcome` only. |
| Historical trends | No time-series or aggregation endpoint, and no time filter on evidence. |
| Security findings inbox | Scans are stateless. No findings store, history or triage state. |
| Connector drift comparison | `detectDrift` is CLI-only; the API returns a health message. |
| Delegation chain | `AgentPrincipal.delegatedFrom` exists in the schema and is never populated. |

These are documented in `docs/roadmap/arc-control-future-capabilities.md` and
**not** built into the console.

## 8. Implementation risks

| Risk | Mitigation |
| --- | --- |
| **The Access matrix implying authorization.** A cell showing a policy in scope is not a grant; parameters at request time decide the effect. | Cells render policies in scope and the effects a policy's rules *can* produce. Never "allowed". Suspended agents are marked as refused at authentication, before policy. The matrix uses the engine's own `matchSelectors`, so it cannot drift from the engine. |
| **Reports reading as analytics.** Derived counts over a bounded window can look like trends. | Every report prints its window — record count and the first/last timestamp in it. No time axis, no rates, no trend arrows. |
| **Weakening the CSP.** The design has interactive panels. | No inline scripts, no client JS, no third-party origins. `style-src 'unsafe-inline'` stays as-is for the single inline `<style>`; nothing else loosens. Interactions are links, `GET` query params and `POST` → 303. |
| **Softening the audit caveat.** The self-only verification caveat is a trust commitment (`TRUST_MODEL.md`). | Restyled, never shortened. Both branches of `checkedAgainstExpectation` keep their full text. |
| **Escaping.** Tool descriptions, policy reasons, approval comments and scan findings are agent- or operator-controlled. | The existing `html` tagged template escapes every interpolation; `raw()` is only ever applied to `html` output. New helpers follow the same discipline, and a test asserts it. |
| **Secrets.** Agent detail shows credentials. | `AgentCredential` carries `displayPrefix`, `salt` and `secretHash`. Only the prefix and the timestamps render; the salt and hash are never sent to the page. |
| **A larger page budget.** Ten sections against six. | No new dependency. The console keeps zero runtime dependencies beyond the workspace SDK and schemas. |
