import { clip, list, type Milestones } from '../milestoneText.js';

const DECIDED: Record<string, string> = { approved: 'carried', rejected: 'defeated', needs_human: 'referred to the sovereign' };

function verdictCount(findings: unknown): string {
  const counts = new Map<string, number>();
  for (const finding of Array.isArray(findings) ? findings : []) {
    const verdict = String(finding?.verdict ?? '?');
    counts.set(verdict, (counts.get(verdict) ?? 0) + 1);
  }
  return [...counts].map(([verdict, n]) => `${n} ${verdict}`).join(', ');
}

/** Parliamentary milestones: elections, the order paper, committee, divisions, confidence. */
export const democraticMilestones: Milestones = {
  offices_constituted: (d) =>
    `Government formed (term ${d.termId}): Prime Coordinator ${d.primeCoordinator}, Speaker ${d.speaker}, ` +
    `${Array.isArray(d.representatives) ? d.representatives.length : 0} representatives seated`,
  government_formed: (d) => `Government formed (term ${d.termId}): Prime Coordinator ${d.primeCoordinator}, by ${d.method}`,
  offices_rotated: (d) => `New term ${d.termId}: offices rotated (${list(d.rotated, 3)})`,
  security_committee_constituted: (d) => `Security committee constituted: ${list(d.members)}`,
  conflict_declared: (d) => `Conflict of interest: ${d.personaId} holds ${list(d.offices)}; ${clip(d.remedy, 80)}`,
  motions_drafted: (d) => `Order paper: the government tabled ${d.count} motions`,
  speaker_ruling: (d) =>
    d.admissible
      ? `Speaker admits motion ${d.motionId} (${d.treatment})`
      : `Speaker rules motion ${d.motionId} out of order${d.duplicateOf ? `, a duplicate of ${d.duplicateOf}` : ''}`,
  speaker_amendment: (d) => `Speaker amends motion ${d.motionId}: struck ${list(d.struck)}`,
  order_paper_restored: (d) => `Speaker ${d.speaker} restores motion ${d.motionId} to the order paper`,
  committee_expedited: (d) => `Committee on ${d.taskId} expedited: ${d.seated} of ${d.fullChamber} seats (${d.reason})`,
  committee_inquiry: (d) => `Committee (${d.portfolioTag}) reports on ${d.taskId}: ${verdictCount(d.findings)}`,
  opposition_brief: (d) => `Opposition ${d.verdict === 'approve' ? 'supports' : `${d.verdict}s`} ${d.taskId} (severity ${d.severity})`,
  government_reply: (d) => `Minister ${d.personaId} ${d.conceded ? 'concedes' : 'answers'} the Opposition on ${d.taskId}`,
  minority_amendment_considered: (d) => `House considers the Opposition's amendment to ${d.taskId}`,
  division_recorded: (d) =>
    `Division on ${d.taskId}: ${d.ayes} ayes, ${d.noes} noes, ${d.abstentions} abstentions; ${DECIDED[d.outcome] ?? d.outcome}`,
  vote_computed: () => undefined,
  task_decided: (d) =>
    d.outcome === 'approved'
      ? `Legislation passed: ${d.taskId}`
      : d.outcome === 'rework'
        ? `Motion ${d.taskId} sent back for redrafting`
        : `Motion ${d.taskId} ${DECIDED[d.outcome] ?? d.outcome}`,
  closure_applied: (d) => `Closure applied on ${d.taskId} (attempt ${d.attemptNumber}, ${d.carriedFindings} findings carried)`,
  appeal_recorded: (d) => `Appeal by ${d.appellant} on ${d.taskId} ${d.granted ? 'granted' : 'refused'}`,
  cabinet_dissent: (d) => `Minister ${d.personaId} ${d.resigned ? 'resigns' : 'dissents'} over the ${d.portfolioTag} portfolio`,
  reserve_power_exercised: (d) => `Reserve power exercised: ${d.power} (${clip(d.subject, 80)})`,
  confidence_motion: (d) =>
    `Confidence motion in ${d.subject}: ${d.ayes} ayes, ${d.noes} noes; ${d.outcome === 'lost' ? 'the government falls' : 'the government survives'}`,
  confidence_vote: (d) => `The ${d.portfolioTag} portfolio loses confidence after ${d.consecutiveFailures} rejections; ${d.incomingPersonaId} replaces ${d.outgoingPersonaId}`,
  representative_recalled: (d) => `Representative for ${d.constituency} recalled: ${d.incoming} replaces ${d.outgoing}`,
  question_time: (d) => `Question time after ${d.asOfCompletedTasks} completed tasks`,
  motions_recommitted: (d) => `Motions recommitted (cycle ${d.cycle}): ${list(d.taskIds)}`,
  minority_report_retained: (d) => `Speaker retains ${Array.isArray(d.findingIds) ? d.findingIds.length : 0} minority reports`,
  house_of_review_report: (d) =>
    d.convened
      ? `House of Review reports: ${d.revisions} revisions, ${d.delayed} delayed, ${d.vetoes} vetoes`
      : 'House of Review not convened',
  alternative_programme_prepared: (d) => `Opposition publishes an alternative programme of ${Array.isArray(d.motions) ? d.motions.length : 0} motions`,
  accountability_report: (d) => `Accountability report: ${d.criteriaMet} criteria met, ${Array.isArray(d.criteriaUnmet) ? d.criteriaUnmet.length : 0} unmet`,
  constitutional_gate: (d) => (d.accepted ? 'Assent granted' : `Assent refused: ${clip(list(d.breaches, 2), 140)}`),
};
