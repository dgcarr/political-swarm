import { describe, expect, it } from 'vitest';
import { scoreVerdicts, type VerdictRecord } from './decisionBench.js';
import { LABELLED_REVIEWS } from './decisionBenchCases.js';

const verdict = (id: string, expected: 'approve' | 'reject', choice: string, pApprove: number): VerdictRecord =>
  ({ id, expected, choice, pApprove });

describe('scoreVerdicts', () => {
  it('finds the lowest floor at which no defective change is approved unexplained', () => {
    const scored = scoreVerdicts([
      verdict('a', 'approve', 'approve', 0.97),
      verdict('b', 'approve', 'approve', 0.82),
      verdict('c', 'reject', 'approve', 0.88),
      verdict('d', 'reject', 'reject', 0.1),
    ]);
    expect(scored.accuracy).toBe(0.75);
    expect(scored.safeFloor).toBe(0.9);
    expect(scored.floors.find((f) => f.floor === 0.8)).toEqual({ floor: 0.8, fastPathSound: 2, fastPathDefective: 1 });
    expect(scored.floors.find((f) => f.floor === 0.9)).toEqual({ floor: 0.9, fastPathSound: 1, fastPathDefective: 0 });
  });

  it('reports no safe floor when a defective change clears every one', () => {
    expect(scoreVerdicts([verdict('x', 'reject', 'approve', 0.99)]).safeFloor).toBeNull();
  });

  it('balances the labelled set', () => {
    const sound = LABELLED_REVIEWS.filter((c) => c.expected === 'approve').length;
    expect(sound * 2).toBe(LABELLED_REVIEWS.length);
    expect(new Set(LABELLED_REVIEWS.map((c) => c.id)).size).toBe(LABELLED_REVIEWS.length);
  });
});
