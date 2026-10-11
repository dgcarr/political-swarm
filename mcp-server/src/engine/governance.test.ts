import { describe, expect, it, vi } from 'vitest';
import type { Ledger } from './Ledger.js';
import type { LedgerEntry } from './Ledger.js';
import type { RunState } from './RunStore.js';
import {
  digestArtifact,
  GovernanceHaltError,
  requireGovernanceAction,
  grantGovernanceMandate,
  nextGovernanceDecisionId,
  requireAssignmentAuthority,
  recordGovernanceDecision,
  requireGovernanceMandate,
  RevokedMandateError,
  revokeGovernanceMandate,
  restoreGovernanceFromLedger,
  type GovernanceDecision,
} from './governance.js';
import type { RuleId } from '../constitution/rules.js';

function fixture() {
  return {
    state: { governanceDecisions: [], governanceMandates: [] } as unknown as RunState,
    ledger: { record: vi.fn() } as unknown as Ledger,
  };
}

const decision: GovernanceDecision = {
  id: 'division:task:1',
  body: 'commons',
  subject: 'task',
  artifactDigest: digestArtifact({ version: 1 }),
  rule: 'simple_majority',
  eligible: ['frontend', 'testing'],
  positions: [{ actor: 'frontend', choice: 'aye' }, { actor: 'testing', choice: 'abstain' }],
  evidenceRefs: ['check:unit'],
  result: 'approved',
  nextAction: 'execute',
};

