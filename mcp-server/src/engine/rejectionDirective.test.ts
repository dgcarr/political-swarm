import { describe, expect, it } from 'vitest';
import { rejectionRequiredChanges } from './rejectionDirective.js';
import type { TestResult } from './types.js';

const CLEAN_TEST: TestResult = { ran: true, passed: true };

describe('rejectionRequiredChanges', () => {
  it('keeps the doctrine rationale', () => {
    expect(rejectionRequiredChanges('Rejected: wrong units.', CLEAN_TEST)).toEqual(['Rejected: wrong units.']);
  });

  it('names each charged check and whether this change broke it', () => {
    const changes = rejectionRequiredChanges('Rejected.', {
      ran: true,
      passed: false,
      checks: [
        { categoryId: 'unit', status: 'new', output: 'E AssertionError' },
        { categoryId: 'lint', status: 'still_failing' },
      ],
    });

    expect(changes).toEqual([
      'Rejected.',
      'Failing check: unit (passed before this change)',
      'Failing check: lint (required, still failing)',
    ]);
  });

  // The output itself travels in the repair brief; pasting it here put it in the prompt twice.
  it('does not paste check output', () => {
    const changes = rejectionRequiredChanges('Rejected.', {
      ran: true,
      passed: false,
      output: 'AssertionError: 1.0 != 2.0',
      checks: [{ categoryId: 'unit', status: 'new', output: 'AssertionError: 1.0 != 2.0' }],
    });

    expect(changes.join('\n')).not.toContain('AssertionError');
  });

  it('drops an empty rationale', () => {
    expect(rejectionRequiredChanges('   ', CLEAN_TEST)).toEqual([]);
  });
});
