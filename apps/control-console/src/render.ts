/**
 * HTML rendering for the console.
 *
 * The console is server-rendered with no client-side framework and no build
 * step. That is a deliberate choice for v0.1: the console displays evidence
 * about security decisions, and a page an auditor can read the source of is
 * worth more here than a richer one they cannot. The page is also the thing
 * most likely to be screenshotted into an audit report, so it is built to
 * print legibly.
 */

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
 * comments, audit summaries — originated outside it, and some of it came from
 * an agent. Escaping by default at the template level means a tool description
 * cannot become script in an operator's browser.
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

interface Trusted {
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

export interface LayoutOptions {
  readonly title: string;
  readonly active: string;
  readonly body: string;
  readonly apiBase: string;
  readonly banner?: string;
}

const NAVIGATION: readonly { href: string; label: string }[] = [
  { href: '/', label: 'Overview' },
  { href: '/agents', label: 'Agents' },
  { href: '/policies', label: 'Policies' },
  { href: '/approvals', label: 'Approvals' },
  { href: '/evidence', label: 'Evidence' },
  { href: '/audit', label: 'Audit' },
];

export function layout(options: LayoutOptions): string {
  const nav = NAVIGATION.map(
    (item) =>
      html`<a href="${item.href}" class="${item.href === options.active ? 'nav-item active' : 'nav-item'}"
        >${item.label}</a
      >`,
  );

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(options.title)} — ARC Control</title>
<style>${STYLES}</style>
</head>
<body>
<header class="masthead">
  <div class="brand">
    <span class="mark" aria-hidden="true"></span>
    <span class="wordmark">ARC <strong>Control</strong></span>
  </div>
  <nav aria-label="Sections">${nav.join('')}</nav>
  <span class="api-base" title="API this console reads from">${escapeHtml(options.apiBase)}</span>
</header>
${options.banner ? `<div class="banner" role="status">${escapeHtml(options.banner)}</div>` : ''}
<main>
${options.body}
</main>
<footer>
  <span>ARC Control v0.1 — the trust and control layer between enterprise AI agents and the systems they act upon.</span>
</footer>
</body>
</html>`;
}

/** The effect badge. Colour carries meaning, so each also carries its text. */
export function effectBadge(effect: string): Trusted {
  const className = {
    ALLOW: 'badge allow',
    REQUIRE_APPROVAL: 'badge approval',
    DENY: 'badge deny',
  }[effect] ?? 'badge';
  return raw(html`<span class="${className}">${effect}</span>`);
}

export function outcomeBadge(outcome: string): Trusted {
  const className =
    {
      executed: 'badge allow',
      allowed: 'badge allow',
      denied: 'badge deny',
      rejected: 'badge deny',
      failed: 'badge failed',
      pending_approval: 'badge approval',
      approved: 'badge allow',
      expired: 'badge muted',
    }[outcome] ?? 'badge muted';
  return raw(html`<span class="${className}">${outcome.replace(/_/g, ' ')}</span>`);
}

export function riskBadge(tier: string): Trusted {
  const className =
    { low: 'badge muted', medium: 'badge approval', high: 'badge failed', critical: 'badge deny' }[tier] ?? 'badge';
  return raw(html`<span class="${className}">${tier}</span>`);
}

/** Renders a value as a readable JSON block. */
export function jsonBlock(value: unknown): Trusted {
  return raw(html`<pre class="json">${JSON.stringify(value, null, 2)}</pre>`);
}

export function emptyState(message: string): Trusted {
  return raw(html`<p class="empty">${message}</p>`);
}

/** Formats an ISO timestamp for display, keeping it unambiguous. */
export function timestamp(iso: string | undefined): string {
  if (!iso) return '—';
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toISOString().replace('T', ' ').replace('.000Z', 'Z');
}

const STYLES = `
:root {
  --bg: #f6f7f9;
  --surface: #ffffff;
  --border: #dfe3e8;
  --ink: #16191d;
  --ink-soft: #5b626b;
  --accent: #1d4ed8;
  --allow: #0f7a4a;
  --allow-bg: #e6f4ec;
  --deny: #b4232c;
  --deny-bg: #fdeaeb;
  --approval: #8a5a00;
  --approval-bg: #fdf3e0;
  --failed: #8a4b00;
  --failed-bg: #fdeee0;
  --radius: 8px;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #101317;
    --surface: #181c22;
    --border: #2b313a;
    --ink: #e8eaed;
    --ink-soft: #9aa3ae;
    --accent: #7ba2ff;
    --allow: #5bd49a;
    --allow-bg: #10291f;
    --deny: #ff8a90;
    --deny-bg: #2c1618;
    --approval: #f0c069;
    --approval-bg: #2a2114;
    --failed: #f0a768;
    --failed-bg: #2a1d12;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font: 15px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
.masthead {
  display: flex; align-items: center; gap: 24px;
  padding: 14px 24px;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  flex-wrap: wrap;
}
.brand { display: flex; align-items: center; gap: 10px; }
.mark {
  width: 18px; height: 18px; border-radius: 5px;
  background: linear-gradient(135deg, var(--accent), var(--allow));
}
.wordmark { font-size: 16px; letter-spacing: 0.02em; }
.wordmark strong { font-weight: 700; }
nav { display: flex; gap: 4px; flex-wrap: wrap; }
.nav-item {
  color: var(--ink-soft); text-decoration: none;
  padding: 6px 11px; border-radius: 6px; font-size: 14px;
}
.nav-item:hover { background: var(--bg); color: var(--ink); }
.nav-item.active { background: var(--accent); color: #fff; }
.api-base { margin-left: auto; font-family: var(--mono); font-size: 12px; color: var(--ink-soft); }
.banner {
  padding: 10px 24px; background: var(--approval-bg); color: var(--approval);
  border-bottom: 1px solid var(--border); font-size: 14px;
}
main { padding: 24px; max-width: 1200px; margin: 0 auto; }
footer {
  padding: 20px 24px; color: var(--ink-soft); font-size: 13px;
  border-top: 1px solid var(--border); margin-top: 32px;
}
h1 { font-size: 22px; margin: 0 0 4px; }
h2 { font-size: 16px; margin: 28px 0 10px; }
.lede { color: var(--ink-soft); margin: 0 0 22px; max-width: 70ch; }
.card {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 18px; margin-bottom: 16px;
}
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 24px; }
.stat {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 14px 16px;
}
.stat .value { font-size: 26px; font-weight: 650; font-variant-numeric: tabular-nums; }
.stat .label { color: var(--ink-soft); font-size: 13px; }
table { width: 100%; border-collapse: collapse; background: var(--surface); }
.table-wrap { border: 1px solid var(--border); border-radius: var(--radius); overflow-x: auto; }
th, td { text-align: left; padding: 10px 14px; border-bottom: 1px solid var(--border); vertical-align: top; }
th { font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--ink-soft); font-weight: 600; }
tbody tr:last-child td { border-bottom: none; }
td.mono, .mono { font-family: var(--mono); font-size: 12.5px; }
.badge {
  display: inline-block; padding: 2px 8px; border-radius: 999px;
  font-size: 11.5px; font-weight: 650; letter-spacing: 0.03em;
  background: var(--bg); color: var(--ink-soft); white-space: nowrap;
}
.badge.allow { background: var(--allow-bg); color: var(--allow); }
.badge.deny { background: var(--deny-bg); color: var(--deny); }
.badge.approval { background: var(--approval-bg); color: var(--approval); }
.badge.failed { background: var(--failed-bg); color: var(--failed); }
.badge.muted { background: var(--bg); color: var(--ink-soft); }
pre.json {
  font-family: var(--mono); font-size: 12.5px; background: var(--bg);
  border: 1px solid var(--border); border-radius: 6px;
  padding: 12px; overflow-x: auto; margin: 8px 0 0;
}
.empty { color: var(--ink-soft); padding: 24px; text-align: center; }
a { color: var(--accent); }
.reason { color: var(--ink-soft); font-size: 13.5px; }
form.inline { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 0; }
button {
  font: inherit; font-size: 13.5px; padding: 6px 12px; border-radius: 6px;
  border: 1px solid var(--border); background: var(--surface); color: var(--ink); cursor: pointer;
}
button:hover { border-color: var(--accent); }
button.primary { background: var(--allow); border-color: var(--allow); color: #fff; }
button.danger { background: var(--deny); border-color: var(--deny); color: #fff; }
input[type=text] {
  font: inherit; font-size: 13.5px; padding: 6px 10px;
  border: 1px solid var(--border); border-radius: 6px;
  background: var(--surface); color: var(--ink); min-width: 220px;
}
.chain-ok { color: var(--allow); font-weight: 600; }
.chain-bad { color: var(--deny); font-weight: 600; }
@media print {
  .masthead nav, form.inline, footer { display: none; }
  body { background: #fff; }
  .card, .table-wrap, .stat { border-color: #ccc; }
}
`;
