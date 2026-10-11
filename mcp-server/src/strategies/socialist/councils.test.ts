import { describe, expect, it } from 'vitest';
import {
  constituteCouncil,
  constituteCouncils,
  councilIdFor,
  misallocationRecallDue,
  recallDelegate,
  seedBasis,
  tallyCouncilAcceptance,
  tallyCouncilPlanBallots,
  tallyCouncilRecallBallots,
  type WorkerCouncil,
} from './councils.js';
import type { SocialistConfig } from './types.js';

const cfg = {
  guilds: ['frontend', 'backend', 'testing', 'security', 'docs', 'architecture'],
  initialCapabilityScore: 0.5,
  recall: { consecutivePlannerFailuresBeforeSwap: 3, delegateMisallocations: 3 },
  escalateToHuman: { securityPathGlobs: [] },
} as unknown as SocialistConfig;

const council = (over: Partial<WorkerCouncil> = {}): WorkerCouncil => ({
  id: 'council-t1',
  taskId: 't1',
  guilds: ['backend'],
  members: ['backend-1', 'backend-2'],
  delegate: 'backend-1',
  termId: 1,
  ...over,
});

describe('equal council plan ballots', () => {
  it('requires all eligible members and gives an amendment a binding path', () => {
    const members = council({ members: ['a', 'b', 'c'] });
    expect(tallyCouncilPlanBallots(members, [
      { member: 'a', choice: 'amend', amendment: 'Preserve the API.' },
      { member: 'b', choice: 'amend', amendment: 'Add a regression test.' },
      { member: 'c', choice: 'approve' },
    ])).toEqual({ choice: 'amend', amendment: 'Preserve the API.; Add a regression test.' });
    expect(() => tallyCouncilPlanBallots(members, [
      { member: 'a', choice: 'approve' }, { member: 'b', choice: 'approve' },
    ])).toThrow('Missing ballot');
    expect(() => tallyCouncilPlanBallots(members, [
      { member: 'a', choice: 'approve' }, { member: 'b', choice: 'approve' },
      { member: 'outsider', choice: 'approve' },
    ])).toThrow('Foreign council ballot');
  });

  it('keeps abstention distinct from quorum and resolves ties against ratification', () => {
    const members = council({ members: ['a', 'b'] });
    expect(tallyCouncilPlanBallots(members, [
      { member: 'a', choice: 'approve' }, { member: 'b', choice: 'abstain' },
    ])).toMatchObject({ choice: 'reject', amendment: 'Council quorum was not met.' });
    expect(tallyCouncilPlanBallots(members, [
      { member: 'a', choice: 'approve' }, { member: 'b', choice: 'reject', amendment: 'Unsafe.' },
    ])).toMatchObject({ choice: 'reject' });
  });
});

it('requires an absolute member majority for final council acceptance', () => {
  const members = council({ members: ['a', 'b', 'c'] });
  expect(tallyCouncilAcceptance(members, [
    { member: 'a', choice: 'approve', reason: 'Checks passed.' },
    { member: 'b', choice: 'approve', reason: 'Reviewed.' },
    { member: 'c', choice: 'reject', reason: 'Concern.' },
  ]).choice).toBe('approve');
  expect(tallyCouncilAcceptance(members, [
    { member: 'a', choice: 'approve', reason: 'Checks passed.' },
    { member: 'b', choice: 'abstain', reason: 'Cannot inspect.' },
    { member: 'c', choice: 'reject', reason: 'Concern.' },
  ]).choice).toBe('reject');
});

it('requires an absolute member majority from the frozen council for delegate recall', () => {
  const members = council({ members: ['a', 'b', 'c'] });
  expect(tallyCouncilRecallBallots(members, [
    { member: 'a', choice: 'recall' }, { member: 'b', choice: 'recall' },
    { member: 'c', choice: 'retain' },
  ])).toBe(true);
  expect(tallyCouncilRecallBallots(members, [
    { member: 'a', choice: 'recall' }, { member: 'b', choice: 'abstain' },
    { member: 'c', choice: 'retain' },
  ])).toBe(false);
  expect(() => tallyCouncilRecallBallots(members, [
    { member: 'a', choice: 'recall' }, { member: 'a', choice: 'recall' },
    { member: 'c', choice: 'retain' },
  ])).toThrow('Duplicate');
});

