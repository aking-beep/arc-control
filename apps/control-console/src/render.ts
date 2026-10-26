/**
 * HTML rendering for the console.
 *
 * The console is server-rendered with no client-side framework and no build
 * step. That is a deliberate choice: the console displays evidence about
 * security decisions, and a page an auditor can read the source of is worth
 * more here than a richer one they cannot. The page is also the thing most
 * likely to be screenshotted into an audit report, so it is built to print
 * legibly.
 *
 * The visual language comes from the Magic Patterns operational prototype in
 * `design-reference/magic-patterns/arc-control-prototype/`. That export states
 * the same intent in its own source — "Ships as server-rendered templates, not
 * React" — and its design tokens are this file's previous tokens plus additive
 * ones, so the port changed no existing value. Every Tailwind utility in the
 * export became real CSS in `STYLES` below; nothing arrives from a CDN and
 * there is no inline script, so the content security policy stays as strict as
 * it was.
 */

import { count, outcomeLabel, shortDigest, timeMs, timestamp } from './format.js';

/** Escapes text for interpolation into HTML. */
export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Tagged template that escapes every interpolated value.
 *
 * Everything this console renders — tool names, policy reasons, approval
 * comments, audit summaries, scan findings — originated outside it, and some of
 * it came from an agent. Escaping by default at the template level means a tool
 * description cannot become script in an operator's browser.
 */
export function html(strings: TemplateStringsArray, ...values: unknown[]): string {
  return strings.reduce((accumulated, part, index) => {
    if (index === 0) return part;
    const value = values[index - 1];
    const rendered = Array.isArray(value)
      ? value.map((item) => (isTrusted(item) ? item.value : escapeHtml(item))).join('')
      : isTrusted(value)
        ? value.value
        : escapeHtml(value);
    return accumulated + rendered + part;
  }, '');
}

export interface Trusted {
  readonly __trustedHtml: true;
  readonly value: string;
}

/**
 * Marks a string as already-rendered HTML. Only ever applied to output of
 * `html` itself, so no caller-supplied text reaches the page unescaped.
 */
export function raw(value: string): Trusted {
  return { __trustedHtml: true, value };
}

function isTrusted(value: unknown): value is Trusted {
  return typeof value === 'object' && value !== null && (value as Trusted).__trustedHtml === true;
}

/** Joins pre-rendered fragments. */
export function join(parts: readonly (Trusted | string)[], separator = ''): Trusted {
  return raw(parts.map((part) => (isTrusted(part) ? part.value : escapeHtml(part))).join(separator));
}

export const NOTHING: Trusted = raw('');

// --- the shell ------------------------------------------------------------

export interface NavItem {
  readonly href: string;
  readonly label: string;
  /** Rendered as a count beside the label, for work waiting on the operator. */
  readonly attention?: number;
}

export interface NavGroup {
  readonly label: string;
  readonly items: readonly NavItem[];
}

/**
 * The navigation, grouped by what an operator is doing rather than by which
 * package serves it. Section names are the ones the prototype kept from the
 * previous flat navigation, so no existing URL changed.
 */
/**
 * The 2.0 navigation.
 *
 * Grouped by what a security or platform team does rather than by which
 * object a page happens to show: an operator arrives either because something
 * needs them (Operate), because they are changing what agents may do
 * (Inventory, Govern), because they are answering for it (Assure, Record), or
 * because they are configuring ARC itself (Admin).
 *
 * The 1.0 sections are all still here. Tools, Access and Audit were not in
 * the 2.0 proposal, but each is a working page with tests and a place in the
 * published showcase, and removing a working answer to "what can this agent
 * reach?" to hit a nav count would be a loss, not a tidy-up.
 */
export const NAVIGATION: readonly NavGroup[] = [
  {
    label: 'Operate',
    items: [
      { href: '/', label: 'Overview' },
      { href: '/approvals', label: 'Approvals' },
      { href: '/activity', label: 'Activity' },
    ],
  },
  { label: 'Inventory', items: [{ href: '/agents', label: 'Agents' }, { href: '/tools', label: 'Tools' }] },
  { label: 'Govern', items: [{ href: '/policies', label: 'Policies' }, { href: '/access', label: 'Access' }] },
  {
    label: 'Assure',
    items: [
      { href: '/assurance', label: 'Assurance' },
      { href: '/risks', label: 'Risks' },
      { href: '/findings', label: 'Findings' },
      { href: '/security', label: 'Security' },
    ],
  },
  {
    label: 'Record',
    items: [
      { href: '/evidence', label: 'Evidence' },
      { href: '/audit', label: 'Audit' },
      { href: '/notifications', label: 'Notifications' },
    ],
  },
  { label: 'Admin', items: [{ href: '/reports', label: 'Reports' }, { href: '/settings', label: 'Settings' }] },
];

export type BannerKind = 'info' | 'success' | 'error';

export interface Banner {
  readonly kind: BannerKind;
  readonly message: string;
}

export interface LayoutOptions {
  readonly title: string;
  /** The nav href of the active section. */
  readonly active: string;
  readonly body: string;
  readonly apiBase: string;
  readonly operatorIdentity: string;
  readonly banner?: Banner;
  /** Pending approvals, shown against the Approvals item. */
  readonly pendingApprovals?: number;
  /** `ok` | `degraded` from `/health`, or undefined when health is unknown. */
  readonly health?: string;
  readonly version?: string;
  /** True when the API reports it is serving the demo seed. */
  readonly demo?: boolean;
}

/**
 * The brand mark as an inline SVG favicon.
 *
 * Inline rather than a file because the console serves exactly one resource —
 * the document — and a tab icon is not worth a second request or a build step.
 * Without it the browser asks the origin for `/favicon.ico` on every page view
 * and takes a 404, which is noise in an operator's network log and a broken
 * request on any host that does not happen to have one at its root.
 *
 * Three bars, the middle one full width: a decision point, which is what the
 * product is. It reads as a mark rather than a glyph at 16px.
 */
