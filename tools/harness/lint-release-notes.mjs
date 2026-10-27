#!/usr/bin/env node
/**
 * Lints the release notes in `docs/releases/` — the `release-notes` skill's
 * procedure, as a check.
 *
 * Every release note in this repository states how the release was verified
 * and what it does not establish. Those two sections are what stop a release
 * note becoming marketing, so they are required; the rest is the author's.
 *
 * Usage: node tools/harness/lint-release-notes.mjs [--out result.json]
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, writeResult } from './lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function lintReleaseNote(text) {
  const problems = [];
  const headings = [...text.matchAll(/^#{1,3} (.+)$/gm)].map((match) => match[1].trim());
  if (!/^# /m.test(text)) problems.push('no title (a "# " heading)');
  if (!headings.some((heading) => /^verification\b/i.test(heading))) problems.push('no "Verification" section');
  if (!headings.some((heading) => /does not establish|still not here|deferred|not establish|limitation/i.test(heading))) {
    problems.push('no section stating what the release does not establish (its limits)');
  }
  // A line may mention enterprise readiness only to deny it.
  for (const line of text.split('\n')) {
    if (/\benterprise[- ]read(?:y|iness)\b/i.test(line) && !/\b(?:not|no|nothing|never|nor|isn't|cannot)\b/i.test(line)) {
      problems.push(`claims enterprise readiness: "${line.trim().slice(0, 80)}"`);
    }
  }
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { options } = parseArgs();
  const directory = join(ROOT, 'docs', 'releases');
  const files = (await readdir(directory)).filter((file) => file.endsWith('.md')).sort();
  const results = [];
  for (const file of files) {
    const problems = lintReleaseNote(await readFile(join(directory, file), 'utf8'));
    results.push({ file, problems });
    process.stdout.write(`${problems.length === 0 ? 'ok  ' : 'FAIL'} docs/releases/${file}${problems.map((problem) => `\n       ${problem}`).join('')}\n`);
  }
  const passing = results.filter((result) => result.problems.length === 0).length;
  process.stdout.write(`\n${passing}/${results.length} release note(s) pass\n`);
  await writeResult(options.out, {
    skill: 'release-notes',
    tool: 'lint-release-notes',
    ok: passing === results.length,
    metrics: { notes_total: results.length, notes_passing: passing, notes_passing_rate: results.length ? passing / results.length : 1 },
    details: { results },
  });
  if (passing !== results.length) process.exitCode = 1;
}
