export { PolicyEngine, traceDigest, type PolicyEngineOptions } from './engine.js';
export { evaluateCondition, ConditionError } from './condition.js';
export { policyApplies, matchSelectors, matchesName } from './match.js';
export { buildPolicyInput } from './input.js';
export { isReference, resolveOperand, resolvePath, MISSING, REFERENCE_PREFIX } from './reference.js';