const FAVICON =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
      '<rect width="32" height="32" rx="7" fill="#1d4ed8"/>' +
      '<rect x="7" y="7.5" width="11" height="3" rx="1.5" fill="#ffffff" opacity="0.5"/>' +
      '<rect x="7" y="14.5" width="18" height="3" rx="1.5" fill="#ffffff"/>' +
      '<rect x="7" y="21.5" width="11" height="3" rx="1.5" fill="#ffffff" opacity="0.5"/>' +
      '</svg>',
  );

export function layout(options: LayoutOptions): string {
  const groups = NAVIGATION.map((group) => {
    const items = group.items.map((item) => {
      const active = item.href === '/' ? options.active === '/' : options.active.startsWith(item.href);
      const attention = item.href === '/approvals' ? (options.pendingApprovals ?? 0) : 0;
      return html`<li>
        <a
          href="${item.href}"
          class="${active ? 'rail-item active' : 'rail-item'}"
          ${raw(active ? 'aria-current="page"' : '')}
        >
          ${active ? raw('<span class="rail-mark" aria-hidden="true"></span>') : NOTHING}
          <span>${item.label}</span>
          ${attention > 0
            ? raw(html`<span class="rail-count">${count(attention)}<span class="sr-only"> pending</span></span>`)
            : NOTHING}
        </a>
      </li>`;
    });

    return html`<div class="rail-group">
      <div class="rail-group-label">${group.label}</div>
      <ul>
        ${items.map((item) => raw(item))}
      </ul>
    </div>`;
  });

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(options.title)} — ARC Control</title>
<link rel="icon" href="${FAVICON}">
<style>${STYLES}</style>
</head>
<body>
<a href="#main" class="skip-link">Skip to content</a>
${options.demo ? DEMO_STRIP : ''}
<div class="shell">
<nav class="rail" aria-label="Console">
  <div class="rail-brand">
    <span class="mark" aria-hidden="true"></span>
    <span class="wordmark">ARC <strong>Control</strong></span>
  </div>
  <div class="rail-groups">${groups.join('')}</div>
  <div class="rail-foot">Theme follows the system setting</div>
</nav>
<div class="column">
  <header class="masthead">
    <p class="masthead-operator">
      Acting as <strong>${escapeHtml(options.operatorIdentity)}</strong>
      <span class="muted">(configured, not authenticated)</span>
    </p>
    <p class="masthead-api">
      <span>API <span class="mono">${escapeHtml(options.apiBase)}</span></span>
      ${options.health ? healthIndicator(options.health).value : ''}
      ${options.version ? `<span class="tnum muted">v${escapeHtml(options.version)}</span>` : ''}
    </p>
  </header>
  <main id="main">
    <div class="main-inner">
${options.banner ? bannerView(options.banner).value : ''}
${options.body}
    </div>
  </main>
</div>
</div>
</body>
</html>`;
}

/**
 * The demonstration notice.
 *
 * Shown only when the API reports it loaded the demo seed. An operator looking
 * at a console must never have to guess whether what they are reading describes
 * their own systems, so this says so at the top of every page rather than on
 * the pages that happen to show records.
 */
const DEMO_STRIP = `<aside class="demo-strip" aria-label="Environment notice">
  <strong>Demonstration environment</strong>
  <span>This API was started with <span class="mono">ARC_SEED_DEMO=true</span>. The agents, tools and policies are the worked example from <span class="mono">apps/control-api/src/seed.ts</span> and the connector effects are simulated. The gateway, policy engine, approval engine, evidence and audit chain are real, and so is every record below.</span>
