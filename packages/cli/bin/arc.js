#!/usr/bin/env node
/**
 * Launcher for the `arc` command.
 *
 * This file is committed and contains no logic, because npm links a
 * workspace's `bin` entries during installation — before any `prepare` script
 * has had a chance to compile anything. A `bin` pointing straight at
 * `dist/bin.js` is therefore skipped on a fresh clone, and `npx arc` reports
 * that it cannot determine an executable to run. Pointing at a file that
 * always exists gets the symlink created; this then loads the compiled CLI.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const entry = join(dirname(dirname(fileURLToPath(import.meta.url))), 'dist', 'bin.js');

if (!existsSync(entry)) {
  process.stderr.write(
    'arc: the CLI has not been built yet.\n' +
      '  Run `npm run build` from the repository root, then try again.\n',
  );
  process.exit(2);
}

await import(pathToFileURL(entry).href);
