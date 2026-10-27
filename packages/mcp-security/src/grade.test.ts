import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkConformance } from './conformance.js';
import { compareGrades, gradeScan } from './grade.js';
import type { Finding, ScanReport } from './manifest.js';
import { scanManifest } from './scanner.js';

function report(severities: Finding['severity'][]): ScanReport {
  return {
    server: 's',
    endpoint: 'https://s.example.com',
    scannedAt: '2026-10-27T00:00:00Z',
    toolsScanned: 1,
    findings: severities.map((severity, index) => ({ id: `X-${index}`, severity, title: 't', detail: 'd', remediation: 'r' })),
    highestSeverity: 'info',
    passed: true,
  };
}

describe('gradeScan', () => {
  it('grades a clean scan A', () => {
    assert.deepEqual(gradeScan(report([])).grade, 'A');
  });

  it('grades any critical finding F, however clean the rest', () => {
    assert.equal(gradeScan(report(['critical'])).grade, 'F');
  });

  it('caps a high finding at D', () => {
    assert.equal(gradeScan(report(['high'])).grade, 'D');
  });

  it('bands by score below the caps', () => {
    assert.equal(gradeScan(report(['medium'])).grade, 'A');
    assert.equal(gradeScan(report(['medium', 'medium'])).grade, 'B');
    assert.equal(gradeScan(report(['medium', 'medium', 'medium'])).grade, 'C');
    assert.equal(gradeScan(report(['medium', 'medium', 'medium', 'medium', 'medium'])).grade, 'F');
    assert.equal(gradeScan(report(['info', 'info', 'info'])).grade, 'A');
  });

  it('orders grades, and treats an unknown grade as F', () => {
    assert.ok(compareGrades('A', 'B') > 0);
    assert.ok(compareGrades('D', 'C') < 0);
    assert.equal(compareGrades('Z', 'F'), 0);
  });
});

describe('checkConformance', () => {
  const base = { name: 's', endpoint: 'https://s.example.com', protocolVersion: '2025-06-18' };

  it('flags a missing protocol version, a non-portable name, a non-object schema and an unannotated write', () => {
    const findings = checkConformance({
      name: 's',
      endpoint: 'https://s.example.com',
      tools: [
        { name: 'bad name!', description: 'x', inputSchema: { type: 'object' } },
        { name: 'lookup', description: 'x', inputSchema: { type: 'string' } },
        { name: 'delete_record', description: 'x', inputSchema: { type: 'object' } },
      ],
    });
    assert.deepEqual(findings.map((finding) => finding.id).sort(), ['MCP-CNF-001', 'MCP-CNF-002', 'MCP-CNF-003', 'MCP-CNF-004']);
  });

  it('accepts an annotated destructive tool and a read-only one', () => {
    const findings = checkConformance({
      ...base,
      tools: [
        { name: 'delete_record', inputSchema: { type: 'object' }, annotations: { destructiveHint: true } },
        { name: 'update_view', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
      ],
    });
    assert.deepEqual(findings, []);
  });

  it('runs as part of every scan', () => {
    const scan = scanManifest({ name: 's', endpoint: 'https://s.example.com', tools: [] });
    assert.ok(scan.findings.some((finding) => finding.id === 'MCP-CNF-001'));
  });
});
