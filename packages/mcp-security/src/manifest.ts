/**
 * The shape of an MCP server's advertised capabilities, as ARC Control reads
 * them. This is deliberately a defensive subset of the MCP specification: the
 * fields ARC Control needs in order to decide whether a tool is safe to
 * expose, nothing more.
 */
export interface McpToolDescriptor {
  readonly name: string;
  readonly description?: string;
  /** JSON Schema for the tool's arguments, as published by the server. */
  readonly inputSchema?: Readonly<Record<string, unknown>>;
  readonly annotations?: Readonly<Record<string, unknown>>;
}

export interface McpServerManifest {
  /** Operator-assigned name for the server, used in tool names and policy. */
  readonly name: string;
  readonly endpoint: string;
  readonly protocolVersion?: string;
  readonly tools: readonly McpToolDescriptor[];
  readonly capturedAt?: string;
}

export type FindingSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';

export interface Finding {
  /** Stable check identifier, e.g. `MCP-SEC-003`. Cited in reports and suppressions. */
  readonly id: string;
  readonly severity: FindingSeverity;
  readonly title: string;
  /** What was observed. */
  readonly detail: string;
  /** What an operator should do about it. */
  readonly remediation: string;
  /** The tool the finding concerns, when it is tool-specific. */
  readonly tool?: string;
  readonly evidence?: Readonly<Record<string, unknown>>;
}

export interface ScanReport {
  readonly server: string;
  readonly endpoint: string;
  readonly scannedAt: string;
  readonly toolsScanned: number;
  readonly findings: readonly Finding[];
  /** The highest severity observed, or `info` when nothing was found. */
  readonly highestSeverity: FindingSeverity;
  /** False when any finding is high or critical. */
  readonly passed: boolean;
}

export const SEVERITY_ORDER: Record<FindingSeverity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};
