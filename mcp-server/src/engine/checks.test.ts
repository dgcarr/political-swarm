import { describe, it, expect } from 'vitest';
import { attributeAgainstBaseline, blockingFailures, executedNothing, toTaskTestResult, toTestResult } from './checks.js';
import type { CheckRunRecord } from './packets.js';
import type { ChecksConfig } from '../util/config.js';

const CHECKS: ChecksConfig = {
  categories: [{ id: 'unit', command: 'pytest', args: [], timeoutMs: 1_000, required: true }],
  reviewCommands: [],
  testPathGlobs: ['**/*.test.*'],
  maxConcurrentExecutes: 1,
  manualEvidenceAccepted: true,
  sandbox: 'none',
  command: 'pytest',
  args: [],
  timeoutMs: 1_000,
};

function record(overrides: Partial<CheckRunRecord> = {}): CheckRunRecord {
  return {
    categoryId: 'unit',
    command: 'pytest',
    args: [],
    ran: true,
    passed: false,
    output: '',
    ...overrides,
  };
}

const REAL_FAILURE = record({
  output: 'collected 1 item / 1 error\nE SyntaxError: invalid syntax',
});

describe('task regression attribution', () => {
  it('does not block an early task on a category that was already incomplete', () => {
    const result = toTaskTestResult([REAL_FAILURE], [REAL_FAILURE], CHECKS);
    expect(result).toMatchObject({ passed: true, suitePassed: false, introducedRegression: false });
    expect(result.incompleteCategories).toEqual(['unit']);
  });

  it('blocks a task that turns an empty suite into a failure', () => {
    const empty = record({ output: 'collected 0 items\n\n======== no tests ran in 0.01s ========' });
    const result = toTaskTestResult([REAL_FAILURE], [empty], CHECKS);
    expect(result).toMatchObject({ passed: false, introducedRegression: true });
    expect(result.newFailures).toEqual(['unit']);
  });

  it('does not block a task that leaves an empty suite empty', () => {
    const empty = record({ output: 'collected 0 items\n\n======== no tests ran in 0.01s ========' });
    const result = toTaskTestResult([empty], [empty], CHECKS);
    expect(result).toMatchObject({ passed: true, suitePassed: false, introducedRegression: false });
    expect(result.incompleteCategories).toEqual(['unit']);
  });

  it('blocks a task that turns a genuinely passing category into a failure', () => {
    const passing = { ...REAL_FAILURE, passed: true };
    const result = toTaskTestResult([REAL_FAILURE], [passing], CHECKS);
    expect(result).toMatchObject({ passed: false, suitePassed: false, introducedRegression: true });
    expect(result.newFailures).toEqual(['unit']);
  });
});

describe('executedNothing', () => {
  it('recognises pytest collecting zero items', () => {
    const baseline = record({ output: 'collected 0 items\n\n======== no tests ran in 0.01s ========' });

    expect(executedNothing(baseline)).toBe(true);
    expect(attributeAgainstBaseline([REAL_FAILURE], [baseline])[0].failedAtBaseline).toBeUndefined();
  });

  it('does not mistake a pytest collection error for an empty suite', () => {
    const baseline = record({
      output:
        "collected 0 items / 1 error\n==================================== ERRORS ====================================\nERROR collecting tests/test_legacy.py\nE   ImportError: cannot import name 'gone' from 'legacy'",
    });

    expect(executedNothing(baseline)).toBe(false);
    expect(attributeAgainstBaseline([REAL_FAILURE], [baseline])[0].failedAtBaseline).toBe(true);
  });

  it('recognises the vitest empty-suite message', () => {
    const baseline = record({ output: 'No test files found, exiting with code 1' });

    expect(executedNothing(baseline)).toBe(true);
    expect(attributeAgainstBaseline([REAL_FAILURE], [baseline])[0].failedAtBaseline).toBeUndefined();
  });

  it('does not mistake a vitest transform failure for an empty suite', () => {
    const baseline = record({
      output:
        'No test files found\nFailed Suites 1\nFAIL tests/legacy.test.ts\nError: Failed to load url ./legacy',
    });

    expect(executedNothing(baseline)).toBe(false);
    expect(attributeAgainstBaseline([REAL_FAILURE], [baseline])[0].failedAtBaseline).toBe(true);
  });

  it('recognises the jest empty-suite message', () => {
    const baseline = record({ output: 'NO TESTS FOUND, exiting with code 1' });

    expect(executedNothing(baseline)).toBe(true);
    expect(attributeAgainstBaseline([REAL_FAILURE], [baseline])[0].failedAtBaseline).toBeUndefined();
  });

  it('does not mistake a jest transform failure for an empty suite', () => {
    const baseline = record({
      output:
        'No tests found\nTest suite failed to run\nSyntaxError: Unexpected token\nTest Suites: 1 failed, 1 total\nTests: 0 total',
    });

    expect(executedNothing(baseline)).toBe(false);
    expect(attributeAgainstBaseline([REAL_FAILURE], [baseline])[0].failedAtBaseline).toBe(true);
  });
});

describe('attributeAgainstBaseline', () => {
  it('still excuses a later failure when baseline tests genuinely failed', () => {
    const baseline = record({ output: 'collected 4 items\n1 failed, 3 passed in 0.12s' });

    expect(attributeAgainstBaseline([REAL_FAILURE], [baseline])[0].failedAtBaseline).toBe(true);
  });

  it('returns records unchanged when the baseline is absent or empty', () => {
    const records = [REAL_FAILURE];

    expect(attributeAgainstBaseline(records, undefined)).toBe(records);
    expect(attributeAgainstBaseline(records, [])).toBe(records);
  });
});

