#!/usr/bin/env node
import { isArcError } from '@arc-control/schemas';
import { parseArgs } from './args.js';
import { errorOut, out, style } from './output.js';
import { lintPolicy, testPolicy } from './commands/policy.js';
import { diffMcp, scanMcp } from './commands/mcp.js';
import { verifyAudit, verifyEvidenceFile } from './commands/audit.js';
import { runDemo } from './commands/demo.js';

const VERSION = '0.1.0';

const USAGE = `${style.bold('arc')} — the ARC Control command line (v${VERSION})

${style.bold('USAGE')}
  arc <command> [subcommand] [options]

${style.bold('POLICY')}
  arc policy lint <file...>                   Validate policy documents
  arc policy test --policy <f> --input <f>    Evaluate actions against policy
      --trace                                 Always print the rule-by-rule trace

${style.bold('MCP SECURITY')}
  arc mcp scan --endpoint <url>               Scan a live MCP server
  arc mcp scan <manifest.json>                Scan a captured manifest
      --header <name:value>                   Header sent with each request
      --suppress <ids>                        Check ids to record as informational
      --json                                  Emit the raw report
  arc mcp diff --pinned <f> --endpoint <url>  Detect drift from a pinned manifest

${style.bold('VERIFICATION')}
  arc audit verify --data <dir>               Verify a store's audit chain
  arc audit verify --file <audit.jsonl>       Verify an exported chain
  arc evidence verify <evidence.json>         Verify exported evidence records

${style.bold('DEMONSTRATION')}
  arc demo                                    Run the refund workflow end to end

${style.bold('EXIT CODES')}
  0  success, or nothing to report
  1  a check failed: invalid policy, a security finding, a broken chain
  2  the command was used incorrectly

${style.dim('Verification commands need no running server and no credentials: they work')}
${style.dim('on exports, so an auditor can check them with a tool they control.')}
`;

async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  const [command, subcommand] = args.command;

  if (args.flags.version === true || args.flags.v === true || command === 'version') {
    out(VERSION);
    return 0;
  }

  if (command === undefined || args.flags.help === true || args.flags.h === true || command === 'help') {
    out(USAGE);
    return command === undefined ? 2 : 0;
  }

  switch (`${command} ${subcommand ?? ''}`.trim()) {
    case 'policy lint':
      return lintPolicy(args);
    case 'policy test':
      return testPolicy(args);
    case 'mcp scan':
      return scanMcp(args);
    case 'mcp diff':
      return diffMcp(args);
    case 'audit verify':
      return verifyAudit(args);
    case 'evidence verify':
      return verifyEvidenceFile(args);
    case 'demo':
      return runDemo(args);
    default:
      errorOut(`arc: unknown command "${[command, subcommand].filter(Boolean).join(' ')}"`);
      errorOut('Run `arc help` for usage.');
      return 2;
  }
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

    const code = (cause as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') {
      errorOut(style.red(`arc: no such file: ${(cause as NodeJS.ErrnoException).path ?? 'unknown'}`));
      process.exit(2);
    }

    errorOut(style.red(`arc: ${cause instanceof Error ? cause.message : String(cause)}`));
    process.exit(1);
  });
