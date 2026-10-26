/**
 * A tool is a named capability an agent may ask to use. ARC Control treats the
 * tool definition as the contract: parameters outside the declared schema are
 * rejected before policy evaluation, so a policy never has to reason about
 * parameters that cannot exist.
 */
export type ParameterType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array';

export interface ParameterSpec {
  readonly name: string;
  readonly type: ParameterType;
  readonly required?: boolean;
  readonly description?: string;
  readonly enum?: readonly (string | number | boolean)[];
  readonly minimum?: number;
  readonly maximum?: number;
  readonly pattern?: string;
  readonly maxLength?: number;
  /** Marks a parameter whose value must never reach evidence or audit in the clear. */
  readonly sensitive?: boolean;
}

/**
 * How reversible an action is. This is the single most useful signal for
 * writing policy, so it lives on the tool rather than being inferred.
 */
export type ToolEffect = 'read' | 'write' | 'irreversible';

export type ToolRiskTier = 'low' | 'medium' | 'high' | 'critical';

export interface Tool {
  readonly id: string;
  /** Qualified name used by agents and policies, e.g. `stripe.refund`. */
  readonly name: string;
  readonly description: string;
  /** Logical system the tool acts upon, e.g. `stripe`, `github`, `aws`. */
  readonly system: string;
  readonly effect: ToolEffect;
  readonly riskTier: ToolRiskTier;
  /** Connector that executes this tool. */
  readonly connector: string;
  /** Connector-specific routing and credentials reference. Never contains secrets. */
  readonly connectorConfig: Readonly<Record<string, unknown>>;
  readonly parameters: readonly ParameterSpec[];
  readonly labels: Readonly<Record<string, string>>;
  /**
   * The per-tool kill switch.
   *
   * A disabled tool is refused at resolution, before policy evaluation — the
   * same stage an unregistered tool is refused at. That placement is
   * deliberate: it means disabling a tool cannot be undone by a policy, by a
   * rule ordering accident, or by an ALLOW fallback. Absent rather than
   * `false` on a tool that has never been disabled, so the flag's presence is
   * itself a record that somebody touched it.
   */
  readonly disabled?: boolean;
  readonly disabledAt?: string;
  readonly disabledBy?: string;
  readonly disabledReason?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ToolRegistration {
  readonly name: string;
  readonly description: string;
  readonly system?: string;
  readonly effect: ToolEffect;
  readonly riskTier?: ToolRiskTier;
  readonly connector: string;
  readonly connectorConfig?: Readonly<Record<string, unknown>>;
  readonly parameters?: readonly ParameterSpec[];
  readonly labels?: Readonly<Record<string, string>>;
}
