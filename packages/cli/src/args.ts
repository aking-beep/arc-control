/**
 * Argument parsing.
 *
 * Hand-rolled rather than taken from a dependency: the CLI ships inside a
 * security control plane, and an argument parser is not worth a supply-chain
 * surface.
 */
export interface ParsedArgs {
  readonly command: readonly string[];
  readonly flags: Readonly<Record<string, string | boolean>>;
  readonly positional: readonly string[];
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const command: string[] = [];
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  let seenFlag = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;

    if (token.startsWith('--')) {
      seenFlag = true;
      const body = token.slice(2);
      const equals = body.indexOf('=');

      if (equals !== -1) {
        flags[body.slice(0, equals)] = body.slice(equals + 1);
        continue;
      }

      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith('-')) {
        flags[body] = next;
        index += 1;
      } else {
        flags[body] = true;
      }
      continue;
    }

    if (token.startsWith('-') && token.length > 1) {
      seenFlag = true;
      flags[token.slice(1)] = true;
      continue;
    }

    if (seenFlag) positional.push(token);
    else command.push(token);
  }

  return { command, flags, positional };
}

export function flagString(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags[name];
  return typeof value === 'string' ? value : undefined;
}

export function flagBool(args: ParsedArgs, name: string): boolean {
  return args.flags[name] === true || args.flags[name] === 'true';
}