</aside>`;

export function bannerView(banner: Banner): Trusted {
  const glyph = banner.kind === 'error' ? '✕' : banner.kind === 'success' ? '✓' : 'i';
  return raw(html`<div class="banner ${banner.kind}" role="${banner.kind === 'error' ? 'alert' : 'status'}">
    <span class="banner-glyph" aria-hidden="true">${glyph}</span>
    <span>${banner.message}</span>
  </div>`);
}

// --- page furniture -------------------------------------------------------

export interface PageHeaderOptions {
  readonly title: Trusted | string;
  readonly lede?: Trusted | string;
  readonly actions?: Trusted | string;
  /** Larger title, for a page whose subject is one object. */
  readonly display?: boolean;
}

export function pageHeader(options: PageHeaderOptions): Trusted {
  return raw(html`<div class="page-header">
    <div class="page-header-text">
      <h1 class="${options.display ? 'display' : ''}">${options.title}</h1>
      ${options.lede ? raw(html`<p class="lede">${options.lede}</p>`) : NOTHING}
    </div>
    ${options.actions ? raw(html`<div class="page-header-actions">${options.actions}</div>`) : NOTHING}
  </div>`);
}

export function sectionTitle(title: string, aside?: Trusted | string): Trusted {
  return raw(html`<div class="section-title">
    <h2>${title}</h2>
    ${aside ? raw(html`<div class="section-aside">${aside}</div>`) : NOTHING}
  </div>`);
}

export function emptyState(message: string): Trusted {
  return raw(html`<p class="empty">${message}</p>`);
}

/** A back link above a detail page's header. */
export function backLink(href: string, label: string): Trusted {
  return raw(html`<p class="back"><a href="${href}">← ${label}</a></p>`);
}

// --- tables ---------------------------------------------------------------

export interface Column {
  readonly label: string;
  /** Right-aligns the column, for counts and durations. */
  readonly numeric?: boolean;
  /** Hides the heading visually while keeping it for screen readers. */
  readonly hidden?: boolean;
}

/**
 * The dense table.
 *
 * Takes a caption because a table of evidence in an audit export needs to say
 * what it is, and `scope` on every heading because these tables are read by
 * screen readers as often as they are skimmed.
 */
export function table(
  caption: string,
  columns: readonly (Column | string)[],
  rows: readonly (Trusted | string)[],
  options: { readonly compact?: boolean } = {},
): Trusted {
  if (rows.length === 0) return NOTHING;

  const headings = columns.map((column) => {
    const spec: Column = typeof column === 'string' ? { label: column } : column;
    const classes = [spec.numeric ? 'numeric' : '', spec.hidden ? 'sr-head' : ''].filter(Boolean).join(' ');
    return html`<th scope="col" class="${classes}">
      ${spec.hidden ? raw(html`<span class="sr-only">${spec.label}</span>`) : spec.label}
    </th>`;
  });

  // A horizontally scrolling region has to be focusable, or a keyboard user
  // cannot scroll it. These tables are dense by design and several of them
  // scroll at ordinary widths, so the wrapper is a labelled region.
  return raw(html`<div class="table-wrap" role="region" aria-label="${caption}" tabindex="0">
    <table class="dt ${options.compact ? 'compact' : ''}">
      <caption class="sr-only">${caption}</caption>
      <thead>
        <tr>
          ${headings.map((heading) => raw(heading))}
        </tr>
      </thead>
      <tbody>
        ${rows.map((row) => (typeof row === 'string' ? raw(row) : row))}
      </tbody>
    </table>
  </div>`);
}

/** A definition list: the shape most detail panels want. */
export function definitions(entries: readonly (readonly [string, Trusted | string])[]): Trusted {
  return raw(html`<dl class="defs">
    ${entries.map(([term, value]) => raw(html`<dt>${term}</dt>
      <dd>${value}</dd>`))}
  </dl>`);
}

// --- filters --------------------------------------------------------------

export interface FilterOption {
  readonly value: string;
  readonly label: string;
  readonly count?: number;
}

/**
 * Filter links.
 *
 * Links, not a form: the filtered view has its own URL, which can be
 * bookmarked, shared with an auditor and reached without JavaScript.
 */
export function filterLinks(
  label: string,
  options: readonly FilterOption[],
  current: string,
  hrefFor: (value: string) => string,
): Trusted {
  return raw(html`<nav class="filters" aria-label="${label}">
    <span class="filters-label">${label}</span>
    ${options.map((option) => {
      const active = option.value === current;
      return raw(html`<a
        href="${hrefFor(option.value)}"
        class="${active ? 'chip active' : 'chip'}"
        ${raw(active ? 'aria-current="true"' : '')}
        >${option.label}${option.count === undefined
          ? NOTHING
          : raw(html`<span class="chip-count tnum">${count(option.count)}</span>`)}</a
      >`);
    })}
  </nav>`);
}

/** The quiet inventory line that replaces a row of stat tiles. */
export function countLine(items: readonly { value: unknown; label: string; href?: string }[]): Trusted {
  return raw(html`<p class="count-line">
    ${items.map((item, index) => {
      const inner = html`<span class="tnum">${count(item.value)}</span> ${item.label}`;
      return raw(html`${index > 0 ? raw('<span class="sep" aria-hidden="true">·</span>') : NOTHING}${item.href
        ? raw(html`<a href="${item.href}">${raw(inner)}</a>`)
        : raw(html`<span>${raw(inner)}</span>`)}`);
    })}
  </p>`);
}

// --- badges ---------------------------------------------------------------

type Tone = 'allow' | 'deny' | 'approval' | 'failed' | 'info' | 'muted';

/** Every badge carries its text, so meaning never depends on colour alone. */
export function badge(tone: Tone, text: string): Trusted {
  return raw(html`<span class="badge ${tone}">${text}</span>`);
}

export function effectBadge(effect: unknown): Trusted {
  const value = String(effect ?? '');
  const tone: Tone =
    value === 'ALLOW' ? 'allow' : value === 'DENY' ? 'deny' : value === 'REQUIRE_APPROVAL' ? 'approval' : 'muted';
  return badge(tone, value || '—');
}

const OUTCOME_TONE: Record<string, Tone> = {
  allowed: 'allow',
  executed: 'allow',
  approved: 'allow',
  pending_approval: 'approval',
  denied: 'deny',
  failed: 'failed',
  rejected: 'muted',
  expired: 'muted',
};

export function outcomeBadge(outcome: unknown): Trusted {
  const value = String(outcome ?? '');
  return badge(OUTCOME_TONE[value] ?? 'muted', outcomeLabel(value));
}

export function riskBadge(tier: unknown): Trusted {
  const value = String(tier ?? '');
  if (!value) return raw(html`<span class="muted">—</span>`);
  const tone: Tone = value === 'critical' ? 'deny' : value === 'high' ? 'failed' : value === 'medium' ? 'approval' : 'muted';
  return badge(tone, value);
}

export function severityBadge(severity: unknown): Trusted {
  const value = String(severity ?? '');
  const tone: Tone =
    value === 'critical' ? 'deny' : value === 'high' ? 'failed' : value === 'medium' ? 'approval' : 'muted';
  return badge(tone, value || 'info');
}

/** A dot plus its text, never the dot alone. */
/**
 * A control assessment status.
 *
 * `not_assessable` is deliberately not styled like a near-miss or a warning.
 * It is a distinct answer — the question could not be answered — and a reader
 * scanning a column of badges must not be able to mistake it for "almost
 * passing" or for a transient problem that will clear itself.
 */
export function controlStatusBadge(status: unknown): Trusted {
  switch (String(status)) {
    case 'pass':
      return badge('allow', 'Pass');
    case 'fail':
      return badge('deny', 'Fail');
    case 'attested':
      return badge('approval', 'Attested');
    case 'not_applicable':
      return badge('muted', 'Not applicable');
    case 'not_assessable':
      return badge('info', 'Not assessable');
    default:
      return badge('muted', String(status ?? 'unknown'));
  }
}

/** A risk severity band. */
export function riskSeverityBadge(severity: unknown): Trusted {
  switch (String(severity)) {
    case 'critical':
      return badge('deny', 'Critical');
    case 'high':
      return badge('failed', 'High');
    case 'moderate':
      return badge('approval', 'Moderate');
    case 'low':
      return badge('muted', 'Low');
    default:
      return badge('muted', String(severity ?? 'unrated'));
  }
}

export function statusDot(ok: boolean, label: string): Trusted {
  return raw(html`<span class="status-dot ${ok ? 'ok' : 'bad'}">
    <span class="dot" aria-hidden="true"></span>${label}</span
  >`);
}

export function healthIndicator(status: unknown): Trusted {
  const value = String(status ?? '');
  const ok = value === 'ok';
  return raw(html`<span class="health ${ok ? 'ok' : 'degraded'}">
    <span class="dot" aria-hidden="true"></span>${value || 'unknown'}</span
  >`);
}

/**
 * An effect as a single letter, for the access matrix where a full word in
 * every cell would be unreadable. The full word stays available to a screen
 * reader and on hover.
 */
export function effectLetter(effect: unknown): Trusted {
  const value = String(effect ?? '');
  const letter = value === 'ALLOW' ? 'A' : value === 'DENY' ? 'D' : 'R';
  const tone = value === 'ALLOW' ? 'allow' : value === 'DENY' ? 'deny' : 'approval';
  return raw(html`<span class="effect-letter ${tone}" title="${value}"
    >${letter}<span class="sr-only"> ${value}</span></span
  >`);
}

// --- digests and raw data -------------------------------------------------

/**
 * A digest, laid out to be selected and compared.
 *
 * `user-select: all` rather than a copy button: a copy button needs
 * JavaScript, and this console has none.
 */
export function digestBlock(label: string, value: unknown, note?: string): Trusted {
  return raw(html`<div class="digest-row">
    <div>
      <div class="mono muted">${label}</div>
      ${note ? raw(html`<div class="digest-note">${note}</div>`) : NOTHING}
    </div>
    <code class="digest">${value ? String(value) : '—'}</code>
  </div>`);
}

/** Renders a value as a readable JSON block. */
export function jsonBlock(value: unknown): Trusted {
  return raw(html`<pre class="json">${safeJson(value)}</pre>`);
}

/**
 * The same JSON, behind a disclosure. Closed on screen so it never crowds the
 * reading of a record, and forced open when printed so an exported page is
 * complete.
 */
export function rawJson(label: string, value: unknown): Trusted {
  return raw(html`<details class="raw">
    <summary>${label}</summary>
    <pre class="json">${safeJson(value)}</pre>
  </details>`);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? 'null';
  } catch {
    return '/* this value could not be serialised */';
  }
}

// --- charts ---------------------------------------------------------------

export interface Segment {
  readonly key: string;
  readonly label: string;
  readonly value: number;
  readonly color: string;
}

/**
 * A stacked bar as inline SVG, with `role="img"` and a text summary.
 *
 * Callers pair it with the same numbers as a table. The bar is the glance; the
 * table is the record, and the record is what an auditor reads.
 */
export function stackedBar(segments: readonly Segment[], summary: string): Trusted {
  const total = segments.reduce((sum, segment) => sum + segment.value, 0) || 1;
  let offset = 0;
  const bars: string[] = [];

  for (const segment of segments) {
    if (segment.value <= 0) continue;
    const width = (segment.value / total) * 1000;
    bars.push(
      html`<rect x="${offset.toFixed(2)}" width="${width.toFixed(2)}" height="36" fill="${segment.color}"></rect>`,
    );
    if (offset > 0) {
      bars.push(html`<rect x="${offset.toFixed(2)}" width="2" height="36" fill="var(--surface)"></rect>`);
    }
    offset += width;
  }

  return raw(html`<svg
    role="img"
    aria-label="${summary}"
    viewBox="0 0 1000 36"
    preserveAspectRatio="none"
    class="stacked-bar"
  >
    <rect width="1000" height="36" fill="var(--surface-sunk)"></rect>
    ${bars.map((bar) => raw(bar))}
  </svg>`);
}

export { count, outcomeLabel, shortDigest, timeMs, timestamp };

const STYLES = `
/*
 * Tokens. The previous palette, unchanged, plus the additive tokens from the
 * Magic Patterns export (sunk surface, strong border, accent ink, focus, info
 * and the demonstration pair).
 */
