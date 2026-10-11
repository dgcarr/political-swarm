import { clip, count, type Milestones } from '../milestoneText.js';

/** Line-management milestones: the plan, assignments, reviews and sign-off. */
export const managerialMilestones: Milestones = {
  plan_source: (d) => `Management issues a plan of ${d.nodeCount} tasks${d.plannerPersonaId ? ` (${d.plannerPersonaId})` : ''}`,
  plan_created: () => undefined,
  plan_fallback: (d) => `Planner failed; management falls back to the default plan (${clip(d.reason, 100)})`,
  work_executed: (d) => `${d.assigneeId ?? d.personaId} delivers ${d.taskId} (${count(d.fileOpCount, 'file change')})`,
  review_completed: (d) => {
    const finding = Array.isArray(d.findings) ? d.findings[0] : undefined;
    return `Reviewer ${finding?.verdict === 'approve' ? 'approves' : `${finding?.verdict ?? 'reviews'}s`} ${d.taskId}`;
  },
  task_decided: (d) => (d.outcome === 'approved' ? `Manager signs off ${d.taskId}` : d.outcome === 'needs_human' ? `Manager escalates ${d.taskId} to the sovereign` : `Manager returns ${d.taskId} for ${d.outcome}`),
  remediation_returned: (d) => `Delivery sent back for remediation (cycle ${d.cycle})`,
};
