import { describe, expect, it } from 'vitest';
import {
  candidatesFor,
  constituencyList,
  constituteOffices,
  tallyElection,
  drawByLot,
  electOne,
  functionHolders,
  performanceScore,
  portfolioList,
  readOfficePerformance,
  recallRepresentative,
  recordOfficePerformance,
  repairSeparationBreaches,
  rotateOffices,
  seededRandom,
  shadowFor,
  shouldRotate,
  type OfficePerformance,
} from './offices.js';
import { separationOfFunctionsBreaches } from './constitution.js';
import type { KnowledgeStore } from '../../engine/KnowledgeStore.js';
import type { DemocraticConfig } from './types.js';

describe('constituent ballots', () => {
  const electors = ['frontend', 'backend', 'testing'];
  const candidates = ['a', 'b'];

  it('lets equal valid ballots displace a performance favorite', () => {
    const result = tallyElection(electors, candidates, [
      { elector: 'frontend', candidate: 'b' },
      { elector: 'backend', candidate: 'b' },
      { elector: 'testing', candidate: 'a' },
    ]);
    expect(result.winner).toBe('b');
    expect(result.votes).toEqual({ a: 1, b: 2 });
  });

  it('distinguishes abstention, quorum, and a published tie rule', () => {
    expect(tallyElection(electors, candidates, [{ elector: 'frontend', candidate: null }]).winner).toBeNull();
    const tied = tallyElection(electors, candidates, [
      { elector: 'frontend', candidate: 'b' },
      { elector: 'backend', candidate: 'a' },
    ]);
    expect(tied.quorumMet).toBe(true);
    expect(tied.winner).toBe('a');
  });

  it('rejects duplicate and foreign ballots', () => {
    expect(() => tallyElection(electors, candidates, [
      { elector: 'frontend', candidate: 'a' }, { elector: 'frontend', candidate: 'b' },
    ])).toThrow('Duplicate ballot');
    expect(() => tallyElection(electors, candidates, [{ elector: 'outsider', candidate: 'a' }])).toThrow('Ineligible elector');
  });
});

const cfg = {
  voteThresholds: {
    routine: 'simple_majority',
    cross_module: 'three_fifths',
    security_boundary: 'two_thirds_plus_security_committee',
    constitutional_amendment: 'two_thirds_both_chambers',
    test_waiver: 'human_required',
  },
  riskClassification: { securityPathGlobs: [], crossModuleThreshold: 2 },
  committee: { electedSpecialistCalls: 2, sortitionCalls: 2 },
  confidenceVote: { consecutiveFailuresBeforeSwap: 3 },
  questionTimeEveryNTasks: 5,
  offices: { termLengthInTasks: 4, candidatesPerOffice: 3, seed: 'run-id' },
} as unknown as DemocraticConfig;

function constitute(runId = 'run-alpha', overrides: Partial<DemocraticConfig> = {}) {
  return constituteOffices({
    seed: runId,
    cfg: { ...cfg, ...overrides },
    constitutedAt: '2026-01-01T00:00:00.000Z',
  });
}

