import { readFile } from 'node:fs/promises';
import { AssuranceEngine, baselineControls, buildCoverageReport } from '@arc-control/assurance';
import { AuditLog } from '@arc-control/audit';
import { verifyBundle } from '@arc-control/evidence';
import { FileStore } from '@arc-control/store';
import type { ControlStatus, EvidenceBundle } from '@arc-control/schemas';
import { flagBool, flagString, type ParsedArgs } from '../args.js';
import { detail, out, style, table } from '../output.js';

/**
 * The assurance commands.
 *
 * They follow the same rule as `arc audit verify`: work against a data
 * directory or an exported file, need no running server and no credentials.
 * An auditor should be able to check an export with a tool they control,
 * against a party that has an interest in the answer — and an operator should
 * be able to run an assessment on a laptop without standing the API up.
 */

/** How a status is painted. `not_assessable` is not a near-pass and must not look like one. */
function paintStatus(status: ControlStatus): string {
  switch (status) {
    case 'pass':
      return style.green(style.bold('PASS'));
    case 'fail':
      return style.red(style.bold('FAIL'));
    case 'attested':
      return style.yellow('ATTESTED');
    case 'not_applicable':
      return style.dim('N/A');
    case 'not_assessable':
    default:
      return style.cyan('NOT ASSESSABLE');
  }
}

async function openStore(args: ParsedArgs): Promise<{ store: FileStore; path: string } | undefined> {
  const dataDir = flagString(args, 'data') ?? process.env.ARC_DATA_DIR;
  if (!dataDir) return undefined;
  return { store: await FileStore.open(dataDir), path: dataDir };
}

/** `arc assurance controls` — print the control catalogue. */
export async function listControls(args: ParsedArgs): Promise<number> {
  const opened = await openStore(args);
  const controls = opened ? await opened.store.controls.list() : baselineControls();
  const library = controls.length > 0 ? controls : baselineControls();

  if (flagBool(args, 'json')) {
    out(JSON.stringify(library, null, 2));
    await opened?.store.close();
    return 0;
  }

  out(style.bold(`Control library (${library.length})`));
  out(
    opened && controls.length > 0
      ? style.dim(`  from ${opened.path}`)
      : style.dim('  the shipped baseline; no data directory given, so nothing deployment-specific is shown'),
  );
  out();

  table(
    ['id', 'assurance', 'frequency', 'severity', 'title'],
    library.map((control) => [
      control.enabled ? control.id : style.dim(`${control.id} (off)`),
      control.assurance,
      control.frequency,
      control.failureSeverity,
      control.title,
    ]),
  );

  out();
  const deployment = library.filter((control) => control.assurance !== 'automated');
  if (deployment.length > 0) {
    out(style.dim(`${deployment.length} control(s) cannot be decided by ARC and need a human attestation:`));
    for (const control of deployment) out(style.dim(`  ${control.id}  ${control.title}`));
    out();
  }

  await opened?.store.close();
  return 0;
}

/**
 * `arc assurance evaluate --data <dir>` — run the control library locally.
 *
 * Exits 1 when any control fails, so this is usable as a CI gate. A
 * `not_assessable` result does not fail the command: it is not a control
 * failure, it is a question ARC could not answer, and conflating the two
 * would either make the gate useless or make it permanently red.
 */
