import { describe, expect, it } from 'vitest';
import {
  appointsCoordinator,
  authorisesEmergencyRollback,
  preservesCharter,
  refusesInstruction,
  triggersElection,
} from './ceremonialHead.js';
import type { Finding } from '../../engine/packets.js';
import type { FileOp } from '../../engine/types.js';
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
  ceremonialHead: { emergencyRollbackAfterRemediationCycles: 2 },
} as unknown as DemocraticConfig;

const isTest = (p: string) => p.includes('.test.');

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'f1',
    source: 'engine:checks',
    summary: 'The change weakens authentication on the session route.',
    evidenceRefs: [],
    disposition: 'unresolved',
    dispositionRationale: 'raised',
    nonWaivable: true,
    ...overrides,
  };
}

describe('refusing an unconstitutional instruction', () => {
  it('refuses a change that deletes a test', () => {
    const ops: FileOp[] = [{ op: 'delete', path: 'src/even.test.ts' }];
    const refusal = refusesInstruction(ops, isTest);
    expect(refusal).toMatchObject({ power: 'refuse-unconstitutional-instruction', subject: 'src/even.test.ts' });
  });

  it('allows a change that deletes ordinary source', () => {
    expect(refusesInstruction([{ op: 'delete', path: 'src/old.ts' }], isTest)).toBeNull();
  });

  it('allows a change that edits a test', () => {
    expect(refusesInstruction([{ op: 'edit', path: 'src/even.test.ts', find: 'a', replace: 'b' }], isTest)).toBeNull();
  });

  // "Obviously unconstitutional" has to mean obvious. A reserve power reachable by judgment is a
  // second executive, so anything subtler belongs to the committees.
  it('forms no view about a change it merely dislikes', () => {
    expect(refusesInstruction([{ op: 'write', path: 'src/a.ts', content: 'export const x = 1;' }], isTest)).toBeNull();
  });

  it('names every deleted test, not just the first', () => {
    const refusal = refusesInstruction(
      [
        { op: 'delete', path: 'a.test.ts' },
        { op: 'delete', path: 'b.test.ts' },
      ],
      isTest,
    );
    expect(refusal!.subject).toBe('a.test.ts, b.test.ts');
  });
});

describe('emergency rollback', () => {
  it('is not reached before the charter’s cycle limit', () => {
    expect(authorisesEmergencyRollback({ remediationCycles: 1, openNonWaivable: [finding()], cfg })).toBeNull();
  });

  it('is authorised once the delivery has been round the loop and still breaches', () => {
    const exercise = authorisesEmergencyRollback({ remediationCycles: 2, openNonWaivable: [finding()], cfg });
    expect(exercise).toMatchObject({ power: 'authorise-emergency-rollback' });
    expect(exercise!.rationale).toContain('weakens authentication');
    // Article 12 leaves the decision with the human; the guardian only puts it in front of them.
    expect(exercise!.rationale).toContain('human project owner');
  });

  it('is not reached when nothing constitutional is outstanding', () => {
    expect(authorisesEmergencyRollback({ remediationCycles: 5, openNonWaivable: [], cfg })).toBeNull();
  });

  it('is switched off by a ceiling of zero', () => {
    expect(
      authorisesEmergencyRollback({
        remediationCycles: 9,
        openNonWaivable: [finding()],
        cfg: { ...cfg, ceremonialHead: { emergencyRollbackAfterRemediationCycles: 0 } },
      }),
    ).toBeNull();
  });
});

describe('the formal powers', () => {
  it('records the appointment of a coordinator who commands confidence', () => {
    const exercise = appointsCoordinator('pm-2', 'pm-1');
    expect(exercise).toMatchObject({ power: 'appoint-coordinator', subject: 'pm-2' });
    expect(exercise.rationale).toContain('pm-1');
  });

  it('records an election being triggered', () => {
    expect(triggersElection(3)).toMatchObject({ power: 'trigger-election', subject: 'term 3' });
  });

  it('preserves the charter as it actually stands', () => {
    const charter = preservesCharter();
    expect(charter.articles).toBe(12);
    expect(charter.digest).toContain('article-12. Human sovereignty');
  });
});
