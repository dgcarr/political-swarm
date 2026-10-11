import { describe, expect, it } from 'vitest';
import { lotSeed } from './lots.js';

describe('lotSeed', () => {
  it('draws from the run lot seed when there is one, else from the run id', () => {
    expect(lotSeed({ runId: 'democratic-abc', runState: { lotSeed: 'benchmark-trial-2' } })).toBe('benchmark-trial-2');
    expect(lotSeed({ runId: 'democratic-abc', runState: {} })).toBe('democratic-abc');
  });
});
