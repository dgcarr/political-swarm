import { describe, expect, it } from 'vitest';
import { fingerprintAttempt } from './attemptFingerprint.js';

const baseInput = () => ({
  fileOps: [
    { op: 'write' as const, path: 'src/b.ts', content: 'export const b = 2;' },
    { op: 'edit' as const, path: 'src/a.ts', find: 'old', replace: 'new' },
  ],
  failedCategoryIds: ['unit', 'lint'],
  blockingReviewVerdicts: [
    { reviewerId: 'reviewer-b', verdict: 'reject' },
    { reviewerId: 'reviewer-a', verdict: 'reject' },
  ],
  reworkDirective: ['add coverage', 'fix types'],
});

describe('fingerprintAttempt', () => {
  it('is stable for identical logical input regardless of array order', () => {
    const input = baseInput();
    const reordered = {
      fileOps: [...input.fileOps].reverse(),
      failedCategoryIds: [...input.failedCategoryIds].reverse(),
      blockingReviewVerdicts: [...input.blockingReviewVerdicts].reverse(),
      reworkDirective: [...input.reworkDirective].reverse(),
    };

    expect(fingerprintAttempt(input)).toBe(fingerprintAttempt(reordered));
  });

  it.each([
    ['file operation', { fileOps: [{ op: 'delete' as const, path: 'src/a.ts' }] }],
    ['failed category', { failedCategoryIds: ['unit'] }],
    ['blocking review verdict', { blockingReviewVerdicts: [{ reviewerId: 'reviewer-c', verdict: 'reject' }] }],
    ['rework directive', { reworkDirective: ['replace the implementation'] }],
  ])('changes when the %s changes', (_label, change) => {
    expect(fingerprintAttempt({ ...baseInput(), ...change })).not.toBe(fingerprintAttempt(baseInput()));
  });

  it('accepts empty arrays', () => {
    expect(() => fingerprintAttempt({
      fileOps: [],
      failedCategoryIds: [],
      blockingReviewVerdicts: [],
    })).not.toThrow();
  });
});