:root {
  --bg: #f6f7f9;
  --surface: #ffffff;
  --surface-sunk: #eef0f3;
  --border: #dfe3e8;
  --border-strong: #c4cad2;
  --ink: #16191d;
  --ink-soft: #5b626b;
  --accent: #1d4ed8;
  --accent-ink: #ffffff;
  --focus: #1d4ed8;
  --allow: #0f7a4a;
  --allow-bg: #e6f4ec;
  --deny: #b4232c;
  --deny-bg: #fdeaeb;
  --approval: #8a5a00;
  --approval-bg: #fdf3e0;
  --failed: #8a4b00;
  --failed-bg: #fdeee0;
  --info: #1d4ed8;
  --info-bg: #e8eefc;
  --proto: #5b21b6;
  --proto-bg: #f1ebfd;
  --radius: 8px;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  --sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #101317;
    --surface: #181c22;
    --surface-sunk: #14181d;
    --border: #2b313a;
    --border-strong: #3a414c;
    --ink: #e8eaed;
    --ink-soft: #9aa3ae;
    --accent: #7ba2ff;
    --accent-ink: #0b1220;
    --focus: #7ba2ff;
    --allow: #5bd49a;
    --allow-bg: #10291f;
    --deny: #ff8a90;
    --deny-bg: #2c1618;
    --approval: #f0c069;
    --approval-bg: #2a2114;
    --failed: #f0a768;
    --failed-bg: #2a1d12;
    --info: #7ba2ff;
    --info-bg: #141c2e;
    --proto: #c4b0ff;
    --proto-bg: #221a38;
    color-scheme: dark;
  }
}