export async function evaluateControls(args: ParsedArgs): Promise<number> {
  const opened = await openStore(args);
  if (!opened) {
    out('usage: arc assurance evaluate --data <dir>');
    out();
    out('  --from <iso>    window start (default: 30 days ago)');
    out('  --to <iso>      window end (default: now)');
    out('  --control <id>  evaluate one control; repeatable');
    out('  --json          emit the raw run');
    out();
    out('Exits 1 if any control fails. A control reporting not_assessable does');
    out('not fail the command: that is a question ARC could not answer, which is');
    out('a different thing from a control that did not hold.');
    return 2;
  }

  const { store, path } = opened;
  try {
    const audit = new AuditLog(store);
    const engine = new AssuranceEngine({
      store,
      audit: (event) => audit.append(event),
      verifyChain: async () => {
        const expectation = await store.recordedAuditHead?.();
        const verification = await audit.verify(expectation);
        // The store's own head marker is ARC's copy of ARC's answer, so it is
        // not an external anchor. Saying otherwise here would hand ARC-AI-006
        // a pass it has not earned.
        return { verification, externallyAnchored: false };
      },
    });

    await engine.seedBaseline();

    const controlIds = [flagString(args, 'control')].filter((value): value is string => value !== undefined);
    const from = flagString(args, 'from');
    const to = flagString(args, 'to');

    const { run, assessments } = await engine.run({
      requestedBy: process.env.USER ?? 'cli',
      ...(from ? { from: new Date(from) } : {}),
      ...(to ? { to: new Date(to) } : {}),
      ...(controlIds.length > 0 ? { controlIds } : {}),
    });

    if (flagBool(args, 'json')) {
      out(JSON.stringify({ run, assessments }, null, 2));
      return assessments.some((assessment) => assessment.status === 'fail') ? 1 : 0;
    }

    out(style.bold('Assurance assessment'));
    detail([
      ['store', path],
      ['window', `${run.window.from} to ${run.window.to}`],
      ['actions in window', String(run.window.actionsConsidered)],
      ['evidence in window', String(run.window.evidenceConsidered)],
      ['controls', String(assessments.length)],
    ]);
    out();

    table(
      ['control', 'status', 'summary'],
      assessments.map((assessment) => [assessment.controlId, paintStatus(assessment.status), assessment.summary]),
    );
    out();

    const failing = assessments.filter((assessment) => assessment.status === 'fail');
    for (const assessment of failing) {
      out(style.red(style.bold(`${assessment.controlId} failed`)));
      for (const observation of assessment.observations.filter((candidate) => !candidate.ok)) {
        out(`  ${style.dim(observation.subject)}  ${observation.detail}`);
      }
      out();
    }

    const unassessable = assessments.filter((assessment) => assessment.status === 'not_assessable');
    if (unassessable.length > 0) {
      out(style.bold(`${unassessable.length} control(s) could not be assessed`));
      out(style.dim('  Not a pass and not a failure: ARC could not answer the question.'));
      for (const assessment of unassessable) {
        out(`  ${style.dim(assessment.controlId)}  ${assessment.summary}`);
      }
      out();
    }

    const counts = Object.entries(run.totals)
      .filter(([, count]) => count > 0)
      .map(([status, count]) => `${count} ${status}`)
      .join(', ');
    out(failing.length > 0 ? style.red(`Result: ${counts}`) : `Result: ${counts}`);

    return failing.length > 0 ? 1 : 0;
  } finally {
    await store.close();
  }
}

/** `arc assurance coverage --data <dir>` — what is not governed at all. */
export async function showCoverage(args: ParsedArgs): Promise<number> {
  const opened = await openStore(args);
  if (!opened) {
    out('usage: arc assurance coverage --data <dir>');
    out();
    out('Lists the gaps by name. Produces no percentage: "94% covered" says');
    out('nothing about whether the missing 6% is a dormant test agent or the');
    out('one holding production database credentials.');
    return 2;
  }

  const { store, path } = opened;
  try {
    const report = await buildCoverageReport({ store });

    if (flagBool(args, 'json')) {
      out(JSON.stringify(report, null, 2));
      return 0;
    }

    out(style.bold('Governance coverage'));
    detail([
      ['store', path],
      ['window', `${report.window.from} to ${report.window.to}`],
      ['agents', String(report.totals.agents)],
      ['tools', String(report.totals.tools)],
      ['enabled policies', String(report.totals.policies)],
      ['enabled controls', String(report.totals.controls)],
      ['controls ever assessed', String(report.totals.controlsAssessed)],
    ]);
    out();

    let gaps = 0;

    if (report.ungovernedAgents.length > 0) {
      gaps += report.ungovernedAgents.length;
      out(style.bold('Agents with an incomplete governance record'));
      table(
        ['agent', 'missing'],
        report.ungovernedAgents.map((agent) => [agent.name, agent.missing.join(', ')]),
      );
      out();
    }

    if (report.uncoveredTools.length > 0) {
      gaps += report.uncoveredTools.length;
      out(style.bold('High-impact tools no enabled policy selects'));
      table(
        ['tool', 'tier', 'effect'],
        report.uncoveredTools.map((tool) => [tool.name, tool.riskTier, tool.effect]),
      );
      out();
    }

    if (report.uncoveredAgents.length > 0) {
      gaps += report.uncoveredAgents.length;
      out(style.bold('Active agents no enabled policy selects'));
      for (const agent of report.uncoveredAgents) out(`  ${agent.name}`);
      out();
    }

    if (report.staleControls.length > 0) {
      out(style.bold('Controls never assessed, or assessed too long ago'));
      table(
        ['control', 'frequency', 'last assessed'],
        report.staleControls.map((control) => [
          control.controlId,
          control.frequency,
          control.lastAssessedAt ?? style.dim('never'),
        ]),
      );
      out();
    }

    if (report.actionsMissingEvidence.length > 0) {
      out(style.red(style.bold('Actions with no evidence record')));
      out(
        style.red(
          '  This should always be empty. The gateway writes evidence on every path, including every error path, so this is a defect in ARC rather than a governance gap.',
        ),
      );
      for (const id of report.actionsMissingEvidence.slice(0, 20)) out(`  ${id}`);
      out();
      return 1;
    }

    if (gaps === 0 && report.staleControls.length === 0) out(style.green('No coverage gaps found.'));
    return 0;
  } finally {
    await store.close();
  }
}

