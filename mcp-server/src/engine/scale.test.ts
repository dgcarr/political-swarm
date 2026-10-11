import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assessGoalScale, decompositionGuidance, MAX_SUGGESTED_NODES } from './scale.js';

import type { TaskSpec } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function spec(goal: string, acceptanceCriteria: string[] = []): TaskSpec {
  return { goal, acceptanceCriteria, repoPath: '/tmp/repo', baseBranch: 'main' };
}

describe('assessGoalScale', () => {
  it('treats a one-line goal as smallest scale: exactly one node', () => {
    const scale = assessGoalScale(spec('Add an isEven function.'));
    expect(scale.large).toBe(false);
    expect(scale.suggestedNodes).toEqual({ min: 1, max: 1 });
  });

  it('keeps a small goal with a couple of criteria at one node', () => {
    const scale = assessGoalScale(spec('Add an isEven function plus a unit test.', ['isEven(2) === true']));
    expect(scale.large).toBe(false);
    expect(scale.suggestedNodes.max).toBe(1);
  });

  it('counts bullet, numbered, and heading lines as structural items', () => {
    const goal = ['# Title', '- one', '* two', '+ three', '1. four', '2) five', 'prose line'].join('\n');
    expect(assessGoalScale(spec(goal)).structuralItems).toBe(6);
  });

  it('does not count bare prose or empty lines as structural items', () => {
    expect(assessGoalScale(spec('just some prose\n\nmore prose')).structuralItems).toBe(0);
  });

  it('counts distinct file paths only once each', () => {
    const goal = 'Touch src/a.py and src/a.py and also tests/test_a.py';
    expect(assessGoalScale(spec(goal)).pathHints).toBe(2);
  });

  it('escalates to multiple nodes once the goal enumerates more than one node of work', () => {
    const goal = ['Build a package:', ...Array.from({ length: 9 }, (_, i) => `- module ${i}`)].join('\n');
    const scale = assessGoalScale(spec(goal, ['a works', 'b works', 'c works']));
    expect(scale.deliverables).toBe(9); // 9 bullets; the intro line is prose and does not count
    expect(scale.large).toBe(true);
    expect(scale.suggestedNodes).toEqual({ min: 2, max: 3 });
  });

  it('keeps a goal with only a few enumerated items at a single node', () => {
    const goal = ['Build a small thing:', '- part a', '- part b'].join('\n');
    const scale = assessGoalScale(spec(goal));
    expect(scale.large).toBe(false);
    expect(scale.suggestedNodes.max).toBe(1);
  });

  it('uses goal length only as a floor, so verbose-but-narrow goals stay small', () => {
    // ~2.9k chars of unstructured prose: implies 1 requirement, not a package.
    const scale = assessGoalScale(spec('make the parser faster. '.repeat(120)));
    expect(scale.structuralItems).toBe(0);
    expect(scale.large).toBe(false);
  });

  it('caps suggested nodes at MAX_SUGGESTED_NODES even for a huge goal', () => {
    const goal = Array.from({ length: 60 }, (_, i) => `- requirement ${i} in src/mod${i}/file${i}.py`).join('\n');
    const scale = assessGoalScale(spec(goal, Array.from({ length: 20 }, (_, i) => `criterion ${i}`)));
    expect(scale.suggestedNodes.max).toBe(MAX_SUGGESTED_NODES);
    expect(scale.suggestedNodes.min).toBe(4);
  });

  it('rates the real alloydamage benchmark TASK.md as large', () => {
    // Regression guard for the actual goal that produced single-node plans in every strategy.
    const taskMd = readFileSync(path.join(__dirname, '../../../benchmark/starting-repo/TASK.md'), 'utf8');
    const scale = assessGoalScale(spec(taskMd, ['python -m pytest passes']));
    expect(scale.large).toBe(true);
    expect(scale.suggestedNodes.min).toBeGreaterThanOrEqual(3);
  });

  it('tolerates an empty goal without throwing', () => {
    expect(assessGoalScale(spec('')).suggestedNodes).toEqual({ min: 1, max: 1 });
  });
});

describe('decompositionGuidance', () => {
  it('tells the planner to return exactly one unit for a small goal', () => {
    const text = decompositionGuidance(spec('Add an isEven function.'));
    expect(text).toContain('exactly ONE');
  });

  it('tells the planner to split a large goal, using the caller-supplied unit noun', () => {
    const goal = Array.from({ length: 20 }, (_, i) => `- requirement ${i} in src/mod${i}/f${i}.py`).join('\n');
    const text = decompositionGuidance(spec(goal, ['a', 'b', 'c', 'd']), 'motion');
    expect(text).toContain('LARGE');
    expect(text).toContain('motions');
    expect(text).not.toContain('nodes');
  });
});
