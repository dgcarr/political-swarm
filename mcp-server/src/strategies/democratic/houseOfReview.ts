// Section 6's second chamber. "Its powers should usually be delaying and revising rather than
// permanently vetoing, except where constitutional safety rules are breached."
//
// That sentence dictates where this runs and what it is allowed to return. It cannot express itself
// through the doctrine's acceptance decision, because the engine treats a non-acceptance as a
// terminal failure and ends the run (SwarmEngine.runAcceptanceBarriers) — which is a veto, and a
// veto is exactly the power section 6 withholds. So the chamber sits at the disposition step,
// after integration and independent verification, and speaks in findings:
//
//   revising  -> a finding deferred with an owner and a return condition. Disclosed, not blocking.
//   delaying  -> the same, plus a recorded delay counted against the chamber's ceiling, so it
//                cannot keep asking for time; the point is disclosed either way.
//   veto      -> a non-waivable finding, which the constitutional gate already refuses to pass.
//
// Only the last of those stops a delivery, and only on the ground section 6 reserves for it.
//
// It does not sit for every run. A programme of low-risk motions has nothing a revising chamber
// would add, and convening one anyway would be a dispatch spent on ceremony.

import type { DraftFinding } from '../../engine/packets.js';
import type { RiskClass } from '../../engine/types.js';
import { nonWaivableGround } from './constitution.js';
import type { DemocraticConfig } from './types.js';
import { DEMOCRATIC_DEFAULTS } from '../../constitution/schema.js';

const RISK_ORDER: Record<RiskClass, number> = { low: 0, medium: 1, high: 2 };

/** Whether the second chamber sits on this programme at all. */
export function shouldConvene(riskClasses: readonly RiskClass[], cfg: DemocraticConfig): boolean {
  if (!(cfg.houseOfReview?.enabled ?? DEMOCRATIC_DEFAULTS.houseOfReview.enabled)) return false;
  if (riskClasses.length === 0) return false;
  const floor = RISK_ORDER[cfg.houseOfReview?.minRiskClass ?? DEMOCRATIC_DEFAULTS.houseOfReview.minRiskClass];
  return riskClasses.some((r) => RISK_ORDER[r] >= floor);
}

/** What the chamber decided to do about one point it raised. */
export type ReviewPower = 'revise' | 'delay' | 'veto';

export interface RevisingPoint {
  summary: string;
  evidence: string;
  power: ReviewPower;
}

export interface RevisingReport {
  /** True when the chamber is content for the delivery to proceed as it stands. */
  content: boolean;
  points: RevisingPoint[];
  rationale: string;
}

export interface ReviewOutcome {
  findings: DraftFinding[];
  /** Delays recorded on this report, subject to the configured ceiling. */
  delayed: number;
  vetoes: number;
  revisions: number;
}

/**
 * Turns the chamber's report into findings the rest of the run already knows how to carry.
 *
 * Two limits are applied here rather than trusted to the chamber. A delay beyond the configured
 * ceiling is downgraded to a revision, so a second chamber cannot hold a delivery indefinitely by
 * repeatedly asking for more time — that would be a veto reached by attrition. And a veto is only
 * honoured on a ground article 10 actually reserves: section 6 permits this chamber to stop a
 * delivery over a constitutional safety breach, not over a disagreement about design it happens to
 * feel strongly about.
 */
export function applyRevisingReport(
  report: RevisingReport,
  chamberId: string,
  delaysAlreadyUsed: number,
  cfg: DemocraticConfig,
): ReviewOutcome {
  const maxDelays = cfg.houseOfReview?.maxDelays ?? DEMOCRATIC_DEFAULTS.houseOfReview.maxDelays;
  const findings: DraftFinding[] = [];
  let delayed = 0;
  let vetoes = 0;
  let revisions = 0;

  for (const point of report.points) {
    const ground = nonWaivableGround({ summary: point.summary, evidenceRefs: [point.evidence] });
    let power = point.power;

    if (power === 'veto' && !ground) {
      power = 'revise';
    }
    if (power === 'delay' && delaysAlreadyUsed + delayed >= maxDelays) {
      power = 'revise';
    }

    if (power === 'veto') {
      vetoes += 1;
      const label = ground ?? 'acceptance-evidence';
      findings.push({
        source: chamberId,
        summary: `The House of Review objects on constitutional ground (${label}): ${point.summary}`,
        evidenceRefs: [point.evidence],
        disposition: 'unresolved',
        dispositionRationale:
          'Raised by the second chamber on a ground article 10 places beyond an ordinary majority; it must be remedied, not dispositioned away.',
        nonWaivable: true,
      });
      continue;
    }

    if (power === 'delay') delayed += 1;
    else revisions += 1;

    findings.push({
      source: chamberId,
      summary: `${power === 'delay' ? 'The House of Review delays for revision' : 'The House of Review would revise'}: ${point.summary}`,
      evidenceRefs: [point.evidence],
      disposition: 'deferred',
      owner: chamberId,
      returnCondition:
        power === 'delay'
          ? 'Reconsidered by the House of Review if this delivery returns for remediation.'
          : 'Revisit when this area is next amended.',
      dispositionRationale:
        'The second chamber revises and delays; it does not veto except on constitutional safety ground, so this is disclosed rather than blocking.',
    });
  }

  return { findings, delayed, vetoes, revisions };
}

