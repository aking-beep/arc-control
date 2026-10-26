#!/usr/bin/env node
import { isArcError } from '@arc-control/schemas';
import { flagBool, parseTokens, withCommand, type ParsedArgs } from './args.js';
import { errorOut, out, style } from './output.js';
import { lintPolicy, testPolicy } from './commands/policy.js';
import { diffMcp, scanMcp } from './commands/mcp.js';
import { verifyAudit, verifyEvidenceFile } from './commands/audit.js';
import { runDemo } from './commands/demo.js';
import { createBackup, verifyBackup } from './commands/backup.js';
import {
  evaluateControls,
  listControls,
  showCoverage,
  verifyBundleFile,
} from './commands/assurance.js';

const VERSION = '2.0.0';

/**
 * The command table.
 *
 * `words` is how many leading tokens the command name occupies, so the parser
 * knows where the arguments start. `arc demo` is one; `arc policy lint` is two.
 */
interface Command {
  readonly words: number;
  readonly run: (args: ParsedArgs) => Promise<number>;
}

const COMMANDS: Readonly<Record<string, Command>> = {
  'policy lint': { words: 2, run: lintPolicy },
  'policy test': { words: 2, run: testPolicy },
  'mcp scan': { words: 2, run: scanMcp },
  'mcp diff': { words: 2, run: diffMcp },
  'audit verify': { words: 2, run: verifyAudit },
  'backup create': { words: 2, run: createBackup },
  'backup verify': { words: 2, run: verifyBackup },
  'evidence verify': { words: 2, run: verifyEvidenceFile },
  'bundle verify': { words: 2, run: verifyBundleFile },
  'assurance controls': { words: 2, run: listControls },
  'assurance evaluate': { words: 2, run: evaluateControls },
  'assurance coverage': { words: 2, run: showCoverage },
  demo: { words: 1, run: runDemo },
};

const USAGE = `${style.bold('arc')} — the ARC Control command line (v${VERSION})

${style.bold('USAGE')}
  arc <command> [subcommand] [arguments] [options]

${style.bold('POLICY')}
  arc policy lint <file...>                   Validate policy documents
  arc policy test --policy <f> --input <f>    Evaluate actions against policy
      --trace                                  Always print the rule-by-rule trace

${style.bold('MCP SECURITY')}
  arc mcp scan --endpoint <url>               Scan a live MCP server
  arc mcp scan <manifest.json>                Scan a captured manifest
      --header <name:value>                    Header sent with each request; repeatable
      --suppress <ids>                         Check ids to record as informational
      --json                                   Emit the raw report
  arc mcp diff --pinned <f> --endpoint <url>  Detect drift from a pinned manifest

  arc backup create --data <dir> --to <dir>   Copy a data directory with digests
  arc backup verify --data <dir>              Check a backup is intact and verifies

${style.bold('ASSURANCE')}
  arc assurance controls                      Print the control library
  arc assurance evaluate --data <dir>         Run the controls over a local store
      --from <iso> --to <iso>                  Window; defaults to the last 30 days
      --control <id>                           Evaluate one control
  arc assurance coverage --data <dir>         List what is not governed at all

${style.bold('VERIFICATION')}
  arc audit verify --data <dir>               Verify a store's audit chain
  arc audit verify --file <audit.jsonl>       Verify an exported chain
      --expect-head <digest>                   Head digest recorded from an anchor
      --expect-records <count>                 Sequence the chain should reach
  arc evidence verify <evidence.json>         Verify exported evidence records
  arc bundle verify <bundle.json>             Verify an exported evidence bundle

${style.bold('DEMONSTRATION')}
  arc demo                                    Run the refund workflow end to end

${style.bold('EXIT CODES')}
  0  success, or nothing to report
  1  a check failed: invalid policy, a security finding, a broken chain,
     a failing control, an altered bundle
  2  the command was used incorrectly

${style.dim('A control reporting not_assessable does not fail a command. It is a')}
${style.dim('question ARC could not answer, which is a different thing from a')}
${style.dim('control that did not hold — and gating CI on it would make the gate')}
${style.dim('either useless or permanently red.')}

${style.dim('The verification commands need no running server and no credentials: they')}
${style.dim('work on exports, so an auditor can check them with a tool they control.')}
`;

async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseTokens(argv);
  const [first, second] = parsed.tokens;

  if (flagBool(parsed, 'version') || parsed.flags.v === true || first === 'version') {
    out(VERSION);
    return 0;
  }

  if (first === undefined || flagBool(parsed, 'help') || parsed.flags.h === true || first === 'help') {
    out(USAGE);
    return first === undefined ? 2 : 0;
  }

  // Prefer the two-word command, so `policy lint` is not read as `policy`.
  const twoWord = second === undefined ? undefined : COMMANDS[`${first} ${second}`];
  const command = twoWord ?? COMMANDS[first];

  if (!command) {
    errorOut(`arc: unknown command "${[first, second].filter(Boolean).join(' ')}"`);
    errorOut('Run `arc help` for usage.');
    return 2;
  }

  return command.run(withCommand(parsed, command.words));
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((cause: unknown) => {
    if (isArcError(cause)) {
      errorOut(style.red(`arc: ${cause.message}`));
      if (Object.keys(cause.details).length > 0) {
        errorOut(style.dim(JSON.stringify(cause.details, null, 2)));
      }
      process.exit(1);
    }

    const errno = cause as NodeJS.ErrnoException | undefined;
    if (errno?.code === 'ENOENT') {
      errorOut(style.red(`arc: no such file: ${errno.path ?? 'unknown'}`));
      process.exit(2);
    }
    if (errno?.code === 'EACCES') {
      errorOut(style.red(`arc: permission denied: ${errno.path ?? 'unknown'}`));
      process.exit(2);
    }
    if (cause instanceof SyntaxError) {
      errorOut(style.red(`arc: that file is not valid JSON — ${cause.message}`));
      process.exit(2);
    }

    errorOut(style.red(`arc: ${cause instanceof Error ? cause.message : String(cause)}`));
    process.exit(1);
  });
