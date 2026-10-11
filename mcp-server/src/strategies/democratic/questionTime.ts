// Section 11's Question Time: "at fixed intervals, the executive should face structured questions
// from representatives and opposition agents."
//
// Deliberately free. Every question the doctrine names is answerable from the graph, the ledger and
// the run's own recorded state, and a model asked to answer them would only be paraphrasing data we
// already hold — with the added risk of paraphrasing it wrong into an audit record. So this file
// makes no dispatch, and the answers are derived rather than reported.
//
// Section 11's point is that "Question Time is valuable because it makes explanation a recurring
// duty rather than a one-off report after failure", so a question with no answer says so explicitly
// instead of being omitted: an empty list is itself an answer, and "no module has gone unconsulted"
// reads differently from a question nobody put.

import type { Finding } from '../../engine/packets.js';
import type { TaskGraph } from '../../engine/types.js';
import { latestVerdict } from '../../engine/TaskGraph.js';
import type { DemocraticStrategyState, QuestionTimeSummary } from './types.js';

export interface QuestionTimeInput {
  graph: TaskGraph | null | undefined;
  state: DemocraticStrategyState;
  /** Every constituency the chamber represents, so the ones never consulted can be named. */
  constituencies?: readonly string[];
  /** The requirement matrix as it stands, for the unmet-criteria question. */
  evidence?: readonly { criterion: string; status: string }[];
  findings?: readonly Finding[];
  costUsd?: number;
  budgetUsd?: number;
  workerCalls?: number;
}

/**
 * Computes the summary for one sitting.
 *
 * Pure — no clock beyond the caller-supplied timestamp, no I/O — so the same run state always
 * produces the same answers and the test can assert on them.
 */
export function computeQuestionTime(input: QuestionTimeInput, generatedAt: string): QuestionTimeSummary {
  const { graph, state } = input;
  const findings = input.findings ?? [];

  const whatChanged: string[] = [];
  const whatsUnmet: string[] = [];
  const risksIncreased: string[] = [];
  const irreversible: string[] = [];
  const consulted = new Set<string>();

  if (graph) {
    for (const id of graph.order) {
      const node = graph.nodes[id];
      const ops = state.taskFileOps?.[id] ?? [];
      // A constituency that abstained on everything was never in a position to be consulted. These
      // are constituency names as the division recorded them, not portfolio tags — the two
      // vocabularies barely overlap, and comparing them would report members who voted as unheard.
      for (const constituency of state.divisions?.[id]?.voted ?? []) consulted.add(constituency);

      if (latestVerdict(node) === 'approved') {
        const opsText = ops.length ? ops.map((o) => `${o.op}:${o.path}`).join(', ') : 'no file ops recorded';
        whatChanged.push(`${node.title} (${opsText})`);
        if (node.riskClass === 'medium' || node.riskClass === 'high') {
          risksIncreased.push(`${node.title} [${node.riskClass}]`);
        }
        if (node.riskClass === 'high' || ops.some((o) => o.op === 'delete')) {
          irreversible.push(node.title);
        }
      } else if (node.phase === 'abandoned' || node.phase === 'blocked') {
        const disposition = node.phase === 'blocked' ? 'blocked_on_human' : (latestVerdict(node) ?? 'rejected');
        whatsUnmet.push(`${node.title} [${disposition}]`);
      }
    }
  }

  // Which acceptance criteria are currently unmet — from the evidence, not from anybody's account.
  for (const item of input.evidence ?? []) {
    if (item.status === 'unsatisfied' || item.status === 'unavailable') {
      whatsUnmet.push(`Acceptance criterion without satisfying evidence: "${item.criterion}"`);
    }
  }

  // What evidence contradicts the executive's preferred approach: the dissent it carried anyway.
  const contradictingEvidence = findings
    .filter((f) => f.minority)
    .map((f) => f.summary);

  // Which modules have not been consulted. Only meaningful if we know who the members are.
  const unconsulted = (input.constituencies ?? []).filter((c) => !consulted.has(c));

  const resourcesConsumed = [
    `${input.workerCalls ?? 0} model call(s)`,
    `$${(input.costUsd ?? 0).toFixed(4)} of a $${(input.budgetUsd ?? 0).toFixed(2)} budget`,
  ];

  // What would cause the executive to change direction: the conditions already on the record as
  // deferred findings, each of which names the thing that would bring it back.
  const wouldChangeDirection = findings
    .filter((f) => f.disposition === 'deferred' && f.returnCondition)
    .map((f) => `${f.returnCondition} (${f.summary})`);

  // The Opposition's strongest objection: its highest-severity unresolved point.
  const oppositionFindings = findings.filter(
    (f) => (f.source.startsWith('shadow-') || f.source.startsWith('opposition')) && f.disposition !== 'accepted',
  );
  const strongestObjection = pickStrongest(oppositionFindings);

  // Which claims remain assumptions rather than verified facts.
  const unverifiedAssumptions = findings
    .filter((f) => f.disposition === 'unresolved')
    .map((f) => f.summary);

  return {
    asOfCompletedTasks: state.completedTaskCount ?? 0,
    generatedAt,
    whatChanged,
    whatsUnmet,
    contradictingEvidence,
    risksIncreased,
    unconsulted,
    resourcesConsumed,
    irreversible,
    wouldChangeDirection,
    strongestObjection,
    unverifiedAssumptions,
  };
}

/**
 * The Opposition's strongest point, or nothing if it made none.
 *
 * Severity reaches a summary in two different shapes: barrier findings are prefixed "[high]" by
 * strategies/barriers.ts, while a minority report quotes the brief's own "severity=high". Matching
 * only one of them would silently rank every finding equal and always report the first.
 */
function pickStrongest(findings: readonly Finding[]): string[] {
  for (const severity of ['high', 'medium', 'low']) {
    const match = findings.find((f) => f.summary.includes(`[${severity}]`) || f.summary.includes(`severity=${severity}`));
    if (match) return [match.summary];
  }
  return findings.length > 0 ? [findings[0].summary] : [];
}
