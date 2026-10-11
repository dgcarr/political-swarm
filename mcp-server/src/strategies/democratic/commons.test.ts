import { describe, expect, it } from 'vitest';
import {
  callDivision,
  committeeSignal,
  divisionShare,
  engagedConstituencies,
  expressedDivision,
  tallyAmendmentBallots,
  tallyChamberSupermajority,
  leadConstituency,
  misrepresentations,
  type DivisionInput,
} from './commons.js';
import type { CommitteeFinding } from './types.js';

const CONSTITUENCIES = [
  'frontend',
  'backend',
  'data',
  'security',
  'testing',
  'documentation',
  'user-experience',
  'operations',
];

it('requires a separate eligible majority and quorum for a repair amendment', () => {
  const eligible = ['backend', 'testing', 'security'];
  expect(tallyAmendmentBallots(eligible, [
    { constituency: 'backend', vote: 'aye' }, { constituency: 'testing', vote: 'aye' },
    { constituency: 'security', vote: 'no' },
  ])).toBe(true);
  expect(tallyAmendmentBallots(eligible, [
    { constituency: 'backend', vote: 'aye' }, { constituency: 'testing', vote: 'abstain' },
    { constituency: 'security', vote: 'abstain' },
  ])).toBe(false);
  expect(() => tallyAmendmentBallots(eligible, [
    { constituency: 'backend', vote: 'aye' }, { constituency: 'testing', vote: 'aye' },
    { constituency: 'testing', vote: 'aye' },
  ])).toThrow('Duplicate');
});

it('requires two thirds of every House seat for a constitutional motion', () => {
  const seats = ['a', 'b', 'c'];
  expect(tallyChamberSupermajority(seats, [
    { member: 'a', vote: 'aye' }, { member: 'b', vote: 'aye' }, { member: 'c', vote: 'no' },
  ])).toBe(true);
  expect(tallyChamberSupermajority(seats, [
    { member: 'a', vote: 'aye' }, { member: 'b', vote: 'abstain' }, { member: 'c', vote: 'no' },
  ])).toBe(false);
  expect(() => tallyChamberSupermajority(seats, [
    { member: 'a', vote: 'aye' }, { member: 'b', vote: 'aye' }, { member: 'b', vote: 'aye' },
  ])).toThrow('Duplicate');
});

function committee(verdicts: CommitteeFinding['verdict'][]): CommitteeFinding[] {
  return verdicts.map((verdict, i) => ({
    personaId: `member-${i + 1}`,
    portfolioTag: 'backend',
    seat: i < 2 ? 'elected' : 'sortition',
    verdict,
    rationale: `${verdict} rationale`,
  }));
}

function divisionInput(overrides: Partial<DivisionInput> = {}): DivisionInput {
  return {
    constituencies: CONSTITUENCIES,
    representatives: Object.fromEntries(CONSTITUENCIES.map((c) => [c, `rep-${c}`])),
    engaged: ['backend'],
    committeeFindings: committee(['approve', 'approve']),
    oppositionVerdict: 'approve',
    oppositionSeverity: 'low',
    test: { ran: true, passed: true },
    ...overrides,
  };
}

describe('constituency routing', () => {
  it('maps a portfolio tag onto the constituency that answers for it', () => {
    expect(leadConstituency('docs', CONSTITUENCIES)).toBe('documentation');
    expect(leadConstituency('verification', CONSTITUENCIES)).toBe('testing');
    expect(leadConstituency('release-operations', CONSTITUENCIES)).toBe('operations');
  });

  it('passes through a tag that is already a constituency', () => {
    expect(leadConstituency('security', CONSTITUENCIES)).toBe('security');
  });

  it('falls back rather than inventing a constituency for an unknown tag', () => {
    expect(CONSTITUENCIES).toContain(leadConstituency('general', CONSTITUENCIES));
  });
});