describe('blockingFailures', () => {
  it('blocks delivery when a required category passed after collecting no tests', () => {
    const empty = record({ passed: true, output: 'collected 0 items\n\n======== no tests ran in 0.01s ========' });

    expect(blockingFailures([empty], CHECKS)).toEqual([empty]);
  });

  it('does not block an individual task for the same empty passing suite', () => {
    const empty = record({ passed: true, output: 'collected 0 items\n\n======== no tests ran in 0.01s ========' });

    const result = toTestResult([empty], CHECKS);

    expect(result.passed).toBe(true);
    expect(result.newFailures).toEqual([]);
  });
});

describe('toTestResult', () => {
  it('reports a real failure after an empty baseline as new and blocking', () => {
    const baseline = record({ output: 'collected 0 items' });
    const attributed = attributeAgainstBaseline([REAL_FAILURE], [baseline]);

    const result = toTestResult(attributed, CHECKS);

    expect(result.passed).toBe(false);
    expect(result.newFailures).toEqual(['unit']);
    expect(result.preExistingFailures).toEqual([]);
    expect(result.output).toContain('E SyntaxError: invalid syntax');
  });

  it('reports a genuinely pre-existing failure without blocking acceptance', () => {
    const baseline = record({ output: 'collected 4 items\n1 failed, 3 passed in 0.12s' });
    const attributed = attributeAgainstBaseline([REAL_FAILURE], [baseline]);

    const result = toTestResult(attributed, CHECKS);

    expect(result.passed).toBe(true);
    expect(result.newFailures).toEqual([]);
    expect(result.preExistingFailures).toEqual(['unit']);
    expect(result.output).toContain('E SyntaxError: invalid syntax');
  });

  it('does not block a task when the suite collected no tests', () => {
    const empty = record({ output: 'collected 0 items\n\n======== no tests ran in 0.01s ========' });

    const result = toTestResult([empty], CHECKS);

    expect(result.passed).toBe(true);
    expect(result.newFailures).toEqual([]);
  });

  it('still blocks a task when collection itself broke', () => {
    const broken = record({
      output: "collected 0 items / 1 error\nERROR collecting tests/test_a.py\nE   ImportError: no module named 'numpy'",
    });

    const result = toTestResult([broken], CHECKS);

    expect(result.passed).toBe(false);
    expect(result.newFailures).toEqual(['unit']);
  });

  it('always returns empty failure arrays for a clean run', () => {
    const passingRecord = record({ passed: true, output: '1 passed in 0.01s' });

    const result = toTestResult([passingRecord], CHECKS);

    expect(result.passed).toBe(true);
    expect(result.newFailures).toEqual([]);
    expect(result.preExistingFailures).toEqual([]);
  });
});

describe('toTaskTestResult category lists', () => {
  it('classes an empty suite that now fails as new only, never also pre-existing', () => {
    const empty = record({ output: 'collected 0 items\n\n======== no tests ran in 0.01s ========' });

    const result = toTaskTestResult([REAL_FAILURE], [empty], CHECKS);

    expect(result.newFailures).toEqual(['unit']);
    expect(result.preExistingFailures).toEqual([]);
  });
});

describe('toTaskTestResult check output', () => {
  const TWO_CHECKS: ChecksConfig = {
    ...CHECKS,
    categories: [
      { id: 'unit', command: 'pytest', args: [], timeoutMs: 1_000, required: true },
      { id: 'lint', command: 'ruff', args: [], timeoutMs: 1_000, required: false },
    ],
  };

  // A task meant to make a still-failing suite pass regressed nothing, so it is `passed` — and needs
  // that suite's output more than any other task.
  it('keeps a still-failing required check\'s output even when the task regressed nothing', () => {
    const result = toTaskTestResult([REAL_FAILURE], [REAL_FAILURE], CHECKS);
    expect(result.passed).toBe(true);
    expect(result.output).toContain('E SyntaxError');
    expect(result.checks).toEqual([{ categoryId: 'unit', status: 'still_failing', output: REAL_FAILURE.output }]);
  });

  it('names a failing advisory check without pasting its output', () => {
    const lint = record({ categoryId: 'lint', command: 'ruff', output: 'F401 unused import' });
    const result = toTaskTestResult([record({ passed: true, output: 'ok' }), lint], [], TWO_CHECKS);
    expect(result.output).toBeUndefined();
    expect(result.advisoryFailures).toEqual(['lint']);
    expect(result.checks).toEqual([]);
  });

  it('marks a regression as new', () => {
    const passing = record({ passed: true, output: '1 passed' });
    const result = toTaskTestResult([REAL_FAILURE], [passing], CHECKS);
    expect(result.checks?.[0].status).toBe('new');
  });
});

describe('toTaskTestResult empty suites', () => {
  // Every early task in repairbrief-r1 was told "unit: required, and still failing" with a
  // "collected 0 items" log, for a suite no task had written tests into yet.
  it('names a suite that still collects nothing instead of charging it as a failure', () => {
    const empty = record({ output: 'collected 0 items\n\n======== no tests ran in 0.01s ========' });

    const result = toTaskTestResult([empty], [empty], CHECKS);

    expect(result.checks).toEqual([]);
    expect(result.output).toContain('collected 0 items');
    expect(result.emptyChecks).toEqual(['unit']);
    expect(result.advisoryFailures).toEqual([]);
  });
});