describe('seeded draws', () => {
  it('produces the same sequence for the same seed', () => {
    const a = seededRandom('run-alpha');
    const b = seededRandom('run-alpha');
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it('produces a different sequence for a different seed', () => {
    const a = seededRandom('run-alpha');
    const b = seededRandom('run-beta');
    expect([a(), a(), a()]).not.toEqual([b(), b(), b()]);
  });

  it('draws distinct items and never more than the pool holds', () => {
    const drawn = drawByLot(['a', 'b', 'c'], 5, seededRandom('s'));
    expect(new Set(drawn).size).toBe(3);
  });

  it('draws nothing when asked for nothing', () => {
    expect(drawByLot(['a', 'b'], 0, seededRandom('s'))).toEqual([]);
  });
});

describe('election on recorded performance', () => {
  const record: OfficePerformance[] = [
    { personaId: 'x-t1c1', carried: 1, defeated: 9 },
    { personaId: 'x-t1c2', carried: 9, defeated: 1 },
  ];

  it('scores an unknown candidate at the neutral prior, not at zero', () => {
    expect(performanceScore('never-served', record)).toBe(0.5);
  });

  it('scores a strong record above a weak one', () => {
    expect(performanceScore('x-t1c2', record)).toBeGreaterThan(performanceScore('x-t1c1', record));
  });

  it('smooths, so one lucky win does not outrank a long solid record', () => {
    const solid = performanceScore('solid', [{ personaId: 'solid', carried: 20, defeated: 2 }]);
    const lucky = performanceScore('lucky', [{ personaId: 'lucky', carried: 1, defeated: 0 }]);
    expect(solid).toBeGreaterThan(lucky);
  });

  it('returns the best-recorded candidate', () => {
    expect(electOne(['x-t1c1', 'x-t1c2'], record, seededRandom('s'))).toBe('x-t1c2');
  });

  it('returns an empty string rather than throwing on an empty roster', () => {
    expect(electOne([], record, seededRandom('s'))).toBe('');
  });

  it('names a stable, inspectable roster per office and term', () => {
    expect(candidatesFor('speaker', 3, 2)).toEqual(['speaker-t2c1', 'speaker-t2c2', 'speaker-t2c3']);
  });
});

describe('constituting a term', () => {
  it('fills every office section 6 names', () => {
    const register = constitute();
    expect(register.primeCoordinator).not.toBe('');
    expect(register.speaker).not.toBe('');
    expect(register.ceremonialHead).not.toBe('');
    expect(Object.keys(register.representatives)).toHaveLength(constituencyList(cfg).length);
    expect(Object.keys(register.cabinet)).toHaveLength(portfolioList(cfg).length);
    expect(register.houseOfReview.length).toBeGreaterThanOrEqual(3);
    expect(register.securityCommittee).toHaveLength(3);
    expect(register.securityCommittee?.every((member) => !register.houseOfReview.includes(member))).toBe(true);
    expect(register.holders.filter((holder) => holder.office === 'security-committee')).toHaveLength(3);
    expect(register.sortitionPool).toHaveLength(cfg.committee.sortitionCalls);
  });

  it('is reproducible from the run id, so the ledger can be replayed', () => {
    expect(constitute('run-alpha')).toEqual(constitute('run-alpha'));
  });

  // Per-office, two runs can legitimately draw the same candidate out of three — so the claim
  // worth making is about the register as a whole, not about any one seat.
  it('draws a different register for a different run', () => {
    expect(constitute('run-alpha')).not.toEqual(constitute('run-zulu'));
  });

  it('separates the functions article 6 keeps apart', () => {
    const register = constitute();
    expect(separationOfFunctionsBreaches(functionHolders(register, [], 'integrator', 'verifier'))).toEqual([]);
  });

  it('mixes appointed specialists with jurors drawn by lot in the House of Review', () => {
    const register = constitute();
    const methods = register.holders.filter((h) => h.office === 'house-of-review').map((h) => h.method);
    expect(methods).toContain('appointment');
    expect(methods).toContain('sortition');
  });

  it('does not elect the Ceremonial Head, which checks the government that would elect it', () => {
    const register = constitute();
    const head = register.holders.find((h) => h.office === 'ceremonial-head');
    expect(head?.method).toBe('sortition');
  });

  it('falls back to section 6 constituencies and portfolios when config names none', () => {
    const bare = constituteOffices({
      seed: 'r',
      cfg: { ...cfg, constituencies: [], cabinet: { ...cfg.cabinet, portfolios: [] } },
      constitutedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(Object.keys(bare.representatives)).toContain('user-experience');
    expect(Object.keys(bare.cabinet)).toContain('release-operations');
  });

  it('mirrors the executive portfolios in the shadow cabinet, defaulting the unlisted ones', () => {
    const withShadows = { ...cfg, shadowCabinet: { security: 'shadow-security-reviewer', default: 'shadow-general' } };
    expect(shadowFor(withShadows, 'security')).toBe('shadow-security-reviewer');
    expect(shadowFor(withShadows, 'frontend')).toBe('shadow-general');
  });
});

describe('article 6 repair', () => {
  it('moves the procedural office, never the executive one', () => {
    const register = constitute();
    const collided = { ...register, speaker: register.primeCoordinator };
    const { register: repaired, repairs } = repairSeparationBreaches(collided, 3);

    expect(repairs).toEqual([]);
    expect(repaired.primeCoordinator).toBe(register.primeCoordinator);
    expect(repaired.speaker).not.toBe(repaired.primeCoordinator);
    expect(separationOfFunctionsBreaches(functionHolders(repaired, [], 'i', 'v'))).toEqual([]);
  });

  it('updates the holder roll alongside the office, so the two cannot drift', () => {
    const register = constitute();
    const { register: repaired } = repairSeparationBreaches({ ...register, speaker: register.primeCoordinator }, 3);
    expect(repaired.holders.find((h) => h.office === 'speaker')?.personaId).toBe(repaired.speaker);
  });

  it('leaves an already-separated register untouched', () => {
    const register = constitute();
    expect(repairSeparationBreaches(register, 3).register).toEqual(register);
  });
});

describe('rotation and recall', () => {
  it('rotates on the configured cadence and not between', () => {
    expect(shouldRotate(4, cfg)).toBe(true);
    expect(shouldRotate(3, cfg)).toBe(false);
    expect(shouldRotate(8, cfg)).toBe(true);
  });

  it('does not rotate when the term length is 0', () => {
    expect(shouldRotate(4, { ...cfg, offices: { ...cfg.offices, termLengthInTasks: 0 } })).toBe(false);
    expect(shouldRotate(0, cfg)).toBe(false);
  });

  it('opens a new term rather than renewing the incumbents by inertia', () => {
    const first = constitute();
    const second = rotateOffices(first, { seed: 'run-alpha', cfg, constitutedAt: '2026-01-02T00:00:00.000Z' });
    expect(second.termId).toBe(2);
    expect(second.speaker).not.toBe(first.speaker);
  });

  it('replaces a recalled representative without disturbing any other seat', () => {
    const register = constitute();
    const result = recallRepresentative(register, 'security', 3);

    expect(result).not.toBeNull();
    expect(result!.outgoing).toBe(register.representatives.security);
    expect(result!.incoming).not.toBe(result!.outgoing);
    expect(result!.register.representatives.frontend).toBe(register.representatives.frontend);
    expect(result!.register.holders.find((h) => h.office === 'representative' && h.seat === 'security')?.personaId).toBe(
      result!.incoming,
    );
  });

  it('declines to recall a constituency that has no representative', () => {
    expect(recallRepresentative(constitute(), 'no-such-constituency', 3)).toBeNull();
  });
});

describe('the cross-run performance record', () => {
  function fakeStore(entries: Array<{ content: string }>): KnowledgeStore {
    return {
      queryByTags: () => entries.map((e) => ({ ...e, id: 'i', kind: 'lesson', tags: [], sourceRunId: 'r', createdAt: 'now' })),
      add: () => undefined,
    } as unknown as KnowledgeStore;
  }

  it('totals a persona record across runs', () => {
    const store = fakeStore([
      { content: JSON.stringify({ personaId: 'pm', carried: 2, defeated: 1 }) },
      { content: JSON.stringify({ personaId: 'pm', carried: 3, defeated: 0 }) },
    ]);
    expect(readOfficePerformance(store)).toEqual([{ personaId: 'pm', carried: 5, defeated: 1 }]);
  });

  it('skips malformed entries rather than failing the election', () => {
    const store = fakeStore([{ content: 'not json' }, { content: JSON.stringify({ carried: 1 }) }]);
    expect(readOfficePerformance(store)).toEqual([]);
  });

  it('returns no record when the civil service has no store at all', () => {
    expect(readOfficePerformance(undefined)).toEqual([]);
    expect(readOfficePerformance({} as KnowledgeStore)).toEqual([]);
  });

  it('survives a store that throws, because a bad cache must not stop an election', () => {
    const throwing = { queryByTags: () => { throw new Error('corrupt'); } } as unknown as KnowledgeStore;
    expect(readOfficePerformance(throwing)).toEqual([]);
    expect(() => recordOfficePerformance(throwing, 'r', { personaId: 'p', carried: 1, defeated: 0 }, 'now')).not.toThrow();
  });

  it('files a record the next election can read back', () => {
    const written: Array<{ content: string }> = [];
    const store = { add: (entry: { content: string }) => written.push(entry) } as unknown as KnowledgeStore;
    recordOfficePerformance(store, 'run-1', { personaId: 'pm', carried: 4, defeated: 1 }, 'now');
    expect(JSON.parse(written[0].content)).toEqual({ personaId: 'pm', carried: 4, defeated: 1 });
  });
});
