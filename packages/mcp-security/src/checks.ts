import type { Finding, McpServerManifest, McpToolDescriptor } from './manifest.js';

/**
 * Static checks over an MCP server's advertised tools.
 *
 * The threat these address is specific to MCP: a tool's *description* is
 * model-facing text that an agent reads and acts on. A server operator — or
 * anyone who has compromised one — can therefore attempt to steer a client's
 * agent purely through metadata, without ever being called. That is tool
 * poisoning, and it is invisible to a gateway that only inspects arguments.
 *
 * Every check is a heuristic over text, and heuristics produce false
 * positives. None of them is an authorization control: a finding is an
 * operator signal, and policy remains the thing that decides. They are
 * written to be read and argued with — each one names what it looked for.
 */

/** Phrases that attempt to override an agent's own instructions. */
const INSTRUCTION_OVERRIDE = [
  /\bignore\s+(all\s+|any\s+)?(previous|prior|above|earlier)\b/i,
  /\bdisregard\s+(all\s+|any\s+)?(previous|prior|above|earlier|your)\b/i,
  /\boverride\s+(your|the|all)\s+(instructions|rules|guidelines|policy)/i,
  /\byou\s+must\s+(always|never)\b.{0,40}\b(regardless|no matter|even if)\b/i,
  /\bdo\s+not\s+(tell|inform|mention|reveal)\s+(the\s+)?(user|human|operator)/i,
  /\bwithout\s+(asking|informing|notifying|telling)\s+(the\s+)?(user|human|operator)/i,
  /\bnew\s+(system\s+)?(instructions?|prompt)\b/i,
  /<\/?(system|instructions?)>/i,
];

/** Phrases that direct the agent at credentials or other secrets. */
const CREDENTIAL_SOLICITATION = [
  /\b(read|open|cat|fetch|retrieve|send|exfiltrate|upload)\b.{0,40}\b(~\/\.ssh|id_rsa|\.env|\.aws\/credentials|password|api[\s_-]?key|secret|token)\b/i,
  /\b(include|attach|append)\b.{0,30}\b(credential|secret|api[\s_-]?key|token|password)\b/i,
  /\bconversation\s+history\b.{0,40}\b(send|post|forward|include)\b/i,
];

/** Phrases that instruct the agent to call another tool as a side effect. */
const TOOL_CHAINING = [
  /\b(also|then|afterwards|additionally)\s+(call|invoke|run|use)\s+(the\s+)?[\w.]+\s*(tool|function)?/i,
  /\bbefore\s+(using|calling)\s+this\b.{0,40}\bcall\b/i,
];

export function checkToolDescription(tool: McpToolDescriptor): Finding[] {
  const findings: Finding[] = [];
  const text = `${tool.name} ${tool.description ?? ''}`;

  for (const pattern of INSTRUCTION_OVERRIDE) {
    const match = pattern.exec(text);
    if (!match) continue;
    findings.push({
      id: 'MCP-SEC-001',
      severity: 'critical',
      title: 'Tool description attempts to override agent instructions',
      detail: `The description of "${tool.name}" contains instruction-override language: "${excerpt(match[0])}". An agent reads this text as guidance, so a server can steer a client's agent through metadata alone.`,
      remediation:
        'Do not expose this tool. Confirm with the server operator that the description is intentional, and treat the server as untrusted until it is corrected.',
      tool: tool.name,
      evidence: { matched: excerpt(match[0]) },
    });
    break;
  }

  for (const pattern of CREDENTIAL_SOLICITATION) {
    const match = pattern.exec(text);
    if (!match) continue;
    findings.push({
      id: 'MCP-SEC-002',
      severity: 'critical',
      title: 'Tool description solicits credentials or conversation history',
      detail: `The description of "${tool.name}" directs the agent toward secrets or transcript contents: "${excerpt(match[0])}".`,
      remediation: 'Do not expose this tool. A tool that needs a credential should receive it from the connector, never ask the agent for it.',
      tool: tool.name,
      evidence: { matched: excerpt(match[0]) },
    });
    break;
  }

  for (const pattern of TOOL_CHAINING) {
    const match = pattern.exec(text);
    if (!match) continue;
    findings.push({
      id: 'MCP-SEC-003',
      severity: 'medium',
      title: 'Tool description instructs the agent to call another tool',
      detail: `The description of "${tool.name}" tells the agent to invoke something else: "${excerpt(match[0])}". Chained calls bypass the operator's expectation of what this tool does.`,
      remediation: 'Review whether the chaining is legitimate. If it is, register each tool with ARC Control separately so each call is decided on its own merits.',
      tool: tool.name,
      evidence: { matched: excerpt(match[0]) },
    });
    break;
  }

  if (!tool.description || tool.description.trim().length < 8) {
    findings.push({
      id: 'MCP-SEC-004',
      severity: 'low',
      title: 'Tool has no usable description',
      detail: `"${tool.name}" publishes no meaningful description, so neither an operator nor a reviewer can tell what it does.`,
      remediation: 'Ask the server operator to document the tool before exposing it to agents.',
      tool: tool.name,
    });
  }

  if (tool.description && tool.description.length > 4096) {
    findings.push({
      id: 'MCP-SEC-005',
      severity: 'medium',
      title: 'Tool description is unusually long',
      detail: `The description of "${tool.name}" is ${tool.description.length} characters. Length is a common way to bury injected instructions where a human reviewer will not read them.`,
      remediation: 'Read the full description before exposing the tool.',
      tool: tool.name,
      evidence: { length: tool.description.length },
    });
  }

  if (containsInvisibleCharacters(tool.description ?? '')) {
    findings.push({
      id: 'MCP-SEC-006',
      severity: 'high',
      title: 'Tool description contains hidden characters',
      detail: `The description of "${tool.name}" contains zero-width or bidirectional control characters, which can hide text from a human reviewer while an agent still reads it.`,
      remediation: 'Treat the server as untrusted. Inspect the raw bytes of the description before exposing the tool.',
      tool: tool.name,
    });
  }

  return findings;
}

