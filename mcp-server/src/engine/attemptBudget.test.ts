// What a task's rework budget is spent on, and what the test-owning task is judged by.
//
// Both rules exist because of measured benchmark behaviour: 37 of 411 attempts across two sweeps
// ended in a provider timeout that consumed the budget, and 79 were rejected while the engine
// recorded the tests as passing because "passed" meant "introduced no regression".

import { describe, expect, it } from 'vitest';
import { countedAttempts, trailingTransientAttempts } from './TaskGraph.js';
import { isTransientProviderFailure, ownsTestFiles, suiteBoundTestResult } from './SwarmEngine.js';
import type { TaskAttempt, TaskNode } from './types.js';

function attempt(overrides: Partial<TaskAttempt> = {}): TaskAttempt {
  return {
    attempt: 1,
    outcome: 'rejected',
    rationale: '',
    evidenceRefs: [],
    at: '2026-09-24T00:00:00.000Z',
    fingerprint: 'f',
    repeated: false,
    ...overrides,
  };
}

function node(attempts: TaskAttempt[], targetGlobs: string[] = []): TaskNode {
  return {
    id: 't',
    title: 'T',
    description: '',
    acceptanceCriteria: [],
    dependsOn: [],
    targetGlobs,
    riskTags: [],
    riskClass: 'low',
    phase: 'queued',
    attempts,
  };
}

describe('isTransientProviderFailure', () => {
  it.each([
    'Error: OpenRouter call to deepseek/deepseek-v4-flash exceeded the per-call timeout of 300000ms',
    'Error: 503 Service Unavailable',
    'Error: 429 rate limit exceeded',
    'FetchError: request failed, reason: ECONNRESET',
    'Error: socket hang up',
    'TypeError: fetch failed',
  ])('treats a transport failure as transient: %s', (message) => {
    expect(isTransientProviderFailure(new Error(message))).toBe(true);
  });

  it.each([
    'Error: Cannot edit nonexistent file alloydamage/cli.py',
    'Error: the model returned no parseable JSON',
    'Error: refused to write outside the worktree',
  ])('treats anything the model actually said as a judgement, not transport: %s', (message) => {
    // These must still cost an attempt, or a task that fails the same way forever never stops.
    expect(isTransientProviderFailure(new Error(message))).toBe(false);
  });
});

describe('countedAttempts', () => {
  it('spends the budget only on attempts that judged the work', () => {
    const subject = node([
      attempt({ attempt: 1 }),
      attempt({ attempt: 2, transient: true }),
      attempt({ attempt: 3, transient: true }),
      attempt({ attempt: 4 }),
    ]);
    expect(subject.attempts).toHaveLength(4);
    expect(countedAttempts(subject)).toBe(2);
  });

  it('keeps transient attempts on the record', () => {
    // They are real cost and real elapsed time; exempting them from the budget must not hide them.
    const subject = node([attempt({ transient: true })]);
    expect(countedAttempts(subject)).toBe(0);
    expect(subject.attempts).toHaveLength(1);
  });
});

describe('trailingTransientAttempts', () => {
  it('counts an unbroken run of transport failures at the end', () => {
    expect(trailingTransientAttempts(node([
      attempt(),
      attempt({ transient: true }),
      attempt({ transient: true }),
    ]))).toBe(2);
  });

  it('resets once a real attempt lands, so an intermittent provider never accumulates', () => {
    expect(trailingTransientAttempts(node([
      attempt({ transient: true }),
      attempt({ transient: true }),
      attempt(),
    ]))).toBe(0);
  });
});

describe('ownsTestFiles', () => {
  it.each([
    ['tests/test_alloydamage.py'],
    ['pkg/tests/helpers.py'],
    ['test_core.py'],
    ['core_test.go'],
    ['src/engine/thing.test.ts'],
    ['spec/behaviour.rb'],
  ])('recognises %s as the repository\'s tests', (path) => {
    expect(ownsTestFiles(node([], [path]))).toBe(true);
  });

  it.each([['alloydamage/cli.py'], ['README.md'], ['src/latest.ts'], ['data/Fe/contest.csv']])(
    'does not claim %s owns the tests',
    (path) => {
      // A task that runs before any tests exist must stay approvable, or nothing ever gets built.
      expect(ownsTestFiles(node([], [path]))).toBe(false);
    },
  );

  it.each([['tests/__init__.py'], ['tests/conftest.py'], ['tests/.gitkeep']])(
    'does not count %s alone as owning the tests',
    (path) => {
      // Socialist cycle 3: a task owning only tests/__init__.py was held to an empty suite six times.
      expect(ownsTestFiles(node([], [path]))).toBe(false);
      expect(ownsTestFiles(node([], [path, 'tests/test_core.py']))).toBe(true);
    },
  );

  it('reads the task\'s declared targets as well as what it wrote', () => {
    expect(ownsTestFiles(node([], ['tests/test_x.py']), [])).toBe(true);
    expect(ownsTestFiles(node([], []), [{ path: 'tests/test_x.py' }])).toBe(true);
  });
});

describe('suiteBoundTestResult', () => {
  it('fails the test-owning task when the suite is red, whatever the regression check says', () => {
    const result = suiteBoundTestResult({ passed: true, suitePassed: false });
    expect(result.passed).toBe(false);
  });

  it('leaves a green suite approved', () => {
    expect(suiteBoundTestResult({ passed: true, suitePassed: true }).passed).toBe(true);
  });

  it('does not invent a verdict when the strict status is unknown', () => {
    expect(suiteBoundTestResult({ passed: true }).passed).toBe(true);
  });

  it('never rescues a genuine regression', () => {
    expect(suiteBoundTestResult({ passed: false, suitePassed: true }).passed).toBe(false);
  });
});
