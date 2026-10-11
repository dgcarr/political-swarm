import { z } from 'zod';
import type { SwarmEngine } from '../engine/SwarmEngine.js';
import { approvalIdSchema, MAX_TASK_CHARS, runIdSchema } from '../util/ids.js';

export const swarmDecideInputShape = {
  runId: runIdSchema,
  approvalId: approvalIdSchema,
  decision: z.enum(['approve', 'reject', 'modify']),
  note: z.string().max(MAX_TASK_CHARS).optional(),
  modifiedBudgetUsd: z.number().positive().optional(),
};

export interface SwarmDecideResult {
  applied: boolean;
  resultingStatus: import('../engine/RunStore.js').RunStatus;
  budgetUsd: number;
}

export async function swarmDecide(
  engine: SwarmEngine,
  input: { runId: string; approvalId: string; decision: 'approve' | 'reject' | 'modify'; note?: string; modifiedBudgetUsd?: number },
): Promise<SwarmDecideResult> {
  const state = engine.resolveApproval(input.runId, input.approvalId, input.decision, input.note, input.modifiedBudgetUsd);
  return { applied: true, resultingStatus: state.status, budgetUsd: state.budgetUsd };
}
