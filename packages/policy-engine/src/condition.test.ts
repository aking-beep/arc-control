import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateCondition } from '@arc-control/schemas';
import { ConditionError, evaluateCondition } from './condition.js';
import { resolvePath, MISSING } from './reference.js';

const INPUT = {
  agent: { name: 'finance-agent', roles: ['finance', 'reader'], labels: { tier: 'gold' } },
  action: { parameters: { amount: 1200, customer: 'customer_123', tags: ['urgent', 'vip'] } },
  context: { environment: 'production', hourUtc: 14 },
};

describe('references', () => {
  it('resolves a nested path', () => {
    assert.equal(resolvePath('action.parameters.amount', INPUT), 1200);
  });

  it('resolves an array index and length', () => {
    assert.equal(resolvePath('action.parameters.tags.0', INPUT), 'urgent');
    assert.equal(resolvePath('action.parameters.tags.length', INPUT), 2);
  });

  it('yields MISSING rather than undefined for an absent path', () => {
    assert.equal(resolvePath('action.parameters.nope', INPUT), MISSING);
  });

  it('never reaches an inherited property', () => {
    for (const path of ['action.parameters.constructor', 'action.parameters.__proto__', 'agent.toString']) {
      assert.equal(resolvePath(path, INPUT), MISSING, path);
    }
  });
});

describe('comparison operators', () => {
  it('compares numbers', () => {
    assert.equal(evaluateCondition({ gt: ['$.action.parameters.amount', 1000] }, INPUT), true);
    assert.equal(evaluateCondition({ lt: ['$.action.parameters.amount', 1000] }, INPUT), false);
  });

  it('refuses to compare a number against a string', () => {
    assert.throws(
      () => evaluateCondition({ gt: ['$.action.parameters.customer', 1000] }, INPUT),
      (error: unknown) => error instanceof ConditionError && /requires two numbers or two strings/.test(error.message),
    );
  });

  it('treats a missing operand as a non-match rather than an error', () => {
    assert.equal(evaluateCondition({ gt: ['$.action.parameters.nope', 10] }, INPUT), false);
    assert.equal(evaluateCondition({ eq: ['$.action.parameters.nope', null] }, INPUT), false);
  });

  it('tests membership in a literal list', () => {
    assert.equal(evaluateCondition({ in: ['$.context.environment', ['staging', 'production']] }, INPUT), true);
    assert.equal(evaluateCondition({ nin: ['$.context.environment', ['staging']] }, INPUT), true);
  });

  it('tests membership of an array-valued reference', () => {
    assert.equal(evaluateCondition({ contains: ['$.agent.roles', 'finance'] }, INPUT), true);
    assert.equal(evaluateCondition({ contains: ['$.agent.roles', 'admin'] }, INPUT), false);
  });

  it('combines with and, or and not', () => {
    assert.equal(
      evaluateCondition(
        {
          and: [
            { eq: ['$.context.environment', 'production'] },
            { or: [{ gt: ['$.action.parameters.amount', 5000] }, { contains: ['$.agent.roles', 'finance'] }] },
            { not: { eq: ['$.agent.name', 'rogue-agent'] } },
          ],
        },
        INPUT,
      ),
      true,
    );
  });

  it('reports a condition with more than one operator', () => {
    assert.throws(
      () => evaluateCondition({ eq: ['a', 'a'], ne: ['b', 'c'] } as never, INPUT),
      (error: unknown) => error instanceof ConditionError && /exactly one operator/.test(error.message),
    );
  });
});

describe('matches', () => {
  it('matches with JavaScript regular expression syntax', () => {
    assert.equal(evaluateCondition({ matches: ['$.action.parameters.customer', '^customer_\\d+$'] }, INPUT), true);
    assert.equal(evaluateCondition({ matches: ['$.action.parameters.customer', '^acct_'] }, INPUT), false);
  });

  it('honours a leading (?i) as a case-insensitive flag', () => {
    // Operators arriving from Go, Python or PCRE write this, and a policy that
    // failed to compile would tell them nothing useful.
    assert.equal(evaluateCondition({ matches: ['$.agent.name', '(?i)FINANCE-AGENT'] }, INPUT), true);
    assert.equal(evaluateCondition({ matches: ['$.agent.name', 'FINANCE-AGENT'] }, INPUT), false);
  });

  it('validates the same patterns the engine accepts', () => {
    assert.deepEqual(validateCondition({ matches: ['$.agent.name', '(?i)finance'] }, 'when'), []);
    assert.equal(validateCondition({ matches: ['$.agent.name', '(?m)finance'] }, 'when').length, 1);
    assert.equal(validateCondition({ matches: ['$.agent.name', '([unclosed'] }, 'when').length, 1);
  });

  it('rejects an unsupported inline flag rather than ignoring it', () => {
    assert.throws(
      () => evaluateCondition({ matches: ['$.agent.name', '(?s)finance'] }, INPUT),
      (error: unknown) => error instanceof ConditionError && /not supported/.test(error.message),
    );
  });

  it('refuses an input longer than the match bound', () => {
    assert.throws(
      () => evaluateCondition({ matches: ['$.long', 'a+'] }, { long: 'a'.repeat(5000) }),
      (error: unknown) => error instanceof ConditionError && /refuses input longer/.test(error.message),
    );
  });
});
