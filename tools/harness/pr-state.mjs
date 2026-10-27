#!/usr/bin/env node
/**
 * Prints a pull request's full state as one checklist — the `steward`
 * skill's "every event" step, as a script.
 *
 * Mergeability, the check rollup on the current head, open review threads and
 * draft status, each as a line that is either done or names what is left. In
 * GitHub Actions the checklist is also written to the job summary.
 *
 * Usage: node tools/harness/pr-state.mjs --pr 12 [--out result.json]
 * Needs GITHUB_TOKEN and GITHUB_REPOSITORY (set in Actions).
 */
import { appendFile } from 'node:fs/promises';
import { parseArgs, writeResult } from './lib.mjs';
import { githubContext, pullRequest } from './github.mjs';

const { options } = parseArgs();
const context = githubContext();
if (!context) {
  process.stderr.write('pr-state needs GITHUB_TOKEN and GITHUB_REPOSITORY\n');
  process.exit(2);
}
const number = Number(options.pr ?? process.env.PR_NUMBER);
const pr = await pullRequest(context, number);

const rollup = pr.commits.nodes[0]?.commit.statusCheckRollup?.state ?? 'NONE';
const openThreads = pr.reviewThreads.nodes.filter((thread) => !thread.isResolved).length;
const items = [
  { item: 'No merge conflict', done: pr.mergeable === 'MERGEABLE', detail: `${pr.mergeable} / ${pr.mergeStateStatus}` },
  { item: 'Checks green on the current head', done: rollup === 'SUCCESS', detail: rollup },
  { item: 'No unresolved review threads', done: openThreads === 0, detail: `${openThreads} open` },
  { item: 'Not a draft', done: !pr.isDraft, detail: pr.isDraft ? 'draft' : 'ready' },
];
const remaining = items.filter((entry) => !entry.done).length;

const lines = [
  `### Steward checklist — #${pr.number} ${pr.title}`,
  '',
  ...items.map((entry) => `- [${entry.done ? 'x' : ' '}] ${entry.item} (${entry.detail})`),
  '',
  remaining === 0 ? 'Ready for a human to review and merge. Agents never merge.' : `${remaining} item(s) need work before this is mergeable.`,
];
process.stdout.write(`${lines.join('\n')}\n`);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);

await writeResult(options.out, {
  skill: 'steward',
  tool: 'pr-state',
  ok: remaining === 0,
  metrics: { open_threads: openThreads, checklist_remaining: remaining },
  details: { pr: pr.number, items },
});
