import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { flagBool, flagString, flagStrings, parseTokens, withCommand } from './args.js';

describe('parseTokens', () => {
  it('keeps every non-flag token in order', () => {
    const parsed = parseTokens(['policy', 'lint', 'a.json', 'b.json']);
    assert.deepEqual(parsed.tokens, ['policy', 'lint', 'a.json', 'b.json']);
  });

  it('reads --name value and --name=value alike', () => {
    const parsed = parseTokens(['--policy', 'p.json', '--input=i.json']);
    assert.equal(flagString(parsed, 'policy'), 'p.json');
    assert.equal(flagString(parsed, 'input'), 'i.json');
  });

  it('treats a flag with no value as a boolean', () => {
    const parsed = parseTokens(['--json', '--trace']);
    assert.equal(flagBool(parsed, 'json'), true);
    assert.equal(flagBool(parsed, 'trace'), true);
    assert.equal(flagBool(parsed, 'absent'), false);
  });

  it('collects a repeated flag', () => {
    const parsed = parseTokens(['--header', 'a:1', '--header', 'b:2']);
    assert.deepEqual(flagStrings(parsed, 'header'), ['a:1', 'b:2']);
  });

  it('reports a single-valued flag given once as one value', () => {
    assert.deepEqual(flagStrings(parseTokens(['--header', 'a:1']), 'header'), ['a:1']);
  });

  it('treats everything after a bare -- as positional', () => {
    const parsed = parseTokens(['audit', 'verify', '--', '--not-a-flag.json']);
    assert.deepEqual(parsed.tokens, ['audit', 'verify', '--not-a-flag.json']);
    assert.equal(flagBool(parsed, 'not-a-flag.json'), false);
  });

  it('does not consume a following flag as a value', () => {
    const parsed = parseTokens(['--json', '--file', 'x.json']);
    assert.equal(flagBool(parsed, 'json'), true);
    assert.equal(flagString(parsed, 'file'), 'x.json');
  });
});

describe('withCommand', () => {
  it('gives a two-word command its file arguments', () => {
    // The bug this covers: `arc policy lint a.json` used to see no files at
    // all, because every bare token before the first flag was read as part of
    // the command name.
    const args = withCommand(parseTokens(['policy', 'lint', 'a.json', 'b.json']), 2);
    assert.deepEqual(args.command, ['policy', 'lint']);
    assert.deepEqual(args.positional, ['a.json', 'b.json']);
  });

  it('gives a one-word command its arguments', () => {
    const args = withCommand(parseTokens(['demo', 'extra']), 1);
    assert.deepEqual(args.command, ['demo']);
    assert.deepEqual(args.positional, ['extra']);
  });

  it('mixes positional arguments and flags', () => {
    const args = withCommand(parseTokens(['evidence', 'verify', 'export.json', '--json']), 2);
    assert.deepEqual(args.positional, ['export.json']);
    assert.equal(flagBool(args, 'json'), true);
  });

  it('is unaffected by flags appearing before the positional arguments', () => {
    const args = withCommand(parseTokens(['policy', 'lint', '--trace', 'a.json']), 2);
    assert.deepEqual(args.command, ['policy', 'lint']);
    assert.deepEqual(args.positional, ['a.json']);
    assert.equal(flagBool(args, 'trace'), true);
  });
});

describe('boolean flags', () => {
  it('does not let a boolean flag swallow the next argument', () => {
    // `--trace a.json` is a boolean flag followed by a file, not a flag with
    // a value. Without a declared vocabulary the parser cannot tell.
    const args = withCommand(parseTokens(['policy', 'lint', '--trace', 'a.json']), 2);
    assert.equal(flagBool(args, 'trace'), true);
    assert.deepEqual(args.positional, ['a.json']);
  });

  it('still accepts an explicit value for a boolean flag', () => {
    assert.equal(flagBool(parseTokens(['--json=true']), 'json'), true);
    assert.equal(flagBool(parseTokens(['--json=false']), 'json'), false);
  });

  it('lets a caller declare its own vocabulary', () => {
    const parsed = parseTokens(['--quiet', 'file.json'], { booleans: ['quiet'] });
    assert.equal(flagBool(parsed, 'quiet'), true);
    assert.deepEqual(parsed.tokens, ['file.json']);
  });

  it('leaves a value-taking flag alone', () => {
    const parsed = parseTokens(['--policy', 'p.json', '--trace']);
    assert.equal(flagString(parsed, 'policy'), 'p.json');
    assert.equal(flagBool(parsed, 'trace'), true);
  });
});
