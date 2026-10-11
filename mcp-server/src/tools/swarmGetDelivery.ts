import { z } from 'zod';
import type { SwarmEngine } from '../engine/SwarmEngine.js';
import { runIdSchema } from '../util/ids.js';
import type { DeliveryPacket } from '../engine/packets.js';
import { sensitivePaths } from '../engine/delivery.js';

export const swarmGetDeliveryInputShape = {
  runId: runIdSchema,
  /** The full diff can be large. Omit it when only the evidence and findings are wanted. */
  includeDiff: z.boolean().optional(),
};

export interface SwarmGetDeliveryResult {
  runId: string;
  status: import('../engine/RunStore.js').RunStatus;
  /** Absent until the doctrine has reached its own acceptance decision and assembled a manifest. */
  delivery: DeliveryPacket | undefined;
  /** What Claude must satisfy itself of before accepting. Not a verdict — a checklist. */
  independentCheck: {
    criteriaWithoutSatisfyingEvidence: string[];
    /** Permitted by every doctrine where automation is impractical — and therefore exactly the
     * evidence Claude has to weigh itself, since no check proved these. */
    criteriaRestingOnManualInspection: Array<{ criterion: string; inspection: string }>;
    failingRequiredChecks: string[];
    unresolvedFindings: Array<{ id: string; summary: string; nonWaivable: boolean }>;
    deferredFindings: Array<{ id: string; summary: string; owner?: string; returnCondition?: string }>;
    minorityReports: Array<{ id: string; summary: string }>;
    changedFileCount: number;
    /** Changed files that run code outside the checks once applied (CI, hooks, manifests). swarm_apply
     * refuses them without confirmSensitivePaths, so they are worth reading before accepting. */
    sensitivePaths: string[];
    remediationCycles: number;
  } | undefined;
  note: string;
}

/**
 * Hands Claude the delivery packet for its independent check.
 *
 * Section 5, identical across all three doctrines: "At delivery, Claude receives a final delivery
 * packet containing the implementation, evidence, test results and disclosed risks. Claude
 * independently checks the code, tests, scope compliance, unresolved risks and repository state.
 * It may reject the result and return concrete defects to the same political swarm for
 * remediation."
 *
 * The `independentCheck` block surfaces what the packet already contains — it does not judge.
 * Deciding whether the run is acceptable is Claude's work, done against the diff and the evidence,
 * and the swarm's own approval never settles it.
 */
export async function swarmGetDelivery(
  engine: SwarmEngine,
  input: { runId: string; includeDiff?: boolean },
): Promise<SwarmGetDeliveryResult> {
  const state = engine.getRunStore().load(input.runId);
  if (!state) throw new Error(`Unknown run "${input.runId}"`);

  const packet = state.delivery;
  if (!packet) {
    return {
      runId: state.runId,
      status: state.status,
      delivery: undefined,
      independentCheck: undefined,
      note:
        state.status === 'running' || state.status === 'paused_human' || state.status === 'paused_budget'
          ? `Run is "${state.status}" — the swarm has not reached its own acceptance decision yet, so there is no delivery packet.`
          : `Run is "${state.status}" and produced no delivery packet.${state.lastError ? ` Reason: ${state.lastError}` : ''}`,
    };
  }

  const userCriteria = new Set(packet.acceptanceCriteria.map((c) => c.trim()));
  const delivery = input.includeDiff === false ? { ...packet, diffText: '(omitted)' } : packet;

  return {
    runId: state.runId,
    status: state.status,
    delivery,
    independentCheck: {
      criteriaWithoutSatisfyingEvidence: packet.requirementMatrix
        .filter((m) => userCriteria.has(m.criterion.trim()) && m.status !== 'satisfied' && m.status !== 'manual')
        .map((m) => m.criterion),
      criteriaRestingOnManualInspection: packet.requirementMatrix
        .filter((m) => userCriteria.has(m.criterion.trim()) && m.status === 'manual')
        .map((m) => ({ criterion: m.criterion, inspection: m.command })),
      failingRequiredChecks: packet.finalChecks.filter((c) => !c.passed && !c.failedAtBaseline).map((c) => c.categoryId),
      unresolvedFindings: packet.findings
        .filter((f) => f.disposition === 'unresolved')
        .map((f) => ({ id: f.id, summary: f.summary, nonWaivable: f.nonWaivable === true })),
      deferredFindings: packet.findings
        .filter((f) => f.disposition === 'deferred')
        .map((f) => ({ id: f.id, summary: f.summary, owner: f.owner, returnCondition: f.returnCondition })),
      minorityReports: packet.minorityReports.map((f) => ({ id: f.id, summary: f.summary })),
      changedFileCount: packet.changedFiles.length,
      sensitivePaths: sensitivePaths(packet.changedFiles),
      remediationCycles: packet.remediationCycles,
    },
    note:
      state.status === 'awaiting_acceptance'
        ? 'The swarm accepted this delivery under its own rules. That does not bind Claude: check the diff and the evidence yourself, then accept with swarm_accept or return concrete defects with swarm_remediate.'
        : `Run is "${state.status}"; this packet is a record of what the swarm produced.`,
  };
}
