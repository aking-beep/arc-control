# ARC Control — operational prototype (Magic Patterns export)

The approved visual reference for the console implemented in
`apps/control-console`.

Exported from Magic Patterns. This tree is **source only**: its `App.tsx`,
`index.html`, `index.tsx`, `package.json` and `vite.config.ts` were overwritten
by the second export during the flat upload in commit `87d1435` and are not
recoverable. It will not `npm run dev`. See `../README.md` for the full account.

What survived, and where it went:

| Path | Contents |
| --- | --- |
| `src/index.css` | Design tokens and base styles. The existing `render.ts` tokens plus additive ones; no existing value changed. |
| `src/components/` | 27 components. `AppShell`, `NavRail` and `Masthead` define the shell; the rest are the badges, tables, timelines and panels. |
| `src/screens/` | 17 screens — the ten navigation sections plus the detail, confirm, error and mapping screens. |
| `src/data/mapping.ts` | The integration spec: screen → console source, endpoints read, writes, SDK methods, status. Read this first. |
| `src/data/types.ts` | The prototype's view of the `@arc-control/schemas` types. |
| `src/data/seed.ts` | Canvas demo data. Not production data; the console reads `apps/control-api/src/seed.ts`. |
| `src/lib/` | Pure helpers: formatting, condition-to-text, action headlines, selector matching, scan preview, fake digests. |
| `src/state/ProtoContext.tsx` | Canvas-only state: theme toggle, scenario switcher, banner lifetime. Replaced in the console by the server's own request handling. |

`src/components/PrototypeBar.tsx` and `src/screens/Mapping.tsx` are canvas
chrome. They are review tools, and the export says so: they never ship.
