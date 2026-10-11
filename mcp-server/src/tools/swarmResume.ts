import type { SwarmEngine } from '../engine/SwarmEngine.js';
import { runIdSchema } from '../util/ids.js';

export const swarmResumeInputShape = {
  runId: runIdSchema,
};

export interface SwarmResumeResult {
  status: import('../engine/RunStore.js').RunStatus;
  lastError?: string;
}

/**
 * Continue an interrupted run from its saved state: governance is replayed from the ledger, a task
 * cut off mid-verdict has its unjudged change reverted and runs again, and the worktree is checked
 * against the run's recorded base before anything proceeds.
 */
export async function swarmResume(engine: SwarmEngine, input: { runId: string }): Promise<SwarmResumeResult> {
  const state = await engine.resumeRun(input.runId);
  return { status: state.status, ...(state.status !== 'running' && state.lastError ? { lastError: state.lastError } : {}) };
}
