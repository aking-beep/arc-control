import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import {
  classifyAction,
  digest,
  rateRisk,
  type Agent,
  type ControlAssessment,
  type ControlDefinition,
  type EvidenceRecord,
  type Finding,
  type Risk,
  type Tool,
} from './index.js';

/**
 * The published JSON Schemas are the contract other languages build against,
 * and they drifted from the TypeScript model during the 2.0 work: three of
 * them declare `additionalProperties: false` and would have rejected a valid
 * 2.0 agent, evidence record and tool. CI parsed them happily, because
 * parsing a schema says nothing about whether it describes the objects ARC
 * actually produces.
 *
 * So these tests validate real, fully-populated objects against the published
 * schemas. The validator below is deliberately small and covers only the
 * keywords these schemas use — the repository has no runtime dependencies and
 * a JSON Schema library would be the first. It is strict about the one thing
 * that matters here: an unexpected property under `additionalProperties:
 * false` is an error, which is exactly the drift that went unnoticed.
 */

const SCHEMAS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'schemas');

type Schema = Record<string, unknown>;

function resolve(ref: string, root: Schema): Schema {
  // Only local `#/$defs/name` references are used by these schemas.
  const path = ref.replace(/^#\//, '').split('/');
  let node: unknown = root;
  for (const segment of path) {
    node = (node as Record<string, unknown>)[segment];
    if (node === undefined) throw new Error(`unresolvable $ref: ${ref}`);
  }
  return node as Schema;
}

/** Returns the problems found, deepest path first. Empty means valid. */
function validate(value: unknown, schema: Schema, root: Schema, path = '$'): string[] {
  if (typeof schema.$ref === 'string') {
    return validate(value, resolve(schema.$ref, root), root, path);
  }

  const problems: string[] = [];

  if (Array.isArray(schema.allOf)) {
    for (const member of schema.allOf as Schema[]) problems.push(...validate(value, member, root, path));
  }

  if (schema.const !== undefined && value !== schema.const) {
    problems.push(`${path}: expected ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
  }

  if (Array.isArray(schema.enum) && !(schema.enum as unknown[]).includes(value)) {
    problems.push(`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  }

  const type = schema.type as string | undefined;
  if (type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      problems.push(`${path}: expected an object`);
      return problems;
    }

    const record = value as Record<string, unknown>;
    const properties = (schema.properties ?? {}) as Record<string, Schema>;

    for (const required of (schema.required ?? []) as string[]) {
      if (record[required] === undefined) problems.push(`${path}.${required}: required but absent`);
    }

    for (const [key, member] of Object.entries(record)) {
      if (member === undefined) continue;
      const property = properties[key];

      if (!property) {
        if (schema.additionalProperties === false) {
          problems.push(`${path}.${key}: not described by the schema, which forbids additional properties`);
        } else if (typeof schema.additionalProperties === 'object') {
          problems.push(...validate(member, schema.additionalProperties as Schema, root, `${path}.${key}`));
        }
        continue;
      }

      problems.push(...validate(member, property, root, `${path}.${key}`));
    }
  } else if (type === 'array') {
    if (!Array.isArray(value)) {
      problems.push(`${path}: expected an array`);
      return problems;
    }
    if (schema.items) {
      value.forEach((item, index) => {
        problems.push(...validate(item, schema.items as Schema, root, `${path}[${index}]`));
      });
    }
  } else if (type === 'string') {
    if (typeof value !== 'string') problems.push(`${path}: expected a string, got ${typeof value}`);
    else if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) {
      problems.push(`${path}: ${JSON.stringify(value)} does not match ${schema.pattern}`);
    }
  } else if (type === 'integer') {
    if (!Number.isInteger(value)) problems.push(`${path}: expected an integer, got ${JSON.stringify(value)}`);
  } else if (type === 'number') {
    if (typeof value !== 'number') problems.push(`${path}: expected a number`);
  } else if (type === 'boolean') {
    if (typeof value !== 'boolean') problems.push(`${path}: expected a boolean`);
  }

  if (typeof schema.minimum === 'number' && typeof value === 'number' && value < schema.minimum) {
    problems.push(`${path}: ${value} is below the minimum ${schema.minimum}`);
  }
  if (typeof schema.maximum === 'number' && typeof value === 'number' && value > schema.maximum) {
    problems.push(`${path}: ${value} is above the maximum ${schema.maximum}`);
  }
  if (typeof schema.minItems === 'number' && Array.isArray(value) && value.length < schema.minItems) {
    problems.push(`${path}: needs at least ${schema.minItems} item(s)`);
  }

  return problems;
}

async function schema(name: string): Promise<Schema> {
  return JSON.parse(await readFile(join(SCHEMAS, name), 'utf8')) as Schema;
}

