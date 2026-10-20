/**
 * Argument parsing.
 *
 * Hand-rolled rather than taken from a dependency: the CLI ships inside a
 * security control plane, and an argument parser is not worth a supply-chain
 * surface.
 *
 * The parser does not try to work out where the command name ends and the
 * arguments begin — it cannot, because `arc demo` is one word and
 * `arc policy lint` is two. It returns every non-flag token in order, and the
 * caller slices off as many command words as the command it matched actually
 * has. Guessing here is what made `arc policy lint <file>` silently lose its
 * file argument.
 */

/**
 * Flags that never take a value.
 *
 * Without this list `--trace a.json` is ambiguous: the parser cannot tell a
 * boolean flag followed by a file from a flag with a value. Declaring the
 * vocabulary resolves it in the direction a shell user expects, and keeps
 * `arc policy lint --trace a.json` working.
 */
export const BOOLEAN_FLAGS: readonly string[] = [
  'trace',
  'json',
  'help',
  'h',
  'version',
  'v',
];

export interface ParseOptions {
  /** Flags to treat as value-less. Defaults to `BOOLEAN_FLAGS`. */
  readonly booleans?: readonly string[];
}

export interface ParsedTokens {
  /** Every non-flag argument, in the order given. */
  readonly tokens: readonly string[];
  readonly flags: Readonly<Record<string, string | boolean | readonly string[]>>;
}

/** What a command handler receives. */
export interface ParsedArgs {
  /** The command words that were matched, e.g. `['policy', 'lint']`. */
  readonly command: readonly string[];
  /** Everything after the command words. */
  readonly positional: readonly string[];
  readonly flags: Readonly<Record<string, string | boolean | readonly string[]>>;
}

export function parseTokens(argv: readonly string[], options: ParseOptions = {}): ParsedTokens {
  const booleans = new Set(options.booleans ?? BOOLEAN_FLAGS);
  const tokens: string[] = [];
  const flags: Record<string, string | boolean | readonly string[]> = {};

  const set = (name: string, value: string | boolean): void => {
    const existing = flags[name];
    if (existing === undefined) {
      flags[name] = value;
      return;
    }
    // A repeated flag collects, so `--header a:b --header c:d` works.
    const collected = Array.isArray(existing) ? existing : [String(existing)];
    flags[name] = [...collected, String(value)];
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;

    // Everything after a bare `--` is positional, even if it looks like a flag.
    if (token === '--') {
      tokens.push(...argv.slice(index + 1));
      break;
    }

    if (token.startsWith('--')) {
      const body = token.slice(2);
      const equals = body.indexOf('=');

      if (equals !== -1) {
        set(body.slice(0, equals), body.slice(equals + 1));
        continue;
      }

      const next = argv[index + 1];
      if (!booleans.has(body) && next !== undefined && !next.startsWith('-')) {
        set(body, next);
        index += 1;
      } else {
        set(body, true);
      }
      continue;
    }

    if (token.startsWith('-') && token.length > 1) {
      set(token.slice(1), true);
      continue;
    }

    tokens.push(token);
  }

  return { tokens, flags };
}

/** Splits parsed tokens into the matched command words and the rest. */
export function withCommand(parsed: ParsedTokens, depth: number): ParsedArgs {
  return {
    command: parsed.tokens.slice(0, depth),
    positional: parsed.tokens.slice(depth),
    flags: parsed.flags,
  };
}

export function flagString(args: ParsedArgs | ParsedTokens, name: string): string | undefined {
  const value = args.flags[name];
  if (typeof value === 'string') return value;
  // A repeated flag where one value was wanted: the last wins, as a shell user expects.
  if (Array.isArray(value)) return value.at(-1);
  return undefined;
}

/** Every value given for a repeatable flag, such as `--header`. */
export function flagStrings(args: ParsedArgs | ParsedTokens, name: string): readonly string[] {
  const value = args.flags[name];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value;
  return [];
}

export function flagBool(args: ParsedArgs | ParsedTokens, name: string): boolean {
  const value = args.flags[name];
  return value === true || value === 'true';
}
