/**
 * Shared plumbing for the harness scripts. Kept tiny and dependency-free:
 * argument parsing, and the one result format every script can emit so the
 * measurement step (`measure.mjs`) can read any of them the same way.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** `--name value` and bare `--flag` arguments; everything else is positional. */
export function parseArgs(argv = process.argv.slice(2)) {
  const options = {};
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) options[name] = true;
    else {
      options[name] = next;
      index += 1;
    }
  }
  return { options, positional };
}

/**
 * Writes a result file when `--out` was given.
 *
 * Shape: { skill, tool, at, ok, metrics: { name: number }, details }. Metrics
 * are plain numbers so they can be compared against targets and charted over
 * time without interpretation.
 */
export async function writeResult(path, result) {
  if (!path) return;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ at: new Date().toISOString(), ...result }, null, 2)}\n`, 'utf8');
}
