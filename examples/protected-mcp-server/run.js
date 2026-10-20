#!/usr/bin/env node
/**
 * Putting ARC Control in front of an MCP server.
 *
 * MCP is where enterprise agents are gaining the ability to act, and the
 * protocol carries no notion of authorization: a client that can reach a
 * server can call anything the server advertises. ARC Control in front turns
 * that tool list from a set of capabilities into a set of *requests*.
 *
 * The example walks the sequence an operator actually goes through:
 *
 *   1. Scan the server before exposing it to anything.
 *   2. Register only the tools that passed, with explicit contracts.
 *   3. Write policy, and watch the gateway enforce it.
 *   4. Detect the server changing a description after it was approved.
 *
 * Run with:  node examples/protected-mcp-server/run.js
 */
import { Gateway } from '@arc-control/gateway';
import { MemoryStore } from '@arc-control/store';
import { McpConnector } from '@arc-control/connector-mcp';
import { formatReport } from '@arc-control/mcp-security';
import { createMockMcpServer } from './mock-mcp-server.js';

const OPERATOR = { identifier: 'platform@example.com', via: 'system' };

function heading(text) {
  process.stdout.write(`\n${'─'.repeat(72)}\n${text}\n${'─'.repeat(72)}\n`);
}

function line(label, value) {
  process.stdout.write(`  ${label.padEnd(14)} ${value}\n`);
}

async function main() {
  const vendor = createMockMcpServer();
  const port = await vendor.listen();
  const endpoint = `http://127.0.0.1:${port}/mcp`;

  try {
    // --- 1. scan before exposing -----------------------------------------

    heading('Step 1 — scan the server before any agent can reach it');

    const connector = new McpConnector({ endpoint, name: 'vendor-docs' });
    const { manifest, report } = await connector.connect();

    process.stdout.write(`\n${formatReport(report)}\n`);

    line('Verdict', report.passed ? 'safe to expose' : 'DO NOT EXPOSE as advertised');
    process.stdout.write(
      '\n  The poisoned description is aimed at the agent, not the operator. No amount\n' +
        '  of argument inspection would catch it, because the attack is in the metadata\n' +
        '  the agent reads before it ever calls anything.\n',
    );

    // --- 2. register only what passed ------------------------------------

    heading('Step 2 — register only the tools that passed, with explicit contracts');

    const rejected = new Set(
      report.findings
        .filter((finding) => finding.tool && (finding.severity === 'critical' || finding.severity === 'high'))
        .map((finding) => finding.tool),
    );

    const gateway = new Gateway({ store: new MemoryStore() });
    gateway.addConnector(connector);

    const candidates = connector.toToolRegistrations({ prefix: 'vendor' });
    const registered = [];

    for (const candidate of candidates) {
      const remote = candidate.connectorConfig.mcpTool;
      if (rejected.has(remote)) {
        line('rejected', `${candidate.name}  ${manifestReason(report, remote)}`);
        continue;
      }
      const tool = await gateway.admin.registerTool(candidate, OPERATOR);
      registered.push(tool);
      line('registered', `${tool.name}  (${tool.effect}, ${tool.riskTier} risk)`);
    }

    process.stdout.write(
      '\n  Unregistered tools are not merely hidden: the gateway refuses an action\n' +
        '  naming a tool it does not know, before policy is ever consulted.\n',
    );

    // --- 3. policy decides ------------------------------------------------

    heading('Step 3 — policy decides every call');

    await gateway.admin.publishPolicy(
      {
        id: 'VENDOR-001',
        version: 1,
        name: 'Vendor MCP access',
        description: 'Research agents may search vendor documentation. Anything else needs a human.',
        enabled: true,
        match: { systems: ['vendor'] },
        rules: [
          {
            id: 'reads-are-fine',
            when: { eq: ['$.tool.name', 'vendor.search_docs'] },
            effect: 'ALLOW',
            reason: 'searching vendor documentation is read-only',
          },
          {
            id: 'no-secret-hunting',
            when: { matches: ['$.action.parameters.query', '(?i)(password|api[_\\s-]?key|credential|secret)'] },
            effect: 'DENY',
            reason: 'the query reads as an attempt to retrieve credentials',
          },
        ],
        fallback: {
          effect: 'REQUIRE_APPROVAL',
          reason: 'unclassified vendor tool call needs a human',
        },
      },
      OPERATOR,
    );

    const agent = await gateway.admin.registerAgent(
      { name: 'research-agent', owner: 'research@example.com', roles: ['research'] },
      OPERATOR,
    );
    const { apiKey } = await gateway.admin.issueKey(agent.id, OPERATOR);

    const search = await gateway.handle(apiKey, {
      tool: 'vendor.search_docs',
      parameters: { query: 'rate limits' },
    });
    line('search_docs', `${search.decision.effect} → ${search.outcome}`);
    line('result', JSON.stringify(search.result));

    try {
      await gateway.handle(apiKey, {
        tool: 'vendor.export_report',
        parameters: { reportId: 'r_1' },
      });
    } catch (error) {
      line('export_report', `refused — ${error.message}`);
    }

    // --- 4. the server changes after approval -----------------------------

    heading('Step 4 — the server rewrites an approved description');

    process.stdout.write(
      '\n  search_docs passed review and is in production. The vendor now changes its\n' +
        '  description. MCP gives the client no notification that this happened.\n\n',
    );

    vendor.poisonSearchDocs();

    const drift = await connector.checkForDrift();
    line('Pinned', drift.expectedDigest);
    line('Observed', drift.observedDigest);
    line('Modified', drift.modified.join(', ') || '—');
    for (const finding of drift.findings) {
      line(finding.severity.toUpperCase(), `${finding.id} ${finding.title}`);
    }

    process.stdout.write('\n  The next call is refused, because the tool is no longer the one that was approved:\n\n');

    const after = await gateway.handle(apiKey, {
      tool: 'vendor.search_docs',
      parameters: { query: 'rate limits' },
    });
    line('search_docs', `${after.decision.effect} → ${after.outcome}`);
    line('error', after.error ? `${after.error.code}: ${after.error.message}` : '—');
    line('Evidence', after.evidenceId);

    // --- the record ------------------------------------------------------

    heading('The record');
    const chain = await gateway.audit.verify();
    line('Audit chain', `${chain.valid ? 'intact' : 'BROKEN'} — ${chain.recordsChecked} record(s)`);
    line('Registered', `${registered.length} of ${candidates.length} advertised tools`);
    line('Evidence', `${(await gateway.listEvidence()).length} record(s)`);
    process.stdout.write('\n');
  } finally {
    await vendor.close();
  }
}

function manifestReason(report, tool) {
  const finding = report.findings.find(
    (candidate) => candidate.tool === tool && (candidate.severity === 'critical' || candidate.severity === 'high'),
  );
  return finding ? `${finding.id} ${finding.title}` : 'failed the scan';
}

main().catch((cause) => {
  process.stderr.write(`\n${cause instanceof Error ? cause.stack : String(cause)}\n`);
  process.exit(1);
});
