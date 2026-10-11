import { describe, expect, it } from 'vitest';
import {
  appealGround,
  classifyCause,
  convenePanel,
  diagnosisDue,
  hearAppeal,
  pathsOutsideScope,
  retryLimitReached,
  validateDiagnosis,
  type FailureSignals,
} from './recovery.js';
import type { SocialistConfig } from './types.js';

const cfg = {
  guilds: ['backend'],
  initialCapabilityScore: 0.5,
  recall: { consecutivePlannerFailuresBeforeSwap: 3 },
  escalateToHuman: { securityPathGlobs: [] },
} as unknown as SocialistConfig;

const signals = (over: Partial<FailureSignals> = {}): FailureSignals => ({
  taskId: 't1',
  checksRan: true,
  hasCriteria: true,
  wasReturned: false,
  returnedByAll: false,
  survivedReassignment: false,
  atBarrier: false,
  ...over,
});

describe('establishing why work failed (section 11)', () => {
  it('blames the harness when the checks never ran', () => {
    expect(classifyCause(signals({ checksRan: false }))).toMatchObject({ cause: 'infrastructure', confident: true });
  });

  it('calls a failure that only appears in combination an integration failure', () => {
    expect(classifyCause(signals({ atBarrier: true })).cause).toBe('integration');
  });

  it('reads a whole council refusing the work as a statement about the work', () => {
    expect(classifyCause(signals({ returnedByAll: true, wasReturned: true })).cause).toBe('specification');
  });

  it('calls work with nothing to be judged against a specification failure', () => {
    expect(classifyCause(signals({ hasCriteria: false })).cause).toBe('specification');
  });

  it('calls one worker handing it back and another taking it a routing failure', () => {
    expect(classifyCause(signals({ wasReturned: true })).cause).toBe('allocation');
  });

  it('rules out the worker when a second failed it the same way', () => {
    expect(classifyCause(signals({ survivedReassignment: true })).cause).toBe('specification');
  });

  // "The worker got it wrong" is the cheapest conclusion available and the easiest to be wrong
  // about, so it is marked as the residual answer rather than a finding.
  it('admits when nothing in the record distinguishes the causes', () => {
    const residual = classifyCause(signals());
    expect(residual.cause).toBe('implementation');
    expect(residual.confident).toBe(false);
    expect(residual.rationale).toContain('residual');
  });

  it('gives a reason for every verdict it reaches', () => {
    const cases = [signals({ checksRan: false }), signals({ atBarrier: true }), signals({ wasReturned: true }), signals()];
    for (const c of cases) expect(classifyCause(c).rationale.length).toBeGreaterThan(20);
  });
});

describe('when a diagnosis is commissioned', () => {
  const residual = classifyCause(signals());
  const confident = classifyCause(signals({ checksRan: false }));

  it('waits for repeated failure', () => {
    expect(diagnosisDue(1, residual, cfg)).toBe(false);
    expect(diagnosisDue(2, residual, cfg)).toBe(true);
  });

  // Paying a model to re-derive an answer the record already gives plainly would be spending on
  // ceremony.
  it('does not spend a dispatch on a question the record already answered', () => {
    expect(diagnosisDue(5, confident, cfg)).toBe(false);
  });

  it('can be switched off', () => {
    expect(diagnosisDue(9, residual, { ...cfg, recovery: { ...cfg.recovery, failuresBeforeDiagnosis: 0 } })).toBe(false);
  });

  it('validates what comes back, including the cause being one of the five', () => {
    expect(() => validateDiagnosis({ cause: 'specification', remedy: 'Re-scope it.', rationale: 'Because.', confident: true })).not.toThrow();
    // An answer is not a finding: the diagnostician must say whether its evidence establishes it.
    expect(() => validateDiagnosis({ cause: 'specification', remedy: 'Re-scope it.', rationale: 'Because.' })).toThrow(/confident/);
    expect(() => validateDiagnosis({ cause: 'vibes', remedy: 'x', rationale: 'y' })).toThrow(/cause/);
    expect(() => validateDiagnosis({ cause: 'specification', remedy: '', rationale: 'y' })).toThrow(/remedy/);
    expect(() => validateDiagnosis(null)).toThrow(/JSON object/);
  });
});