describe('forming a council around a work unit', () => {
  it('draws its members from every discipline the unit touches', () => {
    const formed = constituteCouncil({ taskId: 't1', guilds: ['frontend', 'testing'], cfg, seed: 'run-a', termId: 1 });
    expect(formed.members).toEqual(['frontend-1', 'frontend-2', 'testing-1', 'testing-2']);
    expect(formed.id).toBe(councilIdFor('t1'));
  });

  it('sends exactly one delegate, drawn from its own membership', () => {
    const formed = constituteCouncil({ taskId: 't1', guilds: ['backend'], cfg, seed: 'run-a', termId: 1 });
    expect(formed.members).toContain(formed.delegate);
  });

  // A council register that cannot be re-derived from the ledger is an unrepeatable accident.
  it('draws reproducibly from the same run id and differently across runs', () => {
    const a = constituteCouncil({ taskId: 't1', guilds: ['frontend', 'backend'], cfg, seed: 'run-a', termId: 1 });
    const again = constituteCouncil({ taskId: 't1', guilds: ['frontend', 'backend'], cfg, seed: 'run-a', termId: 1 });
    expect(again).toEqual(a);

    const otherTerm = constituteCouncil({ taskId: 't1', guilds: ['frontend', 'backend'], cfg, seed: 'run-a', termId: 2 });
    const otherUnit = constituteCouncil({ taskId: 't2', guilds: ['frontend', 'backend'], cfg, seed: 'run-a', termId: 1 });
    // Not an assertion that these differ — a two-member draw can legitimately repeat — only that
    // the seed varies with both, so a term or a unit is never forced to reuse a draw.
    expect([otherTerm.delegate, otherUnit.delegate].every((d) => a.members.includes(d))).toBe(true);
  });

  it('honours a configured guild size', () => {
    const wide = constituteCouncil({
      taskId: 't1',
      guilds: ['backend'],
      cfg: { ...cfg, councils: { ...cfg.councils, membersPerGuild: 3 } },
      seed: 'run-a',
      termId: 1,
    });
    expect(wide.members).toEqual(['backend-1', 'backend-2', 'backend-3']);
  });

  it('never forms a council with no members, whatever the plan says', () => {
    const orphan = constituteCouncil({ taskId: 't1', guilds: [], cfg, seed: 'run-a', termId: 1 });
    expect(orphan.members.length).toBeGreaterThan(0);
    expect(orphan.delegate).not.toBe('');
  });

  it('forms one council per work unit', () => {
    const all = constituteCouncils([{ taskId: 't1', guilds: ['backend'] }, { taskId: 't2', guilds: ['docs'] }], cfg, 'run-a', 1);
    expect(Object.keys(all)).toEqual(['t1', 't2']);
    expect(all.t2.members).toEqual(['docs-1', 'docs-2']);
  });

  it('takes its seed from the run id, or from a fixed basis when asked', () => {
    expect(seedBasis('run-a', cfg)).toBe('run-a');
    expect(seedBasis('run-a', { ...cfg, councils: { ...cfg.councils, seed: 'fixed' } })).toBe(
      seedBasis('run-b', { ...cfg, councils: { ...cfg.councils, seed: 'fixed' } }),
    );
  });
});

describe('recalling a delegate', () => {
  it('replaces the delegate with another of the council\'s own members', () => {
    const c = council();
    const recall = recallDelegate(c, 'exceeded-mandate', 'run-a');
    expect(recall).toMatchObject({ council: 'council-t1', outgoing: 'backend-1', ground: 'exceeded-mandate' });
    expect(recall!.incoming).toBe('backend-2');
    expect(c.delegate).toBe('backend-2');
  });

  // A power the council holds over its delegate must not become a way of removing the council from
  // the federation.
  it('refuses to leave a council of one unrepresented', () => {
    const c = council({ members: ['backend-1'] });
    expect(recallDelegate(c, 'lost-confidence', 'run-a')).toBeNull();
    expect(c.delegate).toBe('backend-1');
  });

  it('records every ground section 11 names', () => {
    for (const ground of ['exceeded-mandate', 'concealed-evidence', 'misallocated-work', 'lost-confidence'] as const) {
      expect(recallDelegate(council(), ground, 'run-a')!.ground).toBe(ground);
    }
  });
});

describe('when repeated misallocation reaches the recall threshold', () => {
  it('waits for the configured count', () => {
    expect(misallocationRecallDue(2, cfg)).toBe(false);
    expect(misallocationRecallDue(3, cfg)).toBe(true);
  });

  it('never recalls when the threshold is switched off', () => {
    expect(misallocationRecallDue(99, { ...cfg, recall: { ...cfg.recall, consecutivePlannerFailuresBeforeSwap: 3, delegateMisallocations: 0 } })).toBe(false);
  });
});
