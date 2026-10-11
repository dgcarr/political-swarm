// Pure, auditable vote logic. Nothing in this file makes a model call — it only combines
// structured signals (committee findings, opposition verdict/severity, riskClass) against the
// thresholds configured in config/strategies.yaml. Kept separate from DemocraticStrategy.ts so
// the decision math can be read (and unit-tested) without the dispatch/orchestration noise.
import { matchesAnyGlob } from '../../util/glob.js';
import { committeeSignal } from './commons.js';
import type { RiskClass, TestResult } from '../../engine/types.js';
import type { CommitteeFinding, MotionClass, ThresholdCategory, VoteInputs, VoteResult } from './types.js';
import { shareMeets, thresholdRule } from '../../constitution/rules.js';

// This repo's own governance/config surface. Touching it is treated as a "constitutional
// amendment" — changing the rules of the swarm itself, not just code the swarm produces about
// some other topic — regardless of riskClass. Deliberately hardcoded rather than config-driven:
// a list of "the paths that define the swarm's own rules" which the swarm could edit through its
// own config would not be much of an entrenchment.
const CONSTITUTIONAL_GLOBS = ['**/config/*.yaml', '**/CLAUDE.md', '**/engine/**', '**/.claude-plugin/**'];

/**
 * Maps riskClass (+ test signal + touched paths) onto one of the five vote-threshold buckets
 * named in config/strategies.yaml. RiskClass only has three values ('low'|'medium'|'high') while
 * the doc names five buckets, so this mapping is this strategy's own documented design choice:
 *   - No test signal at all (test.ran === false) => 'test_waiver'. Approving a change with zero
 *     test evidence is itself an implicit waiver of the testing gate, so it always needs a human.
 *   - Touches the swarm's own governance/config surface (see CONSTITUTIONAL_GLOBS above) =>
 *     'constitutional_amendment', regardless of riskClass.
 *   - Otherwise riskClass maps directly: low -> routine, medium -> cross_module, high -> security_boundary.
 */
export function classifyThresholdCategory(riskClass: RiskClass, test: TestResult, touchedPaths: string[]): ThresholdCategory {
  if (!test.ran) return 'test_waiver';
  if (touchedPaths.some((p) => matchesAnyGlob(p, CONSTITUTIONAL_GLOBS))) return 'constitutional_amendment';
  if (riskClass === 'high') return 'security_boundary';
  if (riskClass === 'medium') return 'cross_module';
  return 'routine';
}

/**
 * First-reading classification, done deterministically from riskClass rather than via an extra
 * `speaker`-role dispatch. Design choice: the speaker's whole job here (routine vs. committee vs.
 * emergency) is already fully determined by the same touched-paths signal classifyRiskByPaths
 * already computed for riskClass, so a separate LLM call would just be re-deriving a label from
 * data we already have deterministically — it wouldn't add judgment, only cost and latency.
 */
export function classifyMotionClass(riskClass: RiskClass): MotionClass {
  if (riskClass === 'high') return 'emergency';
  if (riskClass === 'medium') return 'committee';
  return 'routine';
}

/**
 * Committee's recommendation as a single approve-score: approve=1, flag=0.5, reject=0, averaged
 * over the members who actually voted.
 *
 * Delegates to commons.committeeSignal so abstentions are handled in one place. A committee that
 * returned no view at all scores 0 — it has not endorsed anything, and a threshold measured against
 * silence should not be met.
 */
export function committeeApproveScore(findings: CommitteeFinding[]): number {
  return committeeSignal(findings) ?? 0;
}

/**
 * The deterministic vote. Pure/auditable: no model call happens in here, only combining
 * already-collected structured signals against config-driven thresholds.
 */