/**
 * `arc bundle verify <bundle.json>` — check an evidence bundle offline.
 *
 * The command the whole bundle format exists for. It reads a file, recomputes
 * every digest in it, and contacts nothing. An auditor can run it against a
 * bundle from a customer they do not trust, on a machine with no network.
 */
export async function verifyBundleFile(args: ParsedArgs): Promise<number> {
  const file = flagString(args, 'file') ?? args.positional[0];
  if (!file) {
    out('usage: arc bundle verify <bundle.json>');
    out();
    out('Recomputes every digest in the bundle from the file itself. Makes no');
    out('network request and needs no credentials or running server.');
    return 2;
  }

  const bundle = JSON.parse(await readFile(file, 'utf8')) as EvidenceBundle;
  const result = verifyBundle(bundle);

  if (flagBool(args, 'json')) {
    out(JSON.stringify(result, null, 2));
    return result.valid ? 0 : 1;
  }

  out(style.bold('Evidence bundle verification'));
  detail([
    ['file', file],
    ['bundle', bundle.manifest?.id ?? style.dim('(none)')],
    ['produced by', bundle.manifest?.producedBy ?? style.dim('(unstated)')],
    ['exported by', bundle.manifest?.exportedBy ?? style.dim('(unstated)')],
    ['exported at', bundle.manifest?.exportedAt ?? style.dim('(unstated)')],
    ['window', bundle.manifest ? `${bundle.manifest.window.from} to ${bundle.manifest.window.to}` : undefined],
    ['records', String(result.entriesChecked)],
    ['result', result.valid ? style.green('INTACT') : style.red('FAILED')],
  ]);
  out();

  if (result.failures.length > 0) {
    table(
      ['problem', 'subject', 'detail'],
      result.failures.map((failure) => [failure.problem, failure.subject, failure.detail]),
    );
    out();
    out(style.red('This bundle has been altered since it was exported. Do not rely on it.'));
    return 1;
  }

  if (result.chain) {
    detail([
      ['audit records', String(result.chain.recordsChecked)],
      ['chain', result.chain.valid ? style.green('linked') : style.red('broken')],
      ['head', result.chain.headDigest],
    ]);
    out();
  }

  // Printed after a pass, deliberately and prominently. These are the things
  // an intact bundle still does not establish, and a reader who stops at
  // "INTACT" is the reader this section exists for.
  if (result.limitations.length > 0) {
    out(style.bold('What this does not establish'));
    for (const limitation of result.limitations) out(`  ${style.yellow('·')} ${limitation.detail}`);
    out();
  }

  if (bundle.limitations?.length) {
    out(style.bold('Stated limitations of the bundle itself'));
    for (const limitation of bundle.limitations) out(`  ${style.dim('·')} ${limitation}`);
    out();
  }

  out(style.green('Every digest in this bundle recomputed correctly.'));
  return 0;
}
