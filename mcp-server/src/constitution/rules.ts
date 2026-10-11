// The closed set of rules a governance decision may be recorded under, each stated declaratively,
// and the one pure function that says what a rule makes of a set of ballots.
//
// A recorded decision names its rule, its electorate and every position cast. Until this file the
// rule was a free string and nothing checked that the recorded result followed from the positions
// under it: a tally helper could drift from what its rule's name promised and the ledger would
// still read as authority. engine/governance.ts now evaluates every recorded decision against its
// rule here and refuses one whose result the ballots do not support.
//
// Three kinds:
//   threshold  — one choice counted against a fraction of the votes cast or of the whole
//                electorate, with an optional quorum. Each rule lists which recorded results mean
//                "carried" and which mean "failed"; a result outside the list is refused.
//   plurality  — an election: the most-supported candidate wins, given a quorum. Ties are broken by
//                the candidate roster, which the ballots do not carry, so any tied leader is valid.
//   recorded   — a decision that is not a ballot (a market award scored by a published formula).
//                Its positions are recorded as evidence and not tallied.
import type { ThresholdLabel } from './schema.js';

export type Denominator = 'cast' | 'eligible';

export interface Quorum {
  /** Share of the electorate that must take part. */
  fraction: number;
  /** 'participating' counts every ballot including abstentions; 'voting' counts only votes for or against. */
  of: 'participating' | 'voting';
  strict: boolean;
}

export interface ThresholdRule {
  kind: 'threshold';
  description: string;
  /** The choice the threshold counts. */
  inFavour: string;
  /** Choices counted against it. Anything else cast is an abstention. */
  against: string[];
  fraction: number;
  /** 'cast' measures inFavour against inFavour + against; 'eligible' against the whole electorate. */
  denominator: Denominator;
  /** True when the share must exceed the fraction, false when meeting it is enough. */
  strict: boolean;
  quorum?: Quorum;
  /** The result is never final without a human: the ballots decide only whether to refer. */
  requiresHuman: boolean;
  /** Recorded results consistent with the rule having carried, and having failed. */
  results: { carried: string[]; failed: string[] };
}

export interface PluralityRule {
  kind: 'plurality';
  description: string;
  quorum: Quorum;
  /** The position an elector records for no candidate. */
  abstain: string;
  /** The recorded result when nobody is elected. */
  noWinner: string;
  requiresHuman: false;
}

export interface RecordedRule {
  kind: 'recorded';
  description: string;
  requiresHuman: false;
}

export type DecisionRule = ThresholdRule | PluralityRule | RecordedRule;

const AYE_NO = { inFavour: 'aye', against: ['no'] };

// A Commons division under a voteThresholds label. A carried division can still be refused when an
// unanswered Opposition objection blocks it, and categories that always go to a human record
// needs_human whatever the label says; only 'approved' has to follow from the ballots.
const DIVISION_RESULTS = { carried: ['approved', 'rejected', 'needs_human'], failed: ['rejected', 'needs_human'] };
const HUMAN_RESULTS = { carried: ['needs_human'], failed: ['needs_human'] };

const THRESHOLD_RULES: Record<ThresholdLabel, ThresholdRule> = {
  simple_majority: {
    kind: 'threshold', description: 'More ayes than noes among votes cast; abstentions do not count.',
    ...AYE_NO, fraction: 1 / 2, denominator: 'cast', strict: true, requiresHuman: false, results: DIVISION_RESULTS,
  },
  three_fifths: {
    kind: 'threshold', description: 'At least three fifths of votes cast are ayes.',
    ...AYE_NO, fraction: 3 / 5, denominator: 'cast', strict: false, requiresHuman: false, results: DIVISION_RESULTS,
  },
  two_thirds_plus_security_committee: {
    kind: 'threshold',
    description: 'At least two thirds of votes cast are ayes, then a binding Security Committee vote and human sign-off.',
    ...AYE_NO, fraction: 2 / 3, denominator: 'cast', strict: false, requiresHuman: true, results: HUMAN_RESULTS,
  },
  two_thirds_both_chambers: {
    kind: 'threshold',
    description: 'Ayes from at least two thirds of every seated member, so abstentions cannot manufacture it; ' +
      'then the House of Review and human sign-off.',
    ...AYE_NO, fraction: 2 / 3, denominator: 'eligible', strict: false, requiresHuman: true, results: HUMAN_RESULTS,
  },
  human_required: {
    kind: 'threshold',
    description: 'A human decides. The division (two thirds of votes cast) is advisory.',
    ...AYE_NO, fraction: 2 / 3, denominator: 'cast', strict: false, requiresHuman: true, results: HUMAN_RESULTS,
  },
};

