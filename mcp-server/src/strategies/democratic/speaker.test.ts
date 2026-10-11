import { describe, expect, it } from 'vitest';
import {
  amendOverlappingMandates,
  restoreIfPaperEmpty,
  retainMinorityReports,
  screenMotions,
  titleSimilarity,
  type AdmissibilityRuling,
} from './speaker.js';
import type { Finding } from '../../engine/packets.js';
import type { Motion } from './types.js';

function motion(overrides: Partial<Motion> = {}): Motion {
  return {
    id: 'm1',
    title: 'Add an isEven helper',
    description: 'Introduce isEven and cover it with a unit test.',
    acceptanceCriteria: ['isEven returns true for even integers'],
    targetGlobs: ['src/even.ts'],
    dependsOn: [],
    portfolioTag: 'backend',
    ...overrides,
  };
}

const screenOptions = { duplicateTitleSimilarity: 0.85, maxMotionsPerReading: 12 };

describe('title similarity', () => {
  it('scores an identical title at 1', () => {
    expect(titleSimilarity('Add an isEven helper', 'Add an isEven helper')).toBe(1);
  });

  it('scores a near-restatement high', () => {
    expect(titleSimilarity('Add isEven helper function', 'Add isEven function helper')).toBe(1);
  });

  it('scores unrelated motions low', () => {
    expect(titleSimilarity('Add an isEven helper', 'Rotate the signing keys')).toBeLessThan(0.3);
  });

  // Common words are not stripped, so they do contribute — the claim that matters is that they
  // cannot carry two different motions anywhere near the duplicate threshold on their own.
  it('does not let a shared filler word make two different motions look alike', () => {
    expect(titleSimilarity('Add the widget loader', 'Fix the gadget cache')).toBeLessThan(0.5);
  });

  it('scores a title with nothing to compare at 0', () => {
    expect(titleSimilarity('', 'Add an isEven helper')).toBe(0);
  });
});

describe('the order-of-debate screen', () => {
  it('admits an ordinary motion', () => {
    const results = screenMotions([motion()], screenOptions);
    expect(results[0].verdict).toBe('in-order');
  });

  it('refuses a motion nobody could scrutinise', () => {
    const results = screenMotions([motion({ description: '   ' })], screenOptions);
    expect(results[0].verdict).toBe('not-in-order');
  });

  it('refuses a motion with neither criteria nor a file it would touch', () => {
    const results = screenMotions([motion({ acceptanceCriteria: [], targetGlobs: [] })], screenOptions);
    expect(results[0].verdict).toBe('not-in-order');
  });

  it('refuses the same question put twice over the same files', () => {
    const results = screenMotions(
      [motion(), motion({ id: 'm2', title: 'Add an isEven helper' })],
      screenOptions,
    );
    expect(results[1]).toMatchObject({ verdict: 'duplicate', duplicateOf: 'm1' });
  });

  it('admits a similarly worded motion that touches different files', () => {
    const results = screenMotions(
      [motion(), motion({ id: 'm2', title: 'Add an isEven helper', targetGlobs: ['src/odd.ts'] })],
      screenOptions,
    );
    expect(results[1].verdict).toBe('in-order');
  });

  it('admits two motions over the same file that ask different questions', () => {
    const results = screenMotions(
      [motion(), motion({ id: 'm2', title: 'Document the parity helpers' })],
      screenOptions,
    );
    expect(results[1].verdict).toBe('in-order');
  });

  it('holds motions beyond the sitting limit over rather than admitting them', () => {
    const many = Array.from({ length: 4 }, (_, i) =>
      motion({ id: `m${i}`, title: `Motion number ${i}`, targetGlobs: [`src/f${i}.ts`] }),
    );
    const results = screenMotions(many, { ...screenOptions, maxMotionsPerReading: 2 });
    expect(results.map((r) => r.verdict)).toEqual(['in-order', 'in-order', 'beyond-the-sitting', 'beyond-the-sitting']);
  });

  it('counts only admitted motions against the sitting limit', () => {
    const results = screenMotions(
      [motion({ id: 'bad', description: '' }), motion({ id: 'good' })],
      { ...screenOptions, maxMotionsPerReading: 1 },
    );
    expect(results[1].verdict).toBe('in-order');
  });
});

