export * from './ids.js';
export * from './canonical.js';
export * from './errors.js';
export * from './agent.js';
export * from './tool.js';
export * from './policy.js';
export * from './action.js';
export * from './approval.js';
export * from './evidence.js';
export * from './audit.js';
export * from './governance.js';
export * from './operator.js';
export * from './notify.js';
export * from './bundle.js';
export * from './classification.js';
export * from './validate.js';
export * from './redact.js';
export * from './regex.js';

/**
 * Version of the ARC Control object model these types describe.
 *
 * 2 adds the governance and assurance objects, the agent lifecycle states and
 * the agent governance record. Every 1.0 object remains readable: the new
 * fields are optional and the new collections are empty on an old data
 * directory, so a 1.x store opens without migration. See
 * `docs/releases/2.0.md` for what changes on disk.
 */
export const SCHEMA_VERSION = 2 as const;

/** Object-model versions this build can read. */
export const SUPPORTED_SCHEMA_VERSIONS = [1, 2] as const;