describe('who has something to go on', () => {
  const base = {
    portfolioTag: 'backend',
    riskClass: 'low' as const,
    touchedPaths: ['src/util/helper.ts'],
    test: { ran: false, passed: false },
    securityPathGlobs: ['**/auth/**'],
  };

  it('engages the constituency the motion was referred to', () => {
    expect(engagedConstituencies(base, CONSTITUENCIES)).toContain('backend');
  });

  it('leaves untouched constituencies out, so their members abstain', () => {
    expect(engagedConstituencies(base, CONSTITUENCIES)).not.toContain('user-experience');
  });

  it('engages security on a high-risk motion wherever it was referred', () => {
    expect(engagedConstituencies({ ...base, riskClass: 'high' }, CONSTITUENCIES)).toContain('security');
  });

  it('engages security on a protected path', () => {
    expect(engagedConstituencies({ ...base, touchedPaths: ['src/auth/login.ts'] }, CONSTITUENCIES)).toContain('security');
  });

  it('engages testing exactly when a check actually ran', () => {
    expect(engagedConstituencies(base, CONSTITUENCIES)).not.toContain('testing');
    expect(engagedConstituencies({ ...base, test: { ran: true, passed: true } }, CONSTITUENCIES)).toContain('testing');
  });

  it('engages a constituency named in a path the motion touches', () => {
    expect(engagedConstituencies({ ...base, touchedPaths: ['src/frontend/app.ts'] }, CONSTITUENCIES)).toContain('frontend');
  });

  it('returns constituencies in the chamber’s own order, not discovery order', () => {
    const engaged = engagedConstituencies({ ...base, riskClass: 'high', touchedPaths: ['src/frontend/a.ts'] }, CONSTITUENCIES);
    expect(engaged).toEqual(CONSTITUENCIES.filter((c) => engaged.includes(c)));
  });
});

describe('the committee signal', () => {
  it('averages the members who voted', () => {
    expect(committeeSignal(committee(['approve', 'reject']))).toBe(0.5);
    expect(committeeSignal(committee(['approve', 'flag']))).toBe(0.75);
  });

  it('drops abstentions from the average rather than scoring them at a half', () => {
    expect(committeeSignal(committee(['approve', 'abstain']))).toBe(1);
    expect(committeeSignal(committee(['reject', 'abstain']))).toBe(0);
  });

  it('returns no signal at all when every member abstained', () => {
    expect(committeeSignal(committee(['abstain', 'abstain']))).toBeNull();
  });

  it('returns no signal for an empty committee', () => {
    expect(committeeSignal([])).toBeNull();
  });
});

describe('the division', () => {
  it('counts only engaged members, and abstains the rest', () => {
    const division = callDivision(divisionInput());
    expect(division.ayes).toBe(1);
    expect(division.noes).toBe(0);
    expect(division.abstentions).toBe(CONSTITUENCIES.length - 1);
  });

  it('carries the constituency view where the evidence does not contradict it', () => {
    const division = callDivision(divisionInput({ committeeFindings: committee(['reject', 'reject']) }));
    expect(division.noes).toBe(1);
    expect(division.departures).toEqual([]);
  });

  // A departure is confined to the member's own remit. The testing member can read the check, so a
  // failure is its business to act on; it is not a licence for every other member to follow.
  it('departs the testing member from an approving committee when the check failed', () => {
    const division = callDivision(
      divisionInput({ engaged: ['backend', 'testing'], test: { ran: true, passed: false } }),
    );
    expect(division.departures).toEqual(['testing']);
    expect(division.ayes).toBe(1);
    expect(division.noes).toBe(1);
    expect(division.votes.find((v) => v.constituency === 'testing')!.rationale).toContain('the check ran and failed');
  });

  it('leaves a member with no evidence of its own carrying the committee view', () => {
    const division = callDivision(
      divisionInput({ engaged: ['backend', 'testing'], test: { ran: true, passed: false } }),
    );
    expect(division.votes.find((v) => v.constituency === 'backend')!.vote).toBe('aye');
  });

  it('departs the security member when the Opposition raises a high-severity objection', () => {
    const division = callDivision(
      divisionInput({ engaged: ['backend', 'security'], oppositionVerdict: 'reject', oppositionSeverity: 'high' }),
    );
    expect(division.departures).toEqual(['security']);
  });

  it('does not depart the security member on an objection below high severity', () => {
    const division = callDivision(
      divisionInput({ engaged: ['backend', 'security'], oppositionVerdict: 'flag', oppositionSeverity: 'medium' }),
    );
    expect(division.departures).toEqual([]);
  });

  // The whole point of a chamber: without this the share is only ever 0 or 1, and simple majority,
  // three-fifths and two-thirds all become the same test.
  it('can split, so the configured thresholds actually distinguish anything', () => {
    const division = callDivision(
      divisionInput({ engaged: ['backend', 'security', 'testing'], test: { ran: true, passed: false } }),
    );
    expect(divisionShare(division)).toBeCloseTo(2 / 3);
  });

  // Section 3 states Burke's trustee one way: a member may refuse a motion the evidence
  // contradicts. It does not license carrying one the constituency doubts because CI is green.
  it('does not depart from a rejecting committee merely because the tests passed', () => {
    const division = callDivision(
      divisionInput({ committeeFindings: committee(['reject', 'reject']), test: { ran: true, passed: true } }),
    );
    expect(division.departures).toEqual([]);
    expect(division.noes).toBe(1);
  });

  it('abstains on an evenly divided committee rather than breaking the tie uninformed', () => {
    const division = callDivision(divisionInput({ committeeFindings: committee(['approve', 'reject']) }));
    expect(division.ayes).toBe(0);
    expect(division.noes).toBe(0);
    expect(division.abstentions).toBe(CONSTITUENCIES.length);
  });

  it('does not turn a lone committee flag into representative approval', () => {
    const division = callDivision(divisionInput({ committeeFindings: committee(['flag']) }));
    expect(division.ayes).toBe(0);
    expect(division.noes).toBe(0);
    expect(division.abstentions).toBe(CONSTITUENCIES.length);
  });

  it('still blocks outright on a lone committee member\'s reject', () => {
    const division = callDivision(divisionInput({ committeeFindings: committee(['reject']) }));
    expect(division.ayes).toBe(0);
    expect(division.noes).toBe(1);
  });

  it('still abstains a genuinely split two-member committee even though the score also averages 0.5', () => {
    const division = callDivision(divisionInput({ committeeFindings: committee(['approve', 'flag', 'flag', 'reject']) }));
    // (1 + 0.5 + 0.5 + 0) / 4 = 0.5, from four real voices in real disagreement, not one hedge.
    expect(division.ayes).toBe(0);
    expect(division.noes).toBe(0);
    expect(division.abstentions).toBe(CONSTITUENCIES.length);
  });

  it('abstains everyone when the committee returned no view to represent', () => {
    const division = callDivision(divisionInput({ committeeFindings: committee(['abstain', 'abstain']) }));
    expect(division.abstentions).toBe(CONSTITUENCIES.length);
  });

  it('names the elected member for each seat', () => {
    const division = callDivision(divisionInput());
    expect(division.votes.find((v) => v.constituency === 'backend')!.personaId).toBe('rep-backend');
  });

  it('falls back to a seat name when a constituency has no returned member', () => {
    const division = callDivision(divisionInput({ representatives: {} }));
    expect(division.votes[0].personaId).toBe('representative-frontend');
  });
});

