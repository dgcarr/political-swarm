import { z } from 'zod';
import type { SwarmEngine } from '../engine/SwarmEngine.js';
import { MAX_LIST_ITEMS, MAX_TASK_CHARS, runIdSchema } from '../util/ids.js';

export const swarmRemediateInputShape = {
  runId: runIdSchema,
  findings: z
    .array(
      z.object({
        summary: z.string().min(1).max(MAX_TASK_CHARS).describe('The concrete defect, stated so the swarm can act on it.'),
        evidence: z.string().min(1).max(MAX_TASK_CHARS).describe('What shows it: a file and line, a failing command, a missing test.'),
        affectedTaskIds: z.array(z.string()).optional().describe('Task ids to reopen. Omit to return the whole programme.'),
        severity: z.enum(['low', 'medium', 'high']),
      }),
    )
    .min(1)
    .max(MAX_LIST_ITEMS)
    .describe('At least one concrete defect. A rejection with no defects is not a rejection.'),
};

export interface SwarmRemediateResult {
  runId: string;
  status: import('../engine/RunStore.js').RunStatus;
  cycle: number;
  reopenedTaskIds: string[];
  note: string;
}

/**
 * Returns Claude's concrete defects to the SAME swarm, which resumes under its own rules.
 *
 * Section 5: "A run is returned for remediation when Claude identifies a concrete defect, missing
 * evidence, scope violation or unresolved non-waivable risk; the same swarm resumes from the
 * remediation packet under its own rules." Claude names the defects; it does not decide how the
 * doctrine repairs them — that is the committee's, the council's or the liable firm's to work out.
 * The rejected delivery travels with the packet and is preserved, so a later cycle cannot quietly
 * discard evidence an earlier one produced.
 */
export async function swarmRemediate(
  engine: SwarmEngine,
  input: {
    runId: string;
    findings: Array<{ summary: string; evidence: string; affectedTaskIds?: string[]; severity: 'low' | 'medium' | 'high' }>;
  },
): Promise<SwarmRemediateResult> {
  const state = await engine.submitRemediation(input.runId, input.findings);
  const reopened = state.graph
    ? state.graph.order.filter((id) => state.graph!.nodes[id].phase === 'queued' && state.graph!.nodes[id].remediationOf)
    : [];

  return {
    runId: state.runId,
    status: state.status,
    cycle: state.remediationCycles ?? 1,
    reopenedTaskIds: reopened,
    note: 'Defects returned to the swarm, which is working them under its own procedure. Poll swarm_status; a new delivery packet appears when it reaches acceptance again.',
  };
}
