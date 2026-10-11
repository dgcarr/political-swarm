// Section 6's Cabinet of Maintainers, and section 11's confidence.
//
// The load-bearing idea here is collective responsibility: "once an executive plan is approved
// internally, the cabinet must either defend it collectively or record a formal dissent and resign
// from the relevant role. This prevents agents from claiming authority when a plan succeeds and
// denying responsibility when it fails."
//
// That needs a moment where a minister's own position is on the record, and there is exactly one:
// the government reply. When the Opposition objects, the responsible minister answers — and either
// defends the motion or concedes the point. A minister who concedes and then watches the motion
// carried anyway is in precisely the position section 6 describes. So the concession is the formal
// dissent, and the resignation follows from it. No extra dispatch is needed, because the reply is
// already being made.
//
// Confidence is decided on the government's record rather than on anybody's opinion of it. Nothing
// in this file dispatches.

import type { OfficeRegister } from './offices.js';
import { candidatesFor } from './offices.js';
import type { DemocraticConfig } from './types.js';
import { DEMOCRATIC_DEFAULTS } from '../../constitution/schema.js';

export interface TermTally {
  carried: number;
  defeated: number;
}

/** The minister answering for a portfolio, or a stable fallback if the register has no such seat. */
export function ministerFor(register: OfficeRegister | undefined, portfolioTag: string): string {
  return register?.cabinet[portfolioTag] ?? `minister-${portfolioTag}`;
}

export interface DissentInput {
  portfolioTag: string;
  personaId: string;
  /** Whether the minister conceded the Opposition's objection in its reply. */
  conceded: boolean;
  /** Whether the House carried the motion notwithstanding. */
  carried: boolean;
  collectiveResponsibility: boolean;
}

export interface CabinetDissent {
  portfolioTag: string;
  personaId: string;
  resigned: boolean;
  rationale: string;
}

/**
 * Applies collective responsibility to one carried motion.
 *
 * Only a conceded objection on a motion that was nonetheless carried produces a dissent. A minister
 * who defended the motion is bound by the collective line whether or not it was wise; a minister
 * whose motion was defeated has nothing to be collectively responsible for.
 */
export function assessCollectiveResponsibility(input: DissentInput): CabinetDissent | null {
  if (!input.collectiveResponsibility) return null;
  if (!input.conceded || !input.carried) return null;

  return {
    portfolioTag: input.portfolioTag,
    personaId: input.personaId,
    resigned: true,
    rationale:
      `The minister conceded the Opposition's objection and the House carried the motion regardless. ` +
      'Under collective responsibility the minister may not both concede the point and answer for the ' +
      'policy, so the dissent is recorded formally and the portfolio changes hands.',
  };
}

/**
 * Hands a portfolio to a successor after a resignation.
 *
 * Returns null when the roster is exhausted — a cabinet with nobody left to appoint is a real state
 * and should be reported, not papered over with a recycled name.
 */
export function replaceMinister(
  register: OfficeRegister,
  portfolioTag: string,
  perOffice: number,
): { register: OfficeRegister; incoming: string } | null {
  const taken = new Set(Object.values(register.cabinet));
  const incoming = candidatesFor(`minister-${portfolioTag}`, perOffice + 2, register.termId).find((c) => !taken.has(c));
  if (!incoming) return null;

  return {
    register: {
      ...register,
      cabinet: { ...register.cabinet, [portfolioTag]: incoming },
      holders: register.holders.map((h) =>
        h.office === 'minister' && h.seat === portfolioTag ? { ...h, personaId: incoming } : h,
      ),
    },
    incoming,
  };
}

// ----------------------------------------------------------------- confidence

export type ConfidenceOutcome = 'sustained' | 'lost';

export interface ConfidenceMotion {
  subject: string;
  ayes: number;
  noes: number;
  abstentions: number;
  outcome: ConfidenceOutcome;
  rationale: string;
}

export interface ConfidenceInput {
  subject: string;
  constituencies: readonly string[];
  tally: TermTally;
  consecutiveFailures: number;
}

export interface ConfidenceBallot {
  elector: string;
  choice: 'aye' | 'no' | 'abstain';
}

/** A carried confidence motion needs quorum; only an actual majority against withdraws it. */
export function tallyConfidenceBallots(
  subject: string,
  electors: readonly string[],
  ballots: readonly ConfidenceBallot[],
): ConfidenceMotion {
  const eligible = new Set(electors);
  const seen = new Set<string>();
  let ayes = 0;
  let noes = 0;
  let abstentions = 0;
  for (const ballot of ballots) {
    if (!eligible.has(ballot.elector) || seen.has(ballot.elector)) {
      throw new Error(`Invalid confidence elector: ${ballot.elector}.`);
    }
    seen.add(ballot.elector);
    if (ballot.choice === 'aye') ayes += 1;
    else if (ballot.choice === 'no') noes += 1;
    else if (ballot.choice === 'abstain') abstentions += 1;
    else throw new Error('Invalid confidence position.');
  }
  abstentions += electors.length - ballots.length;
  const quorumMet = electors.length > 0 && ballots.length / electors.length >= 0.5;
  const outcome = quorumMet && noes > ayes ? 'lost' : 'sustained';
  return {
    subject, ayes, noes, abstentions, outcome,
    rationale: quorumMet
      ? `Members cast ${ayes} aye, ${noes} no, and ${abstentions} abstentions; ` +
        (outcome === 'lost' ? 'a majority of votes cast withdrew confidence.' : 'confidence was not withdrawn.')
      : 'Fewer than half of members participated; the motion cannot withdraw confidence.',
  };
}

/**
 * Puts the question of confidence, decided on the government's record.
 *
 * Section 11 lists the grounds — repeated failure to meet acceptance criteria, unauthorised scope
 * expansion, concealment, refusal to answer scrutiny — and the one this runtime can actually
 * observe is the first. So the question each member answers is whether the government has carried
 * more than it has lost. A member with no record to go on abstains, for the same reason it abstains
 * on a motion it cannot inspect, and confidence is lost only on an actual majority against: section
 * 11's threshold for loss of confidence is a simple majority, not an absence of support.
 */
export function putConfidenceMotion(input: ConfidenceInput): ConfidenceMotion {
  const { carried, defeated } = input.tally;
  const decided = carried + defeated;
  const members = input.constituencies.length;

  if (decided === 0) {
    return {
      subject: input.subject,
      ayes: 0,
      noes: 0,
      abstentions: members,
      outcome: 'sustained',
      rationale: 'The government has no record before the House, so confidence is not withdrawn on speculation.',
    };
  }

  const against = defeated > carried;
  return {
    subject: input.subject,
    ayes: against ? 0 : members,
    noes: against ? members : 0,
    abstentions: 0,
    outcome: against ? 'lost' : 'sustained',
    rationale: against
      ? `The government has lost ${defeated} of ${decided} motions this term, and after ` +
        `${input.consecutiveFailures} consecutive defeats the House withdraws its confidence.`
      : `The government has carried ${carried} of ${decided} motions this term and retains the confidence of the House.`,
  };
}

/** Whether the government's run of defeats has reached the point where the question must be put. */
export function confidenceMotionDue(consecutiveFailures: number, cfg: DemocraticConfig): boolean {
  const threshold = cfg.confidence?.governmentFailuresBeforeMotion ?? DEMOCRATIC_DEFAULTS.confidence.governmentFailuresBeforeMotion;
  return threshold > 0 && consecutiveFailures >= threshold;
}
