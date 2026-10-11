import { z } from 'zod';
import type { SwarmEngine } from '../engine/SwarmEngine.js';
import { runIdSchema } from '../util/ids.js';
import { progressSummary } from '../engine/TaskGraph.js';

export const swarmStatusInputShape = {
  runId: runIdSchema,
};

export interface SwarmStatusResult {
  runId: string;
  strategy: import('../engine/types.js').StrategyId;
  status: import('../engine/RunStore.js').RunStatus;
  progress: { total: number; approved: number; rejected: number; pending: number };
  costUsd: number;
  budgetUsd: number;
  tokensUsed: { prompt: number; completion: number };
  workerCalls: number;
  pendingApprovals: import('../engine/types.js').PendingApproval[];
  lastError: string | undefined;
  updatedAt: string;
  /** Findings raised so far and how they stand. Nothing here may be dropped from the record. */
  findings: { unresolved: number; deferred: number; accepted: number; rejected: number; minorityReports: number };
  /** How many times Claude rejected a delivery and returned it to this same swarm. */
  remediationCycles: number;
  /** Plain-language reading of the run's status, so the three terminal states aren't conflated. */
  stateMeaning: string;
  /** Present once the doctrine has assembled a manifest. Read the whole thing with swarm_get_delivery. */
  deliveryReady: boolean;
}

/** Section 5 defines three distinct endings, and reporting one as another is exactly what it
 * forbids. This keeps that distinction in the words the caller reads, not just in an enum. */
function describeStatus(state: import('../engine/RunStore.js').RunState): string {
  switch (state.status) {
    case 'running':
      return 'The swarm is working under its own procedure.';
    case 'paused_budget':
      return 'Halted on a resource limit. Nothing is decided; raising the budget resumes it.';
    case 'paused_human':
      return 'Blocked on a decision only a human may take. See pendingApprovals.';
    case 'awaiting_acceptance':
      return 'The swarm reached its own acceptance decision and submitted a delivery packet. NOT complete: Claude must independently check it (swarm_get_delivery), then accept (swarm_accept) or return defects (swarm_remediate).';
    case 'remediation':
      return 'Claude rejected the delivery; the same swarm is reopening the work under its own rules.';
    case 'completed':
      return 'Complete: the swarm accepted it under its own rules AND Claude independently accepted the delivery packet.';
    case 'terminated_incomplete':
      return `Ended incomplete — this is not success, and the work must not be described as accepted.${state.lastError ? ` ${state.lastError}` : ''}`;
    case 'failed':
      return 'The run failed with a runtime error.';
    case 'stopped':
      return 'Halted by the user.';
    default:
      return '';
  }
}

export async function swarmStatus(engine: SwarmEngine, input: { runId: string }): Promise<SwarmStatusResult> {
  const state = engine.getRunStore().load(input.runId);
  if (!state) throw new Error(`Unknown run "${input.runId}"`);

  const progress = state.graph ? progressSummary(state.graph) : { total: 0, approved: 0, rejected: 0, pending: 0 };
  const pendingApprovals = state.pendingApprovals.filter((a) => !a.resolvedAt);
  const all = state.findings ?? [];

  return {
    runId: state.runId,
    strategy: state.strategy,
    status: state.status,
    progress,
    costUsd: Number(state.costUsd.toFixed(4)),
    budgetUsd: state.budgetUsd,
    tokensUsed: state.tokensUsed,
    workerCalls: state.workerCalls,
    pendingApprovals,
    lastError: state.lastError,
    updatedAt: state.updatedAt,
    findings: {
      unresolved: all.filter((f) => f.disposition === 'unresolved').length,
      deferred: all.filter((f) => f.disposition === 'deferred').length,
      accepted: all.filter((f) => f.disposition === 'accepted').length,
      rejected: all.filter((f) => f.disposition === 'rejected').length,
      minorityReports: all.filter((f) => f.minority).length,
    },
    remediationCycles: state.remediationCycles ?? 0,
    stateMeaning: describeStatus(state),
    deliveryReady: state.delivery !== undefined,
  };
}