* { box-sizing: border-box; }
html, body { height: 100%; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font: 14px/1.5 var(--sans);
}
.mono { font-family: var(--mono); font-size: 12.5px; }
.tnum { font-variant-numeric: tabular-nums; }
.muted { color: var(--ink-soft); }
.nowrap { white-space: nowrap; }
.allow-text { color: var(--allow); font-weight: 600; }
.deny-text { color: var(--deny); font-weight: 600; }
.failed-text { color: var(--failed); }
.sr-only {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
}
/*
 * Links in prose are underlined, not just coloured. WCAG 1.4.1: colour alone
 * cannot be the only thing that marks a link, and these pages are read in
 * greyscale often enough — printed into an audit report — that the underline
 * is the only cue that survives.
 *
 * It comes back off where the link is the whole content of a cell, a chip or a
 * nav item: there the link is identified by its position and its column
 * heading, not by its colour, and underlining every identifier in a dense
 * table costs legibility for nothing.
 */
a { color: var(--accent); text-decoration: underline; text-underline-offset: 2px; }
a:hover { text-decoration-thickness: 2px; }
.dt a, .matrix a, .rail-item, .chip, .button, .skip-link,
.count-line a, .filters a, .section-aside a, .back a,
h1 a, h2 a, .attention a.cta, .masthead a, details.raw summary a {
  text-decoration: none;
}
.dt a:hover, .matrix a:hover, .count-line a:hover, .section-aside a:hover,
.back a:hover, h1 a:hover, h2 a:hover, .attention a.cta:hover {
  text-decoration: underline;
}

/* Focus: a 3px ring at 2px offset, never removed. */
:where(a, button, input, select, textarea, summary, [tabindex]):focus-visible {
  outline: 3px solid var(--focus);
  outline-offset: 2px;
  border-radius: 4px;
}
.skip-link {
  position: absolute; left: -9999px; top: 0; z-index: 50;
  background: var(--surface); padding: 8px 12px; border: 1px solid var(--border);
}
.skip-link:focus { left: 8px; top: 8px; }

/* Motion: colour only, 120ms, links and controls only. */
a, button, .chip, .rail-item { transition: color 120ms, background-color 120ms, border-color 120ms; }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }

/* --- the shell --- */
.demo-strip {
  display: flex; gap: 12px; align-items: baseline; flex-wrap: wrap;
  padding: 8px 20px; background: var(--proto-bg); color: var(--proto);
  border-bottom: 1px solid var(--border); font-size: 12.5px;
}
.demo-strip strong { white-space: nowrap; }
.shell { display: flex; min-height: 100%; }
.rail {
  display: flex; flex-direction: column; width: 216px; flex-shrink: 0;
  border-right: 1px solid var(--border); background: var(--surface-sunk);
}
.rail-brand {
  display: flex; align-items: center; gap: 10px; height: 56px;
  padding: 0 20px; border-bottom: 1px solid var(--border);
}
.mark { width: 16px; height: 16px; border-radius: 3px; background: var(--accent); }
.wordmark { font-size: 15px; letter-spacing: -0.01em; }
.wordmark strong { font-weight: 600; }
.rail-groups { flex: 1; padding: 16px 12px; }
.rail-group { margin-bottom: 16px; }
.rail-group-label {
  padding: 0 8px 4px; font-size: 11px; font-weight: 600;
  text-transform: uppercase; letter-spacing: 0.04em; color: var(--ink-soft);
}
.rail-group ul { list-style: none; margin: 0; padding: 0; }
.rail-item {
  position: relative; display: flex; align-items: center; justify-content: space-between;
  height: 32px; padding: 0 8px; border-radius: 6px;
  color: var(--ink-soft); text-decoration: none;
}
.rail-item:hover { background: var(--surface); color: var(--ink); text-decoration: none; }
.rail-item.active { background: var(--surface); color: var(--ink); font-weight: 600; }
.rail-mark {
  position: absolute; left: 0; top: 6px; bottom: 6px; width: 2px;
  border-radius: 2px; background: var(--accent);
}
.rail-count { font-variant-numeric: tabular-nums; font-weight: 600; color: var(--approval); }
.rail-foot {
  padding: 12px 20px; border-top: 1px solid var(--border);
  font-size: 12px; color: var(--ink-soft);
}
.column { display: flex; flex-direction: column; flex: 1; min-width: 0; }
.masthead {
  display: flex; align-items: center; justify-content: space-between;
  gap: 24px; min-height: 56px; padding: 8px 32px; flex-wrap: wrap;
  border-bottom: 1px solid var(--border); background: var(--surface);
}
.masthead p { margin: 0; font-size: 13px; color: var(--ink-soft); }
.masthead strong { color: var(--ink); }
.masthead-api { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
main { flex: 1; min-width: 0; }
.main-inner { max-width: 1360px; margin: 0 auto; padding: 24px 32px 64px; }

.banner {
  display: flex; align-items: center; gap: 12px; margin-bottom: 20px;
  padding: 10px 16px; border: 1px solid; border-radius: var(--radius); font-size: 14px;
}
.banner-glyph { font-family: var(--mono); font-weight: 700; }
.banner.info { border-color: var(--info); background: var(--info-bg); color: var(--info); }
.banner.success { border-color: var(--allow); background: var(--allow-bg); color: var(--allow); }
.banner.error { border-color: var(--deny); background: var(--deny-bg); color: var(--deny); }

/* --- page furniture --- */
.page-header {
  display: flex; align-items: flex-start; justify-content: space-between;
  gap: 32px; margin-bottom: 24px; padding-bottom: 20px;
  border-bottom: 1px solid var(--border); flex-wrap: wrap;
}
.page-header-text { min-width: 0; }
.page-header-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; flex-wrap: wrap; }
h1 { font-size: 22px; font-weight: 650; line-height: 1.3; letter-spacing: -0.01em; margin: 0; }
h1.display { font-size: 28px; line-height: 1.2; }
h2 { font-size: 16px; font-weight: 650; margin: 0 0 12px; }
h3, h2.quiet { font-size: 12px; font-weight: 600; color: var(--ink-soft); margin: 0 0 8px; }
.lede { margin: 6px 0 0; max-width: 78ch; font-size: 15px; line-height: 1.55; color: var(--ink-soft); }
.section-title {
  display: flex; align-items: baseline; justify-content: space-between;
  gap: 16px; margin: 32px 0 12px;
}
.section-title h2 { margin: 0; }
.section-aside { font-size: 13px; color: var(--ink-soft); }
.back { margin: 0 0 12px; font-size: 13px; }
.note {
  font-size: 13px; color: var(--ink-soft); margin: 12px 0 0;
  max-width: 100ch; line-height: 1.55; overflow-wrap: anywhere;
}
.card {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 16px 20px; margin-bottom: 16px;
}
.card.broken { border-color: var(--deny); background: var(--deny-bg); }
.empty {
  padding: 24px 16px; text-align: center; font-size: 14px; color: var(--ink-soft);
  border: 1px dashed var(--border-strong); border-radius: var(--radius); margin: 0;
}
/*
 * minmax(0, ...) on every track, so a wide table inside a column scrolls in
 * its own wrapper instead of stretching the page. A grid item's default
 * minimum is its content, which is what makes an overflowing table push the
 * whole document sideways.
 */
