// Section 6's Code Commons — the representative chamber — and section 8's answer to the oldest
// question in representative government: is a member a delegate or a trustee?
//
// The doctrine takes a position, and this file implements that position rather than a general one.
// Section 3 on Burke: "Module representatives consult worker agents but may reject a popular
// proposal when evidence shows it is technically unsound." The departure the doctrine describes
// runs one way — a representative may break with its constituency to *refuse* a motion the
// evidence contradicts, not to carry one the constituency doubts. A passing test does not answer
// a scope objection, so a representative that overrode its committee on the strength of green CI
// would be practising section 14's "populist optimisation" with extra ceremony.
//
// The other rule doing real work here is section 6's: "An agent should not vote on a proposal it
// cannot inspect. Abstention is preferable to uninformed voting." Most motions do not touch most
// constituencies, so most representatives abstain, and the division is decided by the members who
// actually have something to go on. An abstention is not counted against the threshold — it is not
// a vote.
//
// Nothing here dispatches. Every input is already collected by the time the division is called.

import { matchesAnyGlob } from '../../util/glob.js';
import type { RiskClass, TestResult } from '../../engine/types.js';
import type { CommitteeFinding, OppositionFinding } from './types.js';

export type Vote = 'aye' | 'no' | 'abstain';

export interface RepresentativeVote {
  constituency: string;
  personaId: string;
  vote: Vote;
  /** True when the member voted against the signal from its own constituency's committee. */
  departed: boolean;
  /** Why — and for a departure, the evidence section 8 requires it to disclose. */
  rationale: string;
}

export interface Division {
  ayes: number;
  noes: number;
  abstentions: number;
  votes: RepresentativeVote[];
  /** Constituencies whose member departed from the committee signal, with the evidence recorded. */
  departures: string[];
}

/** An amendment authorizes a revised attempt, never acceptance of the original work. */
export function tallyAmendmentBallots(
  eligible: readonly string[],
  ballots: readonly { constituency: string; vote: Vote }[],
): boolean {
  const electorate = new Set(eligible);
  if (electorate.size !== eligible.length || electorate.size === 0) throw new Error('Invalid amendment electorate.');
  const cast = new Set<string>();
  for (const ballot of ballots) {
    if (!['aye', 'no', 'abstain'].includes(ballot.vote)) throw new Error('Invalid amendment vote.');
    if (!electorate.has(ballot.constituency)) throw new Error(`Foreign amendment ballot: ${ballot.constituency}.`);
    if (cast.has(ballot.constituency)) throw new Error(`Duplicate amendment ballot: ${ballot.constituency}.`);
    cast.add(ballot.constituency);
  }
  if (cast.size !== electorate.size) throw new Error('Missing amendment ballot.');
  const ayes = ballots.filter((ballot) => ballot.vote === 'aye').length;
  const noes = ballots.filter((ballot) => ballot.vote === 'no').length;
  const active = ayes + noes;
  return active >= Math.floor(electorate.size / 2) + 1 && ayes > noes;
}

/** A constitutional motion needs two thirds of every seated chamber, including abstentions. */
export function tallyChamberSupermajority(
  eligible: readonly string[],
  ballots: readonly { member: string; vote: Vote }[],
): boolean {
  const electorate = new Set(eligible);
  if (electorate.size !== eligible.length || electorate.size === 0) throw new Error('Invalid chamber electorate.');
  const cast = new Set<string>();
  for (const ballot of ballots) {
    if (!electorate.has(ballot.member)) throw new Error(`Foreign chamber ballot: ${ballot.member}.`);
    if (cast.has(ballot.member)) throw new Error(`Duplicate chamber ballot: ${ballot.member}.`);
    if (!['aye', 'no', 'abstain'].includes(ballot.vote)) throw new Error('Invalid chamber vote.');
    cast.add(ballot.member);
  }
  if (cast.size !== electorate.size) throw new Error('Missing chamber ballot.');
  return ballots.filter((ballot) => ballot.vote === 'aye').length >= Math.ceil(electorate.size * 2 / 3);
}

