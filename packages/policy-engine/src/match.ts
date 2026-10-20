import type { Policy, PolicyInput, PolicyMatch } from '@arc-control/schemas';

/**
 * Decides whether a policy applies to an action at all. Matching is separate
 * from rule evaluation so the console can answer "which policies govern this
 * tool?" without evaluating anything.
 *
 * An omitted selector matches everything. Every selector that *is* present
 * must match, so narrowing a policy can never widen what it governs.
 */
export function policyApplies(policy: Policy, input: PolicyInput): boolean {
  return matchSelectors(policy.match, input);
}

export function matchSelectors(match: PolicyMatch, input: PolicyInput): boolean {
  if (match.agents && !matchesAgent(match.agents, input)) return false;
  if (match.tools && !match.tools.some((pattern) => matchesName(pattern, input.tool.name))) return false;
  if (match.systems && !match.systems.includes(input.tool.system)) return false;
  if (match.environments && !match.environments.includes(input.context.environment)) return false;
  if (match.effects && !(match.effects as readonly string[]).includes(input.tool.effect)) return false;
  return true;
}

function matchesAgent(selectors: readonly string[], input: PolicyInput): boolean {
  return selectors.some((selector) => {
    if (selector === '*') return true;
    if (selector.startsWith('role:')) return input.agent.roles.includes(selector.slice('role:'.length));
    if (selector.startsWith('label:')) {
      const [key, value] = splitOnce(selector.slice('label:'.length), '=');
      if (value === undefined) return input.agent.labels[key] !== undefined;
      return input.agent.labels[key] === value;
    }
    return matchesName(selector, input.agent.name);
  });
}

/** Exact match, or a trailing-`*` prefix match such as `stripe.*`. */
export function matchesName(pattern: string, value: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('*')) return value.startsWith(pattern.slice(0, -1));
  return pattern === value;
}

function splitOnce(text: string, separator: string): [string, string | undefined] {
  const index = text.indexOf(separator);
  if (index === -1) return [text, undefined];
  return [text.slice(0, index), text.slice(index + separator.length)];
}
