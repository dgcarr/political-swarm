import { z } from 'zod';
import type { SwarmEngine } from '../engine/SwarmEngine.js';
import { MAX_TASK_CHARS, runIdSchema } from '../util/ids.js';

export const swarmAcceptInputShape = {
  runId: runIdSchema,
  /** What the independent check actually established. Recorded in the ledger. */
  note: z.string().max(MAX_TASK_CHARS).optional(),
};

export interface SwarmAcceptResult {
  runId: string;
  status: import('../engine/RunStore.js').RunStatus;
  changedFiles: string[];
  note: string;
}

/**
 * Records Claude's acceptance of a delivery packet, completing the run.
 *
 * Section 5: a run is "complete only when the selected doctrine has reached its own valid
 * acceptance decision and submitted a delivery packet that Claude independently accepts." This is
 * that second half — and it is a gate on swarm_apply, which refuses to write to the real
 * repository until a run reaches `completed`.
 */
export async function swarmAccept(
  engine: SwarmEngine,
  input: { runId: string; note?: string },
): Promise<SwarmAcceptResult> {
  const state = engine.acceptDelivery(input.runId, input.note);
  return {
    runId: state.runId,
    status: state.status,
    changedFiles: state.delivery?.changedFiles ?? [],
    note: 'Delivery accepted. /swarm-apply can now write these changes to the real repository, with explicit human confirmation.',
  };
}
