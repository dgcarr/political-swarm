import type { LedgerEntry } from '../engine/Ledger.js';
import type { StrategyId } from '../engine/types.js';
import { capitalistMilestones } from './capitalist/milestones.js';
import { democraticMilestones } from './democratic/milestones.js';
import { managerialMilestones } from './managerial/milestones.js';
import { singleAgentMilestones } from './singleAgent/milestones.js';
import { socialistMilestones } from './socialist/milestones.js';
import { clip, list, type Milestones } from './milestoneText.js';

// Plain-language headlines for the governing events a run records in its ledger ("Government
// formed", "Legislation passed", "Contract awarded"), so a watcher can follow how each doctrine
// is governing without reading ledger.jsonl. Narration only reads entries the strategies already
// write; it never changes what is recorded.

/** Engine events every doctrine shares: the plan, task outcomes, remediation and delivery. */
export const commonMilestones: Milestones = {
  plan_created: (d) => `Plan adopted: ${d.nodeCount} tasks`,
  task_decided: (d) => (d.outcome === 'needs_human' ? `Task ${d.taskId} escalated to the sovereign` : `Task ${d.taskId}: ${d.outcome}`),
  rework_budget_exhausted: (d) => `Task ${d.taskId} abandoned after ${d.attemptNumber} attempts`,
  ownership_handoff: (d) =>
    `Task ${d.taskId} handed to the owners of the failing code: ${list(d.ownerTaskIds)}` +
    (Array.isArray(d.keptTestFiles) && d.keptTestFiles.length ? ` (kept tests ${list(d.keptTestFiles)})` : ''),
  review_reject_downgraded: (d) => `Reject of ${d.taskId} kept as a flag: defect in other tasks' files ${list(d.foreignPaths)}`,
  ownership_handoff_declined: (d) => `Task ${d.taskId} kept its repair; ${list(d.ownerTaskIds)} already wait on it`,
  ownership_transferred: (d) => `File ${d.path} moved from ${list(d.from)} to ${d.to}`,
  task_error: (d) => `Task ${d.taskId} errored: ${clip(d.error, 120)}`,
  graph_remediation_returned: (d) => `Remediation cycle ${d.cycle}: reopened ${list(d.affectedTaskIds)}`,
  graph_remediation_stalled: (d) => `Remediation stalled at cycle ${d.cycle}: ${list(d.affectedTaskIds)} made no progress`,
  graph_remediation_failed: (d) => `Remediation failed: ${clip(d.error, 120)}`,
  integration_report: (d) => `Integration review: ${d.integrated ? 'integrated' : 'not integrated'}, ${d.findingCount} findings`,
  independent_verification: (d) => `Independent verification ${d.verified ? 'passed' : 'failed'} (${d.criteriaTraced} criteria traced)`,
  delivery_assembled: (d) =>
    `Delivery assembled: ${d.accepted ? 'accepted' : 'not accepted'} (${d.changedFiles} files changed, ${d.unresolved} findings unresolved)`,
  delivery_returned_for_repair: (d) => `Delivery returned for repair (cycle ${d.cycle} of ${d.maxCycles})`,
  partial_delivery_submitted: (d) => `Partial delivery: ${d.approved} of ${d.of} tasks approved; abandoned ${list(d.abandoned)}`,
  delivery_accepted: () => 'Delivery accepted',
  sovereign_decision: (d) => `Sovereign ${d.decision}s the ${d.kind} escalation`,
  terminated_incomplete: (d) => `Run ended incomplete: ${clip(d.reason, 140)}`,
  wall_clock_exceeded: (d) => `Wall clock exceeded after ${Math.round(Number(d.elapsedMin))} minutes`,
};

const doctrineMilestones: Readonly<Partial<Record<StrategyId, Milestones>>> = {
  democratic: democraticMilestones,
  socialist: socialistMilestones,
  capitalist: capitalistMilestones,
  managerial: managerialMilestones,
  single_agent: singleAgentMilestones,
};

/**
 * The headline for a ledger entry, or undefined when the entry is not a governing milestone.
 * A doctrine's own wording replaces the common one for the same event type; a doctrine that maps
 * an event to `() => undefined` silences it (for example where its own event already says it).
 */
export function milestoneFor(entry: LedgerEntry): string | undefined {
  const doctrine = doctrineMilestones[entry.strategy] ?? {};
  const narrate = Object.hasOwn(doctrine, entry.type) ? doctrine[entry.type] : commonMilestones[entry.type];
  if (!narrate) return undefined;
  try {
    return narrate(entry.data ?? {});
  } catch {
    // A malformed entry costs its headline, never the run.
    return undefined;
  }
}
