import type { Agent, Effect, Policy, PolicyMatch, Tool } from '../data/types';

/**
 * Line-for-line port of packages/policy-engine/src/match.ts `matchSelectors`
 * for the prototype. The shipped console imports the real function read-only
 * (plan §14). It answers "which policies govern this pair?" and never decides
 * anything.
 */
export function matchSelectors(match: PolicyMatch, agent: Agent, tool: Tool): boolean {
  if (match.agents && !matchesAgent(match.agents, agent)) return false;
  if (match.tools && !match.tools.some((pattern) => matchesName(pattern, tool.name))) return false;
  if (match.systems && !match.systems.includes(tool.system)) return false;
  if (match.environments && !match.environments.includes(agent.environment)) return false;
  if (match.effects && !match.effects.includes(tool.effect)) return false;
  return true;
}

function matchesAgent(selectors: string[], agent: Agent): boolean {
  return selectors.some((selector) => {
    if (selector === '*') return true;
    if (selector.startsWith('role:')) return agent.roles.includes(selector.slice(5));
    if (selector.startsWith('label:')) {
      const rest = selector.slice(6);
      const index = rest.indexOf('=');
      if (index === -1) return agent.labels[rest] !== undefined;
      return agent.labels[rest.slice(0, index)] === rest.slice(index + 1);
    }
    return matchesName(selector, agent.name);
  });
}

export function matchesName(pattern: string, value: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('*')) return value.startsWith(pattern.slice(0, -1));
  return pattern === value;
}

/** Effects a policy's rules and fallback can produce, in ladder order A · R · D. */
export function possibleEffects(policy: Policy): Effect[] {
  const set = new Set<Effect>([...policy.rules.map((rule) => rule.effect), policy.fallback.effect]);
  return (['ALLOW', 'REQUIRE_APPROVAL', 'DENY'] as Effect[]).filter((effect) => set.has(effect));
}

export interface CellScope {
  declared: boolean;
  enabled: Policy[];
  disabled: Policy[];
  effects: Effect[];
}

export function cellScope(agent: Agent, tool: Tool, policies: Policy[]): CellScope {
  const inScope = policies.filter((policy) => matchSelectors(policy.match, agent, tool));
  const enabled = inScope.filter((policy) => policy.enabled);
  const effects = new Set<Effect>(enabled.flatMap(possibleEffects));
  return {
    declared: agent.declaredTools.includes(tool.name),
    enabled,
    disabled: inScope.filter((policy) => !policy.enabled),
    effects: (['ALLOW', 'REQUIRE_APPROVAL', 'DENY'] as Effect[]).filter((effect) => effects.has(effect)),
  };
}
