# Magic Patterns design reference

The approved visual reference for the ARC Control console. Nothing in this
directory is built, tested, linted or shipped: it is the design record the
console in `apps/control-console` was implemented from, kept so that a later
change can be checked against what was approved.

Two exports live here.

| Directory | What it is | Status |
| --- | --- | --- |
| `arc-control-prototype/` | The operational console. Ten sections against the capabilities that exist in this repository. | Implemented — see `apps/control-console` |
| `arc-control-proposed/` | Six product concepts that need backend work this repository does not have. Structure and empty states only, no data. | Not implemented — see `docs/roadmap/arc-control-future-capabilities.md` |

## How these files got here, and what was lost

Both exports were uploaded to the repository root in commit `87d1435` ("Add
files via upload") as a single flat directory, with no subdirectories. Two
things followed from that:

1. **The root `README.md` and the workspace root `package.json` were
   overwritten** by the proposed export's own files. The monorepo root
   `package.json` defines the npm workspaces and every `npm run` script, so at
   `87d1435` the repository could not install, build or test. Both files have
   been restored from `f68c4d2` (the merge commit the branch was taken from).

2. **The two exports were merged into one namespace.** Where both exports
   contained a file of the same name, the second upload won. The prototype
   export's `App.tsx`, `index.html`, `index.tsx`, `package.json`,
   `vite.config.ts` and `README.md` were overwritten by the proposed export's
   and are not recoverable from this repository. The prototype's
   `src/index.css` survived and is byte-identical to the proposed export's, so
   a copy sits in both trees.

The directory structure here was reconstructed from the relative import paths
in the exported source (`../state/ProtoContext`, `./components/ConceptFrame`,
`../lib/format`, and so on), which pin every surviving file to exactly one
location. `src/screens/*` is the one group no surviving file imports — the
prototype's `App.tsx` held those routes and was lost — so those seventeen
screens are placed by elimination.

Practical consequence: **`arc-control-prototype/` will not `npm run dev`.** It
has no entry point, no `index.html` and no `package.json`. Read it as source,
not as a running app. `arc-control-proposed/` is complete and does run.

## What the prototype export already tells you

The prototype was designed against this repository rather than alongside it,
and it carries its own integration spec. Three files are worth reading before
changing the console:

- **`arc-control-prototype/src/data/mapping.ts`** — every screen mapped to the
  `apps/control-console` source that renders it, the API endpoints it reads,
  the writes it performs, the SDK methods it needs, and a status of
  `IMPLEMENTED` / `API-ONLY` / `DERIVED`. The second half maps every component
  to the server-side helper it ships as.
- **`arc-control-prototype/src/index.css`** — the design tokens, which are the
  existing `render.ts` tokens plus additive ones. No existing value changed.
- **`arc-control-prototype/src/components/PrototypeBar.tsx`** — states the
  architectural intent in the export itself: *"Ships as server-rendered
  templates, not React."*

That intent is what the implementation follows. The console remains
server-rendered Node with no client JavaScript and
`content-security-policy: default-src 'none'`; the React in this directory is a
canvas prototype, not the delivery mechanism.

## Reading the prototype's data

`arc-control-prototype/src/data/seed.ts` and `src/lib/digest.ts` contain
demo-shaped values for the canvas: deterministic fake digests and ids that only
need to look the right shape. They are not production data and were never
produced by a running gateway. The console reads the real
`apps/control-api/src/seed.ts` instead.
