import { describe, expect, it } from 'vitest';
import { minorityReportsFrom, retainMinorityReports } from './dissent.js';
import type { Finding } from '../../engine/packets.js';
import type { ReviewResult, TestResult } from '../../engine/types.js';

const passing: TestResult = { ran: true, passed: true, command: 'npm test', output: 'ok' };
const failing: TestResult = { ran: true, passed: false, command: 'npm test', output: 'no' };

const review = (
  verdicts: { reviewerId: string; verdict: 'approve' | 'reject' | 'flag'; rationale: string }[],
  testResult: TestResult = passing,
): ReviewResult => ({
  taskId: 't1',
  findings: verdicts.map((v) => ({ ...v, evidenceRefs: ['src/a.ts'] })),
  testResult,
});

const input = (over: Partial<Parameters<typeof minorityReportsFrom>[0]> = {}) => ({
  taskId: 't1',
  nodeTitle: 'Add the profile endpoint',
  approved: true,
  review: review([{ reviewerId: 'frontend-2', verdict: 'flag' as const, rationale: 'The error path is untested.' }]),
  implementerId: 'backend-1',
  ...over,
});

function finding(over: Partial<Finding>): Finding {
  return {
    id: 'f1',
    source: 'reviewer',
    summary: 'A summary.',
    evidenceRefs: [],
    disposition: 'unresolved',
    dispositionRationale: 'Because.',
    ...over,
  } as Finding;
}

describe('objections that survived a decision to proceed', () => {
  it('preserves a flag on work the council took anyway', () => {
    const reports = minorityReportsFrom(input());
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ minority: true, source: 'frontend-2', taskId: 't1', disposition: 'deferred' });
    expect(reports[0].summary).toContain('The error path is untested.');
    expect(reports[0].owner).toBe('frontend-2');
    expect(reports[0].returnCondition).toBeTruthy();
  });

  // A rejection means the dissent carried. Recording it again as a minority view would describe a
  // reviewer who won as one who lost.
  it('raises nothing when the objection already decided the outcome', () => {
    expect(minorityReportsFrom(input({ approved: false }))).toEqual([]);
  });

  it('raises nothing when nobody objected', () => {
    const agreed = review([{ reviewerId: 'frontend-2', verdict: 'approve', rationale: 'Fine.' }]);
    expect(minorityReportsFrom(input({ review: agreed }))).toEqual([]);
  });

  it('preserves every dissenting voice, not just the first', () => {
    const split = review([
      { reviewerId: 'frontend-2', verdict: 'approve', rationale: 'Fine.' },
      { reviewerId: 'security-1', verdict: 'reject', rationale: 'The token is logged.' },
      { reviewerId: 'testing-1', verdict: 'flag', rationale: 'No regression test.' },
    ]);
    const reports = minorityReportsFrom(input({ review: split }));
    expect(reports.map((r) => r.source)).toEqual(['security-1', 'testing-1']);
  });

  // Section 11: where alternatives are equivalent the council takes the simpler reversible option
  // and records the minority reasoning.
  it('cites the reversible-option rule when the council proceeded on passing evidence', () => {
    expect(minorityReportsFrom(input()).at(0)?.dispositionRationale).toContain('simpler');
    const overFailure = minorityReportsFrom(input({ review: review([{ reviewerId: 'a', verdict: 'flag', rationale: 'r' }], failing) }));
    expect(overFailure.at(0)?.dispositionRationale).not.toContain('simpler');
  });

  it('reaches the delivery packet as a minority report, which is the whole point', () => {
    // DeliveryPacket.minorityReports is findings.filter(f => f.minority).
    expect(minorityReportsFrom(input()).every((r) => r.minority === true)).toBe(true);
  });
});

describe('dissent that disposition dropped', () => {
  it('is restored, without touching the disposition itself', () => {
    const before = [finding({ id: 'f1', minority: true })];
    const after = [finding({ id: 'f1', disposition: 'rejected', dispositionRationale: 'Not a defect.' })];

    const result = retainMinorityReports(before, after);

    expect(result.retained).toEqual(['f1']);
    expect(result.findings[0].minority).toBe(true);
    // The decision stands; only the record of who objected is restored.
    expect(result.findings[0].disposition).toBe('rejected');
    expect(result.findings[0].dispositionRationale).toContain('Not a defect.');
    expect(result.findings[0].dispositionRationale).toContain('article 9');
  });

  it('leaves a record that kept its dissent exactly as it was', () => {
    const findings = [finding({ id: 'f1', minority: true }), finding({ id: 'f2' })];
    const result = retainMinorityReports(findings, findings);
    expect(result.retained).toEqual([]);
    expect(result.findings).toBe(findings);
  });
});