describe('governance records', () => {
  it('rejects duplicate and foreign ballots', () => {
    const { state, ledger } = fixture();
    expect(() => recordGovernanceDecision(state, ledger, {
      ...decision,
      positions: [...decision.positions, { actor: 'frontend', choice: 'no' }],
    })).toThrow(/Duplicate/);
    expect(() => recordGovernanceDecision(state, ledger, {
      ...decision,
      positions: [{ actor: 'outsider', choice: 'aye' }],
    })).toThrow(/Ineligible/);
  });

  it('halts on a recorded result the ballots do not support under the named rule', () => {
    const { state, ledger } = fixture();
    expect(() => recordGovernanceDecision(state, ledger, {
      ...decision,
      positions: [{ actor: 'frontend', choice: 'aye' }, { actor: 'testing', choice: 'no' }],
    })).toThrow(GovernanceHaltError);
    expect(() => recordGovernanceDecision(state, ledger, {
      ...decision, rule: 'member-council-majority-acceptance-v1', result: 'approve',
      positions: [{ actor: 'frontend', choice: 'approve' }, { actor: 'testing', choice: 'abstain' }],
    })).toThrow(/does not carry|do not carry/);
    expect(state.governanceDecisions).toHaveLength(0);
    expect(ledger.record).not.toHaveBeenCalled();
  });

  it('refuses a rule the constitution does not define, and does not tally a market award', () => {
    const { state, ledger } = fixture();
    expect(() => recordGovernanceDecision(state, ledger, { ...decision, rule: 'simple-majority' as RuleId }))
      .toThrow(/names no constitutional rule/);
    expect(() => recordGovernanceDecision(state, ledger, {
      ...decision, id: 'award:task:1', rule: 'published-weighted-bid-score', result: 'testing',
      positions: [{ actor: 'frontend', choice: '120' }, { actor: 'testing', choice: '90' }],
    })).not.toThrow();
  });

  it('records once and refuses a conflicting replay', () => {
    const { state, ledger } = fixture();
    recordGovernanceDecision(state, ledger, decision);
    recordGovernanceDecision(state, ledger, decision);
    expect(state.governanceDecisions).toHaveLength(1);
    expect(ledger.record).toHaveBeenCalledTimes(1);
    expect(() => recordGovernanceDecision(state, ledger, { ...decision, result: 'rejected' })).toThrow(/Conflicting/);
  });

  // democratic-murzhjer lost four tasks to "Conflicting replay of decision confidence-3-13": the
  // question was put twice before another task completed, under an id keyed by that count.
  it('numbers a series so a second decision on the same subject never reuses the first id', () => {
    const { state, ledger } = fixture();
    const first = nextGovernanceDecisionId(state, 'confidence-3-');
    recordGovernanceDecision(state, ledger, { ...decision, id: first, result: 'approved' });
    const second = nextGovernanceDecisionId(state, 'confidence-3-');
    recordGovernanceDecision(state, ledger, { ...decision, id: second, result: 'rejected' });

    expect([first, second]).toEqual(['confidence-3-1', 'confidence-3-2']);
    expect(nextGovernanceDecisionId(state, 'confidence-31-')).toBe('confidence-31-1');
  });

  it('revokes authority and rejects a stale artifact version', () => {
    const { state, ledger } = fixture();
    const mandate = {
      id: 'plan:1', grantor: 'council', holder: 'delegate', scope: ['ordering'], artifactDigest: decision.artifactDigest,
    };
    grantGovernanceMandate(state, ledger, mandate);
    requireGovernanceMandate(state, mandate.id, 'delegate', decision.artifactDigest);
    expect(() => requireGovernanceMandate(state, mandate.id, 'delegate', digestArtifact({ version: 2 }))).toThrow(/does not authorize/);
    revokeGovernanceMandate(state, ledger, mandate.id);
    expect(() => requireGovernanceMandate(state, mandate.id, 'delegate', decision.artifactDigest)).toThrow(RevokedMandateError);
    grantGovernanceMandate(state, ledger, mandate);
    expect(() => requireGovernanceMandate(state, mandate.id, 'delegate', decision.artifactDigest)).toThrow(RevokedMandateError);
  });

  it('checks assignment scope and revocation at the engine dispatch boundary', () => {
    const { state, ledger } = fixture();
    grantGovernanceMandate(state, ledger, {
      id: 'work:task', grantor: 'council', holder: 'delegate', scope: ['task'], artifactDigest: decision.artifactDigest,
    });
    const assignment = {
      taskId: 'task', assigneeId: 'worker', role: 'implementer' as const,
      meta: { authority: { mandateId: 'work:task', holder: 'delegate', artifactDigest: decision.artifactDigest } },
    };
    expect(() => requireAssignmentAuthority(state, assignment)).not.toThrow();
    expect(() => requireAssignmentAuthority(state, { ...assignment, meta: {} }, true))
      .toThrow(/missing a governance mandate/);
    expect(() => requireAssignmentAuthority(state, { ...assignment, taskId: 'other' })).toThrow(/does not authorize/);
    revokeGovernanceMandate(state, ledger, 'work:task');
    expect(() => requireAssignmentAuthority(state, assignment)).toThrow(RevokedMandateError);
  });

  it('restores durable decisions and revoked mandates once after an interrupted transition', () => {
    const { state, ledger } = fixture();
    recordGovernanceDecision(state, ledger, decision);
    grantGovernanceMandate(state, ledger, {
      id: 'work:task', grantor: 'council', holder: 'delegate', scope: ['task'], artifactDigest: decision.artifactDigest,
    });
    revokeGovernanceMandate(state, ledger, 'work:task');
    const events = vi.mocked(ledger.record).mock.calls.map(([type, data]) => ({
      ts: '2026-01-01T00:00:00Z', runId: 'run', strategy: 'socialist' as const, type,
      data,
    })) as LedgerEntry[];
    const resumed = { governanceDecisions: [], governanceMandates: [] } as unknown as RunState;

    restoreGovernanceFromLedger(resumed, events);
    restoreGovernanceFromLedger(resumed, events);

    expect(resumed.governanceDecisions).toEqual([decision]);
    expect(resumed.governanceMandates).toEqual([expect.objectContaining({ id: 'work:task', revoked: true })]);
    expect(() => recordGovernanceDecision(resumed, ledger, decision)).not.toThrow();
    expect(ledger.record).toHaveBeenCalledTimes(3);
  });

  it('requires every cited final decision to approve the exact delivery version', () => {
    const { state, ledger } = fixture();
    const finalDecision = {
      ...decision,
      id: 'delivery:council-a',
      rule: 'member-council-majority-acceptance-v1' as const,
      positions: [{ actor: 'frontend', choice: 'approve' }, { actor: 'testing', choice: 'approve' }],
      result: 'approve',
      nextAction: 'accept-delivery',
    };
    recordGovernanceDecision(state, ledger, finalDecision);
    const proof = {
      artifactDigest: finalDecision.artifactDigest,
      decisionIds: [finalDecision.id],
      action: 'accept-delivery',
    };

    expect(() => requireGovernanceAction(state, proof, finalDecision.artifactDigest, 'accept-delivery')).not.toThrow();
    expect(() => requireGovernanceAction(state, proof, digestArtifact({ version: 2 }), 'accept-delivery'))
      .toThrow(/no valid governance action proof/);
    expect(() => requireGovernanceAction(state, { ...proof, decisionIds: [...proof.decisionIds, 'missing'] },
      finalDecision.artifactDigest, 'accept-delivery')).toThrow(/does not authorize/);
    expect(() => requireGovernanceAction(state, { ...proof, decisionIds: [finalDecision.id, finalDecision.id] },
      finalDecision.artifactDigest, 'accept-delivery')).toThrow(/no valid governance action proof/);
    expect(() => requireGovernanceAction(state, proof, finalDecision.artifactDigest, 'accept-delivery',
      ['task', 'other-task'])).toThrow(/omits a required subject/);
  });
});
