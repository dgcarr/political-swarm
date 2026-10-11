import { describe, expect, it } from 'vitest';
import type { TaskNode, WorkProduct, TestResult } from '../../engine/types.js';
import { buildBidderUserPrompt, buildImplementerUserPrompt, buildReviewerUserPrompt } from './prompts.js';

/**
 * A real 2026-09-11 capitalist benchmark run rejected 5 of 7 tasks and abandoned them after
 * exhausting remediation attempts — including `init-task`, whose entire acceptance criterion was
 * "File alloydamage/__init__.py exists". The reviewer rejected it citing the repository's
 * *overall* missing modules (damage.py, plotting.py, cli.py, ...) that belonged to other,
 * still-in-progress listings. The cause: buildReviewerUserPrompt used to interpolate the full
 * pasted benchmark spec ("Overall goal: ...") alongside the listing's own narrow acceptance
 * criteria, inviting the reviewer to judge each listing against the whole project instead of its
 * own scope — even though every other strategy's reviewer prompt omits the full spec for exactly
 * this reason. The fix removes the full-spec dump and states the scope boundary explicitly.
 */
describe('buildReviewerUserPrompt scope', () => {
  const node: TaskNode = {
    id: 'init-task',
    title: 'Create package __init__',
    description: 'Add the package init file.',
    acceptanceCriteria: ['File alloydamage/__init__.py exists and is empty or contains minimal docstring.'],
    dependsOn: [],
    targetGlobs: ['alloydamage/__init__.py'],
    riskTags: [],
    riskClass: 'low',
    phase: 'running',
    attempts: [],
  };

  const product: WorkProduct = {
    taskId: 'init-task',
    assignment: { taskId: 'init-task', assigneeId: 'bidder-1', role: 'implementer' },
    fileOps: [{ op: 'write', path: 'alloydamage/__init__.py', content: '' }],
    rationale: 'Created the empty package init file per the acceptance criterion.',
  };

  const test: TestResult = { ran: true, passed: true };

  it('does not dump the full benchmark spec into the reviewer prompt', () => {
    const prompt = buildReviewerUserPrompt(node, product, test);
    expect(prompt).not.toMatch(/Overall goal:/);
  });

  it('tells the reviewer that other listings own the rest of the repository', () => {
    const prompt = buildReviewerUserPrompt(node, product, test);
    expect(prompt).toMatch(/other listings/i);
    expect(prompt).toMatch(/not a defect in this listing/i);
  });

  it('still includes this listing\'s own acceptance criteria', () => {
    const prompt = buildReviewerUserPrompt(node, product, test);
    expect(prompt).toContain('File alloydamage/__init__.py exists and is empty or contains minimal docstring.');
  });

  // pytest's error is the last thing it prints; a head-only cut showed the reviewer the header.
  it('shows the reviewer the end of a long failing test output', () => {
    const output = `${'collected 3 items '.repeat(100)}\nE   AssertionError: expected 2 got 1`;
    const prompt = buildReviewerUserPrompt(node, product, { ran: true, passed: false, output });
    expect(prompt).toContain('E   AssertionError: expected 2 got 1');
  });
});

/**
 * A real 2026-09-11 capitalist run (v7, after the reviewer-scope fix above) reached 8/8 tasks
 * settled, then failed at final acceptance because README.md — a legitimate task in its own
 * right — had been overwritten with a placeholder ("This file is intentionally left unchanged by
 * task8.") by an earlier attempt. The engine correctly reopened the task and recorded the exact
 * defect on `node.remediationOf`, but once warranty repair was exhausted the task was re-tendered
 * to the open market with a plain buildListing() (scope = node.description, unchanged since
 * planning) — new bidders never saw the defect and bid to "confirm README.md has not been
 * modified", perpetuating the corrupted placeholder for several more cycles until the run
 * exhausted its bounded remediation and terminated incomplete. Socialist's implementer prompt
 * already surfaces `node.remediationOf` as a "STRICT REMEDIATION DIRECTIVE"; capitalist set the
 * field (CapitalistStrategy.ts) but never read it in either the bidder or implementer prompt.
 */
describe('remediation directive surfaced on re-tender', () => {
  const reopenedNode: TaskNode = {
    id: 'task8',
    title: 'Own README',
    description: 'Provide README.md with a title and basic usage section.',
    acceptanceCriteria: ['File README.md exists and contains at least a title and basic usage section.'],
    dependsOn: [],
    targetGlobs: ['README.md'],
    riskTags: [],
    riskClass: 'low',
    phase: 'queued',
    attempts: [],
    remediationOf: 'The README file is a required deliverable but has been replaced with a placeholder.',
  };

  it('tells a fresh bidder why the listing was re-tendered', () => {
    const prompt = buildBidderUserPrompt(
      'goal text',
      'Listing "task8": Own README',
      ['documentation'],
      undefined,
      reopenedNode.remediationOf,
    );
    expect(prompt).toContain('The README file is a required deliverable but has been replaced with a placeholder.');
    expect(prompt).toMatch(/re-tendered because the prior delivery was rejected/i);
  });

  it('does not add remediation text to a bidder prompt for a task that was never reopened', () => {
    const prompt = buildBidderUserPrompt('goal text', 'Listing "task8": Own README', ['documentation']);
    expect(prompt).not.toMatch(/re-tendered/i);
  });

  it('tells the implementer the specific defect, not just the original acceptance criteria', () => {
    const prompt = buildImplementerUserPrompt('goal text', reopenedNode, undefined);
    expect(prompt).toContain('The README file is a required deliverable but has been replaced with a placeholder.');
    expect(prompt).toMatch(/STRICT REMEDIATION DIRECTIVE/);
  });
});

/**
 * A real 2026-09-11 capitalist run (v9, after both fixes above) still lost one task:
 * composition-module was rejected 4 times in a row for the exact same defect — the implementer
 * named its test file `tests/tests_composition.py`, which does not match pytest's `test_*.py`
 * discovery pattern, so pytest collected 0 tests every attempt. The reviewer named the defect
 * precisely each time ("its name does not match pytest's default discovery pattern"), but this is
 * an ordinary per-task reviewer-rejection warranty repair (recover() -> state.warrantyRepairs,
 * not the acceptance-barrier node.remediationOf path fixed earlier), and CapitalistStrategy.ts
 * only ever read `assignment.meta.warrantyRepair` as a boolean liability flag — never surfaced its
 * `requiredChanges` text to the same contractor's next implementer attempt. The contractor kept
 * resubmitting blind and never renamed the file.
 */
describe('warranty repair required changes surfaced to the implementer', () => {
  const node: TaskNode = {
    id: 'composition-module',
    title: 'Composition module',
    description: 'Parse alloy composition YAML.',
    acceptanceCriteria: ['Tests pass under `python -m pytest`.'],
    dependsOn: [],
    targetGlobs: ['alloydamage/composition.py', 'tests/test_composition.py'],
    riskTags: [],
    riskClass: 'low',
    phase: 'running',
    attempts: [],
  };

  it('tells the same contractor exactly what the reviewer rejected last time', () => {
    const prompt = buildImplementerUserPrompt('goal text', node, undefined, [
      "Address the independent review finding: the test file's name does not match pytest's default discovery pattern (test_*.py).",
    ]);
    expect(prompt).toMatch(/WARRANTY REPAIR/);
    expect(prompt).toContain("does not match pytest's default discovery pattern");
  });

  it('does not add warranty-repair text for a fresh, non-repair attempt', () => {
    const prompt = buildImplementerUserPrompt('goal text', node, undefined);
    expect(prompt).not.toMatch(/WARRANTY REPAIR/);
  });
});
