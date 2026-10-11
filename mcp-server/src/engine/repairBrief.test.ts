import { describe, expect, it } from 'vitest';
import {
  buildRepairBrief,
  failureSignature,
  failureSummary,
  renderPriorAttempt,
  renderRepairBrief,
  trailingRepeatCount,
} from './repairBrief.js';
import type { ReviewResult, TaskAttempt, TaskNode, TestResult } from './types.js';

function node(attempts: Partial<TaskAttempt>[] = []): TaskNode {
  return {
    id: 'core',
    title: 'Core',
    description: '',
    acceptanceCriteria: [],
    dependsOn: [],
    targetGlobs: [],
    riskTags: [],
    riskClass: 'low',
    phase: 'running',
    attempts: attempts.map((attempt, index) => ({
      attempt: index + 1,
      outcome: 'rework',
      rationale: '',
      evidenceRefs: [],
      at: '2026-10-05T00:00:00.000Z',
      fingerprint: `f${index}`,
      repeated: false,
      ...attempt,
    })),
  };
}

const NO_REVIEW: ReviewResult = { taskId: 'core', findings: [] };

function failing(output: string): TestResult {
  return { ran: true, passed: false, newFailures: ['unit'], checks: [{ categoryId: 'unit', status: 'new', output }] };
}

describe('failureSignature', () => {
  it('matches the same failure across different timings, addresses and line numbers', () => {
    const first = failing('E   ValueError: bad at 0x7f12\nFAILED tests/test_a.py:12 - boom\n1 failed in 0.53s');
    const second = failing('E   ValueError: bad at 0x9a00\nFAILED tests/test_a.py:40 - boom\n1 failed in 2.10s');
    expect(failureSignature(first, NO_REVIEW)).toBe(failureSignature(second, NO_REVIEW));
  });

  it('differs when the error differs', () => {
    expect(failureSignature(failing('E   ValueError: a'), NO_REVIEW))
      .not.toBe(failureSignature(failing('E   KeyError: b'), NO_REVIEW));
  });

  it('falls back to the blocking reviewers, not their prose, when every check passed', () => {
    const review = (rationale: string): ReviewResult => ({
      taskId: 'core',
      findings: [{ reviewerId: 'opposition', verdict: 'reject', rationale }],
    });
    const clean: TestResult = { ran: true, passed: true };
    expect(failureSignature(clean, review('one wording'))).toBe(failureSignature(clean, review('another')));
    expect(failureSignature(clean, NO_REVIEW)).toBe('');
  });
});

describe('trailingRepeatCount', () => {
  it('counts consecutive judged attempts with the latest signature, skipping transient ones', () => {
    const graphNode = node([
      { failureSignature: 'x' },
      { failureSignature: 'y' },
      { failureSignature: 'y' },
      { transient: true, rationale: 'Execution failed: timeout' },
      { failureSignature: 'y' },
    ]);
    expect(trailingRepeatCount(graphNode)).toBe(3);
  });
});

describe('renderPriorAttempt', () => {
  it('shows edits as find and replace, and stays within its budget', () => {
    const rendered = renderPriorAttempt([
      { op: 'edit', path: 'src/core.py', find: 'return a', replace: 'return a + b' },
      { op: 'write', path: 'src/big.py', content: 'x'.repeat(20_000) },
      { op: 'delete', path: 'src/old.py' },
    ], 2_000);
    expect(rendered).toContain('edit src/core.py');
    expect(rendered).toContain('return a + b');
    expect(rendered).toContain('delete src/old.py');
    expect(rendered.length).toBeLessThanOrEqual(2_000);
  });
});

