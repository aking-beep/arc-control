#!/usr/bin/env node
import { isArcError } from '@arc-control/schemas';
import { flagBool, parseTokens, withCommand, type ParsedArgs } from './args.js';
import { errorOut, out, style } from './output.js';
import { lintPolicy, testPolicy } from './commands/policy.js';
import { diffMcp, scanMcp } from './commands/mcp.js';
import { verifyAudit, verifyEvidenceFile } from './commands/audit.js';
import { runDemo } from './commands/demo.js';

const VERSION = '0.1.0';

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
  'evidence verify': { words: 2, run: verifyEvidenceFile },
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

${style.bold('VERIFICATION')}
  arc audit verify --data <dir>               Verify a store's audit chain
  arc audit verify --file <audit.jsonl>       Verify an exported chain
      --expect-head <digest>                   Head digest recorded from an anchor
      --expect-records <count>                 Sequence the chain should reach
  arc evidence verify <evidence.json>         Verify exported evidence records

${style.bold('DEMONSTRATION')}
  arc demo                                    Run the refund workflow end to end

${style.bold('EXIT CODES')}
  0  success, or nothing to report
  1  a check failed: invalid policy, a security finding, a broken chain
  2  the command was used incorrectly

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
