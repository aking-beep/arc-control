import { digest } from '@arc-control/schemas';
import { checkServer, checkToolDescription, checkToolSchema } from './checks.js';
import { checkConformance } from './conformance.js';
import {
  SEVERITY_ORDER,
  type Finding,
  type FindingSeverity,
  type McpServerManifest,
  type ScanReport,
} from './manifest.js';

export interface ScanOptions {
  /** Check ids to record as `info` instead of their declared severity. */
  readonly suppress?: readonly string[];
  readonly now?: () => Date;
}

/** Runs every static check over an MCP server manifest. */
export function scanManifest(manifest: McpServerManifest, options: ScanOptions = {}): ScanReport {
  const suppressed = new Set(options.suppress ?? []);
  const now = options.now ?? (() => new Date());

  const raw: Finding[] = [
    ...checkServer(manifest),
    ...checkConformance(manifest),
    ...manifest.tools.flatMap((tool) => [...checkToolDescription(tool), ...checkToolSchema(tool)]),
  ];

  const findings = raw
    .map((finding) => (suppressed.has(finding.id) ? { ...finding, severity: 'info' as FindingSeverity } : finding))
    .sort((left, right) => SEVERITY_ORDER[right.severity] - SEVERITY_ORDER[left.severity]);

  const highestSeverity = findings.reduce<FindingSeverity>(
    (highest, finding) => (SEVERITY_ORDER[finding.severity] > SEVERITY_ORDER[highest] ? finding.severity : highest),
    'info',
  );

  return {
    server: manifest.name,
    endpoint: manifest.endpoint,
    scannedAt: now().toISOString(),
    toolsScanned: manifest.tools.length,
    findings,
    highestSeverity,
    passed: SEVERITY_ORDER[highestSeverity] < SEVERITY_ORDER.high,
  };
}

/**
 * A digest of a server's advertised tool surface: names, descriptions and
 * schemas, canonically ordered.
 *
 * This is the defence against a server that passes review and then changes.
 * An MCP server can revise a tool description at any time, and nothing in the
 * protocol tells the client it happened — so a reviewed, approved tool can
 * silently become a poisoned one. Pinning this digest at registration turns
 * that silent change into a detectable event.
 */
export function manifestDigest(manifest: McpServerManifest): string {
  return digest(
    manifest.tools
      .map((tool) => ({
        name: tool.name,
        description: tool.description ?? '',
        inputSchema: tool.inputSchema ?? {},
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  );
}

export interface DriftReport {
  readonly changed: boolean;
  readonly expectedDigest: string;
  readonly observedDigest: string;
  readonly added: readonly string[];
  readonly removed: readonly string[];
  /** Tools whose description or schema changed while keeping the same name. */
  readonly modified: readonly string[];
  readonly findings: readonly Finding[];
}

/** Compares a pinned manifest against what a server now advertises. */
export function detectDrift(pinned: McpServerManifest, observed: McpServerManifest): DriftReport {
  const expectedDigest = manifestDigest(pinned);
  const observedDigest = manifestDigest(observed);

  const pinnedByName = new Map(pinned.tools.map((tool) => [tool.name, tool]));
  const observedByName = new Map(observed.tools.map((tool) => [tool.name, tool]));

  const added = [...observedByName.keys()].filter((name) => !pinnedByName.has(name)).sort();
  const removed = [...pinnedByName.keys()].filter((name) => !observedByName.has(name)).sort();

  const modified = [...observedByName.keys()]
    .filter((name) => {
      const before = pinnedByName.get(name);
      const after = observedByName.get(name);
      if (!before || !after) return false;
      return (
        (before.description ?? '') !== (after.description ?? '') ||
        digest(before.inputSchema ?? {}) !== digest(after.inputSchema ?? {})
      );
    })
    .sort();

  const findings: Finding[] = [];

  if (modified.length > 0) {
    findings.push({
      id: 'MCP-SEC-030',
      severity: 'critical',
      title: 'A reviewed tool changed after registration',
      detail: `${modified.join(', ')} changed description or schema since this server was pinned. The protocol gives a client no notification of such a change, so a tool that passed review can become a poisoned one silently.`,
      remediation:
        'Suspend the affected tools, re-scan the server and re-pin the manifest only after a human has read the new descriptions.',
      evidence: { modified, expectedDigest, observedDigest },
    });
  }

  if (added.length > 0) {
    findings.push({
      id: 'MCP-SEC-031',
      severity: 'high',
      title: 'Server advertises tools that were never reviewed',
      detail: `${added.join(', ')} appeared after this server was pinned.`,
      remediation: 'Scan and register each new tool explicitly. ARC Control refuses unregistered tools, so they are not yet reachable.',
      evidence: { added },
    });
  }

  if (removed.length > 0) {
    findings.push({
      id: 'MCP-SEC-032',
      severity: 'medium',
      title: 'Previously available tools have disappeared',
      detail: `${removed.join(', ')} are no longer advertised. Agents relying on them will fail.`,
      remediation: 'Confirm the removal was intentional and retire the corresponding ARC Control tool definitions.',
      evidence: { removed },
    });
  }

  return {
    changed: expectedDigest !== observedDigest,
    expectedDigest,
    observedDigest,
    added,
    removed,
    modified,
    findings,
  };
}

/** Renders a report as plain text for the CLI and CI logs. */
export function formatReport(report: ScanReport): string {
  const lines: string[] = [
    `MCP security scan: ${report.server}`,
    `  endpoint      ${report.endpoint}`,
    `  tools         ${report.toolsScanned}`,
    `  findings      ${report.findings.length}`,
    `  result        ${report.passed ? 'PASS' : 'FAIL'} (highest severity: ${report.highestSeverity})`,
  ];

  if (report.findings.length === 0) {
    lines.push('', '  No findings.');
    return lines.join('\n');
  }

  lines.push('');
  for (const finding of report.findings) {
    lines.push(
      `  [${finding.severity.toUpperCase()}] ${finding.id} ${finding.title}${finding.tool ? ` (${finding.tool})` : ''}`,
      `      ${finding.detail}`,
      `      → ${finding.remediation}`,
      '',
    );
  }

  return lines.join('\n');
}