/** Drops undefined members, as JSON serialization would. */
function asJson<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value));
}

const AT = '2026-10-20T12:00:00.000Z';
const HEX32 = 'a'.repeat(32);

// --- fully-populated 2.0 objects -------------------------------------------

const AGENT: Agent = {
  id: `arc_ag_${HEX32}`,
  name: 'finance-agent',
  kind: 'autonomous',
  status: 'draft',
  organizationId: 'default',
  environment: 'production',
  owner: 'ops@example.com',
  description: 'Issues refunds.',
  roles: ['finance'],
  declaredTools: ['stripe.refund'],
  labels: { tier: 'gold' },
  governance: {
    purpose: 'Issues customer refunds within policy limits.',
    department: 'finance-operations',
    criticality: 'business_critical',
    deploymentRef: 'github.com/arc/finance-agent',
    dataClassification: ['pii'],
    reviewIntervalDays: 90,
    lastReviewedAt: AT,
    lastReviewedBy: 'risk@example.com',
    reviewDueAt: AT,
    reviewNote: 'Grants checked against the refund runbook.',
  },
  retiredAt: AT,
  createdAt: AT,
  updatedAt: AT,
};

const TOOL: Tool = {
  id: `arc_tl_${HEX32}`,
  name: 'stripe.refund',
  description: 'Refund a charge.',
  system: 'stripe',
  effect: 'irreversible',
  riskTier: 'critical',
  connector: 'simulation',
  connectorConfig: { manifestDigest: 'sha256:abc' },
  parameters: [{ name: 'amount', type: 'number', required: true, minimum: 0 }],
  labels: {},
  disabled: true,
  disabledAt: AT,
  disabledBy: 'secops@example.com',
  disabledReason: 'duplicate refunds observed',
  createdAt: AT,
  updatedAt: AT,
};

const RISK: Risk = {
  id: `arc_rsk_${HEX32}`,
  reference: 'RISK-AI-001',
  title: 'Agent issues an unauthorized refund',
  description: 'A finance agent refunds a charge outside policy.',
  organizationId: 'default',
  category: 'unauthorized-action',
  status: 'accepted',
  inherent: rateRisk(4, 3),
  residual: {
    ...rateRisk(4, 1),
    reviewedBy: 'risk@example.com',
    reviewedAt: AT,
    rationale: 'Approval gate verified operating for two quarters.',
  },
  treatment: 'accept',
  owner: 'cfo@example.com',
  controlIds: ['ARC-AI-004'],
  scope: ['stripe'],
  acceptance: { acceptedBy: 'ciso@example.com', acceptedAt: AT, rationale: 'Within appetite.', expiresAt: AT },
  reviewDueAt: AT,
  labels: { pillar: 'finance' },
  createdAt: AT,
  updatedAt: AT,
};

const CONTROL: ControlDefinition = {
  id: 'ARC-AI-001',
  version: 1,
  title: 'Every registered agent has a recorded identity and owner',
  objective: 'An agent can be traced to a named accountable human.',
  procedure: 'Assert every non-retired agent has an owner, a purpose and a criticality.',
  assurance: 'automated',
  frequency: 'continuous',
  enabled: true,
  category: 'governance',
  failureSeverity: 'high',
  limitations: ['Checks that an owner is recorded, not that the named person knows they own it.'],
  owner: 'risk@example.com',
  labels: { pillar: 'identity' },
  createdAt: AT,
  updatedAt: AT,
};

const FINDING: Finding = {
  id: `arc_fnd_${HEX32}`,
  organizationId: 'default',
  controlId: 'ARC-AI-001',
  assessmentId: `arc_asm_${HEX32}`,
  severity: 'high',
  status: 'accepted',
  title: 'ARC-AI-001: identity and ownership',
  detail: 'agent "ops-agent" is missing: governance record',
  subject: `arc_ag_${'b'.repeat(32)}`,
  subjectKind: 'agent',
  owner: 'ops@example.com',
  dueAt: AT,
  evidenceIds: [`arc_ev_${HEX32}`],
  resolution: { by: 'ciso@example.com', at: AT, note: 'Dormant test agent.' },
  occurrences: 3,
  firstSeenAt: AT,
  lastSeenAt: AT,
  createdAt: AT,
  updatedAt: AT,
};

