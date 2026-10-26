#!/usr/bin/env node
/**
 * AUTHORIZE → EXECUTE → PROVE, walked through the console.
 *
 * `examples/approval-required-agent/run.js` drives the same workflow in one
 * process, against the gateway directly. This one drives it the way a
 * deployment actually works: over HTTP, through the control API's two
 * credentials, and through the console's own routes — so what it proves is not
 * only that the control path is correct but that the console an operator sits
 * in front of reports it correctly.
 *
 * It starts both servers in process on ephemeral ports, so there is nothing to
 * set up and nothing left running.
 *
 * Nine steps:
 *
 *   1. an agent attempts an action
 *   2. ARC Control evaluates it against policy
 *   3. the engine decides whether a human is required
 *   4. an authorized operator reviews the request in the console
 *   5. the operator records a decision
 *   6. the system decides whether execution proceeds
 *   7. execution evidence is recorded
 *   8. the operator reviews the evidence
 *   9. audit integrity is verified
 *
 * THIS IS A DEMONSTRATION. The connector effects are simulated: no money
 * moves and no issue is filed. Everything that decides whether they would is
 * the shipped implementation — the same gateway, policy engine, approval
 * engine, evidence builder and audit chain. A demo that faked the decision
 * would prove nothing, so this one fakes only the consequence.
 *
 * Run with:  npm run demo:console
 */
import { createControlApi, seedDemo } from '@arc-control/control-api';
import { createConsole } from '@arc-control/control-console';
import { verifyBundle } from '@arc-control/evidence';
import { digest } from '@arc-control/schemas';
import { MemoryStore } from '@arc-control/store';

const OPERATOR_TOKEN = 'demo-operator-token';
const OPERATOR_IDENTITY = 'cfo@example.com';
const OPERATOR_ROLES = ['finance-manager'];

let step = 0;

function heading(text) {
  step += 1;
  process.stdout.write(`\n${'─'.repeat(78)}\n${step}. ${text}\n${'─'.repeat(78)}\n`);
}

function say(text) {
  process.stdout.write(`   ${text}\n`);
}

function field(label, value) {
  process.stdout.write(`   ${String(label).padEnd(22)} ${value}\n`);
}

/** Fails loudly: a demonstration that quietly skips a step proves nothing. */
function check(condition, description) {
  if (!condition) throw new Error(`the demonstration did not hold: ${description}`);
  say(`✓ ${description}`);
}

