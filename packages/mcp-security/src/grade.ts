import type { FindingSeverity, ScanReport } from './manifest.js';

export type McpGrade = 'A' | 'B' | 'C' | 'D' | 'F';

export const GRADES: readonly McpGrade[] = ['A', 'B', 'C', 'D', 'F'];

/** Points a finding costs, by severity. */
const DEDUCTION: Record<FindingSeverity, number> = { info: 0, low: 3, medium: 10, high: 25, critical: 50 };

export interface McpGradeResult {
  readonly grade: McpGrade;
  /** 0-100. */
  readonly score: number;
  /** Why the grade is what it is, in one line. */
  readonly basis: string;
}

/**
 * Grades a scan.
 *
 * A score out of 100, less a deduction per finding, mapped to the scanner's
 * letter bands. Two caps keep a long list of clean tools from averaging away
 * a single bad one: any critical finding grades F, any high finding grades no
 * better than D. A grade is a floor for registration, not a certificate — a
 * server can grade A and still be malicious in ways no static check sees.
 */
export function gradeScan(report: ScanReport): McpGradeResult {
  const score = Math.max(0, 100 - report.findings.reduce((total, finding) => total + DEDUCTION[finding.severity], 0));
  const critical = report.findings.filter((finding) => finding.severity === 'critical').length;
  const high = report.findings.filter((finding) => finding.severity === 'high').length;

  const banded: McpGrade = score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 60 ? 'D' : 'F';
  const grade: McpGrade = critical > 0 ? 'F' : high > 0 && compareGrades(banded, 'D') > 0 ? 'D' : banded;

  const basis =
    critical > 0
      ? `${critical} critical finding(s)`
      : high > 0
        ? `${high} high finding(s), score ${score}`
        : `score ${score} from ${report.findings.length} finding(s)`;
  return { grade, score, basis };
}

/** Positive when `left` is better than `right`. Anything unrecognised compares as F. */
export function compareGrades(left: string, right: string): number {
  const rank = (grade: string): number => {
    const index = (GRADES as readonly string[]).indexOf(grade);
    return index === -1 ? GRADES.length - 1 : index;
  };
  return rank(right) - rank(left);
}

export function isGrade(value: unknown): value is McpGrade {
  return typeof value === 'string' && (GRADES as readonly string[]).includes(value);
}
