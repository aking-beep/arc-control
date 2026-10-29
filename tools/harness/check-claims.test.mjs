import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { inspect } from './check-claims.mjs';

/**
 * The claim check, made to fail the way it must not pass.
 *
 * Every case here is a defect that actually shipped and was found by hand.
 * Each one fails against the state the repository was in before the fix, and
 * passes after it — which is the only reason to believe the check works.
 */

const RATE_LIMIT_CLAIM = {
  file: 'SECURITY.md',
  phrase: 'No rate limiting, quota or concurrency control',
  evidence: 'packages/gateway/src/rate-limit.ts',
  because: 'the gateway rate-limits actions per agent',
};

/** A repository whose self-description is true. */
const healthy = (overrides = {}) => ({
  versions: new Map([['2.3.0', ['package.json', 'packages/gateway/package.json', 'apps/control-api/src/server.ts (API_VERSION)']]]),
  releaseNotes: ['2.0.md', '2.1.md', '2.2.md', '2.3.md'],
  security: '| Version | Supported |\n|---|---|\n| 2.3.x | ✅ |\n',
  claims: [RATE_LIMIT_CLAIM],
  docs: { 'SECURITY.md': 'Rate limiting is a safety valve, not a quota.' },
  evidenceExists: () => true,
  ...overrides,
});

describe('one version', () => {
  it('passes when every place agrees', () => {
    assert.deepEqual(inspect(healthy()).problems, []);
  });

  it('reports the real defect: five versions live at once', () => {
    // package.json 2.0.0 · packages 2.1.0 · spend 2.3.0 · API_VERSION 2.1.0 · console banner 2.1.0
    const { problems } = inspect(
      healthy({
        versions: new Map([
          ['2.0.0', ['package.json', 'packages/gateway/package.json']],
          ['2.1.0', ['packages/notify/package.json', 'apps/control-api/src/server.ts (API_VERSION)', 'apps/control-console/src/main.ts (banner)']],
          ['2.3.0', ['packages/spend/package.json']],
        ]),
      }),
    );
    assert.equal(problems.length, 3, problems.join('\n'));
    assert.match(problems[0], /3 different versions are live at once/);
    // the root manifest's 2.0.0 is behind the newest note
    assert.match(problems[1], /reports 2\.0\.0 but the newest release note is 2\.3\.x/);
    // and the supported-versions table names a release the product does not claim
    assert.match(problems[2], /does not list 2\.0\.x/);
  });

  it('takes the root manifest as the product version when they disagree', () => {
    const { version } = inspect(
      healthy({
        versions: new Map([
          ['2.1.0', ['apps/control-api/src/server.ts (API_VERSION)']],
          ['2.3.0', ['package.json']],
        ]),
      }),
    );
    assert.equal(version, '2.3.0');
  });

  it('fails when the product has moved past the newest release note', () => {
    const { problems } = inspect(
      healthy({
        versions: new Map([['2.4.0', ['package.json']]]),
        security: '| 2.4.x | ✅ |',
      }),
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0], /newest release note is 2\.3\.x — write the note/);
  });

  it('allows a patch ahead of the note, since a patch needs no note', () => {
    assert.deepEqual(
      inspect(healthy({ versions: new Map([['2.3.7', ['package.json']]]) })).problems,
      [],
    );
  });

  it('orders release notes numerically, not as strings', () => {
    // '10.0' sorts before '2.0' as a string; the newest note here is 10.0.
    const { problems } = inspect(
      healthy({
        releaseNotes: ['2.0.md', '9.0.md', '10.0.md'],
        versions: new Map([['10.0.0', ['package.json']]]),
        security: '| 10.0.x | ✅ |',
      }),
    );
    assert.deepEqual(problems, []);
  });

  it('reports the real defect: the supported-versions table still said 0.1.x', () => {
    const { problems } = inspect(
      healthy({ security: '| Version | Supported |\n|---|---|\n| 0.1.x | ✅ |\n' }),
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0], /does not list 2\.3\.x/);
  });

  it('fails closed when there is nothing to compare', () => {
    const { problems } = inspect(healthy({ versions: new Map() }));
    assert.ok(problems.some((line) => /no versions found/.test(line)), problems.join('\n'));
  });
});

describe('no contradicted claim', () => {
  it('reports the real defect: SECURITY.md denied a rate limiter that shipped', () => {
    const { problems } = inspect(
      healthy({
        docs: { 'SECURITY.md': '- **No rate limiting, quota or concurrency control.** An agent in a loop can fill the audit log.' },
      }),
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0], /says "No rate limiting/);
    assert.match(problems[0], /packages\/gateway\/src\/rate-limit\.ts exists/);
  });

  it('matches the phrase whatever its case', () => {
    const { problems } = inspect(
      healthy({ docs: { 'SECURITY.md': 'no RATE LIMITING, Quota or Concurrency Control here' } }),
    );
    assert.equal(problems.length, 1);
  });

  it('stops applying when the evidence is deleted, because the claim may be true again', () => {
    const { problems } = inspect(
      healthy({
        docs: { 'SECURITY.md': '- **No rate limiting, quota or concurrency control.**' },
        evidenceExists: () => false,
      }),
    );
    assert.deepEqual(problems, []);
  });

  it('fails when a rule names a document that is not there', () => {
    const { problems } = inspect(healthy({ docs: { 'SECURITY.md': undefined } }));
    assert.equal(problems.length, 1);
    assert.match(problems[0], /missing, but a claim rule names it/);
  });
});
