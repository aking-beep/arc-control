/**
 * Regular expressions in policy documents.
 *
 * The `matches` operator compiles to a JavaScript `RegExp`, which has no
 * inline flag syntax. Operators coming from Go, Python, Ruby or any PCRE
 * dialect will nonetheless write `(?i)` for a case-insensitive match, and
 * without help that policy fails to compile with nothing to explain why.
 *
 * So a leading `(?i)` is translated to the `i` flag. It is the only inline
 * flag accepted, and it is only recognized at the very start of the pattern,
 * which keeps the translation unambiguous. The policy validator and the
 * evaluation engine both go through this function, so `arc policy lint` and
 * the running gateway can never disagree about whether a pattern compiles.
 */
const LEADING_INLINE_FLAGS = /^\(\?([a-zA-Z]+)\)/;

const SUPPORTED_FLAGS = new Set(['i']);

export interface CompiledPattern {
  readonly regex: RegExp;
}

export class PatternError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PatternError';
  }
}

/** Compiles a policy pattern, or throws `PatternError` explaining why it cannot. */
export function compilePattern(pattern: string): RegExp {
  let source = pattern;
  let flags = '';

  const inline = LEADING_INLINE_FLAGS.exec(pattern);
  if (inline) {
    const requested = [...inline[1]!];
    const unsupported = requested.filter((flag) => !SUPPORTED_FLAGS.has(flag));
    if (unsupported.length > 0) {
      throw new PatternError(
        `inline flag${unsupported.length > 1 ? 's' : ''} (?${unsupported.join('')}) ${unsupported.length > 1 ? 'are' : 'is'} not supported; only (?i) is`,
      );
    }
    flags = requested.join('');
    source = pattern.slice(inline[0].length);
  }

  try {
    return new RegExp(source, flags);
  } catch (cause) {
    throw new PatternError(cause instanceof Error ? cause.message : String(cause));
  }
}

/** Whether a pattern compiles. Used by the validator. */
export function patternCompiles(pattern: string): { ok: true } | { ok: false; message: string } {
  try {
    compilePattern(pattern);
    return { ok: true };
  } catch (cause) {
    return { ok: false, message: cause instanceof PatternError ? cause.message : String(cause) };
  }
}