.split { display: grid; grid-template-columns: minmax(0, 5fr) minmax(0, 7fr); gap: 40px; align-items: start; }
.split-wide { display: grid; grid-template-columns: minmax(0, 8fr) minmax(0, 4fr); gap: 40px; align-items: start; }
.split-even { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 32px; align-items: start; }
.with-detail { display: grid; grid-template-columns: minmax(0, 1fr) 400px; gap: 24px; align-items: start; }
.stack > * + * { margin-top: 20px; }

/* --- tables --- */
.table-wrap {
  border: 1px solid var(--border); border-radius: var(--radius);
  background: var(--surface); overflow-x: auto; contain: paint;
}
table.dt { width: 100%; border-collapse: collapse; }
.dt th {
  text-align: left; font-size: 12px; font-weight: 600; color: var(--ink-soft);
  background: var(--surface-sunk); padding: 7px 12px;
  border-bottom: 1px solid var(--border); white-space: nowrap;
}
.dt td { padding: 8px 12px; border-bottom: 1px solid var(--border); vertical-align: top; }
.dt tr:last-child td { border-bottom: 0; }
.dt.compact td { padding: 5px 12px; }
.dt th.numeric, .dt td.numeric { text-align: right; }
.dt tbody tr:hover td { background: var(--surface-sunk); }
.dt tr.flagged td { background: var(--deny-bg); }
.dt .sub { display: block; font-size: 13px; color: var(--ink-soft); }
.dt th[scope=row] {
  font-weight: 400; font-size: 12.5px; color: var(--ink-soft);
  background: var(--surface-sunk); font-family: var(--mono);
}
.defs { display: grid; grid-template-columns: auto 1fr; gap: 6px 16px; margin: 0; font-size: 13px; }
.defs dt { color: var(--ink-soft); }
.defs dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }

/* --- filters and counts --- */
.filters { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.filters-label { margin-right: 8px; font-size: 12px; font-weight: 600; color: var(--ink-soft); }
.chip {
  display: inline-flex; align-items: center; gap: 6px; height: 28px;
  padding: 0 10px; border: 1px solid var(--border); border-radius: 6px;
  background: var(--surface); color: var(--ink); font-size: 13px; white-space: nowrap;
}
.chip:hover { border-color: var(--border-strong); background: var(--surface-sunk); text-decoration: none; }
.chip.active { border-color: var(--ink); background: var(--ink); color: var(--bg); }
.chip-count { font-size: 12px; color: var(--ink-soft); }
.chip.active .chip-count { color: var(--bg); opacity: 0.8; }
.count-line {
  display: flex; flex-wrap: wrap; align-items: center; gap: 2px;
  margin: 0; font-size: 14px; color: var(--ink-soft);
}
.count-line .tnum { font-weight: 600; color: var(--ink); }
.count-line .sep { margin: 0 6px; }
.count-row {
  display: flex; align-items: center; justify-content: space-between;
  gap: 16px; flex-wrap: wrap; margin-top: 24px; padding: 12px 0;
  border-top: 1px solid var(--border); border-bottom: 1px solid var(--border);
}

/* --- badges --- */
.badge {
  display: inline-flex; align-items: center; height: 20px; padding: 0 8px;
  border: 1px solid; border-radius: 999px; font-size: 11.5px; font-weight: 600;
  line-height: 1; white-space: nowrap;
}
.badge.allow { background: var(--allow-bg); color: var(--allow); border-color: var(--allow); }
.badge.deny { background: var(--deny-bg); color: var(--deny); border-color: var(--deny); }
.badge.approval { background: var(--approval-bg); color: var(--approval); border-color: var(--approval); }
.badge.failed { background: var(--failed-bg); color: var(--failed); border-color: var(--failed); }
.badge.info { background: var(--info-bg); color: var(--info); border-color: var(--info); }
.badge.muted { background: var(--surface-sunk); color: var(--ink-soft); border-color: var(--border-strong); }
.status-dot, .health { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; font-size: 13px; }
.status-dot .dot, .health .dot { width: 8px; height: 8px; border-radius: 50%; }
.status-dot.ok { color: var(--ink); }
.status-dot.ok .dot { background: var(--allow); }
.status-dot.bad { color: var(--deny); }
.status-dot.bad .dot { background: var(--deny); }
.health { font-weight: 600; }
.health.ok { color: var(--allow); }
.health.ok .dot { background: var(--allow); }
.health.degraded { color: var(--failed); }
.health.degraded .dot { background: var(--failed); }
.effect-letter { font-family: var(--mono); font-size: 12px; font-weight: 700; }
.effect-letter.allow { color: var(--allow); }
.effect-letter.deny { color: var(--deny); }
.effect-letter.approval { color: var(--approval); }

/* --- digests and JSON --- */
.digest-row { display: grid; grid-template-columns: 150px 1fr; gap: 12px; padding: 6px 0; font-size: 13px; }
.digest-note { font-size: 11.5px; color: var(--ink-soft); }
code.digest {
  font-family: var(--mono); font-size: 12.5px; background: var(--surface-sunk);
  padding: 4px 8px; border-radius: 4px; user-select: all; word-break: break-all;
}
pre.json {
  font-family: var(--mono); font-size: 12.5px; background: var(--surface-sunk);
  border-radius: 6px; padding: 12px 16px; margin: 0; max-height: 420px;
  overflow: auto; line-height: 1.6;
}
details.raw { border: 1px solid var(--border); border-radius: 6px; background: var(--surface); }
details.raw > summary { padding: 8px 12px; font-size: 13px; font-weight: 600; }
details.raw > pre.json { border-top: 1px solid var(--border); border-radius: 0 0 6px 6px; }
details > summary { cursor: pointer; list-style: none; }
details > summary::-webkit-details-marker { display: none; }
details > summary::before { content: "▸"; display: inline-block; width: 1em; color: var(--ink-soft); }
details[open] > summary::before { content: "▾"; }

/* --- forms --- */
form { margin: 0; }
form.inline { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
label.field { display: block; font-size: 12px; font-weight: 600; margin-bottom: 12px; }
button, .button {
  display: inline-flex; align-items: center; justify-content: center;
  font: inherit; font-size: 14px; height: 32px; padding: 0 14px;
  border: 1px solid var(--border-strong); border-radius: 6px;
  background: var(--surface); color: var(--ink); cursor: pointer; font-weight: 600;
}
button:hover, .button:hover { background: var(--surface-sunk); text-decoration: none; }
button.primary, .button.primary {
  background: var(--accent); border-color: var(--accent); color: var(--accent-ink);
}
button.primary:hover, .button.primary:hover { opacity: 0.9; background: var(--accent); }
button.danger, .button.danger {
  background: var(--surface); border-color: var(--deny); color: var(--deny);
}
button.danger:hover, .button.danger:hover { background: var(--deny-bg); }
button.danger-solid { background: var(--deny); border-color: var(--deny); color: var(--surface); }
button.small, .button.small { height: 28px; padding: 0 12px; font-size: 13px; }
input[type=text], input[type=number], textarea, select {
  font: inherit; font-size: 14px; width: 100%; margin-top: 4px;
  padding: 6px 10px; border: 1px solid var(--border-strong); border-radius: 6px;
  background: var(--surface); color: var(--ink);
}
input.mono, textarea.mono { font-family: var(--mono); font-size: 12.5px; }
textarea { resize: vertical; }
.field-row { display: flex; gap: 12px; align-items: flex-end; flex-wrap: wrap; }
.field-row > label.field { flex: 1; margin-bottom: 0; min-width: 180px; }
.hint { font-size: 12px; color: var(--ink-soft); }

/* --- the attention list on Overview --- */
.attention { list-style: none; margin: 0; padding: 0; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); overflow: hidden; }
.attention li { display: flex; align-items: center; gap: 16px; padding: 14px 20px; border-bottom: 1px solid var(--border); }
.attention li:last-child { border-bottom: 0; }
.attention .tone { width: 3px; height: 32px; border-radius: 2px; flex-shrink: 0; }
.attention .tone.deny { background: var(--deny); }
.attention .tone.approval { background: var(--approval); }
.attention p { margin: 0; flex: 1; min-width: 0; font-size: 15px; }
.attention p.deny { color: var(--deny); }
.attention a.cta { flex-shrink: 0; white-space: nowrap; font-size: 14px; font-weight: 600; }
.calm { margin: 0; padding: 16px 20px; font-size: 15px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); }