describe('the empty Order Paper safeguard', () => {
  function ruling(overrides: Partial<AdmissibilityRuling> = {}): AdmissibilityRuling {
    return { motionId: 'm1', admissible: false, treatment: 'committee', rationale: 'Refused.', ...overrides };
  }

  it('leaves a paper with business alone', () => {
    const rulings = [ruling({ admissible: true }), ruling({ motionId: 'm2' })];
    expect(restoreIfPaperEmpty([motion()], rulings)).toEqual({ rulings, restored: null });
  });

  it('restores a motion when every one was struck', () => {
    const result = restoreIfPaperEmpty([motion()], [ruling(), ruling({ motionId: 'm2' })]);
    expect(result.restored).not.toBeNull();
    expect(result.rulings.filter((r) => r.admissible)).toHaveLength(1);
  });

  it('prefers to restore one refused on procedure over one refused on substance', () => {
    const result = restoreIfPaperEmpty(
      [motion(), motion({ id: 'm2' })],
      [ruling({ motionId: 'm1', treatment: 'routine' }), ruling({ motionId: 'm2', duplicateOf: 'm1' })],
    );
    expect(result.restored).toBe('m2');
  });

  it('clears the duplicate marking on the motion it restores', () => {
    const result = restoreIfPaperEmpty([motion()], [ruling({ duplicateOf: 'm0' })]);
    expect(result.rulings[0].duplicateOf).toBeUndefined();
    expect(result.rulings[0].rationale).toContain('restores');
  });

  it('has nothing to restore when the planner drafted nothing', () => {
    expect(restoreIfPaperEmpty([], [])).toEqual({ rulings: [], restored: null });
  });
});

describe('article 8 retention at disposition', () => {
  function finding(overrides: Partial<Finding> = {}): Finding {
    return {
      id: 'f1',
      source: 'committee',
      summary: 'A dissenting view.',
      evidenceRefs: [],
      disposition: 'unresolved',
      dispositionRationale: 'raised',
      ...overrides,
    };
  }

  it('restores a minority mark the disposition step dropped', () => {
    const before = [finding({ minority: true })];
    const after = [finding({ disposition: 'rejected', dispositionRationale: 'The committee disagreed.', minority: false })];
    const result = retainMinorityReports(before, after);

    expect(result.retained).toEqual(['f1']);
    expect(result.findings[0].minority).toBe(true);
    expect(result.findings[0].dispositionRationale).toContain('article 8');
  });

  it('leaves the committee’s disposition exactly as it made it', () => {
    const before = [finding({ minority: true })];
    const after = [finding({ disposition: 'rejected', dispositionRationale: 'The committee disagreed.' })];
    expect(retainMinorityReports(before, after).findings[0].disposition).toBe('rejected');
  });

  it('says nothing when every minority report survived', () => {
    const before = [finding({ minority: true })];
    const after = [finding({ minority: true, disposition: 'deferred' })];
    expect(retainMinorityReports(before, after)).toEqual({ findings: after, retained: [] });
  });

  it('does not invent dissent that was never recorded', () => {
    const before = [finding()];
    const after = [finding({ disposition: 'accepted' })];
    expect(retainMinorityReports(before, after).findings[0].minority).toBeUndefined();
  });
});

describe('amendOverlappingMandates', () => {
  it('leaves disjoint mandates untouched', () => {
    const screen = amendOverlappingMandates([
      { id: 'a', paths: ['src/a.ts'] },
      { id: 'b', paths: ['src/b.ts'] },
    ]);
    expect(screen.paths).toEqual({ a: ['src/a.ts'], b: ['src/b.ts'] });
    expect(screen.amendments).toEqual([]);
    expect(screen.subsumed).toEqual({});
  });

  it('gives a contested file to the narrowest mandate, wherever it was tabled', () => {
    const screen = amendOverlappingMandates([
      { id: 'skeleton', paths: ['pkg/__init__.py', 'pkg/cli.py', 'pkg/core.py', 'pkg/io.py'] },
      { id: 'cli', paths: ['pkg/cli.py', 'pkg/__main__.py'] },
    ]);
    expect(screen.paths.cli).toEqual(['pkg/cli.py', 'pkg/__main__.py']);
    expect(screen.paths.skeleton).toEqual(['pkg/__init__.py', 'pkg/core.py', 'pkg/io.py']);
    expect(screen.amendments).toEqual([{ motionId: 'skeleton', struck: ['pkg/cli.py'], keptBy: { 'pkg/cli.py': 'cli' } }]);
  });

  it('breaks a tie between equally narrow mandates in favour of the earlier motion', () => {
    const screen = amendOverlappingMandates([
      { id: 'first', paths: ['src/shared.ts'] },
      { id: 'second', paths: ['SRC/Shared.ts '] },
    ]);
    expect(screen.paths.first).toEqual(['src/shared.ts']);
    expect(screen.subsumed).toEqual({ second: ['first'] });
  });

  it('marks a motion subsumed when every file it named belongs to narrower motions', () => {
    const screen = amendOverlappingMandates([
      { id: 'wrapper', paths: ['a.ts', 'b.ts'] },
      { id: 'a', paths: ['a.ts'] },
      { id: 'b', paths: ['b.ts'] },
    ]);
    expect(screen.subsumed).toEqual({ wrapper: ['a', 'b'] });
  });

  it('does not subsume a motion that named no files in the first place', () => {
    const screen = amendOverlappingMandates([{ id: 'plan-only', paths: [] }, { id: 'a', paths: ['a.ts'] }]);
    expect(screen.subsumed).toEqual({});
    expect(screen.paths['plan-only']).toEqual([]);
  });
});
