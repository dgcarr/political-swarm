import { describe, expect, it } from 'vitest';
import { computeQuestionTime, type QuestionTimeInput } from './questionTime.js';
import type { Finding } from '../../engine/packets.js';
import type { TaskGraph } from '../../engine/types.js';

function graph(): TaskGraph {
  return {
    order: ['m1', 'm2'],
    nodes: {
      m1: {
        id: 'm1',
        title: 'Carried motion',
        description: '',
        acceptanceCriteria: [],
        dependsOn: [],
        targetGlobs: [],
        riskTags: [],
        riskClass: 'high',
        phase: 'settled',
        attempts: [{
          attempt: 1,
          outcome: 'approved',
          rationale: 'approved by test',
          evidenceRefs: [],
          fingerprint: '',
          repeated: false,
          at: '2026-01-01T00:00:00.000Z',
        }],
      },
      m2: {
        id: 'm2',
        title: 'Defeated motion',
        description: '',
        acceptanceCriteria: [],
        dependsOn: [],
        targetGlobs: [],
        riskTags: [],
        riskClass: 'low',
        phase: 'abandoned',
        attempts: [{
          attempt: 1,
          outcome: 'rejected',
          rationale: 'rejected by test',
          evidenceRefs: [],
          fingerprint: '',
          repeated: false,
          at: '2026-01-01T00:00:00.000Z',
        }],
      },
    },
  };
}

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'f1',
    source: 'committee',
    summary: 'A point.',
    evidenceRefs: [],
    disposition: 'unresolved',
    dispositionRationale: 'raised',
    ...overrides,
  };
}

function input(overrides: Partial<QuestionTimeInput> = {}): QuestionTimeInput {
  return {
    graph: graph(),
    state: {
      completedTaskCount: 2,
      taskFileOps: { m1: [{ op: 'write', path: 'src/a.ts' }] },
      taskMeta: { m1: { title: 'Carried motion', riskClass: 'high', portfolioTag: 'backend' } },
      divisions: {
        m1: {
          ayes: 2,
          noes: 0,
          abstentions: 6,
          oppositionVerdict: 'approve',
          oppositionSeverity: 'low',
          voted: ['backend', 'testing'],
        },
      },
    },
    constituencies: ['backend', 'security', 'documentation'],
    evidence: [],
    findings: [],
    costUsd: 0.12,
    budgetUsd: 1,
    workerCalls: 9,
    ...overrides,
  };
}

const AT = '2026-01-01T00:00:00.000Z';

describe('Question Time', () => {
  it('answers all ten questions the doctrine names', () => {
    const summary = computeQuestionTime(input(), AT);
    expect(Object.keys(summary).sort()).toEqual(
      [
        'asOfCompletedTasks',
        'contradictingEvidence',
        'generatedAt',
        'irreversible',
        'resourcesConsumed',
        'risksIncreased',
        'strongestObjection',
        'unconsulted',
        'unverifiedAssumptions',
        'whatChanged',
        'whatsUnmet',
        'wouldChangeDirection',
      ].sort(),
    );
  });

  it('is deterministic for the same run state', () => {
    expect(computeQuestionTime(input(), AT)).toEqual(computeQuestionTime(input(), AT));
  });

  it('reports what changed and what is still unmet', () => {
    const summary = computeQuestionTime(input(), AT);
    expect(summary.whatChanged).toEqual(['Carried motion (write:src/a.ts)']);
    expect(summary.whatsUnmet).toEqual(['Defeated motion [rejected]']);
  });

  it('counts a criterion without evidence as unmet', () => {
    const summary = computeQuestionTime(
      input({ evidence: [{ criterion: 'isEven exists', status: 'unavailable' }] }),
      AT,
    );
    expect(summary.whatsUnmet.some((u) => u.includes('isEven exists'))).toBe(true);
  });

  it('treats the dissent the House overrode as the evidence against the executive', () => {
    const summary = computeQuestionTime(input({ findings: [finding({ minority: true, summary: 'It is unsafe.' })] }), AT);
    expect(summary.contradictingEvidence).toEqual(['It is unsafe.']);
  });

  it('names the constituencies that never got to vote', () => {
    const summary = computeQuestionTime(input(), AT);
    expect(summary.unconsulted).toEqual(['security', 'documentation']);
  });

  it('reports a high-risk carried motion as both a raised risk and an irreversible act', () => {
    const summary = computeQuestionTime(input(), AT);
    expect(summary.risksIncreased).toEqual(['Carried motion [high]']);
    expect(summary.irreversible).toEqual(['Carried motion']);
  });

  it('states what was consumed against the budget', () => {
    const summary = computeQuestionTime(input(), AT);
    expect(summary.resourcesConsumed).toEqual(['9 model call(s)', '$0.1200 of a $1.00 budget']);
  });

  it('reads a deferred finding’s return condition as what would change direction', () => {
    const deferred = finding({ disposition: 'deferred', returnCondition: 'If the caller changes.' });
    expect(computeQuestionTime(input({ findings: [deferred] }), AT).wouldChangeDirection[0]).toContain(
      'If the caller changes.',
    );
  });

  it('picks the Opposition’s strongest point by severity', () => {
    const summary = computeQuestionTime(
      input({
        findings: [
          finding({ id: 'a', source: 'shadow-security-reviewer', summary: '[low] A small worry.' }),
          finding({ id: 'b', source: 'shadow-security-reviewer', summary: '[high] A serious one.' }),
        ],
      }),
      AT,
    );
    expect(summary.strongestObjection).toEqual(['[high] A serious one.']);
  });

  it('reports no objection when the Opposition raised none', () => {
    expect(computeQuestionTime(input(), AT).strongestObjection).toEqual([]);
  });

  // An empty answer is still an answer; a question nobody put reads quite differently.
  it('answers every question even when the record is empty', () => {
    const summary = computeQuestionTime({ graph: null, state: {} }, AT);
    expect(summary.whatChanged).toEqual([]);
    expect(summary.unconsulted).toEqual([]);
    expect(summary.resourcesConsumed).toEqual(['0 model call(s)', '$0.0000 of a $0.00 budget']);
  });
});