/* --- the decision ladder --- */
ol.ladder { list-style: none; margin: 0; padding: 0; }
ol.ladder li {
  display: grid; grid-template-columns: 28px 150px 1fr auto;
  gap: 12px; align-items: start; padding: 12px 0; border-bottom: 1px solid var(--border);
}
ol.ladder li:last-child { border-bottom: 0; }
ol.ladder li.on { background: var(--surface-sunk); }
ol.ladder .rung { text-align: center; font-size: 12px; font-weight: 600; color: var(--ink-soft); }
ol.ladder .rule-id { font-family: var(--mono); font-size: 12.5px; font-weight: 600; overflow-wrap: anywhere; }
ol.ladder .rule-body { min-width: 0; font-size: 13px; }
ol.ladder .rule-body p { margin: 0 0 4px; }
ol.ladder .rule-body p:last-child { margin-bottom: 0; }
ol.ladder.narrow li { grid-template-columns: 24px minmax(0, 1fr); }
ol.ladder.narrow .rule-id, ol.ladder.narrow .rule-body { grid-column: 2; }
ol.ladder.narrow .badge { grid-column: 2; justify-self: start; margin-top: 6px; }
code.cond {
  font-family: var(--mono); font-size: 12.5px; background: var(--surface-sunk);
  padding: 2px 6px; border-radius: 4px;
}

