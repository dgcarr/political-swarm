import { describe, expect, it } from 'vitest';
import { reportToTheHouse, toDeliveryNotes, type AccountabilityInput } from './accountability.js';
import type { EvidenceItem, Finding } from '../../engine/packets.js';
import type { TaskGraph } from '../../engine/types.js';

function graph(statuses: Record<string, 'pending' | 'approved' | 'rejected'>): TaskGraph {
  const order = Object.keys(statuses);
  return {
    order,
    nodes: Object.fromEntries(
      order.map((id) => [
        id,
        {
          id,
          title: `Motion ${id}`,
          description: '',
          acceptanceCriteria: [],
          dependsOn: [],
          targetGlobs: [],
          riskTags: [],
          riskClass: 'low' as const,
          phase: statuses[id] === 'pending' ? 'queued' : statuses[id] === 'approved' ? 'settled' : 'abandoned',
          attempts: statuses[id] === 'pending'
            ? []
            : [{
                attempt: 1,
                outcome: statuses[id],
                rationale: `${statuses[id]} by test`,
                evidenceRefs: [],
                fingerprint: '',
                repeated: false,
                at: '2026-01-01T00:00:00.000Z',
              }],
        },
      ]),
    ),
  };
}

function evidence(statuses: EvidenceItem['status'][]): EvidenceItem[] {
  return statuses.map((status, i) => ({
    criterion: `criterion ${i + 1}`,
    command: 'npm test',
    expectedResult: 'passes',
    status,
  }));
}

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'f1',
    source: 'committee',
    summary: 'Something outstanding.',
    evidenceRefs: [],
    disposition: 'unresolved',
    dispositionRationale: 'raised',
    ...overrides,
  };
}

function input(overrides: Partial<AccountabilityInput> = {}): AccountabilityInput {
  return {
    graph: graph({ m1: 'approved' }),
    state: { motionEstimates: { m1: { estimatedCostUsd: 0.1, foreseeableRisks: [], rollbackConditions: '' } } },
    evidence: evidence(['satisfied']),
    findings: [],
    costUsd: 0.05,
    ...overrides,
  };
}

describe('reporting actual against expected', () => {
  it('counts criteria met and names the ones that are not', () => {
    const report = reportToTheHouse(input({ evidence: evidence(['satisfied', 'unsatisfied', 'unavailable']) }));
    expect(report.criteriaMet).toBe(1);
    expect(report.criteriaUnmet).toEqual(['criterion 2', 'criterion 3']);
  });

  it('counts a manual inspection as met, since the mandate named it as the evidence', () => {
    expect(reportToTheHouse(input({ evidence: evidence(['manual']) })).criteriaMet).toBe(1);
  });

  it('sets the spend against what the government estimated', () => {
    const report = reportToTheHouse(input({ costUsd: 0.3 }));
    expect(report).toMatchObject({ costUsd: 0.3, estimatedCostUsd: 0.1 });
  });

  it('records no estimate when the government gave none', () => {
    expect(reportToTheHouse(input({ state: {} })).estimatedCostUsd).toBe(0);
  });

  it('reports defects but not minority reports, which are dissent rather than defects', () => {
    const report = reportToTheHouse(
      input({ findings: [finding({ id: 'a' }), finding({ id: 'b', minority: true })] }),
    );
    expect(report.defects).toHaveLength(1);
    expect(report.unresolvedRisks).toHaveLength(2);
  });
});

describe('the lessons drawn', () => {
  it('draws none from a clean run', () => {
    expect(reportToTheHouse(input()).lessons).toEqual([]);
  });

  it('notes a material overspend as a ground section 11 recognises', () => {
    const report = reportToTheHouse(input({ costUsd: 1 }));
    expect(report.lessons.join(' ')).toContain('confidence process');
  });

  it('does not call a small overrun an overspend', () => {
    expect(reportToTheHouse(input({ costUsd: 0.12 })).lessons).toEqual([]);
  });

  it('notes criteria that reached delivery without evidence', () => {
    const report = reportToTheHouse(input({ evidence: evidence(['unsatisfied']) }));
    expect(report.lessons.join(' ')).toContain('without satisfying evidence');
  });

  it('notes persistent dissent the House overrode', () => {
    const minority = Array.from({ length: 3 }, (_, i) => finding({ id: `m${i}`, minority: true }));
    expect(reportToTheHouse(input({ findings: minority })).lessons.join(' ')).toContain('majoritarian technical error');
  });

  it('notes a programme the House mostly refused as a drafting failure', () => {
    const report = reportToTheHouse(
      input({ graph: graph({ m1: 'rejected', m2: 'rejected', m3: 'approved' }) }),
    );
    expect(report.lessons.join(' ')).toContain('mis-drafted at first reading');
  });

  it('notes a delay the second chamber imposed', () => {
    const report = reportToTheHouse(input({ state: { houseOfReviewDelays: 1 } }));
    expect(report.lessons.join(' ')).toContain('second chamber delayed');
  });
});

describe('what reaches the delivery manifest', () => {
  it('discloses unmet criteria and the spend against the estimate as limitations', () => {
    const notes = toDeliveryNotes(reportToTheHouse(input({ evidence: evidence(['unsatisfied']), costUsd: 0.3 })));
    expect(notes.limitations.some((l) => l.includes('criterion 1'))).toBe(true);
    expect(notes.limitations.some((l) => l.includes("government's estimate"))).toBe(true);
  });

  it('discloses unresolved risks as residual risks', () => {
    const notes = toDeliveryNotes(reportToTheHouse(input({ findings: [finding()] })));
    expect(notes.residualRisks).toEqual(['Reported to the House at stage 9: Something outstanding.']);
  });

  it('says nothing about spend when there was no estimate to compare it against', () => {
    const notes = toDeliveryNotes(reportToTheHouse(input({ state: {} })));
    expect(notes.limitations.some((l) => l.includes('estimate'))).toBe(false);
  });
});
