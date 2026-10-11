import { list, type Milestones } from '../milestoneText.js';

/** Baseline milestones: one agent plans, writes, reviews its own work and repairs it. */
export const singleAgentMilestones: Milestones = {
  file_ops_proposed: (d) => {
    const paths = Array.isArray(d.ops) ? d.ops.map((op: { path?: string }) => op.path) : [];
    return paths.length ? `Agent writes ${d.taskId}: ${list(paths, 4)}` : `Agent leaves ${d.taskId} unchanged`;
  },
  review_completed: (d) => {
    const finding = Array.isArray(d.findings) ? d.findings[0] : undefined;
    return `Self-review of ${d.taskId}: ${finding?.verdict ?? '?'}`;
  },
  remediation_returned: (d) => `Agent reopens its work for remediation (cycle ${d.cycle})`,
};
