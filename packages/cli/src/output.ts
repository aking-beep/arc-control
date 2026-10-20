/**
 * Terminal output helpers.
 *
 * The CLI is how an operator checks policy before trusting it, so its output
 * is designed to be read under pressure: the decision first, the reasoning
 * underneath, and colour only where a terminal supports it.
 */
const useColour = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;

function wrap(code: string, text: string): string {
  return useColour ? `\u001b[${code}m${text}\u001b[0m` : text;
}

export const style = {
  bold: (text: string): string => wrap('1', text),
  dim: (text: string): string => wrap('2', text),
  green: (text: string): string => wrap('32', text),
  red: (text: string): string => wrap('31', text),
  yellow: (text: string): string => wrap('33', text),
  cyan: (text: string): string => wrap('36', text),
};

export function out(text = ''): void {
  process.stdout.write(`${text}\n`);
}

export function errorOut(text: string): void {
  process.stderr.write(`${text}\n`);
}

/** Colours a policy effect consistently everywhere it appears. */
export function paintEffect(effect: string): string {
  switch (effect) {
    case 'ALLOW':
      return style.green(style.bold(effect));
    case 'DENY':
      return style.red(style.bold(effect));
    case 'REQUIRE_APPROVAL':
      return style.yellow(style.bold(effect));
    default:
      return effect;
  }
}

export function paintSeverity(severity: string): string {
  switch (severity) {
    case 'critical':
    case 'high':
      return style.red(severity.toUpperCase());
    case 'medium':
      return style.yellow(severity.toUpperCase());
    case 'low':
      return style.cyan(severity.toUpperCase());
    default:
      return style.dim(severity.toUpperCase());
  }
}

/** Renders key/value detail lines with aligned labels. */
export function detail(pairs: readonly (readonly [string, string | undefined])[]): void {
  const width = Math.max(...pairs.map(([label]) => label.length));
  for (const [label, value] of pairs) {
    if (value === undefined) continue;
    out(`  ${style.dim(label.padEnd(width))}  ${value}`);
  }
}

export function table(headers: readonly string[], rows: readonly (readonly string[])[]): void {
  if (rows.length === 0) return;

  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => (row[index] ?? '').length)),
  );

  out(`  ${style.dim(headers.map((header, index) => header.padEnd(widths[index]!)).join('  '))}`);
  for (const row of rows) {
    out(`  ${row.map((cell, index) => (cell ?? '').padEnd(widths[index]!)).join('  ')}`);
  }
}
