import { clip, count, list, type Milestones } from '../milestoneText.js';

const money = (value: unknown): string => Number(value ?? 0).toFixed(2);

/** Market milestones: listings, bids, awards, settlement, failure and the regulator. */
export const capitalistMilestones: Milestones = {
  capital_issued: (d) => `Capital of ${money(d.amount)} issued to ${d.personaId}`,
  listing_published: (d) => `Listing published: ${d.taskId} (${d.contractType}, budget ${money(d.budget)})`,
  listing_republished: (d) => `Listing ${d.taskId} republished at budget ${money(d.budget)} after a ${d.reason}`,
  public_good_granted: (d) => `Public-good grant of ${money(d.amount)} toward ${d.taskId} (${d.good})`,
  venture_experiment_commissioned: (d) => `Venture experiment commissioned on ${d.taskId} (${money(d.amount)})`,
  bids_received: (d) => `${d.taskId}: ${Array.isArray(d.bids) ? d.bids.length : 0} bids received`,
  bids_refused: (d) => `${d.taskId}: ${Array.isArray(d.refused) ? d.refused.length : 0} bids refused as over budget`,
  bid_failed: (d) => `${d.personaId} failed to bid on ${d.taskId}`,
  listing_unfilled: (d) => `Listing ${d.taskId} unfilled: ${clip(d.reason, 100)}`,
  market_entry: (d) => `${d.entrants} new entrant(s) on ${d.taskId}: ${d.reason}`,
  listing_awarded: (d) => `Contract for ${d.taskId} awarded to ${d.personaId} at ${d.bid?.priceTokens ?? '?'}`,
  firm_formed: (d) =>
    `Firm formed for ${d.taskId}: ${d.leadId} leads with ${list(Array.isArray(d.members) ? d.members.map((m: { personaId?: string }) => m.personaId) : [])}`,
  credit_drawn: (d) => `${d.personaId} draws ${money(d.drawn)} of credit for ${d.taskId}`,
  work_executed: (d) => `${d.personaId} delivers ${d.taskId} (${count(d.fileOpCount, 'file change')})`,
  subcontract_failed: (d) => `Subcontract on ${d.taskId} failed: ${d.personaId} (${d.role})`,
  spend_cap_breached: (d) => `${d.personaId} breaches the spend cap on ${d.taskId}`,
  contract_deadline_breached: (d) => `${d.personaId} misses the ${d.deadlineMinutes}-minute deadline on ${d.taskId}`,
  review_completed: () => undefined,
  task_decided: () => undefined,
  contract_settled: (d) =>
    `Contract ${d.taskId} settled with ${d.personaId}: ${d.outcome}, ${Number(d.profit) >= 0 ? 'profit' : 'loss'} ${money(Math.abs(Number(d.profit)))}`,
  credit_repaid: (d) => `${d.personaId} repays ${money(d.amount)} of credit`,
  warranty_escrow_claimed: (d) => `Warranty claim on ${d.taskId}: ${d.contractorId} forfeits ${money(d.forfeited)} of escrow`,
  claim_paid: (d) => `Insurance reserve pays ${money(d.paid)} toward repairing ${d.taskId}`,
  warranty_claim_returned: (d) => `Warranty claims returned for repair (cycle ${d.cycle}): ${list(d.taskIds)}`,
  graph_remediation_returned: () => undefined,
  arbitration_ruled: (d) => `Arbitration on ${d.taskId} (${d.matter}): ruled for the ${d.ruling}`,
  arbitration_declined: (d) => `Arbitration on ${d.taskId} declined: the run's limit is reached`,
  arbitration_failed: (d) => `Arbitration on ${d.taskId} failed; the matter falls against the supplier`,
  bankruptcy: (d) => `Bankruptcy: ${d.personaId} fails (${list(d.grounds)})`,
  bailout_considered: (d) => (d.granted ? `Bailout of ${money(d.amount)} granted to ${d.personaId}` : undefined),
  venture_findings_published: (d) => `Venture findings published for ${d.taskId}: ${d.outcome}`,
  market_report: (d) => `Market report: ${d.positions} positions, ${d.unmet} unmet criteria, ${d.unresolved} unresolved findings`,
  constitutional_gate: (d) => (Number(d.blocking) > 0 ? `Antitrust review blocks delivery (${d.blocking} breaches)` : 'Antitrust review passes'),
  regulator_safety_floor: (d) => (d.accepted ? 'Regulator certifies the safety floor' : `Regulator withholds escrow: ${clip(list(d.breaches, 2), 140)}`),
};
