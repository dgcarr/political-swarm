// Article 9: "Councils and workers may challenge plans, evidence and coordinators without
// retaliation; minority reports remain visible."
//
// Section 14 names the failure this guards against — "suppressed dissent", where "calls for
// solidarity may conceal uncertainty or pressure workers to approve a failing plan" — and the
// safeguard is to "protect challenge rights, preserve minority reports and require material
// evidence over consensus".
//
// Until this file existed, no strategy in the repository had ever called ctx.addFinding, so
// DeliveryPacket.minorityReports was structurally always empty: an objection either blocked the
// work or vanished. The dissent that matters is precisely the kind that did not block — a reviewer
// who flagged a real problem on a change the council took anyway. That is what reaches the packet
// now.
//
// Section 11's rule for a technical disagreement lands in the same place: "If alternatives remain
// equivalent, the affected council chooses the simpler reversible option and records minority
// reasoning." A flagged change with passing tests is exactly that case — the work is written, it is
// reversible on a branch, and the reviewer's reasoning is recorded rather than discarded.

import type { DraftFinding, Finding } from '../../engine/packets.js';
import { droppedMinorityReports } from './constitution.js';
import type { ReviewResult } from '../../engine/types.js';

export interface DissentInput {
  taskId: string;
  nodeTitle: string;
  /** Whether the council took the work despite the objection. */
  approved: boolean;
  review: ReviewResult;
  implementerId: string;
}

/**
 * The objections that survived a decision to proceed.
 *
 * Only raised on an approved node, and that is the whole point. A rejection means the dissent
 * carried — it is already the outcome, and recording it again as a minority view would misdescribe
 * a reviewer who won as one who lost. What needs preserving is the objection the council decided
 * against, because that is the one a summary would otherwise smooth away.
 */
export function minorityReportsFrom(input: DissentInput): DraftFinding[] {
  if (!input.approved) return [];

  const testsPassed = input.review.testResult?.passed ?? false;
  const reports: DraftFinding[] = [];

  for (const finding of input.review.findings) {
    if (finding.verdict === 'approve') continue;

    reports.push({
      source: finding.reviewerId,
      taskId: input.taskId,
      summary: `${finding.reviewerId} ${finding.verdict === 'reject' ? 'objected to' : 'flagged'} "${input.nodeTitle}", which the council took anyway: ${finding.rationale}`,
      evidenceRefs: finding.evidenceRefs ?? [],
      disposition: 'deferred',
      owner: finding.reviewerId,
      returnCondition: 'Revisit if this area is amended, or if the objection is borne out in use.',
      dispositionRationale: testsPassed
        ? 'Article 9: the council proceeded on passing evidence over the objection, and section 11 takes the simpler ' +
          'reversible option where alternatives are equivalent. The reasoning is recorded, not discarded.'
        : 'Article 9: the objection did not prevent the council proceeding, so it is preserved as a minority report ' +
          'rather than being converted into apparent consensus.',
      minority: true,
    });
  }
  return reports;
}

// ------------------------------------------------------------------ retention

export interface RetentionResult {
  findings: Finding[];
  retained: string[];
}

/**
 * Disposition is where dissent is most easily lost.
 *
 * A body answering for a pile of findings can mark one `rejected` with a rationale and, in doing so,
 * quietly drop the fact that somebody dissented. Article 9 says the dissent stays visible regardless
 * of how the decision went, so the mark is restored. The disposition itself is left exactly as it
 * was set: this is not overturning the decision, only refusing to let the record forget who objected.
 */
export function retainMinorityReports(before: readonly Finding[], after: Finding[]): RetentionResult {
  const dropped = new Set(droppedMinorityReports([...before], after));
  if (dropped.size === 0) return { findings: after, retained: [] };

  return {
    findings: after.map((f) =>
      dropped.has(f.id)
        ? {
            ...f,
            minority: true,
            dispositionRationale:
              `${f.dispositionRationale} (Restored as a minority report: article 9 keeps material dissent ` +
              'visible alongside the decision, whatever that decision was.)',
          }
        : f,
    ),
    retained: [...dropped],
  };
}
