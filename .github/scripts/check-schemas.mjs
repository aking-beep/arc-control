#!/usr/bin/env node
/**
 * Checks the published JSON Schemas.
 *
 * These are the contract other languages and other teams build against, so a
 * schema that no longer parses, or that loses its `$id`, breaks consumers
 * silently. The check is structural rather than a full validation pass — the
 * repository has no runtime dependencies, and a JSON Schema validator would
 * be the first.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const DIRECTORY = 'schemas';
const REQUIRED = ['$schema', '$id', 'title', 'description', 'type'];

const files = (await readdir(DIRECTORY)).filter((name) => name.endsWith('.schema.json')).sort();

if (files.length === 0) {
  process.stderr.write(`no schemas found in ${DIRECTORY}/\n`);
  process.exit(1);
}

const problems = [];
const seenIds = new Map();

for (const name of files) {
  const path = join(DIRECTORY, name);
  let schema;

  try {
    schema = JSON.parse(await readFile(path, 'utf8'));
  } catch (cause) {
    problems.push(`${path}: not valid JSON — ${cause.message}`);
    continue;
  }

  for (const field of REQUIRED) {
    if (schema[field] === undefined) problems.push(`${path}: missing ${field}`);
  }

  // A duplicated $id makes two schemas indistinguishable to anything
  // resolving them by reference.
  if (schema.$id) {
    const previous = seenIds.get(schema.$id);
    if (previous) problems.push(`${path}: $id collides with ${previous}`);
    else seenIds.set(schema.$id, path);
  }

  // Every internal $ref must resolve, or a consumer's validator fails on a
  // document we consider valid.
  for (const ref of collectRefs(schema)) {
    if (!ref.startsWith('#/')) continue;
    if (resolvePointer(schema, ref.slice(1)) === undefined) {
      problems.push(`${path}: $ref "${ref}" does not resolve`);
    }
  }

  process.stdout.write(`${path.padEnd(32)} ${schema.title ?? '(untitled)'}\n`);
}

if (problems.length > 0) {
  process.stderr.write('\nProblems:\n');
  for (const problem of problems) process.stderr.write(`  ${problem}\n`);
  process.exit(1);
}

process.stdout.write(`\n${files.length} schema(s) OK\n`);

function collectRefs(node, found = new Set()) {
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, found);
    return found;
  }
  if (node === null || typeof node !== 'object') return found;

  for (const [key, value] of Object.entries(node)) {
    if (key === '$ref' && typeof value === 'string') found.add(value);
    else collectRefs(value, found);
  }
  return found;
}

function resolvePointer(root, pointer) {
  let current = root;

  for (const rawSegment of pointer.split('/').filter(Boolean)) {
    const segment = rawSegment.replaceAll('~1', '/').replaceAll('~0', '~');
    if (current === null || typeof current !== 'object') return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
    current = current[segment];
  }

  return current;
}