/** Replace the advisory division with expressed votes from engaged representatives. */
export function expressedDivision(base: Division, engaged: readonly string[],
  ballots: readonly { constituency: string; vote: Vote; rationale: string }[]): Division {
  const ballotByConstituency = new Map(ballots.map((ballot) => [ballot.constituency, ballot]));
  if (ballotByConstituency.size !== ballots.length) throw new Error('Duplicate representative ballot.');
  for (const constituency of engaged) {
    if (!ballotByConstituency.has(constituency)) throw new Error(`Missing representative ballot: ${constituency}.`);
  }
  const votes = base.votes.map((member) => {
    const ballot = ballotByConstituency.get(member.constituency);
    if (!ballot) return member;
    if (!engaged.includes(member.constituency)) {
      throw new Error(`Unengaged constituency ${member.constituency} cannot cast a ballot.`);
    }
    return { ...member, vote: ballot.vote, rationale: ballot.rationale, departed: false };
  });
  for (const constituency of ballotByConstituency.keys()) {
    if (!base.votes.some((vote) => vote.constituency === constituency)) {
      throw new Error(`Foreign representative ballot: ${constituency}.`);
    }
  }
  return {
    ayes: votes.filter((vote) => vote.vote === 'aye').length,
    noes: votes.filter((vote) => vote.vote === 'no').length,
    abstentions: votes.filter((vote) => vote.vote === 'abstain').length,
    departures: votes.filter((vote) => vote.departed).map((vote) => vote.constituency),
    votes,
  };
}

/**
 * Portfolio tags the planner may emit, mapped onto the constituencies section 6 names. The planner
 * schema and the constituency list were written for different purposes and do not use identical
 * words, so an unmapped tag falls through to the constituency of the same name if there is one.
 */
const PORTFOLIO_TO_CONSTITUENCY: Record<string, string> = {
  docs: 'documentation',
  documentation: 'documentation',
  architecture: 'backend',
  implementation: 'backend',
  backend: 'backend',
  frontend: 'frontend',
  ux: 'user-experience',
  'user-experience': 'user-experience',
  security: 'security',
  testing: 'testing',
  verification: 'testing',
  integration: 'operations',
  operations: 'operations',
  'release-operations': 'operations',
  data: 'data',
};

export function leadConstituency(portfolioTag: string, constituencies: readonly string[]): string {
  const mapped = PORTFOLIO_TO_CONSTITUENCY[portfolioTag.trim().toLowerCase()];
  if (mapped && constituencies.includes(mapped)) return mapped;
  if (constituencies.includes(portfolioTag)) return portfolioTag;
  return constituencies[0] ?? portfolioTag;
}

export interface EngagementInput {
  portfolioTag: string;
  riskClass: RiskClass;
  touchedPaths: readonly string[];
  test: TestResult;
  securityPathGlobs: readonly string[];
}

/**
 * Which constituencies have something to go on for this motion.
 *
 * A member of an unengaged constituency abstains, and that is the intended outcome rather than a
 * gap: section 6 prefers abstention to uninformed voting, and a chamber where every member votes
 * on every motion regardless of whether they can inspect it is exactly the majoritarian error
 * section 14 warns about.
 */
export function engagedConstituencies(input: EngagementInput, constituencies: readonly string[]): string[] {
  const engaged = new Set<string>();
  engaged.add(leadConstituency(input.portfolioTag, constituencies));

  // Security sits on every high-risk motion and on anything touching a protected path, whether or
  // not the motion was referred to it.
  if (
    constituencies.includes('security') &&
    (input.riskClass === 'high' || input.touchedPaths.some((p) => matchesAnyGlob(p, [...input.securityPathGlobs])))
  ) {
    engaged.add('security');
  }

  // Testing has something to go on exactly when a check actually ran.
  if (constituencies.includes('testing') && input.test.ran) engaged.add('testing');

  // Anything else whose name appears in a path the motion touches — a crude signal, but a true one:
  // if the change is under src/frontend, the frontend members can inspect it.
  const haystack = input.touchedPaths.join(' ').toLowerCase();
  for (const constituency of constituencies) {
    const needle = constituency.split('-')[0];
    if (needle.length > 2 && haystack.includes(needle)) engaged.add(constituency);
  }

  return constituencies.filter((c) => engaged.has(c));
}

/**
 * The committee's recommendation as a single approve-score: approve = 1, flag = 0.5, reject = 0.
 *
 * Abstentions are dropped from the average rather than scored at a half. A member who says "I
 * cannot judge this" has not said "I half approve", and averaging it as such would let a committee
 * of abstainers carry a motion at exactly the threshold.
 */
export function committeeSignal(findings: readonly CommitteeFinding[]): number | null {
  const voting = findings.filter((f) => f.verdict !== 'abstain');
  if (voting.length === 0) return null;
  const total = voting.reduce((sum, f) => sum + (f.verdict === 'approve' ? 1 : f.verdict === 'flag' ? 0.5 : 0), 0);
  return total / voting.length;
}

export interface DivisionInput {
  constituencies: readonly string[];
  representatives: Record<string, string>;
  engaged: readonly string[];
  committeeFindings: readonly CommitteeFinding[];
  oppositionVerdict: OppositionFinding['verdict'];
  oppositionSeverity: OppositionFinding['severity'];
  test: TestResult;
}

