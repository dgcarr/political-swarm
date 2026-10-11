// Section 7 stage 9: "After release, the executive reports actual versus expected outcomes,
// defects and regressions, compute and token expenditure, unresolved risks, lessons for future
// policy."
//
// The value of this stage is entirely in the "versus". A report of what happened is a summary; a
// report of what happened against what was promised is accountability, and it is the difference
// that makes "repeated material failure may trigger resignation, replacement or a confidence vote"
// mean anything. So every figure here is paired with the figure the government gave when it asked
// the House for authority — which is why the planner is now made to estimate cost and name its own
// foreseeable risks and rollback conditions at first reading.
//
// Deterministic. Asking a model to grade the executive's performance would be asking the executive
// to mark its own homework with extra steps.

import type { EvidenceItem, Finding } from '../../engine/packets.js';
import type { TaskGraph } from '../../engine/types.js';
import { rejectedNodeIds } from '../../engine/TaskGraph.js';
import type { DemocraticStrategyState } from './types.js';

export interface AccountabilityReport {
  criteriaMet: number;
  criteriaUnmet: string[];
  defects: string[];
  /** What the run actually spent. */
  costUsd: number;
  /** What the government said it would spend when it asked for authority. */
  estimatedCostUsd: number;
  unresolvedRisks: string[];
  /** Section 7 stage 9's "lessons for future policy". */
  lessons: string[];
}

export interface AccountabilityInput {
  graph: TaskGraph | null | undefined;
  state: DemocraticStrategyState;
  evidence: readonly EvidenceItem[];
  findings: readonly Finding[];
  costUsd: number;
}

export function reportToTheHouse(input: AccountabilityInput): AccountabilityReport {
  const { graph, state } = input;

  const criteriaUnmet = input.evidence
    .filter((e) => e.status === 'unsatisfied' || e.status === 'unavailable')
    .map((e) => e.criterion);
  const criteriaMet = input.evidence.filter((e) => e.status === 'satisfied' || e.status === 'manual').length;

  const defects = input.findings
    .filter((f) => !f.minority && (f.disposition === 'unresolved' || f.disposition === 'deferred'))
    .map((f) => `[${f.disposition}] ${f.summary}`);

  const unresolvedRisks = input.findings.filter((f) => f.disposition === 'unresolved').map((f) => f.summary);

  const estimatedCostUsd = graph
    ? graph.order.reduce((sum, id) => sum + (state.motionEstimates?.[id]?.estimatedCostUsd ?? 0), 0)
    : 0;

  return {
    criteriaMet,
    criteriaUnmet,
    defects,
    costUsd: input.costUsd,
    estimatedCostUsd,
    unresolvedRisks,
    lessons: drawLessons(input, criteriaUnmet, estimatedCostUsd),
  };
}

/**
 * Section 14's failure modes, checked against what this run actually did.
 *
 * Each lesson corresponds to a named failure mode, and is drawn only when the run's own record
 * shows it — a standing list of things that could go wrong would be a template, not a lesson.
 */
function drawLessons(input: AccountabilityInput, criteriaUnmet: string[], estimatedCostUsd: number): string[] {
  const lessons: string[] = [];
  const { graph, state } = input;

  if (estimatedCostUsd > 0 && input.costUsd > estimatedCostUsd * 1.5) {
    lessons.push(
      `The programme cost $${input.costUsd.toFixed(4)} against an estimate of $${estimatedCostUsd.toFixed(4)}. ` +
        'Section 11 lists systematic underestimation of cost as a ground for a confidence process.',
    );
  }
  if (criteriaUnmet.length > 0) {
    lessons.push(
      `${criteriaUnmet.length} acceptance criterion/criteria reached delivery without satisfying evidence. ` +
        'Section 9 makes that incomplete rather than accepted.',
    );
  }

  const minority = input.findings.filter((f) => f.minority);
  if (minority.length >= 3) {
    lessons.push(
      `${minority.length} minority reports were recorded against carried motions. Persistent dissent the House ` +
        'overrides is section 14\'s majoritarian technical error presenting itself early.',
    );
  }

  const rejected = graph ? rejectedNodeIds(graph).length : 0;
  const total = graph?.order.length ?? 0;
  if (total > 0 && rejected > total / 2) {
    lessons.push(
      `${rejected} of ${total} motions were defeated. A programme the House mostly refuses was mis-drafted at ` +
        'first reading rather than mis-implemented afterwards.',
    );
  }

  if ((state.houseOfReviewDelays ?? 0) > 0) {
    lessons.push(
      'The second chamber delayed part of this delivery; those points return first if it comes back.',
    );
  }

  return lessons;
}

/** The stage 9 report as the disclosures section 10 requires the delivery manifest to carry. */
export function toDeliveryNotes(report: AccountabilityReport): {
  limitations: string[];
  residualRisks: string[];
  rollbackNotes: string[];
} {
  const limitations = report.criteriaUnmet.map(
    (c) => `Question Time recorded this criterion as unmet: "${c}"`,
  );
  if (report.estimatedCostUsd > 0) {
    limitations.push(
      `The programme cost $${report.costUsd.toFixed(4)} against the government's estimate of $${report.estimatedCostUsd.toFixed(4)}.`,
    );
  }
  return {
    limitations: [...limitations, ...report.lessons],
    residualRisks: report.unresolvedRisks.map((r) => `Reported to the House at stage 9: ${r}`),
    rollbackNotes: [],
  };
}
