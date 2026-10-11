import { clip, count, list, type Milestones } from '../milestoneText.js';

/** Council milestones: the plan's ratification, guild assignment, peer review, recall, acceptance. */
export const socialistMilestones: Milestones = {
  councils_constituted: (d) => `Councils constituted (term ${d.termId}, by ${d.method}): ${list(d.councils, 4)}`,
  plan_source: (d) => `${d.plannerPersonaId ? `Planner ${d.plannerPersonaId}` : 'The planner'} drafts a plan of ${d.nodeCount} tasks`,
  plan_created: () => undefined,
  reconnaissance_published: (d) => `Council ${d.council} publishes reconnaissance`,
  council_member_ballots: (d) => {
    const ballots: Array<{ choice?: string }> = Array.isArray(d.ballots) ? d.ballots : [];
    const counts = ballots.reduce<Record<string, number>>((acc, b) => ({ ...acc, [String(b.choice)]: (acc[String(b.choice)] ?? 0) + 1 }), {});
    return `Council ${d.council} votes on the plan for ${d.taskId}: ${Object.entries(counts).map(([c, n]) => `${n} ${c}`).join(', ')}; ${d.result}`;
  },
  plan_amended_by_council: (d) => `Council ${d.council} amends the plan for ${d.taskId}`,
  plan_challenged: (d) => `Council ${d.council} challenges the plan: ${clip(d.challenge, 100)}`,
  plan_revision_proposed: (d) => `Plan revised after objections from ${list(d.objectingCouncils)}`,
  legacy_plan_ratified: (d) => `Earlier ratification carried over for ${list(d.taskIds)}`,
  planner_recall: (d) => `Planner recalled: ${d.to} replaces ${d.from}${d.reason ? ` (${d.reason})` : ''}`,
  guild_assigned: (d) => `${d.taskId} assigned to the ${d.leadGuild} guild (${d.assigneeId})`,
  coordinator_arbitration: (d) => `Coordinator arbitrates ${d.taskId}: ${d.leadGuild} guild leads, ${d.assigneeId} assigned`,
  mandate_breach: (d) => `Mandate breach by ${d.body} on ${d.taskId} (${d.article}); matter returned to the council`,
  assignment_returned: (d) => `${d.workerId} returns ${d.taskId} to the council: ${clip(d.reason, 100)}`,
  work_executed: (d) => `${d.assigneeId} completes work on ${d.taskId} (${count(d.fileOpCount, 'file change')})`,
  peer_review: (d) => `Peer review of ${d.taskId}: ${d.reviewerId} (${d.reviewerGuild}) ${d.verdict}s ${d.implementerId}'s work`,
  task_decided: (d) =>
    d.outcome === 'approved' ? `Council accepts the work on ${d.taskId}` : d.outcome === 'needs_human' ? `Council escalates ${d.taskId} to the sovereign` : `Council returns ${d.taskId} for ${d.outcome}`,
  mutual_aid_supplied: (d) => `Mutual aid for ${d.requesterId} on ${d.taskId} (${d.kind})`,
  independent_diagnosis: (d) => `Diagnosis of ${d.taskId}: the cause is ${d.cause}`,
  appeal_panel_convened: (d) => `Appeal panel on ${d.taskId} (${list(d.panel)}): ${d.granted ? 'granted' : 'refused'}`,
  delegate_recalled: (d) => `Delegate recalled from ${d.council}: ${d.incoming} replaces ${d.outgoing} (${d.ground})`,
  delegate_recall_unfilled: (d) => `Recall of ${d.outgoing} from ${d.council} found no replacement`,
  rotation_recorded: (d) => `Rotation by ${d.method} (term ${d.termId}): ${list(d.rotated)} into ${d.into}`,
  work_returned_to_councils: (d) => `Work returned to the councils (cycle ${d.cycle}): ${list(d.taskIds)}`,
  graph_remediation_returned: () => undefined,
  minority_report_preserved: (d) => `Minority report preserved in the common ledger (${d.article})`,
  commons_report: (d) => `Commons report: ${Array.isArray(d.published) ? d.published.length : 0} contributions published`,
  council_acceptance: (d) => (d.accepted ? 'The councils accept the common tree' : `The councils withhold acceptance: ${clip(list(d.blockers, 2), 140)}`),
  constitutional_gate: (d) => (d.accepted ? 'Constitutional review passes' : `Constitutional breach: ${clip(list(d.breaches, 2), 140)}`),
};