/**
 * Evidence bearing on one constituency's own remit, if it has any.
 *
 * This is what stops a division being a formality. Every member reads the same committee signal, so
 * if that were the only input the House would divide unanimously every time, `divisionShare` would
 * only ever be 0 or 1, and the configured thresholds — simple majority, three-fifths, two-thirds —
 * would all collapse into the same test. Members differ because their remits differ: the testing
 * member can read the check, the security member can read the Opposition's severity, and a member
 * with neither has only the committee's view to go on.
 *
 * Returns null where the constituency has no evidence of its own.
 */
function specialismEvidence(constituency: string, input: DivisionInput): { against: boolean; because: string } | null {
  if (constituency === 'testing' && input.test.ran) {
    return input.test.passed
      ? { against: false, because: 'the check ran and passed' }
      : { against: true, because: 'the check ran and failed' };
  }
  if (constituency === 'security' && input.oppositionVerdict !== 'approve') {
    return input.oppositionSeverity === 'high'
      ? { against: true, because: `the Opposition raised a high-severity ${input.oppositionVerdict} on the diff` }
      : { against: false, because: `the Opposition's ${input.oppositionSeverity}-severity ${input.oppositionVerdict} does not reach a security objection` };
  }
  return null;
}

/**
 * Calls the division.
 *
 * The constituency signal is the committee's, and a member carries it unless evidence *within its
 * own remit* contradicts it — in which case it departs, one way only, towards refusing. Section 3
 * states Burke that way round: a representative "may reject a popular proposal when evidence shows
 * it is technically unsound". A passing check does not turn a doubting member for a motion, because
 * green CI does not answer a scope objection.
 *
 * Confining a departure to the member's own remit is what makes this a chamber rather than a bloc.
 * A failed check is the testing member's business to act on; it is not a reason for the
 * documentation member to overrule a committee it has no standing to second-guess.
 *
 * An inconclusive committee signal, including a lone flag, is an abstention. It cannot be
 * transformed into approval merely because the expedited committee had one seat.
 */
export function callDivision(input: DivisionInput): Division {
  const signal = committeeSignal(input.committeeFindings);
  const engaged = new Set(input.engaged);

  const votes: RepresentativeVote[] = input.constituencies.map((constituency) => {
    const personaId = input.representatives[constituency] ?? `representative-${constituency}`;

    if (!engaged.has(constituency)) {
      return {
        constituency,
        personaId,
        vote: 'abstain',
        departed: false,
        rationale: 'The motion does not touch this constituency, and an uninspected motion is not voted on.',
      };
    }
    if (signal === null) {
      return {
        constituency,
        personaId,
        vote: 'abstain',
        departed: false,
        rationale: 'The committee returned no view this member could represent.',
      };
    }

    const constituencyView: Vote = signal > 0.5 ? 'aye' : signal < 0.5 ? 'no' : 'abstain';
    const own = specialismEvidence(constituency, input);

    if (constituencyView === 'aye' && own?.against) {
      return {
        constituency,
        personaId,
        vote: 'no',
        departed: true,
        rationale:
          `The constituency's committee favoured the motion (score ${signal.toFixed(2)}), but ` +
          `${own.because}. The member departs from that view on evidence within its own remit.`,
      };
    }

    return {
      constituency,
      personaId,
      vote: constituencyView,
      departed: false,
      rationale:
        constituencyView === 'abstain'
          ? `The committee did not endorse or reject the motion (score ${signal.toFixed(2)}), so the member abstains.`
          : `The member carries the constituency's committee view (score ${signal.toFixed(2)})${own ? `, and ${own.because}` : ''}.`,
    };
  });

  return {
    ayes: votes.filter((v) => v.vote === 'aye').length,
    noes: votes.filter((v) => v.vote === 'no').length,
    abstentions: votes.filter((v) => v.vote === 'abstain').length,
    votes,
    departures: votes.filter((v) => v.departed).map((v) => v.constituency),
  };
}

/**
 * The fraction of the division that carried the motion, or null when nobody was in a position to
 * vote. Abstentions are excluded from the denominator: the threshold is measured against the members
 * who voted, which is what "a majority of those present and voting" has always meant.
 */
export function divisionShare(division: Division): number | null {
  const cast = division.ayes + division.noes;
  return cast === 0 ? null : division.ayes / cast;
}

/** Section 8's "persistent misrepresentation or incompetence": a member who carried a motion the
 * House then had to refuse. Departures are not counted — those came with evidence attached. */
export function misrepresentations(division: Division, outcome: 'approved' | 'rejected' | 'needs_human'): string[] {
  if (outcome !== 'rejected') return [];
  return division.votes.filter((v) => v.vote === 'aye' && !v.departed).map((v) => v.constituency);
}