export const DECISION_RULES = {
  ...THRESHOLD_RULES,
  'simple-majority-of-engaged-with-quorum': {
    kind: 'threshold',
    description: 'A minority amendment: more ayes than noes, with an absolute majority of engaged members voting.',
    ...AYE_NO, fraction: 1 / 2, denominator: 'cast', strict: true,
    quorum: { fraction: 1 / 2, of: 'voting', strict: true },
    requiresHuman: false, results: { carried: ['adopted'], failed: ['defeated'] },
  },
  'two-thirds-of-all-seated-members': {
    kind: 'threshold', description: 'House of Review: ayes from two thirds of every seated member.',
    ...AYE_NO, fraction: 2 / 3, denominator: 'eligible', strict: false,
    requiresHuman: false, results: { carried: ['carried'], failed: ['defeated'] },
  },
  'two-thirds-of-seated-security-panel': {
    kind: 'threshold', description: 'Security Committee: ayes from two thirds of every seated member.',
    ...AYE_NO, fraction: 2 / 3, denominator: 'eligible', strict: false,
    requiresHuman: false, results: { carried: ['approved'], failed: ['withheld'] },
  },
  'equal-representative-ballot-quorum-half-simple-majority-v1': {
    kind: 'threshold',
    description: 'Confidence is lost only when more representatives vote no than aye, with half of them taking part.',
    inFavour: 'no', against: ['aye'], fraction: 1 / 2, denominator: 'cast', strict: true,
    quorum: { fraction: 1 / 2, of: 'participating', strict: false },
    requiresHuman: false, results: { carried: ['lost'], failed: ['sustained'] },
  },
  'equal-ballot-plurality-quorum-half-tie-roster-order-v1': {
    kind: 'plurality',
    description: 'The candidate with most votes wins if half the electorate cast a ballot; a tie goes to roster order.',
    quorum: { fraction: 1 / 2, of: 'participating', strict: false },
    abstain: 'abstain', noWinner: 'no-mandate', requiresHuman: false,
  },
  'member-council-ratification-v1': {
    kind: 'threshold', description: 'A plan is ratified by approvals from an absolute majority of council members.',
    inFavour: 'approve', against: ['amend', 'reject'], fraction: 1 / 2, denominator: 'eligible', strict: true,
    requiresHuman: false, results: { carried: ['approve'], failed: ['amend', 'reject'] },
  },
  'delegated-council-ratification-v1': {
    kind: 'threshold', description: "The council's delegate carries its plan position alone.",
    inFavour: 'approve', against: ['amend', 'reject'], fraction: 1 / 2, denominator: 'eligible', strict: true,
    requiresHuman: false, results: { carried: ['approve'], failed: ['amend', 'reject'] },
  },
  'member-initiated-absolute-majority-recall-v1': {
    kind: 'threshold', description: 'A delegate is recalled by an absolute majority of council members.',
    inFavour: 'recall', against: ['retain'], fraction: 1 / 2, denominator: 'eligible', strict: true,
    requiresHuman: false, results: { carried: ['recalled'], failed: ['retained'] },
  },
  'member-council-majority-acceptance-v1': {
    kind: 'threshold', description: 'Delivery is accepted by approvals from an absolute majority of council members.',
    inFavour: 'approve', against: ['reject'], fraction: 1 / 2, denominator: 'eligible', strict: true,
    requiresHuman: false, results: { carried: ['approve'], failed: ['reject'] },
  },
  'delegated-council-unanimous-acceptance-v1': {
    kind: 'threshold', description: 'Delivery is accepted only when every delegate approves.',
    inFavour: 'approve', against: ['reject'], fraction: 1, denominator: 'eligible', strict: false,
    requiresHuman: false, results: { carried: ['approve'], failed: ['reject', 'abstain'] },
  },
  'published-weighted-bid-score': {
    kind: 'recorded',
    description: 'The exchange awards the listing to the highest published weighted bid score; bids are recorded, not tallied.',
    requiresHuman: false,
  },
} as const satisfies Record<string, DecisionRule>;

export type RuleId = keyof typeof DECISION_RULES;
export const RULE_IDS = Object.keys(DECISION_RULES) as RuleId[];

export function isRuleId(value: string): value is RuleId {
  return Object.prototype.hasOwnProperty.call(DECISION_RULES, value);
}

