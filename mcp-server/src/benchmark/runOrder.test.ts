import { describe, it, expect } from 'vitest';
import { rotatedStrategyOrder, describeRotation } from './runOrder.js';

describe('rotatedStrategyOrder', () => {
  it('returns the original order for trial 0', () => {
    const strategies = ['democratic', 'socialist', 'capitalist'];
    expect(rotatedStrategyOrder(strategies, 0)).toEqual([
      'democratic',
      'socialist',
      'capitalist',
    ]);
  });

  it('wraps back to the original order when trial index equals array length', () => {
    const strategies = ['democratic', 'socialist', 'capitalist'];
    expect(rotatedStrategyOrder(strategies, 3)).toEqual([
      'democratic',
      'socialist',
      'capitalist',
    ]);
  });

  it('rotates so every element appears first across trial indices 0..length-1', () => {
    const strategies = ['democratic', 'socialist', 'capitalist'];
    const firsts = strategies.map((_, i) => rotatedStrategyOrder(strategies, i)[0]);
    expect(new Set(firsts)).toEqual(new Set(strategies));
  });

  it('rotates correctly for trial index larger than the array length', () => {
    const strategies = ['democratic', 'socialist', 'capitalist'];
    expect(rotatedStrategyOrder(strategies, 5)).toEqual([
      'capitalist',
      'democratic',
      'socialist',
    ]);
  });

  it('returns an empty array for an empty input without throwing', () => {
    expect(rotatedStrategyOrder([], 0)).toEqual([]);
    expect(rotatedStrategyOrder([], 7)).toEqual([]);
  });

  it('returns the single-element array for a single-element input without throwing', () => {
    const strategies = ['democratic'];
    expect(rotatedStrategyOrder(strategies, 0)).toEqual(['democratic']);
    expect(rotatedStrategyOrder(strategies, 9)).toEqual(['democratic']);
  });

  it('does not mutate the input array', () => {
    const strategies = ['democratic', 'socialist', 'capitalist'];
    const snapshot = [...strategies];
    rotatedStrategyOrder(strategies, 2);
    expect(strategies).toEqual(snapshot);
    expect(strategies).toBe(strategies);
  });
});

describe('describeRotation', () => {
  it('describes the permutation for a given trial', () => {
    const strategies = ['democratic', 'socialist', 'capitalist'];
    expect(describeRotation(strategies, 2)).toBe(
      'trial 2: capitalist,democratic,socialist',
    );
  });

  it('describes trial 0 as the original order', () => {
    const strategies = ['democratic', 'socialist', 'capitalist'];
    expect(describeRotation(strategies, 0)).toBe(
      'trial 0: democratic,socialist,capitalist',
    );
  });
});
