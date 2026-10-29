#!/usr/bin/env node
/**
 * Checks the delivery harness itself: the agents in `.claude/agents/`, the
 * skills in `.claude/skills/`, and the catalogue in `docs/harness/`.
 *
 * A harness that drifts is worse than none — an agent told to read a file
 * that was moved, or handed off to an agent that was renamed, fails quietly
 * and confidently. So the harness is held to the same standard as the code:
 *
 *   - every agent has valid frontmatter, a name matching its file, a
 *     description, tools from the allowed set, and the required sections
 *   - every skill has valid frontmatter and a name matching its directory
 *   - every repository path an agent or skill names exists
 *   - every agent named in a hand-off or routing table exists
 *   - every agent and skill is listed in the docs, and nothing listed is missing
 *   - every skill's maturity level is backed by what it claims: L2 needs a
 *     script, L3 needs that script run by a workflow, L4 needs outcome
 *     metrics with targets in tools/harness/metrics.json, from sources
 *     measure.mjs can collect, measured by a scheduled workflow
 *
 * Usage: node tools/harness/check-harness.mjs   (exits non-zero on any problem)
 */
import { access, readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, writeResult } from './lib.mjs';
import { SOURCES } from './measure.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ALLOWED_TOOLS = new Set(['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write']);
const READ_ONLY = new Set(['arc-architect', 'arc-security-reviewer', 'arc-verifier', 'arc-meridian-validator', 'arc-harness-analyst', 'arc-claims-auditor']);
const AGENT_SECTIONS = ['## Mission', '## Owns', '## Must', '## Must not', '## Done when', '## Hands off to', '## Report'];
const PATH = /`((?:packages|apps|connectors|docs|evals|tools|clients|schemas|examples|\.github|\.claude)\/[A-Za-z0-9_./-]+|CLAUDE\.md|CONTRIBUTING\.md|SECURITY\.md|README\.md)(?:#[^`]*)?`/g;

const problems = [];
const problem = (where, message) => problems.push(`${where}: ${message}`);

async function exists(path) {
  try {
    await access(join(ROOT, path));
    return true;
  } catch {
    return false;
  }
}

function frontmatter(text) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) return undefined;
  const fields = {};
  for (const line of match[1].split('\n')) {
    const colon = line.indexOf(':');
    if (colon > 0) fields[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return fields;
}

async function checkPaths(where, text) {
  for (const [, path] of text.matchAll(PATH)) {
    if (/[<>*$]/.test(path)) continue;
    if (!(await exists(path.replace(/\/$/, '')))) problem(where, `names \`${path}\`, which does not exist`);
  }
}

// --- agents ---------------------------------------------------------------
const agentDir = join(ROOT, '.claude', 'agents');
const agentFiles = (await readdir(agentDir)).filter((file) => file.endsWith('.md')).sort();
const agents = new Set(agentFiles.map((file) => file.slice(0, -3)));
const bodies = new Map();

for (const file of agentFiles) {
  const where = `.claude/agents/${file}`;
  const text = await readFile(join(agentDir, file), 'utf8');
  bodies.set(where, text);
  const fields = frontmatter(text);
  if (!fields) {
    problem(where, 'missing frontmatter');
    continue;
  }
  if (fields.name !== file.slice(0, -3)) problem(where, `frontmatter name "${fields.name}" does not match the file name`);
  if (!fields.description || fields.description.length < 40) problem(where, 'description missing or too short to route on');
  const tools = (fields.tools ?? '').split(',').map((tool) => tool.trim()).filter(Boolean);
  if (tools.length === 0) problem(where, 'no tools listed');
  for (const tool of tools) if (!ALLOWED_TOOLS.has(tool)) problem(where, `tool "${tool}" is not in the allowed set`);
  if (READ_ONLY.has(fields.name) && (tools.includes('Edit') || tools.includes('Write'))) {
    problem(where, 'a read-only agent must not have Edit or Write');
  }
  for (const section of AGENT_SECTIONS) if (!text.includes(`\n${section}\n`)) problem(where, `missing section "${section}"`);
}

// --- skills ---------------------------------------------------------------
const skillDir = join(ROOT, '.claude', 'skills');
const skills = new Map();
for (const name of (await readdir(skillDir)).sort()) {
  const where = `.claude/skills/${name}/SKILL.md`;
  let text;
  try {
    text = await readFile(join(skillDir, name, 'SKILL.md'), 'utf8');
  } catch {
    problem(`.claude/skills/${name}`, 'no SKILL.md');
    continue;
  }
  bodies.set(where, text);
  const fields = frontmatter(text);
  if (!fields) {
    problem(where, 'missing frontmatter');
    continue;
  }
  if (fields.name !== name) problem(where, `frontmatter name "${fields.name}" does not match the directory`);
  if (!fields.description || fields.description.length < 40) problem(where, 'description missing or too short to route on');
  skills.set(name, text);
}

// --- cross references -----------------------------------------------------
for (const [where, text] of bodies) {
  await checkPaths(where, text);
  for (const [, name] of text.matchAll(/`(arc-[a-z-]+)`/g)) {
    if (!agents.has(name)) problem(where, `refers to agent \`${name}\`, which does not exist`);
  }
}

const claude = await readFile(join(ROOT, 'CLAUDE.md'), 'utf8').catch(() => undefined);
if (!claude) problem('CLAUDE.md', 'missing');
else await checkPaths('CLAUDE.md', claude);