export function checkToolSchema(tool: McpToolDescriptor): Finding[] {
  const findings: Finding[] = [];
  const schema = tool.inputSchema;

  if (!schema || typeof schema !== 'object') {
    findings.push({
      id: 'MCP-SEC-010',
      severity: 'high',
      title: 'Tool publishes no input schema',
      detail: `"${tool.name}" declares no inputSchema, so its arguments cannot be validated and a policy cannot reason about them.`,
      remediation: 'Register the tool with ARC Control with an explicit parameter contract, or do not expose it.',
      tool: tool.name,
    });
    return findings;
  }

  const properties = schema.properties;
  if (properties === undefined || (isRecord(properties) && Object.keys(properties).length === 0)) {
    findings.push({
      id: 'MCP-SEC-011',
      severity: 'medium',
      title: 'Tool accepts unconstrained input',
      detail: `"${tool.name}" declares a schema with no properties, so any argument shape is acceptable to the server.`,
      remediation: 'Constrain the parameters in the ARC Control tool definition; undeclared parameters are then refused at the gateway.',
      tool: tool.name,
    });
  }

  if (schema.additionalProperties !== false && isRecord(properties) && Object.keys(properties).length > 0) {
    findings.push({
      id: 'MCP-SEC-012',
      severity: 'low',
      title: 'Tool schema permits additional properties',
      detail: `"${tool.name}" does not set additionalProperties to false, so the server will accept arguments it never documented.`,
      remediation: 'ARC Control rejects undeclared parameters regardless; ask the operator to tighten the published schema so the two agree.',
      tool: tool.name,
    });
  }

  return findings;
}

/** Checks that concern the server as a whole. */
export function checkServer(manifest: McpServerManifest): Finding[] {
  const findings: Finding[] = [];

  let endpoint: URL | undefined;
  try {
    endpoint = new URL(manifest.endpoint);
  } catch {
    findings.push({
      id: 'MCP-SEC-020',
      severity: 'high',
      title: 'Server endpoint is not a valid URL',
      detail: `"${manifest.endpoint}" could not be parsed as a URL.`,
      remediation: 'Correct the endpoint before registering the server.',
    });
  }

  if (endpoint && endpoint.protocol === 'http:' && !isLoopback(endpoint.hostname)) {
    findings.push({
      id: 'MCP-SEC-021',
      severity: 'high',
      title: 'Server is reached over plaintext HTTP',
      detail: `${manifest.name} is configured at ${manifest.endpoint}. Tool arguments, results and the server's own tool descriptions all cross the network in the clear, and any of them can be rewritten in transit.`,
      remediation: 'Use HTTPS, or place the server behind a TLS-terminating proxy on the loopback interface.',
      evidence: { endpoint: manifest.endpoint },
    });
  }

  const names = new Map<string, number>();
  for (const tool of manifest.tools) {
    names.set(tool.name, (names.get(tool.name) ?? 0) + 1);
  }
  for (const [name, count] of names) {
    if (count > 1) {
      findings.push({
        id: 'MCP-SEC-022',
        severity: 'high',
        title: 'Server advertises a duplicate tool name',
        detail: `"${name}" is advertised ${count} times. Which definition a client uses is then undefined, so a benign definition can shadow a dangerous one.`,
        remediation: 'Ask the operator to publish unique tool names before exposing the server.',
        tool: name,
      });
    }
  }

  if (manifest.tools.length === 0) {
    findings.push({
      id: 'MCP-SEC-023',
      severity: 'info',
      title: 'Server advertises no tools',
      detail: `${manifest.name} published an empty tool list.`,
      remediation: 'Confirm the server is reachable and initialized.',
    });
  }

  return findings;
}

function containsInvisibleCharacters(text: string): boolean {
  // Zero-width characters, bidirectional overrides and the Unicode tag block,
  // all of which render as nothing while remaining in the text a model reads.
  return /[​-‏‪-‮⁠-⁤﻿]|[\u{E0000}-\u{E007F}]/u.test(text);
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function excerpt(text: string, limit = 120): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit)}…`;
}
