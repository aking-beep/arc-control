/**
 * The eval harness.
 *
 * Evals are not unit tests. A unit test asks whether a function does what its
 * author intended; an eval asks whether the control plane still upholds a
 * property somebody is relying on — "a denied action never reaches the target
 * system", "adding a policy cannot loosen authorization". Those properties are
 * the product, so they are asserted separately from the code that implements
 * them, in terms a reviewer can read without reading the implementation.
 *
 * Each suite exports `{ id, title, rationale, cases }`.
 */

const colour = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (colour ? `\u001b[${code}m${text}\u001b[0m` : text);

export const fmt = {
  bold: (t) => paint('1', t),
  dim: (t) => paint('2', t),
  green: (t) => paint('32', t),
  red: (t) => paint('31', t),
  yellow: (t) => paint('33', t),
};

export class AssertionFailed extends Error {
  constructor(message) {
    super(message);
    this.name = 'AssertionFailed';
  }
}

/**
 * The assertion surface available to a case. Every assertion takes a `because`
 * string: an eval failure should explain what guarantee broke, not just which
 * values differed.
 */
export const expect = {
  equal(actual, wanted, because) {
    if (actual !== wanted) {
      throw new AssertionFailed(`${because}\n      expected: ${format(wanted)}\n      actual:   ${format(actual)}`);
    }
  },
  deepEqual(actual, wanted, because) {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(wanted);
    if (a !== b) {
      throw new AssertionFailed(`${because}\n      expected: ${b}\n      actual:   ${a}`);
    }
  },
  ok(value, because) {
    if (!value) throw new AssertionFailed(`${because}\n      value was ${format(value)}`);
  },
  match(actual, pattern, because) {
    if (!pattern.test(String(actual))) {
      throw new AssertionFailed(`${because}\n      ${format(actual)} does not match ${pattern}`);
    }
  },
  /** Asserts that a call rejects, optionally with a specific ArcError code. */
  async rejects(run, code, because) {
    try {
      await run();
    } catch (cause) {
      if (code && cause?.code !== code) {
        throw new AssertionFailed(`${because}\n      expected code "${code}", got "${cause?.code}": ${cause?.message}`);
      }
      return cause;
    }
    throw new AssertionFailed(`${because}\n      the call resolved instead of rejecting`);
  },
};

function format(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  return JSON.stringify(value) ?? String(value);
}

/** Runs the given suites and reports. Returns the number of failed cases. */
export async function runSuites(suites) {
  let passed = 0;
  const failures = [];

  process.stdout.write(`${fmt.bold('ARC Control — control-plane evals')}\n\n`);

  for (const suite of suites) {
    process.stdout.write(`${fmt.bold(suite.title)} ${fmt.dim(`(${suite.id})`)}\n`);
    if (suite.rationale) process.stdout.write(`${fmt.dim(`  ${suite.rationale}`)}\n`);

    for (const testCase of suite.cases) {
      const started = process.hrtime.bigint();
      try {
        await testCase.run();
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        passed += 1;
        process.stdout.write(`  ${fmt.green('PASS')} ${testCase.name} ${fmt.dim(`${ms.toFixed(1)}ms`)}\n`);
      } catch (cause) {
        failures.push({ suite: suite.title, name: testCase.name, cause });
        process.stdout.write(`  ${fmt.red('FAIL')} ${testCase.name}\n`);
        const detail = cause instanceof AssertionFailed ? cause.message : (cause?.stack ?? String(cause));
        for (const line of detail.split('\n')) {
          process.stdout.write(`       ${fmt.red(line)}\n`);
        }
      }
    }
    process.stdout.write('\n');
  }

  const total = passed + failures.length;
  if (failures.length === 0) {
    process.stdout.write(`${fmt.green(`${total}/${total} properties hold.`)}\n`);
  } else {
    process.stdout.write(`${fmt.red(`${failures.length} of ${total} properties do not hold:`)}\n`);
    for (const failure of failures) {
      process.stdout.write(`  ${fmt.red('•')} ${failure.suite} → ${failure.name}\n`);
    }
  }

  return failures.length;
}
