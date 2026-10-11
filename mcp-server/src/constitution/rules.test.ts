import { describe, expect, it } from 'vitest';
import { tallyConfidenceBallots } from '../strategies/democratic/cabinet.js';
import { tallyAmendmentBallots, tallyChamberSupermajority, type Vote } from '../strategies/democratic/commons.js';
import { tallyElection } from '../strategies/democratic/offices.js';
import { computeVote } from '../strategies/democratic/vote.js';
import {
  tallyCouncilAcceptance,
  tallyCouncilPlanBallots,
  tallyCouncilRecallBallots,
  type WorkerCouncil,
} from '../strategies/socialist/councils.js';
import { THRESHOLD_LABELS } from './schema.js';
import { carries, evaluateRule, resultDisagreement, RULE_IDS, shareMeets, type RuleId } from './rules.js';

/** Every assignment of `choices` to an electorate of each size up to `maxSize`. */
function* electorates<T extends string>(choices: readonly T[], maxSize = 5): Generator<{ actor: string; choice: T }[]> {
  for (let size = 1; size <= maxSize; size += 1) {
    const total = choices.length ** size;
    for (let n = 0; n < total; n += 1) {
      let rest = n;
      yield Array.from({ length: size }, (_, index) => {
        const choice = choices[rest % choices.length];
        rest = Math.floor(rest / choices.length);
        return { actor: `member-${index + 1}`, choice };
      });
    }
  }
}

function council(members: string[]): WorkerCouncil {
  return { id: 'council-x', taskId: 'x', guilds: ['backend'], members, delegate: members[0], termId: 1 };
}

function agrees(rule: RuleId, positions: { actor: string; choice: string }[], result: string): void {
  expect(resultDisagreement(rule, positions.length, positions, result), `${rule} ${JSON.stringify(positions)}`).toBeNull();
}

describe('evaluateRule', () => {
  it('measures simple_majority against votes cast and three_fifths at or above the line', () => {
    const ballots = (ayes: number, noes: number, abstain: number) => [
      ...Array.from({ length: ayes }, (_, i) => ({ actor: `a${i}`, choice: 'aye' })),
      ...Array.from({ length: noes }, (_, i) => ({ actor: `n${i}`, choice: 'no' })),
      ...Array.from({ length: abstain }, (_, i) => ({ actor: `x${i}`, choice: 'abstain' })),
    ];
    expect(carries('simple_majority', 8, ballots(1, 0, 7))).toBe(true);
    expect(carries('simple_majority', 8, ballots(1, 1, 6))).toBe(false);
    expect(carries('three_fifths', 5, ballots(3, 2, 0))).toBe(true);
    expect(carries('three_fifths', 8, ballots(3, 3, 2))).toBe(false);
  });

  it('counts two_thirds_both_chambers against every seated member, so abstentions cannot carry it', () => {
    const positions = [
      { actor: 'a', choice: 'aye' }, { actor: 'b', choice: 'aye' },
      { actor: 'c', choice: 'abstain' }, { actor: 'd', choice: 'abstain' },
    ];
    expect(carries('two_thirds_both_chambers', 4, positions)).toBe(false);
    expect(carries('two_thirds_both_chambers', 3, positions.slice(0, 3))).toBe(true);
  });

  it('leaves a non-ballot decision untallied', () => {
    expect(evaluateRule('published-weighted-bid-score', 3, [{ actor: 'bidder-1', choice: '120' }]))
      .toEqual({ kind: 'recorded' });
    expect(resultDisagreement('published-weighted-bid-score', 3, [], 'bidder-2')).toBeNull();
  });

  it('defines a rule for every threshold label the config may name', () => {
    for (const label of THRESHOLD_LABELS) expect(RULE_IDS).toContain(label);
  });

  it('refuses an approval the division did not carry', () => {
    const positions = [{ actor: 'a', choice: 'aye' }, { actor: 'b', choice: 'no' }];
    expect(resultDisagreement('simple_majority', 2, positions, 'approved')).toMatch(/do not carry/);
    expect(resultDisagreement('simple_majority', 2, positions, 'rejected')).toBeNull();
    expect(resultDisagreement('human_required', 2, positions, 'approved')).toMatch(/needs_human/);
  });
});

