# The static showcase

```bash
npm run showcase          # → dist/showcase/
```

Renders the console to a folder of flat `.html` files with relative links. The
folder works at a site root, in a subdirectory, behind any host, and opened
from disk — no rewrite rules, no clean-URL configuration, no `<base>` tag.

## Why a capture and not a deployment

The console is a Node server that reads a live control API with an operator
credential. Hosting that publicly would mean putting an operator token on the
internet, and anyone who found it could suspend agents and disable policies.

The console is also server-rendered with no client JavaScript, so every page it
serves is already a complete, self-contained document. The showcase is
therefore not a mock-up or a second implementation — it is the real console's
real output, captured. Every byte of markup came out of
`apps/control-console`, rendered against a real gateway, real policy
evaluation, a real approval and a real hash-chained audit log.

## What is real

| | |
| --- | --- |
| **Real** | The markup. The design. The policy decisions and their traces. The approval that was cast and consumed. The evidence records and their integrity digests. The audit chain those digests verify against. |
| **Simulated** | The connector effects. No money moves and no issue is filed — exactly as `ARC_SEED_DEMO=true` behaves for anyone running it locally. |
| **Inert** | Anything that would write. Vote, suspend, resume, enable, disable and scan are rendered and disabled, each with a line saying what it does in the live console. |

The scenario is limited to the three tools and two policies the shipped demo
seed registers, so every page is reproducible: run the seed, take the same
actions, get the same pages. Nothing is invented for the showcase.

One request is left pending on purpose, so the approvals queue has a live card
to look at, and one is approved and executed, so an evidence record shows the
full lifecycle.

## How dead links are prevented

The builder does not work from a hand-written route list. It renders a page,
finds every link in it, renders those, and repeats until closure — then asserts
that no absolute link survived the rewrite. A page the builder forgot cannot
ship as a dead link, because the build fails instead.

That makes it a link checker for the whole console, which is why CI runs it.
It has already caught one: the Audit page linked every `evidence.recorded` row
to `record.subject`, which is the *action* id, not the evidence id — a 404 on
every such row.

Two pages answer a `POST` and so are reached by no link. They are captured
explicitly: the 404 page, and a real scan of a deliberately poisoned MCP
manifest, which the Security page's inert form links to.

## Publishing it

The output is static files; copy them wherever they need to go. On
`arctransformationgroup.com` they live at `public/ark-control/console/` in the
`arc-website` repository and are served from `/ark-control/console/index.html`.

`build.json` records the commit, the build time, the page list and the scenario,
so a published capture can always be traced back to the code that produced it.
