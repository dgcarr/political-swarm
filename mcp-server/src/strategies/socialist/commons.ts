// Articles 2 and 7, at the point the run has to account for itself.
//
// Article 2 makes the repository, tools, task records and work-produced knowledge a commons.
// Article 7 requires that "findings, decisions, evidence, reusable artefacts and failure lessons
// must be published to the shared commons." Section 9 spells out what the ledger owes: "exact
// commands, material working context, outcomes and relevant output, plus environmental limitations,
// skipped or inapplicable checks with reasons, and unresolved failures."
//
// Two things about where this runs.
//
// It writes into state.strategyState.deliveryNotes, the doctrine-neutral channel engine/delivery.ts
// reads. Without it a socialist council has no way to disclose anything that is neither a check
// result nor a finding — and most of what section 9 lists is exactly that.
//
// And it must run before assembleDelivery reads those notes, which means at the end of
// disposeFindings() rather than in accept(). A report filed in accept() is written after the packet
// has already been built from the notes, so every disclosure in it would be silently dropped —
// which would be worse than not writing one, because the run would look like it had accounted for
// itself.

import type { CheckRunRecord, Finding } from '../../engine/packets.js';
import { unpublishedKnowledge, type MonopolyBreach } from './constitution.js';
import type { ProductiveDuty } from './coordinating.js';

export interface CommonsReport {
  /** What this run returned to the commons for whoever comes next. */
  published: string[];
  /** What is going out of the door unfinished. */
  unresolved: string[];
  lessons: string[];
  /** Section 9: "skipped or inapplicable checks with reasons". */
  skippedChecks: string[];
  limitations: string[];
}

export interface CommonsReportInput {
  findings: readonly Finding[];
  finalChecks: readonly CheckRunRecord[];
  /** Knowledge-store entries this run wrote, as `kind:tags` summaries. */
  contributions: readonly string[];
  /** Nodes that failed and taught the swarm something. */
  failedTaskIds: readonly string[];
  /** Nodes whose lesson actually reached the store. */
  publishedTaskIds: readonly string[];
  /** Nodes every worker handed back — a defect in the plan, disclosed as one. */
  planningDefects: readonly string[];
  /** Whether the convener also did inspectable work (section 6). */
  productiveDuty: ProductiveDuty;
  /** Reviewers who never implemented in this run (section 9's anti-QA-caste rule). */
  unrotatedReviewers: readonly string[];
  /** Delegates holding a majority of the council seats (article 10) — disclosed, not blocking. */
  delegateConcentration: readonly MonopolyBreach[];
}

export function buildCommonsReport(input: CommonsReportInput): CommonsReport {
  const published = [...input.contributions];

  const unresolved = input.findings
    .filter((f) => f.disposition === 'unresolved')
    .map((f) => `${f.summary}${f.minority ? ' (recorded as a minority report)' : ''}`);

  const skippedChecks = input.finalChecks
    .filter((c) => !c.ran)
    .map((c) => `${c.categoryId}: ${c.skippedReason ?? 'no reason recorded, which is itself a gap in the record'}`);

  const limitations: string[] = [];

  for (const taskId of input.planningDefects) {
    limitations.push(
      `Every worker offered "${taskId}" handed it back. The councils record this as a defect in the plan rather than in any worker.`,
    );
  }

  // Articles 2 and 7: a failure nobody wrote down is a discovery held privately by whichever agent
  // happened to hit it. Reported rather than blocking — section 11 converts failure into learning
  // rather than punishing it, so the remedy for an unpublished lesson is to say it is missing.
  const withheld = unpublishedKnowledge({ failedTaskIds: input.failedTaskIds, publishedTaskIds: input.publishedTaskIds });
  if (withheld.length > 0) {
    limitations.push(
      `${withheld.length} failure(s) in this run produced no entry in the shared store (${withheld.join(', ')}), ` +
        'so what they taught is not available to the next council.',
    );
  }

  // Section 6: "Coordinators must also perform inspectable productive or verification work when
  // feasible." Disclosed, never blocking — a one-node run may genuinely have had no second piece of
  // work to take, and section 6's own "when feasible" concedes it.
  if (!input.productiveDuty.met && input.productiveDuty.convener) {
    limitations.push(
      `${input.productiveDuty.convener} convened the coordinating council without taking any implementation or ` +
        'verification work in this run.',
    );
  }

  // Section 9: "independence for a change must never create a permanent QA caste."
  if (input.unrotatedReviewers.length > 0) {
    limitations.push(
      `${input.unrotatedReviewers.join(', ')} only ever reviewed in this run and never implemented. Over a single ` +
        'run that may simply be its shape; sustained, it is how a QA caste forms.',
    );
  }

  // Article 10, reported rather than enforced: on a short plan two units in one discipline draw
  // their delegates from the same small membership, so this is arithmetic as often as it is
  // capture. The remedy is to redraw next term, not to refuse the work.
  for (const concentration of input.delegateConcentration) {
    limitations.push(concentration.remedy);
  }

  const lessons = input.findings
    .filter((f) => f.disposition === 'deferred')
    .map((f) => `${f.summary}${f.owner ? ` (owned by ${f.owner})` : ''}`);

  return { published, unresolved, lessons, skippedChecks, limitations };
}

/**
 * The report as the doctrine-neutral notes engine/delivery.ts appends to the manifest.
 *
 * Nothing here can remove a limitation the engine found: the channel is additive by construction,
 * which is what keeps a doctrine's own account of itself from being able to quiet the evidence.
 */
export function toDeliveryNotes(report: CommonsReport): {
  limitations: string[];
  residualRisks: string[];
  rollbackNotes: string[];
} {
  return {
    limitations: [...report.limitations, ...report.skippedChecks.map((c) => `Check not run — ${c}`)],
    residualRisks: report.unresolved.map((u) => `[councils] ${u}`),
    rollbackNotes:
      report.published.length > 0
        ? [
            `What this run returned to the commons stays there and is not reverted with the code: ${report.published.join('; ')}.`,
          ]
        : [],
  };
}