// Each doctrine still tallies in its own module. These sweep every small electorate to prove the
// tallies and the declared rules agree, so the engine's check can never refuse an honest record.
describe('the declared rules agree with every doctrine tally', () => {
  it('Commons amendment', () => {
    for (const positions of electorates(['aye', 'no', 'abstain'] as const)) {
      const carried = tallyAmendmentBallots(positions.map((p) => p.actor),
        positions.map((p) => ({ constituency: p.actor, vote: p.choice as Vote })));
      agrees('simple-majority-of-engaged-with-quorum', positions, carried ? 'adopted' : 'defeated');
    }
  });

  it('House of Review and Security Committee', () => {
    for (const positions of electorates(['aye', 'no', 'abstain'] as const)) {
      const carried = tallyChamberSupermajority(positions.map((p) => p.actor),
        positions.map((p) => ({ member: p.actor, vote: p.choice as Vote })));
      agrees('two-thirds-of-all-seated-members', positions, carried ? 'carried' : 'defeated');
      agrees('two-thirds-of-seated-security-panel', positions, carried ? 'approved' : 'withheld');
    }
  });

  it('confidence motion, including members who never returned a ballot', () => {
    for (const positions of electorates(['aye', 'no', 'abstain', 'absent'] as const)) {
      const cast = positions.filter((p) => p.choice !== 'absent');
      const motion = tallyConfidenceBallots('pm', positions.map((p) => p.actor),
        cast.map((p) => ({ elector: p.actor, choice: p.choice as 'aye' | 'no' | 'abstain' })));
      expect(resultDisagreement('equal-representative-ballot-quorum-half-simple-majority-v1', positions.length,
        cast, motion.outcome)).toBeNull();
    }
  });

  it('constituency and coordinator elections', () => {
    const candidates = ['c1', 'c2', 'c3'];
    for (const positions of electorates(['c1', 'c2', 'c3', 'abstain', 'absent'] as const, 4)) {
      const cast = positions.filter((p) => p.choice !== 'absent');
      const result = tallyElection(positions.map((p) => p.actor), candidates,
        cast.map((p) => ({ elector: p.actor, candidate: p.choice === 'abstain' ? null : p.choice })));
      expect(resultDisagreement('equal-ballot-plurality-quorum-half-tie-roster-order-v1', positions.length,
        cast, result.winner ?? 'no-mandate')).toBeNull();
    }
  });

  it('socialist council plan ratification, recall and delivery acceptance', () => {
    for (const positions of electorates(['approve', 'amend', 'reject', 'abstain'] as const)) {
      const members = positions.map((p) => p.actor);
      const plan = tallyCouncilPlanBallots(council(members), positions.map((p) => ({ member: p.actor, choice: p.choice })));
      agrees('member-council-ratification-v1', positions, plan.choice);
    }
    for (const positions of electorates(['recall', 'retain', 'abstain'] as const)) {
      const carried = tallyCouncilRecallBallots(council(positions.map((p) => p.actor)),
        positions.map((p) => ({ member: p.actor, choice: p.choice })));
      agrees('member-initiated-absolute-majority-recall-v1', positions, carried ? 'recalled' : 'retained');
    }
    for (const positions of electorates(['approve', 'reject', 'abstain'] as const)) {
      const acceptance = tallyCouncilAcceptance(council(positions.map((p) => p.actor)),
        positions.map((p) => ({ member: p.actor, choice: p.choice, reason: 'r' })));
      agrees('member-council-majority-acceptance-v1', positions, acceptance.choice);
    }
    for (const choice of ['approve', 'amend', 'reject'] as const) {
      agrees('delegated-council-ratification-v1', [{ actor: 'delegate', choice }], choice);
    }
    for (const choice of ['approve', 'reject', 'abstain'] as const) {
      agrees('delegated-council-unanimous-acceptance-v1', [{ actor: 'delegate', choice }], choice);
    }
  });

  it('the Commons division under each routine label', () => {
    for (const label of ['simple_majority', 'three_fifths'] as const) {
      for (const positions of electorates(['aye', 'no', 'abstain'] as const)) {
        const ayes = positions.filter((p) => p.choice === 'aye').length;
        const noes = positions.filter((p) => p.choice === 'no').length;
        const vote = computeVote({
          category: label === 'simple_majority' ? 'routine' : 'cross_module', thresholdLabel: label,
          committeeApproveScore: 1, oppositionVerdict: 'approve', oppositionSeverity: 'low',
          divisionShare: ayes + noes === 0 ? null : ayes / (ayes + noes),
        });
        agrees(label, positions, vote.outcome);
        expect(vote.voteWouldPass).toBe(shareMeets(label, ayes + noes === 0 ? null : ayes / (ayes + noes)));
      }
    }
  });
});