export function computeVote(inputs: VoteInputs): VoteResult {
  const { category, thresholdLabel, oppositionVerdict, oppositionSeverity } = inputs;
  // An empty chamber cannot authorize a motion, even if its committee recommended approval.
  const noDivision = inputs.divisionShare === null || inputs.divisionShare === undefined;
  const score = noDivision ? 0 : inputs.divisionShare!;
  const source = noDivision ? 'No representative division' : 'The division';

  // These two categories always require a human, regardless of vote math, and so does any category
  // whose configured threshold is a human one. The threshold itself comes from constitution/rules.ts.
  const rule = thresholdRule(thresholdLabel);
  const share = noDivision ? null : score;
  if (category === 'constitutional_amendment' || category === 'test_waiver' ||
    (rule.requiresHuman && category !== 'security_boundary')) {
    const voteWouldPass = shareMeets(thresholdLabel, share) && oppositionVerdict !== 'reject';
    return {
      outcome: 'needs_human',
      voteWouldPass,
      rationale:
        `Category "${category}" always requires human sign-off per voteThresholds.${category} = "${thresholdLabel}". ` +
        `${source} stands at ${score.toFixed(2)}, opposition verdict "${oppositionVerdict}" (${oppositionSeverity} severity).`,
    };
  }

  // security_boundary: the Commons needs a two-thirds-equivalent majority and cannot ignore a
  // high-severity Opposition objection. The separately constituted Security Committee votes in
  // DemocraticStrategy before a carried motion reaches the human approval boundary.
  if (category === 'security_boundary') {
    const fraction = rule.fraction;
    const highSeverityFlag = oppositionSeverity === 'high' && (oppositionVerdict === 'flag' || oppositionVerdict === 'reject');
    const voteWouldPass = shareMeets(thresholdLabel, share) && !highSeverityFlag && oppositionVerdict !== 'reject';
    return {
      outcome: 'needs_human',
      voteWouldPass,
      rationale:
        `security_boundary always requires human sign-off after the Commons and Security Committee votes. ` +
        `Commons division share ${score.toFixed(2)} (threshold ${fraction.toFixed(2)}), ` +
        `opposition verdict "${oppositionVerdict}" (${oppositionSeverity} severity, high-severity-flag=${highSeverityFlag}).`,
    };
  }

  // routine / cross_module: simple/stricter majority. A non-low-severity Opposition "reject" sends
  // the motion back once, whatever the score: the Opposition is the only reader of the actual diff
  // (the committee saw only the motion), and section 7 stage 4 requires the Government to "answer
  // objections rather than repeat conclusions". Section 6 gives the Opposition powers of challenge,
  // not a veto, so once the Government has answered, the House decides and a standing objection
  // becomes a minority report. A high-severity objection still turns the security member's vote in
  // the division itself.
  const oppositionBlocks = oppositionVerdict === 'reject' && oppositionSeverity !== 'low' && !inputs.oppositionAnswered;
  // Each label states its own strictness: simple_majority passes on strictly-greater-than-half,
  // three_fifths at-or-above 60% — matching "simple majority" vs. "three-fifths" wording literally.
  const voteWouldPass = shareMeets(thresholdLabel, share);

  if (oppositionBlocks) {
    return {
      outcome: 'rejected',
      voteWouldPass,
      rationale: `Opposition raised a ${oppositionSeverity}-severity reject. The motion returns for the Government to answer it before the House decides (${source.toLowerCase()} ${score.toFixed(2)}).`,
    };
  }
  if (voteWouldPass) {
    return {
      outcome: 'approved',
      voteWouldPass,
      rationale: inputs.oppositionAnswered && oppositionVerdict === 'reject'
        ? `${source} at ${score.toFixed(2)} met the "${thresholdLabel}" threshold for category "${category}". The Opposition's ${oppositionSeverity}-severity reject was already answered once; it stands as a minority report.`
        : `${source} at ${score.toFixed(2)} met the "${thresholdLabel}" threshold for category "${category}", and opposition did not block (verdict "${oppositionVerdict}", ${oppositionSeverity} severity).`,
    };
  }
  return {
    outcome: 'rejected',
    voteWouldPass,
    rationale: `${source} at ${score.toFixed(2)} did not meet the "${thresholdLabel}" threshold for category "${category}".`,
  };
}
