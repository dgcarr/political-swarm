import { describe, expect, it } from 'vitest';
import {
  validateImplementerOutput,
  validatePlannerOutput,
  validateSelfReviewOutput,
} from './prompts.js';
import { MISSING_RATIONALE } from '../validation.js';

describe('single-agent wire validators', () => {
  it('accepts a small plan and rejects over-decomposition', () => {
    expect(() =>
      validatePlannerOutput({
        tasks: [
          {
            id: 'implementation',
            title: 'Implement the change',
            description: 'Make the requested change.',
            acceptanceCriteria: ['It works'],
            targetGlobs: ['src/example.ts'],
            dependsOn: [],
          },
        ],
      }),
    ).not.toThrow();

    const task = {
      id: 'task',
      title: 'Task',
      description: 'Do it.',
      acceptanceCriteria: [],
      targetGlobs: [],
      dependsOn: [],
    };
    expect(() => validatePlannerOutput({ tasks: [task, { ...task, id: 'b' }, { ...task, id: 'c' }, { ...task, id: 'd' }] })).toThrow(
      /between 1 and 3/,
    );
  });

  it('rejects duplicate task ids and unsafe file operations', () => {
    const task = {
      id: 'same',
      title: 'Task',
      description: 'Do it.',
      acceptanceCriteria: [],
      targetGlobs: [],
      dependsOn: [],
    };
    expect(() => validatePlannerOutput({ tasks: [task, task] })).toThrow(/unique/);
    expect(() =>
      validateImplementerOutput({
        fileOps: [{ op: 'write', path: '../outside.ts', content: 'bad' }],
        rationale: 'Write outside.',
      }),
    ).toThrow(/unsafe/);
  });

  it('fills in a missing implementer rationale rather than rejecting the fileOps', () => {
    for (const rationale of [undefined, '', '  ']) {
      const output: Record<string, unknown> = { fileOps: [{ op: 'write', path: 'src/a.ts', content: 'x' }], rationale };
      expect(() => validateImplementerOutput(output)).not.toThrow();
      expect(output.rationale).toBe(MISSING_RATIONALE);
    }
  });

  it('requires an explicit, evidence-bearing self-review result', () => {
    expect(() =>
      validateSelfReviewOutput({
        verdict: 'reject',
        rationale: 'A criterion is not implemented.',
        evidenceRefs: ['src/example.ts'],
        requiredChanges: ['Implement the missing branch.'],
        requiresHumanJudgment: false,
      }),
    ).not.toThrow();
    expect(() => validateSelfReviewOutput({ verdict: 'approve', rationale: 'Looks fine.' })).toThrow(/evidenceRefs/);
  });
});
