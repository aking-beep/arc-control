import type { Action, AgentPrincipal, PolicyInput, Tool } from '@arc-control/schemas';

/**
 * Builds the evaluation input from the objects the gateway already has. The
 * input is a flat, plain-data snapshot on purpose: policy evaluation cannot
 * reach back into the store, call a connector or observe anything that was not
 * captured here, which is what makes a decision reproducible from evidence.
 */
export function buildPolicyInput(args: {
  readonly principal: AgentPrincipal;
  readonly tool: Tool;
  readonly action: Action;
  readonly requestedAt?: Date;
  readonly source?: string;
}): PolicyInput {
  const at = args.requestedAt ?? new Date(args.action.requestedAt);

  return {
    agent: {
      id: args.principal.agentId,
      name: args.principal.agentName,
      kind: args.principal.kind,
      environment: args.principal.environment,
      owner: args.principal.owner,
      roles: args.principal.roles,
      labels: args.principal.labels,
    },
    tool: {
      name: args.tool.name,
      system: args.tool.system,
      effect: args.tool.effect,
      riskTier: args.tool.riskTier,
      labels: args.tool.labels,
    },
    action: {
      id: args.action.id,
      parameters: args.action.parameters,
    },
    context: {
      environment: args.principal.environment,
      requestedAt: at.toISOString(),
      hourUtc: at.getUTCHours(),
      dayOfWeekUtc: at.getUTCDay(),
      ...(args.source ? { source: args.source } : {}),
      ...(args.action.correlationId ? { correlationId: args.action.correlationId } : {}),
    },
  };
}
