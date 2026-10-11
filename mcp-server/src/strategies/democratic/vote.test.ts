import { describe, it, expect } from 'vitest';
import { computeVote, classifyThresholdCategory, classifyMotionClass, committeeApproveScore } from './vote.js';
import type { VoteInputs } from './types.js';
import type { TestResult } from '../../engine/types.js';

const passingTest: TestResult = { ran: true, passed: true };
const noTestEvidence: TestResult = { ran: false, passed: false };

describe('classifyThresholdCategory', () => {
  it('maps low/medium/high riskClass to routine/cross_module/security_boundary', () => {
    expect(classifyThresholdCategory('low', passingTest, ['src/a.js'])).toBe('routine');
    expect(classifyThresholdCategory('medium', passingTest, ['src/a.js'])).toBe('cross_module');
    expect(classifyThresholdCategory('high', passingTest, ['src/auth/a.js'])).toBe('security_boundary');
  });

  it('treats missing test evidence as an implicit test_waiver regardless of riskClass', () => {
    expect(classifyThresholdCategory('low', noTestEvidence, ['src/a.js'])).toBe('test_waiver');
  });

  it('treats touching the swarm\'s own governance/config surface as a constitutional_amendment', () => {
    expect(classifyThresholdCategory('low', passingTest, ['config/models.yaml'])).toBe('constitutional_amendment');
    expect(classifyThresholdCategory('low', passingTest, ['mcp-server/src/engine/SwarmEngine.ts'])).toBe('constitutional_amendment');
  });
});

describe('classifyMotionClass', () => {
  it('maps riskClass to motion class', () => {
    expect(classifyMotionClass('low')).toBe('routine');
    expect(classifyMotionClass('medium')).toBe('committee');
    expect(classifyMotionClass('high')).toBe('emergency');
  });
});

describe('committeeApproveScore', () => {
  it('averages approve=1/flag=0.5/reject=0 across findings', () => {
    expect(
      committeeApproveScore([
        { personaId: 'a', portfolioTag: 'x', seat: 'elected', verdict: 'approve', rationale: '' },
        { personaId: 'b', portfolioTag: 'x', seat: 'elected', verdict: 'reject', rationale: '' },
      ]),
    ).toBe(0.5);
    expect(
      committeeApproveScore([{ personaId: 'a', portfolioTag: 'x', seat: 'sortition', verdict: 'flag', rationale: '' }]),
    ).toBe(0.5);
  });

  it('returns 0 for no findings rather than dividing by zero', () => {
    expect(committeeApproveScore([])).toBe(0);
  });
});

function voteInputs(overrides: Partial<VoteInputs>): VoteInputs {
  return {
    category: 'routine',
    thresholdLabel: 'simple_majority',
    committeeApproveScore: 1,
    oppositionVerdict: 'approve',
    oppositionSeverity: 'low',
    ...overrides,
    divisionShare: overrides.divisionShare === undefined ? overrides.committeeApproveScore ?? 1 : overrides.divisionShare,
  };
}

describe('computeVote', () => {
  it('does not let a committee substitute for an absent representative division', () => {
    const result = computeVote(voteInputs({ committeeApproveScore: 1, divisionShare: null }));
    expect(result.outcome).toBe('rejected');
  });
  it('approves a routine motion with committee support and no opposition block', () => {
    const result = computeVote(voteInputs({ category: 'routine', thresholdLabel: 'simple_majority', committeeApproveScore: 0.75 }));
    expect(result.outcome).toBe('approved');
  });

  it('rejects a routine motion when the committee score does not clear a strict majority', () => {
    const result = computeVote(voteInputs({ category: 'routine', thresholdLabel: 'simple_majority', committeeApproveScore: 0.5 }));
    // 'routine' requires score > fraction (strictly greater than 0.5), so exactly 0.5 fails.
    expect(result.outcome).toBe('rejected');
  });

  it('sends a motion back once to answer a non-low-severity opposition reject, whatever the score', () => {
    const result = computeVote(
      voteInputs({ category: 'routine', committeeApproveScore: 1, oppositionVerdict: 'reject', oppositionSeverity: 'medium' }),
    );
    expect(result.outcome).toBe('rejected');
    expect(result.rationale).toMatch(/Government to answer/);
  });

  it('gives the opposition no veto: once its reject has been answered, the House decides', () => {
    const answered = computeVote(
      voteInputs({ category: 'routine', committeeApproveScore: 1, oppositionVerdict: 'reject', oppositionSeverity: 'high', oppositionAnswered: true }),
    );
    expect(answered.outcome).toBe('approved');
    expect(answered.rationale).toMatch(/minority report/);

    const stillShort = computeVote(
      voteInputs({ category: 'routine', committeeApproveScore: 0.5, oppositionVerdict: 'reject', oppositionSeverity: 'high', oppositionAnswered: true }),
    );
    expect(stillShort.outcome).toBe('rejected');
  });

  it('does NOT let a low-severity opposition reject veto an otherwise-passing routine vote', () => {
    const result = computeVote(
      voteInputs({ category: 'routine', committeeApproveScore: 1, oppositionVerdict: 'reject', oppositionSeverity: 'low' }),
    );
    expect(result.outcome).toBe('approved');
  });

  it('always routes security_boundary to a human, even when the vote would have passed', () => {
    const result = computeVote(
      voteInputs({
        category: 'security_boundary',
        thresholdLabel: 'two_thirds_plus_security_committee',
        committeeApproveScore: 1,
        oppositionVerdict: 'approve',
        oppositionSeverity: 'low',
      }),
    );
    expect(result.outcome).toBe('needs_human');
    expect(result.voteWouldPass).toBe(true);
  });

  it('always routes constitutional_amendment and test_waiver to a human', () => {
    expect(computeVote(voteInputs({ category: 'constitutional_amendment', thresholdLabel: 'two_thirds_both_chambers' })).outcome).toBe(
      'needs_human',
    );
    expect(computeVote(voteInputs({ category: 'test_waiver', thresholdLabel: 'human_required' })).outcome).toBe('needs_human');
  });

  it('routes any category to a human when its configured threshold is a human one', () => {
    expect(computeVote(voteInputs({ category: 'routine', thresholdLabel: 'human_required' })).outcome).toBe('needs_human');
  });

  it('flags high-severity opposition findings as blocking security_boundary\'s hypothetical pass', () => {
    const result = computeVote(
      voteInputs({
        category: 'security_boundary',
        thresholdLabel: 'two_thirds_plus_security_committee',
        committeeApproveScore: 1,
        oppositionVerdict: 'flag',
        oppositionSeverity: 'high',
      }),
    );
    expect(result.outcome).toBe('needs_human');
    expect(result.voteWouldPass).toBe(false);
  });
});
