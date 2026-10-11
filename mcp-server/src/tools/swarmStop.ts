import { z } from 'zod';
import type { SwarmEngine } from '../engine/SwarmEngine.js';
import { MAX_TASK_CHARS, runIdSchema } from '../util/ids.js';

export const swarmStopInputShape = {
  runId: runIdSchema,
  reason: z.string().max(MAX_TASK_CHARS).optional(),
};

export interface SwarmStopResult {
  status: import('../engine/RunStore.js').RunStatus;
}

export async function swarmStop(engine: SwarmEngine, input: { runId: string; reason?: string }): Promise<SwarmStopResult> {
  const state = engine.stopRun(input.runId, input.reason);
  return { status: state.status };
}