export function decisionRule(rule: RuleId): DecisionRule {
  return DECISION_RULES[rule];
}

export type RuleEvaluation =
  | { kind: 'threshold'; carried: boolean; inFavour: number; against: number; abstentions: number; quorumMet: boolean }
  | { kind: 'plurality'; winners: string[]; quorumMet: boolean }
  | { kind: 'recorded' };

// Shares are compared as counts against fraction * base, with a tolerance far below one ballot, so
// 2 of 3 meets two thirds exactly as the integer arithmetic it replaces did.
const EPSILON = 1e-9;

function meets(count: number, base: number, fraction: number, strict: boolean): boolean {
  if (base <= 0) return false;
  const margin = count - fraction * base;
  return strict ? margin > EPSILON : margin >= -EPSILON;
}

/** What `rule` makes of these positions, cast by members of an electorate of `eligibleCount`. */
export function evaluateRule(
  rule: RuleId,
  eligibleCount: number,
  positions: ReadonlyArray<{ actor: string; choice: string }>,
): RuleEvaluation {
  const spec: DecisionRule = DECISION_RULES[rule];
  if (spec.kind === 'recorded') return { kind: 'recorded' };
  if (spec.kind === 'plurality') {
    const quorumMet = meets(positions.length, eligibleCount, spec.quorum.fraction, spec.quorum.strict);
    const votes = new Map<string, number>();
    for (const { choice } of positions) {
      if (choice !== spec.abstain) votes.set(choice, (votes.get(choice) ?? 0) + 1);
    }
    const top = Math.max(0, ...votes.values());
    const winners = quorumMet && top > 0 ? [...votes].filter(([, count]) => count === top).map(([choice]) => choice) : [];
    return { kind: 'plurality', winners, quorumMet };
  }
  const inFavour = positions.filter(({ choice }) => choice === spec.inFavour).length;
  const against = positions.filter(({ choice }) => spec.against.includes(choice)).length;
  const quorumMet = !spec.quorum || meets(spec.quorum.of === 'voting' ? inFavour + against : positions.length,
    eligibleCount, spec.quorum.fraction, spec.quorum.strict);
  const base = spec.denominator === 'cast' ? inFavour + against : eligibleCount;
  return {
    kind: 'threshold',
    carried: quorumMet && meets(inFavour, base, spec.fraction, spec.strict),
    inFavour,
    against,
    abstentions: positions.length - inFavour - against,
    quorumMet,
  };
}

/** Whether a threshold rule carries on these positions. */
export function carries(
  rule: RuleId,
  eligibleCount: number,
  positions: ReadonlyArray<{ actor: string; choice: string }>,
): boolean {
  const evaluation = evaluateRule(rule, eligibleCount, positions);
  return evaluation.kind === 'threshold' && evaluation.carried;
}

/** Whether a vote share (inFavour over votes cast) meets a label's fraction. Null means no votes. */
export function shareMeets(label: ThresholdLabel, share: number | null | undefined): boolean {
  const spec = THRESHOLD_RULES[label];
  if (share === null || share === undefined) return false;
  return spec.strict ? share - spec.fraction > EPSILON : share - spec.fraction >= -EPSILON;
}

export function thresholdRule(label: ThresholdLabel): ThresholdRule {
  return THRESHOLD_RULES[label];
}

/**
 * Null when `result` follows from the positions under `rule`; otherwise why it does not. A
 * 'recorded' rule tallies nothing, so any result stands.
 */
export function resultDisagreement(
  rule: RuleId,
  eligibleCount: number,
  positions: ReadonlyArray<{ actor: string; choice: string }>,
  result: string,
): string | null {
  const spec: DecisionRule = DECISION_RULES[rule];
  const evaluation = evaluateRule(rule, eligibleCount, positions);
  if (evaluation.kind === 'recorded') return null;
  if (evaluation.kind === 'plurality') {
    const expected = evaluation.winners.length ? evaluation.winners : [(spec as PluralityRule).noWinner];
    return expected.includes(result) ? null : `the ballots elect ${expected.join(' or ')}`;
  }
  const { results } = spec as ThresholdRule;
  const allowed = evaluation.carried ? results.carried : results.failed;
  if (allowed.includes(result)) return null;
  return `the ballots (${evaluation.inFavour} for, ${evaluation.against} against, ${evaluation.abstentions} other, ` +
    `quorum ${evaluation.quorumMet ? 'met' : 'not met'}) ${evaluation.carried ? 'carry' : 'do not carry'} the motion, ` +
    `which records as ${allowed.join(' or ')}`;
}