describe('the retry limit (section 14)', () => {
  it('stops at the configured number of cycles', () => {
    expect(retryLimitReached(2, cfg)).toBe(false);
    expect(retryLimitReached(3, cfg)).toBe(true);
  });

  it('can be lifted, but is not unlimited by default', () => {
    expect(retryLimitReached(99, { ...cfg, recovery: { ...cfg.recovery, maxAttemptsPerNode: 0 } })).toBe(false);
  });
});

describe('the appeal panel (section 11)', () => {
  const input = (over: Partial<Parameters<typeof appealGround>[0]> = {}) => ({
    taskId: 't1',
    appellant: 'council-t1',
    agreedScope: ['server/**/*.ts'],
    touchedPaths: ['server/api/profile.ts'],
    breaches: [] as string[],
    ...over,
  });

  it('has no ground when the work stayed inside what it declared', () => {
    expect(appealGround(input())).toBeNull();
  });

  // Section 8's comparison at convergence: declared paths against what was actually written.
  it('stands on a scope change when the work wrote outside its allocation', () => {
    expect(appealGround(input({ touchedPaths: ['server/api/profile.ts', 'client/App.tsx'] }))).toBe('scope-change');
    expect(pathsOutsideScope(input({ touchedPaths: ['server/a.ts', 'client/App.tsx'] }))).toEqual(['client/App.tsx']);
  });

  it('stands on a recorded constitutional breach', () => {
    expect(appealGround(input({ breaches: ['Article 5: returned to the council.'] }))).toBe('constitutional-breach');
  });

  // A council that declared nothing cannot claim its scope was changed against it.
  it('has no scope ground when nothing was declared to begin with', () => {
    expect(appealGround(input({ agreedScope: [], touchedPaths: ['anything.ts'] }))).toBeNull();
  });

  it('draws a panel from outside the council and the authorship chain', () => {
    const panel = convenePanel(['backend-1', 'backend-2', 'frontend-1', 'docs-1'], ['backend-1', 'backend-2'], 2, 'seed');
    expect(panel).toHaveLength(2);
    expect(panel).not.toContain('backend-1');
    expect(panel).not.toContain('backend-2');
  });

  it('draws reproducibly from the same seed', () => {
    const pool = ['a', 'b', 'c', 'd', 'e'];
    expect(convenePanel(pool, [], 2, 'run-a')).toEqual(convenePanel(pool, [], 2, 'run-a'));
  });

  it('upholds an appeal that stands on a ground, and says which', () => {
    const heard = hearAppeal(input({ breaches: ['Article 5 breach.'] }), ['frontend-1', 'docs-1'], cfg);
    expect(heard).toMatchObject({ granted: true, appellant: 'council-t1' });
    expect(heard.rationale).toContain('constitutional breach');
  });

  it('refuses an appeal with no ground', () => {
    expect(hearAppeal(input(), ['frontend-1'], cfg)).toMatchObject({ granted: false });
  });

  // Better a truthful "could not be heard" than a panel of the people being appealed against.
  it('refuses to hear an appeal it cannot draw an independent panel for', () => {
    const heard = hearAppeal(input({ breaches: ['Article 5 breach.'] }), [], cfg);
    expect(heard.granted).toBe(false);
    expect(heard.rationale).toContain('could not be heard independently');
  });

  it('lets a swarm decline scope appeals without declining constitutional ones', () => {
    const strict = { ...cfg, recovery: { ...cfg.recovery, appealOnScopeChange: false } };
    expect(hearAppeal(input({ touchedPaths: ['client/App.tsx'] }), ['frontend-1'], strict).granted).toBe(false);
    expect(hearAppeal(input({ breaches: ['Article 5 breach.'] }), ['frontend-1'], strict).granted).toBe(true);
  });
});
