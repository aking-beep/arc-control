import type { Finding, McpServerManifest } from './manifest.js';

/**
 * Conformance checks, ported from the MCP Conformance Scanner (ADR-0002).
 *
 * The scanner probes a live server; these read only the manifest ARC already
 * holds, so they run at registration with no network access. They are about
 * whether a server is well-formed enough to govern — a tool ARC cannot name
 * or parameterize reliably is one policy cannot reliably bound — and they sit
 * below the security checks in severity.
 */

/** Protocol revisions the scanner recognises, newest first. */
export const KNOWN_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;

const PLAIN_NAME = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const STATE_CHANGING = /delete|drop|remove|wipe|exec|shell|payment|transfer|refund|write|update|create|send/i;

export function checkConformance(manifest: McpServerManifest): Finding[] {
  const findings: Finding[] = [];

  if (manifest.protocolVersion === undefined) {
    findings.push({
      id: 'MCP-CNF-001',
      severity: 'low',
      title: 'Server reports no protocol version',
      detail: `${manifest.name} did not report the MCP protocol revision it speaks.`,
      remediation: 'Return `protocolVersion` in the initialize result, as the specification requires.',
    });
  } else if (!(KNOWN_PROTOCOL_VERSIONS as readonly string[]).includes(manifest.protocolVersion)) {
    findings.push({
      id: 'MCP-CNF-001',
      severity: 'info',
      title: 'Server reports an unrecognised protocol version',
      detail: `${manifest.name} reports "${manifest.protocolVersion}".`,
      remediation: `Confirm the revision; the newest this build recognises is ${KNOWN_PROTOCOL_VERSIONS[0]}.`,
      evidence: { reported: manifest.protocolVersion },
    });
  }

  for (const tool of manifest.tools) {
    if (!PLAIN_NAME.test(tool.name)) {
      findings.push({
        id: 'MCP-CNF-002',
        severity: 'low',
        title: 'Tool name is not portable',
        detail: `"${tool.name}" does not match ${PLAIN_NAME.source}; some models cannot call it, and it does not map cleanly to an ARC tool name.`,
        remediation: 'Ask the server operator to use letters, digits, underscores and dashes.',
        tool: tool.name,
      });
    }

    const type = tool.inputSchema?.type;
    if (tool.inputSchema !== undefined && type !== 'object') {
      findings.push({
        id: 'MCP-CNF-003',
        severity: 'medium',
        title: 'Tool input schema is not an object',
        detail: `"${tool.name}" publishes an input schema of type ${JSON.stringify(type ?? null)}. ARC validates named parameters, so it cannot bound this tool's input.`,
        remediation: 'Publish an `inputSchema` of type `object` with typed properties.',
        tool: tool.name,
      });
    }

    const annotations = tool.annotations ?? {};
    if (
      STATE_CHANGING.test(tool.name) &&
      annotations.readOnlyHint !== true &&
      annotations.destructiveHint === undefined
    ) {
      findings.push({
        id: 'MCP-CNF-004',
        severity: 'low',
        title: 'State-changing tool carries no destructive annotation',
        detail: `"${tool.name}" looks state-changing but declares neither \`readOnlyHint\` nor \`destructiveHint\`, so nothing on the server side tells a client how careful to be.`,
        remediation: 'Annotate the tool. ARC registers unannotated tools as writes regardless.',
        tool: tool.name,
      });
    }
  }

  return findings;
}
