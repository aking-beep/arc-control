import { readFile } from 'node:fs/promises';
import { detectDrift, manifestDigest, scanManifest, type McpServerManifest } from '@arc-control/mcp-security';
import { McpClient } from '@arc-control/connector-mcp';
import { flagBool, flagString, flagStrings, type ParsedArgs } from '../args.js';
import { detail, out, paintSeverity, style } from '../output.js';

/**
 * `arc mcp scan` and `arc mcp diff`.
 *
 * Intended to run in CI against every MCP server an organization exposes to
 * agents. Scan exits non-zero on a high or critical finding so a poisoned
 * tool description fails a pipeline rather than reaching production; diff
 * catches a server that passed review and then changed.
 */

export async function scanMcp(args: ParsedArgs): Promise<number> {
  const endpoint = flagString(args, 'endpoint');
  const file = flagString(args, 'file') ?? args.positional[0];

  const manifest = endpoint ? await fetchManifest(endpoint, args) : await readManifest(file);
  if (!manifest) {
    out('usage: arc mcp scan --endpoint <url> | arc mcp scan <manifest.json>');
    out();
    out('  --header <name:value>  sent with each request; repeatable via --header a:b --header c:d');
    out('  --suppress <ids>       comma-separated check ids to record as informational');
    out('  --json                 emit the raw report');
    return 2;
  }

  const suppress = (flagString(args, 'suppress') ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);

  const report = scanManifest(manifest, suppress.length > 0 ? { suppress } : {});

  if (flagBool(args, 'json')) {
    out(JSON.stringify(report, null, 2));
    return report.passed ? 0 : 1;
  }

  out(style.bold(`MCP security scan — ${report.server}`));
  detail([
    ['endpoint', report.endpoint],
    ['tools', String(report.toolsScanned)],
    ['digest', manifestDigest(manifest)],
    ['result', report.passed ? style.green('PASS') : style.red('FAIL')],
    ['highest', paintSeverity(report.highestSeverity)],
  ]);
  out();

  if (report.findings.length === 0) {
    out(style.green('No findings.'));
    return 0;
  }

  for (const finding of report.findings) {
    out(
      `${paintSeverity(finding.severity)} ${style.bold(finding.id)} ${finding.title}${finding.tool ? style.dim(` (${finding.tool})`) : ''}`,
    );
    out(`  ${finding.detail}`);
    out(`  ${style.cyan('→')} ${finding.remediation}`);
    out();
  }

  out(
    report.passed
      ? style.yellow('Findings recorded, but none block exposure.')
      : style.red('Do not expose this server until the high and critical findings are resolved.'),
  );
  return report.passed ? 0 : 1;
}

export async function diffMcp(args: ParsedArgs): Promise<number> {
  const pinnedPath = flagString(args, 'pinned') ?? args.positional[0];
  const endpoint = flagString(args, 'endpoint');
  const observedPath = flagString(args, 'observed') ?? args.positional[1];

  if (!pinnedPath || (!endpoint && !observedPath)) {
    out('usage: arc mcp diff --pinned <pinned.json> (--endpoint <url> | --observed <now.json>)');
    return 2;
  }

  const pinned = await readManifest(pinnedPath);
  const observed = endpoint ? await fetchManifest(endpoint, args) : await readManifest(observedPath);

  if (!pinned || !observed) {
    out(style.red('could not read both manifests'));
    return 2;
  }

  const drift = detectDrift(pinned, observed);

  if (flagBool(args, 'json')) {
    out(JSON.stringify(drift, null, 2));
    return drift.changed ? 1 : 0;
  }

  out(style.bold(`MCP drift — ${pinned.name}`));
  detail([
    ['pinned', drift.expectedDigest],
    ['observed', drift.observedDigest],
    ['status', drift.changed ? style.red('CHANGED') : style.green('unchanged')],
    ['added', drift.added.length > 0 ? drift.added.join(', ') : undefined],
    ['removed', drift.removed.length > 0 ? drift.removed.join(', ') : undefined],
    ['modified', drift.modified.length > 0 ? style.red(drift.modified.join(', ')) : undefined],
  ]);
  out();

  for (const finding of drift.findings) {
    out(`${paintSeverity(finding.severity)} ${style.bold(finding.id)} ${finding.title}`);
    out(`  ${finding.detail}`);
    out(`  ${style.cyan('→')} ${finding.remediation}`);
    out();
  }

  if (!drift.changed) {
    out(style.green('The advertised tool surface matches the pin.'));
    return 0;
  }
  return 1;
}

async function readManifest(path: string | undefined): Promise<McpServerManifest | undefined> {
  if (!path) return undefined;
  const parsed = JSON.parse(await readFile(path, 'utf8')) as McpServerManifest;
  return {
    name: parsed.name ?? 'unnamed',
    endpoint: parsed.endpoint ?? 'unknown',
    tools: Array.isArray(parsed.tools) ? parsed.tools : [],
  };
}

async function fetchManifest(endpoint: string, args: ParsedArgs): Promise<McpServerManifest> {
  const headers: Record<string, string> = {};
  for (const entry of flagStrings(args, 'header')) {
    const separator = entry.indexOf(':');
    if (separator === -1) continue;
    headers[entry.slice(0, separator).trim()] = entry.slice(separator + 1).trim();
  }

  const client = new McpClient({ endpoint, ...(Object.keys(headers).length > 0 ? { headers } : {}) });
  await client.initialize();
  return client.listTools();
}