async function main() {
  process.stdout.write(
    [
      '',
      '═'.repeat(78),
      ' ARC Control — console walkthrough   *** DEMONSTRATION ENVIRONMENT ***',
      '═'.repeat(78),
      '',
      ' Store      in memory; nothing is persisted and nothing is left running',
      ' Connector  simulated; no money moves, no issue is filed',
      ' Real       gateway, policy engine, approval engine, evidence, audit chain,',
      '            the control API over HTTP and the console over HTTP',
      '',
    ].join('\n'),
  );

  const store = new MemoryStore();
  const api = createControlApi({ store, operatorToken: OPERATOR_TOKEN, demoSeed: true });
  const { apiKeys } = await seedDemo(api.gateway);
  const apiAddress = await api.listen(0);
  const apiBase = `http://${apiAddress.host}:${apiAddress.port}`;

  const console_ = createConsole({
    apiBase,
    operatorToken: OPERATOR_TOKEN,
    operatorIdentity: OPERATOR_IDENTITY,
    operatorRoles: OPERATOR_ROLES,
  });
  const consoleAddress = await console_.listen(0);
  const consoleBase = `http://${consoleAddress.host}:${consoleAddress.port}`;

  field('control API', apiBase);
  field('console', consoleBase);
  field('operator', `${OPERATOR_IDENTITY} (roles: ${OPERATOR_ROLES.join(', ')})`);

  /** The agent surface: an agent key, and the one endpoint it may reach. */
  const act = async (apiKey, body) => {
    const response = await fetch(`${apiBase}/v1/actions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };

  /** The operator surface, as the console itself reads it. */
  const operatorGet = async (path) => {
    const response = await fetch(`${apiBase}${path}`, {
      headers: {
        authorization: `Bearer ${OPERATOR_TOKEN}`,
        'x-arc-operator': OPERATOR_IDENTITY,
        'x-arc-operator-roles': OPERATOR_ROLES.join(','),
      },
    });
    return { status: response.status, body: await response.json() };
  };

  /** The operator surface for writes. */
  const operatorPost = async (path, body) => {
    const response = await fetch(`${apiBase}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${OPERATOR_TOKEN}`,
        'x-arc-operator': OPERATOR_IDENTITY,
        'x-arc-operator-roles': OPERATOR_ROLES.join(','),
        'content-type': 'application/json',
      },
      body: JSON.stringify(body ?? {}),
    });
    return { status: response.status, body: await response.json() };
  };

  /** A console page, as a browser would fetch it. */
  const page = async (path) => {
    const response = await fetch(`${consoleBase}${path}`, { redirect: 'manual' });
    return { status: response.status, html: await response.text(), location: response.headers.get('location') };
  };

  /** A console form post, exactly as the Approve button submits it. */
  const submit = async (path, fields) => {
    const response = await fetch(`${consoleBase}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
      redirect: 'manual',
    });
    return { status: response.status, location: response.headers.get('location') };
  };

  try {
    // -- 1 -----------------------------------------------------------------
    heading('An agent attempts an action');

    const financeKey = apiKeys['finance-agent'];
    say('finance-agent asks to refund $1,840.00 to cus_Q41887.');
    say('It presents an agent API key, which permits exactly one thing: asking.');

    const attempt = await act(financeKey, {
      tool: 'stripe.refund',
      parameters: { customer: 'cus_Q41887', amount: 1840, reason: 'service outage credit' },
      intent: 'Three-day outage on the enterprise plan',
    });

    field('HTTP', attempt.status);
    check(attempt.status === 202, 'a held action is 202 Accepted — accepted, but incomplete');

    // -- 2 -----------------------------------------------------------------
    heading('ARC Control evaluates the action against policy');

    // The agent is told the effect, the policy and the rule — and nothing else.
    // `ActionResult.decision` carries no decision id: the full trace is an
    // operator read, reached through the evidence record the action produced.
    const told = attempt.body.decision;
    field('policy', told.policyId);
    field('rule', told.ruleId);
    field('effect', told.effect);
    field('reason', told.reason);

    check(told.policyId === 'FINANCE-004', 'the decision cites the policy that produced it');
    check(told.ruleId === 'needs-approval', 'and the specific rule within it');
    check(told.id === undefined, 'the agent is not handed the decision id; the trace is an operator read');

    const held = await operatorGet(`/v1/evidence/${attempt.body.evidenceId}`);
    const decision = held.body.decision;
    field('policy version', decision.policyVersion);
    field('evaluated in', `${decision.evaluationMs} ms`);

    const explained = await operatorGet(`/v1/decisions/${decision.id}`);
    const examined = explained.body.trace ?? [];
    say(`The engine examined ${examined.length} rule(s), in order:`);
    for (const rule of examined) {
      say(`   ${rule.matched ? '→' : ' '} ${rule.policyId}/${rule.ruleId} ${rule.matched ? `matched → ${rule.effect}` : 'did not match'}`);
    }
    check(examined.length >= 2, 'the trace records every rule examined, not only the one that fired');

    // -- 3 -----------------------------------------------------------------
    heading('The engine determines that a human is required');

    const requirement = (await operatorGet(`/v1/approvals/${attempt.body.approvalId}`)).body.requirement;
    field('effect', 'REQUIRE_APPROVAL');
    field('approvers', requirement.approvers.join(', '));
    field('minApprovals', requirement.minApprovals ?? 1);
    field('separation of duties', requirement.requireSeparationOfDuties ? 'on' : 'off');

    check(attempt.body.outcome === 'pending_approval', 'the action is held, not executed');
    check(
      Array.isArray(requirement.approvers) && requirement.approvers.length > 0,
      'the approval requirement came from the policy rule, not from the caller',
    );

    // -- 4 -----------------------------------------------------------------
    heading('An authorized operator reviews the request in the console');

    const queue = await page('/approvals');
    field('GET /approvals', queue.status);

    const pending = await operatorGet('/v1/approvals');
    const request = pending.body.approvals[0];

    check(queue.status === 200, 'the console serves the approvals queue');
    check(queue.html.includes('Refund'), 'the headline reads the recorded parameters back to the approver');
    check(queue.html.includes('cus_Q41887'), 'the parameters are shown as recorded');
    check(queue.html.includes('FINANCE-004'), 'the governing policy is cited on the page');
    check(
      queue.html.includes('Approving does not execute'),
      'the page states that approving is not itself the act',
    );
    check(
      queue.html.includes('the agent owner may not approve'),
      'separation of duties is stated where the vote is cast',
    );

    const mine = await page('/approvals?mine=true');
    check(
      mine.html.includes(request.id.slice(0, 16)),
      'the request appears under "assigned to me": the operator holds role:finance-manager',
    );

    const detail = await page(`/approvals/${request.id}`);
    check(detail.status === 200, 'the request has its own page');
    check(detail.html.includes('not consumed'), 'an approval that has not released an action says so');

    // -- 5 -----------------------------------------------------------------
    heading('The operator records a decision');

    say('Submitting the console\'s own Approve form.');
    const vote = await submit(`/approvals/${request.id}/vote`, {
      vote: 'approve',
      comment: 'Verified the three-day outage in the incident log. Credit approved.',
    });

    field('HTTP', vote.status);
    field('redirect', vote.location);
    check(vote.status === 303, 'a mutation redirects, so a reload cannot repeat the vote');

    const resolved = await operatorGet(`/v1/approvals/${request.id}`);
    field('status', resolved.body.status);
    field('voted by', resolved.body.votes.map((v) => `${v.approver} → ${v.vote}`).join(', '));
    check(resolved.body.status === 'approved', 'the approvals engine resolved the request');
    check(
      resolved.body.votes[0].approver === OPERATOR_IDENTITY,
      'the vote is recorded against the identity the console presented',
    );
    check(
      Boolean(resolved.body.votes[0].comment),
      'the operator’s reason is kept, not just their verdict',
    );

    // -- 6 -----------------------------------------------------------------
    heading('The system determines whether execution proceeds');

    say('Approving did not execute. Releasing the action is a separate, audited call,');
    say('which the console made after the vote resolved the request.');

    field('consumedAt', resolved.body.consumedAt ?? '(not consumed)');
    check(Boolean(resolved.body.consumedAt), 'the approval was consumed when it released the action');

    const replay = await fetch(`${apiBase}/v1/approvals/${request.id}/execute`, {
      method: 'POST',
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}`, 'x-arc-operator': OPERATOR_IDENTITY },
    });
    field('replay attempt', `HTTP ${replay.status}`);
    check(
      replay.status >= 400,
      'a consumed approval cannot authorize a second execution, even on a direct API call',
    );

    // -- 7 -----------------------------------------------------------------
    heading('Execution evidence is recorded');

    const evidenceList = await operatorGet('/v1/evidence?limit=10');
    const record = evidenceList.body.evidence.find((item) => item.approval?.id === request.id);

    field('evidence id', record.id);
    field('outcome', record.outcome);
    field('decision effect', record.decision.effect);
    field('execution', `${record.execution.status} in ${record.execution.durationMs} ms via ${record.execution.connector}`);
    field('integrityDigest', record.integrityDigest);

    check(record.outcome === 'executed', 'the action executed');
    check(record.approval.status === 'approved', 'the record binds the execution to the approval that authorized it');
    check(Boolean(record.decision.traceDigest), 'and to a digest of the decision trace');
    check(Boolean(record.execution.resultDigest), 'and to a digest of what the connector returned');

    // -- 8 -----------------------------------------------------------------
    heading('The operator reviews the evidence');

    const evidencePage = await page(`/evidence/${record.id}`);
    field('GET /evidence/:id', evidencePage.status);

    check(evidencePage.status === 200, 'the record has its own page');
    for (const stage of ['Requested', 'Decided', 'Approval', 'Executed']) {
      check(evidencePage.html.includes(stage), `the timeline shows ${stage}`);
    }
    check(
      evidencePage.html.includes('integrityDigest'),
      'the digests are on the page, so the record can be verified away from ARC Control',
    );
    check(
      evidencePage.html.includes(OPERATOR_IDENTITY),
      'the timeline names who approved it',
    );
    check(
      evidencePage.html.includes('advisory, not used by policy'),
      'the agent’s stated intent is shown, and labelled as the agent’s claim',
    );

    // -- 9 -----------------------------------------------------------------
    heading('Audit integrity is verified');

    const verification = await operatorGet('/v1/audit/verify');
    field('HTTP', verification.status);
    field('valid', verification.body.valid);
    field('records checked', verification.body.recordsChecked);
    field('head digest', verification.body.headDigest);
    field('head sequence', verification.body.headSequence);

    check(verification.status === 200, 'an intact chain verifies with 200');
    check(verification.body.valid === true, 'the chain is intact');

    const audit = await operatorGet('/v1/audit?limit=200&order=asc');
    const types = audit.body.records.map((r) => r.type);
    say('The lifecycle of this one action, in the chain:');
    for (const type of ['action.requested', 'approval.requested', 'approval.voted', 'approval.approved', 'action.executed', 'evidence.recorded']) {
      if (types.includes(type)) say(`   ${type}`);
    }
    check(types.includes('approval.voted'), 'the vote is in the audit log');
    check(types.includes('evidence.recorded'), 'and so is the evidence record');

    const auditPage = await page('/audit');
    check(auditPage.status === 200, 'the console serves the audit log');
    check(auditPage.html.includes('intact'), 'and reports the chain as intact');
    check(
      auditPage.html.includes('Checked against itself only'),
      'and states that self-verification does not detect truncation',
    );

    say('');
    say('Anchoring that head digest outside ARC Control is what closes the gap:');
    const anchored = await operatorGet(
      `/v1/audit/verify?headDigest=${encodeURIComponent(verification.body.headDigest)}&headSequence=${verification.body.headSequence}`,
    );
    field('checked against anchor', anchored.body.checkedAgainstExpectation);
    check(
      anchored.body.checkedAgainstExpectation === true,
      'verified against the anchored head, which would have detected truncation',
    );

    const tampered = await operatorGet('/v1/audit/verify?headSequence=9999');
    field('claimed head 9999', `HTTP ${tampered.status} · valid=${tampered.body.valid}`);
    check(tampered.status === 409, 'a chain that does not reach the anchored head answers 409');
    check(tampered.body.valid === false, 'and reports itself as broken');
    check(
      tampered.body.failures.some((f) => f.problem === 'truncated'),
      'naming truncation as the problem',
    );

    // -- 10 ----------------------------------------------------------------
    heading('Assurance assesses the controls against what actually happened');

    const seeded = await api.assurance.seedBaseline();
    field('controls installed', seeded.added.length + seeded.kept.length);

    const run = await operatorPost('/v1/assurance/runs', {});
    field('HTTP', run.status);
    field('run', run.body.run.id);
    field('window', `${run.body.run.window.from} → ${run.body.run.window.to}`);
    field('actions in window', run.body.run.window.actionsConsidered);
    field('totals', JSON.stringify(run.body.run.totals));

    check(run.status === 201, 'the run is created');
    check(run.body.assessments.length === 9, 'all nine baseline controls were evaluated');
    check(
      run.body.run.window.from < run.body.run.window.to,
      'and the run states the data window it covers, without which a status cannot be read',
    );

    say('');
    say('What each control established:');
    for (const assessment of run.body.assessments) {
      say(`  ${assessment.controlId}  ${String(assessment.status).padEnd(15)} ${assessment.summary.slice(0, 74)}`);
    }

    // This is the point of the whole module: the figures are not all green,
    // and the ones that are not green are not failures either.
    const byControl = new Map(run.body.assessments.map((a) => [a.controlId, a]));

    check(
      byControl.get('ARC-AI-003').status === 'pass',
      'nothing executed without a decision that permitted it — provable from the evidence, so it passes',
    );
    check(
      byControl.get('ARC-AI-004').status === 'pass',
      'the approval was cast before execution by someone holding the required role, so the approval control passes',
    );
    check(
      byControl.get('ARC-AI-006').status === 'not_assessable',
      'the chain is internally consistent but unanchored, which is NOT a pass: truncation cannot be ruled out',
    );
    check(
      byControl.get('ARC-AI-009').status === 'not_assessable',
      'whether a connector can be bypassed is outside ARC\u2019s records, so it reports that rather than guessing',
    );
    check(
      byControl.get('ARC-AI-001').status === 'fail',
      'the demo agents carry no governance record, and that is reported as a failure rather than waved through',
    );

    // -- 11 ----------------------------------------------------------------
    heading('A control ARC cannot decide takes a human attestation, recorded as such');

    const attested = await operatorPost('/v1/assurance/controls/ARC-AI-009/attest', {
      statement: 'Reviewed VPC routes and connector credential scopes: no agent-reachable credential permits direct access.',
      validForDays: 90,
      reference: 'SECOPS-1184',
    });
    field('HTTP', attested.status);
    field('attested by', attested.body.attestedBy);
    field('expires', attested.body.expiresAt);

    check(attested.status === 201, 'the attestation is recorded');
    check(attested.body.expiresAt > attested.body.attestedAt, 'and it expires: a statement nobody revisits is not assurance');

    const reassessed = await operatorPost('/v1/assurance/runs', { controlIds: ['ARC-AI-009'] });
    field('ARC-AI-009 now', reassessed.body.assessments[0].status);
    check(
      reassessed.body.assessments[0].status === 'attested',
      'the control now reports attested — a human statement, kept distinguishable from a check ARC performed',
    );

    // -- 12 ----------------------------------------------------------------
    heading('The evidence bundle verifies without ARC, and stops verifying if altered');

    const exported = await operatorPost('/v1/evidence/bundles', { scope: { kind: 'window' } });
    field('HTTP', exported.status);
    field('bundle', exported.body.manifest.id);
    field('counts', JSON.stringify(exported.body.manifest.counts));
    field('content digest', exported.body.manifest.contentDigest);

    check(exported.status === 201, 'the bundle is exported');

    const onDisk = JSON.parse(JSON.stringify(exported.body));
    const verified = verifyBundle(onDisk);
    field('verifies offline', verified.valid);
    field('records checked', verified.entriesChecked);

    check(verified.valid === true, 'and verifies from its own bytes, with no store, no network and no ARC instance');
    check(
      verified.limitations.some((l) => l.problem === 'chain_unanchored'),
      'reporting the missing external anchor as a limitation rather than folding it into the verdict',
    );

    // The tamper an attacker would actually attempt: not adding a record, but
    // rewriting one so the decision reads as having been within authority —
    // and recomputing the bundle digest so the obvious check passes.
    const rewritten = JSON.parse(JSON.stringify(exported.body));
    const target = rewritten.evidence[0];
    check(target !== undefined, 'the bundle carries at least one evidence record to rewrite');
    say(`Rewriting evidence ${target.record.id}:`);
    say(`  before  ${target.record.decision.effect} — ${target.record.decision.reason}`);
    target.record.decision.effect = 'ALLOW';
    target.record.decision.reason = 'within autonomous refund authority';
    target.record.approval = undefined;
    target.digest = digest(target.record);
    say(`  after   ${target.record.decision.effect} — ${target.record.decision.reason} (bundle digest recomputed)`);
    const caught = verifyBundle(rewritten);

    field('tampered verdict', caught.valid);
    check(caught.valid === false, 'a rewritten decision does not verify');
    check(
      caught.failures.some((f) => /integrity digest ARC Control stored with it/.test(f.detail)),
      'caught by the digest ARC wrote at storage time, even though the bundle digest was recomputed to match',
    );

    // -- 13 ----------------------------------------------------------------
    heading('The governance sections render, and say what they do not know');

    for (const path of ['/assurance', '/risks', '/findings', '/activity', '/settings']) {
      const rendered = await page(path);
      check(rendered.status === 200, `the console serves ${path}`);
    }

    const assurancePage = await page('/assurance');
    check(assurancePage.html.includes('Covering'), 'the assurance page states its data window');
    check(assurancePage.html.includes('Not assessable'), 'and shows unassessable controls as exactly that');
    check(
      !/\d+(\.\d+)?\s*%/.test(assurancePage.html.slice(assurancePage.html.indexOf('id="main"'))),
      'and reports no percentage: a single coverage figure invites a target, and a target invites gaming it',
    );

    // This walkthrough runs with the shared token and no identity provider,
    // so the page must give the blunt version. A deployment with single
    // sign-on configured gets the other wording, and the console test covers
    // both directions.
    const settings = await page('/settings');
    check(
      settings.html.replace(/\s+/g, ' ').includes('Operator identity is not authenticated in this deployment'),
      'and Settings states plainly that this deployment does not authenticate the operator identity',
    );

    const risks = await page('/risks');
    check(risks.html.includes('No risks are recorded'), 'an empty risk register says so rather than shipping a starter list');

    // -- for contrast --------------------------------------------------------
    // Not one of the nine steps: three more attempts, to show that a refusal is
    // recorded as durably as an execution, and that a declared tool is not a
    // grant.
    heading('For contrast: refusals, and what “declared” does not mean');

    const denied = await act(financeKey, {
      tool: 'stripe.refund',
      parameters: { customer: 'cus_Z99001', amount: 5000, reason: 'escalation' },
    });
    field('$5,000 refund', `${denied.body.outcome} — ${denied.body.decision.reason}`);
    check(denied.status === 200, 'a denial is a successful decision that happens to be "no", not a transport error');
    check(denied.body.outcome === 'denied', 'the hard ceiling refuses it, approved or otherwise');

    const protectedBranch = await act(apiKeys['engineering-agent'], {
      tool: 'github.create_issue',
      parameters: { repository: 'aking-beep/arc-control', title: 'Hotfix', branch: 'main' },
    });
    field('write to main', `${protectedBranch.body.outcome} — ${protectedBranch.body.decision.reason}`);
    check(protectedBranch.body.outcome === 'denied', 'a protected branch is refused');

    // finance-agent does not declare github.create_issue. It can still use it,
    // because declaredTools is what an agent says it needs, not what it may do:
    // GITHUB-002 matches github.* for every agent and its issues-and-prs rule
    // allows this. Policy decides; the declaration does not. This is the
    // distinction the Access page exists to keep visible.
    const financeAgent = (await operatorGet('/v1/agents')).body.agents.find((a) => a.name === 'finance-agent');
    check(
      !financeAgent.declaredTools.includes('github.create_issue'),
      'finance-agent does not declare github.create_issue',
    );

    const crossAgent = await act(financeKey, {
      tool: 'github.create_issue',
      parameters: { repository: 'aking-beep/arc-control', title: 'from the finance agent' },
    });
    field('finance-agent → github', `${crossAgent.body.outcome} — ${crossAgent.body.decision.reason}`);
    check(
      crossAgent.body.outcome === 'executed',
      'and uses it anyway: a declared tool is not a grant, and policy is what decides',
    );
    check(
      crossAgent.body.decision.policyId === 'GITHUB-002',
      'the policy that allowed it is named in the record, so the gap is visible rather than silent',
    );

    const accessPage_ = await page('/access');
    check(
      accessPage_.html.includes('not declared'),
      'and the Access page marks the pair as not declared while showing the policy in scope',
    );

    const evidenceAfter = await operatorGet('/v1/evidence?outcome=denied&limit=10');
    check(
      evidenceAfter.body.evidence.length >= 2,
      'every refusal left an evidence record: the attempt is itself the signal',
    );

    const overview = await page('/');
    check(overview.status === 200, 'the console serves the overview');
    check(
      overview.html.includes('Demonstration environment'),
      'and labels this as a demonstration, because the API reported the demo seed',
    );

    // -- done ---------------------------------------------------------------
    process.stdout.write(
      [
        '',
        '═'.repeat(78),
        ' AUTHORIZE → EXECUTE → PROVE → ASSURE',
        '═'.repeat(78),
        '',
        ' AUTHORIZE  policy decided, the rule is cited, a human was required and asked',
        ' EXECUTE    the approval released the action once, and was consumed doing it',
        ' PROVE      one evidence record per attempt, digests over each, in a chain',
        '            that verifies — and says what its verification does not cover',
        ' ASSURE     nine controls evaluated against those records, with three of',
        '            them reporting not assessable or attested rather than passing,',
        '            and a bundle that verifies with ARC switched off',
        '',
        ' Nothing here was persisted. To walk the same path in a browser, see',
        ' "Run the full stack" in README.md: export an operator token, start the API',
        ' with ARC_SEED_DEMO=true, start the console against it, and open',
        ' http://127.0.0.1:8788.',
        '',
      ].join('\n'),
    );
  } finally {
    await console_.close();
    await api.close();
    await store.close();
  }
}

main().catch((cause) => {
  process.stderr.write(`\narc-control: the walkthrough failed: ${cause instanceof Error ? cause.stack : String(cause)}\n`);
  process.exit(1);
});
