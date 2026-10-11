import { describe, expect, it } from 'vitest';
import {
  assessCollectiveResponsibility,
  confidenceMotionDue,
  ministerFor,
  putConfidenceMotion,
  tallyConfidenceBallots,
  replaceMinister,
} from './cabinet.js';
import { constituteOffices } from './offices.js';

describe('recorded confidence ballots', () => {
  it('counts members separately and withdraws confidence only on a voting majority against', () => {
    expect(tallyConfidenceBallots('pm', ['a', 'b', 'c'], [
      { elector: 'a', choice: 'no' }, { elector: 'b', choice: 'no' }, { elector: 'c', choice: 'aye' },
    ])).toMatchObject({ ayes: 1, noes: 2, outcome: 'lost' });
  });

  it('does not turn missing participation into an adverse vote', () => {
    expect(tallyConfidenceBallots('pm', ['a', 'b', 'c'], [{ elector: 'a', choice: 'no' }]))
      .toMatchObject({ noes: 1, abstentions: 2, outcome: 'sustained' });
  });

  it('rejects a second vote from the same member', () => {
    expect(() => tallyConfidenceBallots('pm', ['a'], [
      { elector: 'a', choice: 'aye' }, { elector: 'a', choice: 'no' },
    ])).toThrow('Invalid confidence elector');
  });
});
import type { DemocraticConfig } from './types.js';

const cfg = {
  voteThresholds: {
    routine: 'simple_majority',
    cross_module: 'three_fifths',
    security_boundary: 'two_thirds_plus_security_committee',
    constitutional_amendment: 'two_thirds_both_chambers',
    test_waiver: 'human_required',
  },
  riskClassification: { securityPathGlobs: [], crossModuleThreshold: 2 },
  committee: { electedSpecialistCalls: 2, sortitionCalls: 1 },
  confidenceVote: { consecutiveFailuresBeforeSwap: 3 },
  questionTimeEveryNTasks: 5,
  confidence: { governmentFailuresBeforeMotion: 3, representativeRecallFailures: 3 },
} as unknown as DemocraticConfig;

const register = constituteOffices({ seed: 'run-1', cfg, constitutedAt: '2026-01-01T00:00:00.000Z' });

function dissentInput(overrides = {}) {
  return {
    portfolioTag: 'security',
    personaId: 'minister-security-t1c1',
    conceded: true,
    carried: true,
    collectiveResponsibility: true,
    ...overrides,
  };
}

describe('the cabinet roll', () => {
  it('names the minister answering for a portfolio', () => {
    expect(ministerFor(register, 'security')).toBe(register.cabinet.security);
  });

  it('falls back to a stable name for a portfolio with no seat', () => {
    expect(ministerFor(register, 'nonesuch')).toBe('minister-nonesuch');
    expect(ministerFor(undefined, 'security')).toBe('minister-security');
  });
});

describe('collective responsibility', () => {
  it('requires a dissenting minister to resign the portfolio', () => {
    const dissent = assessCollectiveResponsibility(dissentInput());
    expect(dissent).toMatchObject({ portfolioTag: 'security', resigned: true });
    expect(dissent!.rationale).toContain('collective responsibility');
  });

  it('binds a minister who defended the motion, however it turned out', () => {
    expect(assessCollectiveResponsibility(dissentInput({ conceded: false }))).toBeNull();
  });

  it('asks nothing of a minister whose motion was defeated', () => {
    expect(assessCollectiveResponsibility(dissentInput({ carried: false }))).toBeNull();
  });

  it('is inert when the convention is switched off', () => {
    expect(assessCollectiveResponsibility(dissentInput({ collectiveResponsibility: false }))).toBeNull();
  });

  it('hands the portfolio to a successor without disturbing the rest of the cabinet', () => {
    const result = replaceMinister(register, 'security', 3);
    expect(result).not.toBeNull();
    expect(result!.incoming).not.toBe(register.cabinet.security);
    expect(result!.register.cabinet.architecture).toBe(register.cabinet.architecture);
    expect(result!.register.holders.find((h) => h.office === 'minister' && h.seat === 'security')?.personaId).toBe(
      result!.incoming,
    );
  });

  it('reports an exhausted roster rather than recycling a name', () => {
    const exhausted = {
      ...register,
      cabinet: { ...register.cabinet, security: 'minister-security-t1c1' },
    };
    // Every candidate the roster can produce is already sitting in the cabinet.
    const taken = Object.fromEntries(
      Array.from({ length: 5 }, (_, i) => [`p${i}`, `minister-security-t1c${i + 1}`]),
    );
    expect(replaceMinister({ ...exhausted, cabinet: taken }, 'security', 3)).toBeNull();
  });
});

describe('the question of confidence', () => {
  const constituencies = ['frontend', 'backend', 'security'];

  it('is due only once the run of defeats reaches the threshold', () => {
    expect(confidenceMotionDue(2, cfg)).toBe(false);
    expect(confidenceMotionDue(3, cfg)).toBe(true);
  });

  it('sustains a government that has carried more than it lost', () => {
    const motion = putConfidenceMotion({
      subject: 'pm',
      constituencies,
      tally: { carried: 4, defeated: 1 },
      consecutiveFailures: 3,
    });
    expect(motion.outcome).toBe('sustained');
    expect(motion.ayes).toBe(3);
  });

  it('withdraws confidence from a government that has lost more than it carried', () => {
    const motion = putConfidenceMotion({
      subject: 'pm',
      constituencies,
      tally: { carried: 1, defeated: 4 },
      consecutiveFailures: 3,
    });
    expect(motion.outcome).toBe('lost');
    expect(motion.noes).toBe(3);
    expect(motion.rationale).toContain('withdraws its confidence');
  });

  it('sustains on an even record rather than withdrawing on a tie', () => {
    const motion = putConfidenceMotion({ subject: 'pm', constituencies, tally: { carried: 2, defeated: 2 }, consecutiveFailures: 3 });
    expect(motion.outcome).toBe('sustained');
  });

  it('does not withdraw confidence on speculation when there is no record', () => {
    const motion = putConfidenceMotion({ subject: 'pm', constituencies, tally: { carried: 0, defeated: 0 }, consecutiveFailures: 3 });
    expect(motion.outcome).toBe('sustained');
    expect(motion.abstentions).toBe(3);
  });
});