/* --- chips for policy scope --- */
.chips { display: inline-flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.scope-chip {
  display: inline-flex; align-items: center; height: 22px; padding: 0 6px;
  border: 1px solid var(--border-strong); border-radius: 4px;
  background: var(--surface-sunk); font-size: 12px;
}
.scope-chip .k { color: var(--ink-soft); margin-right: 4px; }
.scope-chip .v { font-family: var(--mono); }
.label-tag {
  display: inline-flex; align-items: center; height: 22px; padding: 0 6px;
  border: 1px solid var(--border); border-radius: 4px; font-size: 12px; color: var(--ink-soft);
}
.label-tag.control { background: var(--ink); color: var(--bg); border-color: var(--ink); font-weight: 600; }

/* --- the evidence timeline --- */
ol.timeline { list-style: none; margin: 0 0 16px; padding: 0; }
ol.timeline li { position: relative; display: grid; grid-template-columns: 20px 1fr; gap: 12px; padding-bottom: 20px; }
ol.timeline li .spine { position: absolute; left: 9px; top: 16px; bottom: 0; width: 1px; background: var(--border-strong); }
ol.timeline .node {
  margin-top: 4px; width: 11px; height: 11px; justify-self: center;
  border-radius: 50%; border: 2px solid var(--border-strong); background: var(--surface);
}
ol.timeline .node.allow { border-color: var(--allow); background: var(--allow); }
ol.timeline .node.deny { border-color: var(--deny); background: var(--deny); }
ol.timeline .node.approval { border-color: var(--approval); background: var(--approval); }
ol.timeline .node.plain { border-color: var(--ink); background: var(--ink); }
ol.timeline .stage { font-size: 13px; min-width: 0; }
ol.timeline .stage-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
ol.timeline .stage-head .name { font-weight: 600; }
ol.timeline .stage-head .name.hollow { font-weight: 400; color: var(--ink-soft); }

/* --- the access matrix --- */
/*
 * contain:paint here is load-bearing, not decoration. Without it the matrix
 * table's intrinsic width leaks into the root scroller even though this
 * wrapper clips it, and the whole page gains a horizontal scrollbar on a
 * phone. The containment is also simply true: nothing in here paints outside
 * the box. The focus ring is inset so the containment cannot clip it.
 */
.matrix-wrap {
  border: 1px solid var(--border); border-radius: var(--radius);
  background: var(--surface); overflow-x: auto; contain: paint;
}
.matrix-wrap:focus-visible, .table-wrap:focus-visible { outline-offset: -3px; }
table.matrix { width: 100%; border-collapse: collapse; font-size: 13px; }
table.matrix th.corner {
  position: sticky; left: 0; z-index: 2; min-width: 200px;
  background: var(--surface-sunk); text-align: left; padding: 8px 12px;
  font-size: 12px; font-weight: 600; color: var(--ink-soft);
  border-bottom: 1px solid var(--border-strong); border-right: 1px solid var(--border-strong);
}
table.matrix thead th.tool {
  min-width: 180px; background: var(--surface-sunk); text-align: left; vertical-align: bottom;
  padding: 8px 12px; border-bottom: 1px solid var(--border-strong); border-left: 1px solid var(--border-strong);
}
table.matrix thead th.tool .name { font-family: var(--mono); font-size: 12.5px; font-weight: 600; color: var(--ink); }
table.matrix thead th.tool .meta { display: flex; align-items: center; gap: 6px; margin-top: 4px; font-size: 12px; font-weight: 400; color: var(--ink-soft); }
table.matrix th.agent {
  position: sticky; left: 0; z-index: 1; background: var(--surface);
  text-align: left; vertical-align: top; font-weight: 400; padding: 10px 12px;
  border-bottom: 1px solid var(--border-strong); border-right: 1px solid var(--border-strong);
}
table.matrix td.cell { padding: 0; vertical-align: top; border-bottom: 1px solid var(--border); border-left: 1px solid var(--border); }
table.matrix td.cell.on { background: var(--info-bg); }
table.matrix td.cell > a { display: block; height: 100%; padding: 10px 12px; color: inherit; }
table.matrix td.cell > a:hover { background: var(--surface-sunk); text-decoration: none; }
table.matrix tr.suspended { opacity: 0.6; }
.cell-declared { font-size: 12px; font-weight: 600; color: var(--ink); }
.cell-undeclared { font-size: 12px; color: var(--ink-soft); }
.cell-policies { font-family: var(--mono); font-size: 12.5px; margin-top: 4px; color: var(--ink); }
.cell-effects { display: flex; gap: 8px; margin-top: 4px; }
.cell-none { font-size: 12px; color: var(--ink-soft); margin-top: 4px; }
.legend { display: flex; flex-wrap: wrap; gap: 8px 24px; margin-bottom: 16px; font-size: 13px; color: var(--ink-soft); }
.legend span.item { display: inline-flex; align-items: center; gap: 6px; }

/* --- the stacked bar --- */
.stacked-bar { display: block; width: 100%; height: 36px; border-radius: 6px; overflow: hidden; }

/* --- narrow screens --- */
@media (max-width: 900px) {
  .shell { flex-direction: column; min-height: auto; }
  .rail { width: auto; border-right: 0; border-bottom: 1px solid var(--border); }
  .rail-brand { border-bottom: 0; }
  .rail-groups {
    display: flex; gap: 20px; padding: 0 16px 12px;
    overflow-x: auto; -webkit-overflow-scrolling: touch;
  }
  .rail-group { margin-bottom: 0; }
  .rail-group ul { display: flex; gap: 4px; }
  .rail-item { padding: 0 10px; gap: 6px; white-space: nowrap; }
  .rail-mark { top: auto; bottom: 0; left: 8px; right: 8px; width: auto; height: 2px; }
  .rail-foot { display: none; }
  .masthead { padding: 8px 16px; }
  .main-inner { padding: 20px 16px 48px; }
  .split, .split-wide, .split-even, .with-detail { grid-template-columns: minmax(0, 1fr); gap: 24px; }
  .digest-row { grid-template-columns: 1fr; gap: 2px; }
  ol.ladder li { grid-template-columns: 24px 1fr; }
  ol.ladder .rule-id { grid-column: 2; }
  ol.ladder .rule-body { grid-column: 2; }
  ol.ladder .badge { grid-column: 2; justify-self: start; }
  h1 { font-size: 20px; }
  h1.display { font-size: 24px; }
}

/* --- print: the page becomes the audit exhibit --- */
@media print {
  :root { --bg: #fff; --surface: #fff; --surface-sunk: #f4f4f4; --border: #bbb; --border-strong: #999; --ink: #000; --ink-soft: #444; }
  .rail, .masthead, .skip-link, form, .filters, .page-header-actions, .attention a.cta { display: none !important; }
  .shell { display: block; }
  .main-inner { max-width: none; padding: 0; }
  /*
   * An opened disclosure prints in full. A closed one stays closed: without
   * client JavaScript nothing can open it at print time, and an exhibit that
   * silently grew a JSON appendix the operator did not open would be worse
   * than one that shows exactly what was on screen.
   */
  details[open] > pre.json { max-height: none; overflow: visible; }
  .table-wrap, .card, .matrix-wrap { overflow: visible; break-inside: avoid; }
  a { color: #000; text-decoration: underline; }
  .badge { border-color: #000 !important; }
}
`;