// --- catalogue ------------------------------------------------------------
const agentsDoc = await readFile(join(ROOT, 'docs', 'harness', 'AGENTS.md'), 'utf8').catch(() => '');
const skillsDoc = await readFile(join(ROOT, 'docs', 'harness', 'SKILLS.md'), 'utf8').catch(() => '');
for (const doc of ['README.md', 'AGENTS.md', 'SKILLS.md', 'CLIENTS.md']) {
  const text = await readFile(join(ROOT, 'docs', 'harness', doc), 'utf8').catch(() => undefined);
  if (text === undefined) problem(`docs/harness/${doc}`, 'missing');
  else await checkPaths(`docs/harness/${doc}`, text);
}
for (const name of agents) if (!agentsDoc.includes(`\`${name}\``)) problem('docs/harness/AGENTS.md', `does not list agent \`${name}\``);
for (const [, name] of agentsDoc.matchAll(/^\| `(arc-[a-z-]+)` \|/gm)) {
  if (!agents.has(name)) problem('docs/harness/AGENTS.md', `lists agent \`${name}\`, which has no definition`);
}

// Skill maturity: | `name` | L<n> | ... | `<evidence>` |
const workflowDir = join(ROOT, '.github', 'workflows');
const workflows = new Map();
for (const file of await readdir(workflowDir)) workflows.set(file, await readFile(join(workflowDir, file), 'utf8'));
const runByWorkflow = (text) => [...workflows.values()].some((body) => body.includes(text));

const definitions = JSON.parse(await readFile(join(ROOT, 'tools', 'harness', 'metrics.json'), 'utf8'));
const OPS = new Set(['>=', '<=', '==']);
const metricIds = new Set();
for (const metric of definitions.metrics) {
  const where = `tools/harness/metrics.json ${metric.id ?? '(no id)'}`;
  if (metricIds.has(metric.id)) problem(where, 'duplicate metric id');
  metricIds.add(metric.id);
  if (!SOURCES.includes(metric.source)) problem(where, `source "${metric.source}" is not one measure.mjs collects (${SOURCES.join(', ')})`);
  if (!metric.key) problem(where, 'missing key');
  if (!OPS.has(metric.target?.op) || typeof metric.target?.value !== 'number') problem(where, 'target needs an op (>=, <=, ==) and a numeric value');
  if (!metric.description) problem(where, 'missing description');
  if (metric.skill !== 'harness' && !skills.has(metric.skill)) problem(where, `skill "${metric.skill}" does not exist`);
}
const scheduled = [...workflows.entries()].find(([, body]) => body.includes('tools/harness/measure.mjs') && /\bschedule:/.test(body));

const levels = new Map();
for (const [, name, level, evidence] of skillsDoc.matchAll(/^\| `([a-z-]+)` \| L([1-4]) \|[^\n]*\| `([^`]+)` \|$/gm)) {
  levels.set(name, { level: Number(level), evidence });
}
for (const name of skills.keys()) {
  const claim = levels.get(name);
  if (!claim) {
    problem('docs/harness/SKILLS.md', `has no maturity row for skill \`${name}\``);
    continue;
  }
  if (claim.level >= 2) {
    try {
      if (!(await stat(join(ROOT, claim.evidence))).isFile()) throw new Error();
    } catch {
      problem('docs/harness/SKILLS.md', `skill \`${name}\` claims L${claim.level} but its script \`${claim.evidence}\` does not exist`);
    }
  }
  if (claim.level >= 3 && !runByWorkflow(claim.evidence)) {
    problem('docs/harness/SKILLS.md', `skill \`${name}\` claims L${claim.level} but no workflow in .github/workflows runs \`${claim.evidence}\``);
  }
  if (claim.level >= 4) {
    const measured = definitions.metrics.filter((metric) => metric.skill === name);
    if (measured.length === 0) problem('docs/harness/SKILLS.md', `skill \`${name}\` claims L4 but has no metric in tools/harness/metrics.json`);
    if (!scheduled) problem('docs/harness/SKILLS.md', `skill \`${name}\` claims L4 but no scheduled workflow runs tools/harness/measure.mjs`);
    for (const metric of measured) {
      if (!skillsDoc.includes(`\`${metric.id}\``)) problem('docs/harness/SKILLS.md', `does not list metric \`${metric.id}\` for skill \`${name}\``);
    }
  }
}
for (const name of levels.keys()) if (!skills.has(name)) problem('docs/harness/SKILLS.md', `lists skill \`${name}\`, which has no definition`);

// --- report ---------------------------------------------------------------
await writeResult(parseArgs().options.out, {
  skill: 'harness',
  tool: 'check-harness',
  ok: problems.length === 0,
  metrics: {
    agents: agents.size,
    skills: skills.size,
    problems: problems.length,
    skills_at_l4: [...levels.values()].filter((claim) => claim.level === 4).length,
    metrics_defined: definitions.metrics.length,
  },
  details: { problems },
});
if (problems.length > 0) {
  for (const line of problems) process.stdout.write(`FAIL ${line}\n`);
  process.stdout.write(`\n${problems.length} harness problem(s)\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Harness OK: ${agents.size} agent(s), ${skills.size} skill(s), ${[...levels.values()].filter((claim) => claim.level === 4).length} at L4, ${definitions.metrics.length} metric(s); catalogue and references consistent\n`,
  );
}