function assessment(): ControlAssessment {
  const content = {
    id: `arc_asm_${HEX32}`,
    schemaVersion: 2 as const,
    runId: `arc_run_${HEX32}`,
    controlId: 'ARC-AI-009',
    controlVersion: 1,
    organizationId: 'default',
    status: 'attested' as const,
    assurance: 'deployment' as const,
    summary: 'Attested by secops@example.com.',
    observations: [
      {
        subject: 'stripe',
        subjectKind: 'system' as const,
        ok: true,
        detail: 'covered by attestation',
        evidenceIds: [`arc_ev_${HEX32}`],
      },
    ],
    window: { from: AT, to: AT, actionsConsidered: 4, evidenceConsidered: 4 },
    attestation: {
      id: `arc_att_${HEX32}`,
      controlId: 'ARC-AI-009',
      attestedBy: 'secops@example.com',
      attestedAt: AT,
      statement: 'No agent-reachable credential permits direct access.',
      expiresAt: AT,
      reference: 'SECOPS-1184',
    },
    limitations: ['An attestation is a statement by a person at a point in time.'],
    findingIds: [`arc_fnd_${HEX32}`],
    evaluatedAt: AT,
    evaluationMs: 1.5,
  };
  return { ...content, integrityDigest: digest(content) };
}

function evidence(): EvidenceRecord {
  const parameters = { amount: 100 };
  const content = {
    id: `arc_ev_${HEX32}`,
    schemaVersion: 1 as const,
    actionId: `arc_act_${HEX32}`,
    organizationId: 'default',
    environment: 'production',
    agent: { id: AGENT.id, name: AGENT.name, owner: AGENT.owner, roles: AGENT.roles, credentialId: `arc_cred_${HEX32}` },
    tool: { name: 'stripe.refund', system: 'stripe', effect: 'irreversible', riskTier: 'critical', connector: 'simulation' },
    request: { parameters, parametersDigest: digest(parameters), intent: 'duplicate charge', correlationId: 'run-1', requestedAt: AT },
    decision: {
      id: `arc_dec_${HEX32}`,
      effect: 'ALLOW' as const,
      policyId: 'FINANCE-004',
      policyVersion: 1,
      ruleId: 'under-500',
      reason: 'within authority',
      decidedAt: AT,
      evaluationMs: 1,
      traceDigest: `sha256:${'0'.repeat(64)}`,
    },
    risk: classifyAction({ effect: 'irreversible', riskTier: 'critical', parameters, environment: 'production' }),
    outcome: 'executed',
    obligations: ['redact:pii'],
    createdAt: AT,
  };
  return { ...content, integrityDigest: digest(content) };
}

// ---------------------------------------------------------------------------

describe('the published schemas describe the objects ARC actually produces', () => {
  const cases: readonly [string, string, () => unknown][] = [
    ['an agent with the full 2.0 governance record', 'agent.schema.json', () => AGENT],
    ['a tool with its kill switch engaged', 'tool.schema.json', () => TOOL],
    ['an evidence record carrying a risk classification', 'evidence.schema.json', evidence],
    ['a control definition', 'control.schema.json', () => CONTROL],
    ['an attested assessment', 'assessment.schema.json', assessment],
    ['a risk with a reviewed residual and an acceptance', 'risk.schema.json', () => RISK],
    ['a resolved finding', 'finding.schema.json', () => FINDING],
  ];

  for (const [label, file, build] of cases) {
    it(`validates ${label}`, async () => {
      const document = await schema(file);
      const problems = validate(asJson(build()), document, document);
      assert.deepEqual(problems, [], `${file} rejected a valid object:\n  ${problems.join('\n  ')}`);
    });
  }

  it('rejects an object carrying a property the schema does not describe', async () => {
    const document = await schema('control.schema.json');
    const problems = validate({ ...CONTROL, surpriseField: true }, document, document);

    assert.ok(
      problems.some((problem) => /surpriseField/.test(problem)),
      'the validator must notice an undescribed property, since that is the drift this file exists to catch',
    );
  });

  it('rejects an object missing a required property', async () => {
    const document = await schema('control.schema.json');
    const { limitations: _dropped, ...withoutLimitations } = CONTROL;
    const problems = validate(withoutLimitations, document, document);

    assert.ok(problems.some((problem) => /limitations: required but absent/.test(problem)));
  });

  it('covers every schema in the directory, so a new one cannot ship unvalidated', async () => {
    const files = (await readdir(SCHEMAS)).filter((name) => name.endsWith('.schema.json')).sort();
    const covered = new Set(cases.map(([, file]) => file));

    // action.schema.json, audit.schema.json and policy.schema.json describe
    // 1.x objects unchanged by 2.0 and are covered by the gateway's own tests
    // round-tripping them; they are listed here so adding a *new* schema fails
    // this test rather than quietly going unchecked.
    const knownUncovered = ['action.schema.json', 'audit.schema.json', 'policy.schema.json'];

    const unaccounted = files.filter((file) => !covered.has(file) && !knownUncovered.includes(file));
    assert.deepEqual(unaccounted, [], `these schemas have no validation case: ${unaccounted.join(', ')}`);
  });
});
