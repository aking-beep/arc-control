import { readFile } from 'node:fs/promises';
import { digest, validatePolicy, type Policy, type PolicyInput } from '@arc-control/schemas';
import { PolicyEngine } from '@arc-control/policy-engine';
import { flagBool, flagString, type ParsedArgs } from '../args.js';
import { detail, out, paintEffect, style, table } from '../output.js';

/**
 * `arc policy lint` and `arc policy test`.
 *
 * These are the commands that make a policy trustworthy before it governs
 * anything: lint catches a document that cannot decide, and test answers
 * "what would this do to that action?" in CI, where it is cheap, rather than
 * in production, where it is not.
 */

export async function lintPolicy(args: ParsedArgs): Promise<number> {
  const paths = args.positional.length > 0 ? args.positional : [flagString(args, 'file') ?? ''];
  if (paths.some((path) => !path)) {
    out('usage: arc policy lint <policy.json> [more.json ...]');
    return 2;
  }

  let failures = 0;

  for (const path of paths) {
    const policies = await loadPolicies(path);

    for (const policy of policies) {
      const result = validatePolicy(policy);
      const label = `${policy.id ?? '(no id)'} v${policy.version ?? '?'}`;

      if (result.valid) {
        out(`${style.green('✓')} ${style.bold(label)}  ${style.dim(path)}`);
        detail([
          ['rules', String(policy.rules?.length ?? 0)],
          ['fallback', `${policy.fallback?.effect} — ${policy.fallback?.reason}`],
          ['digest', digest(policy)],
        ]);
      } else {
        failures += 1;
        out(`${style.red('✗')} ${style.bold(label)}  ${style.dim(path)}`);
        for (const issue of result.issues) {
          out(`  ${style.red(issue.path)}: ${issue.message}`);
        }
      }
      out();
    }
  }

  out(failures === 0 ? style.green('All policies are valid.') : style.red(`${failures} policy document(s) failed.`));
  return failures === 0 ? 0 : 1;
}

export async function testPolicy(args: ParsedArgs): Promise<number> {
  const policyPath = flagString(args, 'policy') ?? args.positional[0];
  const casePath = flagString(args, 'input') ?? args.positional[1];

  if (!policyPath || !casePath) {
    out('usage: arc policy test --policy <policy.json> --input <cases.json>');
    out();
    out('The input file holds either one policy input object, or an array of');
    out('cases shaped { name, expect, input } for use as an assertion suite.');
    return 2;
  }

  const policies = await loadPolicies(policyPath);
  const cases = await loadCases(casePath);
  const engine = new PolicyEngine();

  let failures = 0;

  for (const testCase of cases) {
    const decision = engine.evaluate(policies, testCase.input);
    const passed = testCase.expect === undefined || testCase.expect === decision.effect;
    if (!passed) failures += 1;

    const marker = testCase.expect === undefined ? style.dim('·') : passed ? style.green('✓') : style.red('✗');
    out(`${marker} ${style.bold(testCase.name)}  →  ${paintEffect(decision.effect)}`);

    detail([
      ['policy', decision.policyId ? `${decision.policyId} v${decision.policyVersion}` : style.dim('(none matched)')],
      ['rule', decision.ruleId],
      ['reason', decision.reason],
      ['expected', testCase.expect === undefined ? undefined : paintEffect(testCase.expect)],
      [
        'approvers',
        decision.approval
          ? `${decision.approval.approvers.join(', ')} (needs ${decision.approval.minApprovals})`
          : undefined,
      ],
    ]);

    if (flagBool(args, 'trace') || !passed) {
      out(`  ${style.dim('trace')}`);
      table(
        ['policy', 'rule', 'matched', 'effect', 'note'],
        decision.trace.map((entry) => [
          entry.policyId,
          entry.ruleId,
          entry.matched ? 'yes' : 'no',
          entry.effect ?? '',
          entry.error ? style.red(entry.error) : (entry.reason ?? ''),
        ]),
      );
    }
    out();
  }

  if (failures > 0) {
    out(style.red(`${failures} of ${cases.length} case(s) did not produce the expected effect.`));
    return 1;
  }

  out(style.green(`${cases.length} case(s) evaluated as expected.`));
  return 0;
}

interface PolicyCase {
  readonly name: string;
  readonly expect?: 'ALLOW' | 'REQUIRE_APPROVAL' | 'DENY';
  readonly input: PolicyInput;
}

async function loadPolicies(path: string): Promise<Policy[]> {
  const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
  if (Array.isArray(parsed)) return parsed as Policy[];
  if (isRecord(parsed) && Array.isArray(parsed.policies)) return parsed.policies as unknown as Policy[];
  return [parsed as Policy];
}

async function loadCases(path: string): Promise<PolicyCase[]> {
  const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;

  const normalize = (value: unknown, index: number): PolicyCase => {
    if (isRecord(value) && isRecord(value.input)) {
      return {
        name: typeof value.name === 'string' ? value.name : `case ${index + 1}`,
        ...(typeof value.expect === 'string' ? { expect: value.expect as PolicyCase['expect'] } : {}),
        input: value.input as unknown as PolicyInput,
      };
    }
    // A bare policy input, with no expectation attached.
    return { name: `case ${index + 1}`, input: value as PolicyInput };
  };

  if (Array.isArray(parsed)) return parsed.map(normalize);
  if (isRecord(parsed) && Array.isArray(parsed.cases)) return parsed.cases.map(normalize);
  return [normalize(parsed, 0)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