describe('buildRepairBrief and renderRepairBrief', () => {
  const review: ReviewResult = {
    taskId: 'core',
    findings: [
      { reviewerId: 'a', verdict: 'approve', rationale: 'fine' },
      { reviewerId: 'b', verdict: 'flag', rationale: 'no test for empty input', evidenceRefs: ['tests/test_core.py'] },
      { reviewerId: 'c', verdict: 'reject', rationale: 'wrong units' },
    ],
    meta: { requiredChanges: ['Return dpa-barns.'] },
  };

  it('carries flags and rejects with evidence, the review\'s own changes, the prior code and history', () => {
    const brief = buildRepairBrief({
      node: node([{ failureSignature: 's', failureSummary: 'checks failing: unit (new) — E KeyError: fe' }, {}]),
      attemptNumber: 2,
      maxAttempts: 8,
      test: failing('E   ValueError: units'),
      review,
      fileOps: [{ op: 'edit', path: 'src/core.py', find: 'a', replace: 'b' }],
      repeatCount: 1,
    });
    const text = renderRepairBrief(brief);

    expect(text).toContain('attempt 2 of at most 8');
    expect(text).toContain('has been reverted');
    expect(text).toContain('[unit] passed before this change and fails with it');
    expect(text).toContain('E   ValueError: units');
    expect(text).toContain('b (flag): no test for empty input [evidence: tests/test_core.py]');
    expect(text).toContain('c (reject): wrong units');
    expect(text).not.toContain('fine');
    expect(text).toContain('- Return dpa-barns.');
    expect(text).toContain('attempt 1 (rework): checks failing: unit (new) — E KeyError: fe');
    expect(text).toContain('edit src/core.py');
    expect(text).not.toContain('same error');
  });

  it('says which required checks have no tests yet, without calling them failing', () => {
    const brief = buildRepairBrief({
      node: node(), attemptNumber: 1, maxAttempts: 8, test: { ran: true, passed: true, checks: [], emptyChecks: ['unit'] },
      review: NO_REVIEW, fileOps: [], repeatCount: 0,
    });
    const text = renderRepairBrief(brief);
    expect(text).toContain('No tests exist yet in: unit.');
    expect(text).not.toContain('Failing checks');
  });

  it('warns when attempts keep failing the same way', () => {
    const brief = buildRepairBrief({
      node: node(), attemptNumber: 3, maxAttempts: 8, test: failing('E x'), review: NO_REVIEW, fileOps: [], repeatCount: 3,
    });
    expect(renderRepairBrief(brief)).toContain('The last 3 attempts failed with the same error');
  });

  it('clips each check output', () => {
    const brief = buildRepairBrief({
      node: node(), attemptNumber: 1, maxAttempts: 8, test: failing(`${'noise\n'.repeat(2_000)}E   ValueError: tail`),
      review: NO_REVIEW, fileOps: [], repeatCount: 1,
    });
    expect(brief.checks[0].output!.length).toBeLessThanOrEqual(1_800);
    expect(brief.checks[0].output).toContain('E   ValueError: tail');
  });
});

describe('failureSummary', () => {
  it('names the failing checks and the first error line', () => {
    expect(failureSummary(failing('collected 1 item\nE   ValueError: units\nE   more'), 'Rejected.'))
      .toBe('checks failing: unit (new) — E   ValueError: units');
  });
});

describe('repair brief for a kept attempt', () => {
  it('tells a retry its files are kept to edit, and shows a task-sized attempt whole', () => {
    // 12,600 characters across three files: managerial composition's real attempt size, which the
    // old 3,000-character budget cut to a head and tail per file.
    const fileOps = [
      { op: 'write' as const, path: 'pkg/__init__.py', content: 'x'.repeat(600) },
      { op: 'write' as const, path: 'pkg/composition.py', content: 'y'.repeat(6_400) },
      { op: 'write' as const, path: 'tests/test_composition.py', content: 'z'.repeat(5_600) },
    ];
    const brief = buildRepairBrief({
      node: node(), attemptNumber: 3, maxAttempts: 8, test: failing('E   AssertionError'),
      review: NO_REVIEW, fileOps, repeatCount: 0, retainedPaths: fileOps.map((op) => op.path),
    });
    const text = renderRepairBrief(brief);

    expect(text).toContain('kept for you as your starting point');
    expect(text).toContain('pkg/composition.py, tests/test_composition.py');
    expect(text).toContain('edit it rather than re-sending it');
    expect(text).not.toContain('has been reverted');
    expect(text).not.toMatch(/chars omitted/);
    expect(text).toContain('z'.repeat(5_600));
  });

  it('still says the attempt was reverted when nothing was kept', () => {
    const brief = buildRepairBrief({
      node: node(), attemptNumber: 1, maxAttempts: 8, test: failing('E   boom'), review: NO_REVIEW,
      fileOps: [{ op: 'write', path: 'a.py', content: 'a' }], repeatCount: 0,
    });
    expect(renderRepairBrief(brief)).toContain('Every file it changed has been reverted');
  });
});