describe('the division share', () => {
  it('excludes abstentions from the denominator', () => {
    const division = callDivision(divisionInput({ engaged: ['backend', 'testing'] }));
    expect(divisionShare(division)).toBe(1);
  });

  it('is null when nobody was in a position to vote', () => {
    const division = callDivision(divisionInput({ engaged: [] }));
    expect(divisionShare(division)).toBeNull();
  });

  it('reports a split division as a fraction of those voting', () => {
    const division = callDivision(divisionInput({ engaged: ['backend', 'testing'], test: { ran: true, passed: false } }));
    expect(divisionShare(division)).toBe(0.5);
  });
});

describe('misrepresentation', () => {
  it('counts a member who carried a motion the House then refused', () => {
    const division = callDivision(divisionInput());
    expect(misrepresentations(division, 'rejected')).toEqual(['backend']);
  });

  it('counts nothing when the motion was carried', () => {
    const division = callDivision(divisionInput());
    expect(misrepresentations(division, 'approved')).toEqual([]);
  });

  it('never counts a departure, which came with its evidence attached', () => {
    const division = callDivision(
      divisionInput({ engaged: ['backend', 'testing'], test: { ran: true, passed: false } }),
    );
    // backend carried the committee view and was wrong; testing departed on the check and was not.
    expect(misrepresentations(division, 'rejected')).toEqual(['backend']);
    expect(division.departures).toEqual(['testing']);
  });
});

describe('expressed Commons ballots', () => {
  it('requires a ballot from every engaged representative and ignores no advisory substitute', () => {
    const base = callDivision(divisionInput({ engaged: ['backend', 'testing'] }));
    expect(() => expressedDivision(base, ['backend', 'testing'], [
      { constituency: 'backend', vote: 'no', rationale: 'Inspected the change.' },
    ])).toThrow('Missing representative ballot');
    const expressed = expressedDivision(base, ['backend', 'testing'], [
      { constituency: 'backend', vote: 'no', rationale: 'Inspected the change.' },
      { constituency: 'testing', vote: 'aye', rationale: 'The test passed.' },
    ]);
    expect(expressed).toMatchObject({ ayes: 1, noes: 1, abstentions: 6 });
  });
});
