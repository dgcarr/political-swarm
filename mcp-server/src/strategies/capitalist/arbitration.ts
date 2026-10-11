// Section 6's Courts and Arbitration — "a neutral adjudication layer" for the disputes the doctrine
// names, decided on "repository evidence, tests, logs and signed contracts".
//
// Every one of those disputes was being decided unilaterally by whichever party happened to hold the
// pen. The sharpest case is the test-infrastructure heuristic in decide(): when a check fails with
// output that looks like the command could not be spawned at all, something has to decide whether
// that is a defect in the delivery or an environment the contract cannot be blamed for. That is
// exactly section 6's "who caused a regression", and it was being settled by a regular expression
// on behalf of the supplier. The regex is a reasonable prior — it encodes a real, documented failure
// — but a prior is not an adjudication, and the party it happens to favour should not be the one
// applying it.
//
// This is the one place in the doctrine where a model call is the right instrument rather than a
// concession. A dispute is a contested reading of evidence; that is a judgment, and unlike an award
// or a price it cannot be computed from the record. What is *not* left to the model is whether the
// judgment counts: section 6 requires judgments to rely on repository evidence, so a ruling citing
// none is void here regardless of how well it argues. That check is deterministic.
//
// Disputes are detected deterministically too, and only genuine conflicts qualify. Section 14's
// time-box applies — an arbitration costs a model call, and a market that litigates everything has
// simply moved its transaction costs rather than reduced them.

import { isNonEmptyString } from '../validation.js';
import { clipCheckOutput } from '../../util/checkOutput.js';

/** The six matters section 6 says the adjudication layer resolves. */
export type DisputeMatter =
  | 'acceptance-criteria' // "whether acceptance criteria were met"
  | 'regression-cause' // "who caused a regression"
  | 'misleading-bid' // "whether a bid was misleading"
  | 'scope-change' // "whether scope changed"
  | 'rollback-cost' // "who bears rollback cost"
  | 'market-power'; // "whether a module owner abused market power"

export interface Dispute {
  matter: DisputeMatter;
  taskId: string;
  /** What the buyer's side of the record says. */
  buyerPosition: string;
  /** What the supplier's side says. */
  supplierPosition: string;
  /** Repository evidence both sides are arguing from. */
  evidence: string[];
}

export interface DisputeInput {
  taskId: string;
  personaId: string;
  /** The independent reviewer's verdict on the delivery. */
  reviewerVerdict?: 'approve' | 'reject' | 'flag';
  /** Whether the regulator flagged the delivery for leaving its statement of work. */
  scopeFlagged: boolean;
  scopePaths: string[];
  /** The check that ran against the delivery. */
  testRan: boolean;
  testPassed: boolean;
  testOutput?: string;
  /** Whether that output looks like the command could not be spawned rather than like a failure. */
  looksLikeInfraFailure: boolean;
}

/**
 * Which genuine disputes this settlement carries.
 *
 * "Genuine" is doing real work. A delivery both parties agree failed is not a dispute, it is a
 * failure; sending it to arbitration would spend a model call to have a third party confirm what
 * nobody contests. Only positions that actually conflict qualify.
 *
 * Only matters whose ruling settlement acts on are raised. "Whether a bid was misleading" used to be
 * raised here too, but nothing read its ruling — article 7 is checked from the bid register at the
 * gate — so it cost a model call and one of the run's few arbitration slots to change nothing.
 */
export function detectDisputes(input: DisputeInput): Dispute[] {
  const disputes: Dispute[] = [];

  // Section 6's "who caused a regression". The check failed, and its output looks like the command
  // never ran — so the buyer sees an unproven delivery and the supplier sees a broken environment.
  // Both readings are available from the same output, which is what makes it a dispute rather than
  // a fact.
  if (input.testRan && !input.testPassed && input.looksLikeInfraFailure) {
    disputes.push({
      matter: 'regression-cause',
      taskId: input.taskId,
      buyerPosition:
        'The contracted check did not pass, so the delivery is unproven and the contract has not been performed.',
      supplierPosition:
        'The check never executed — the output shows the command could not be spawned — so this is the ' +
        'environment failing, not the delivered code, and the contract should be judged on the code.',
      evidence: [
        `check output: ${clipCheckOutput(input.testOutput ?? '', 400)}`,
        'the delivered file operations',
      ],
    });
  }

  // Section 6's "whether scope changed". The reviewer accepted the work and the regulator says it
  // reached outside what was bought — a real conflict, because both can be true at once.
  if (input.scopeFlagged && input.reviewerVerdict === 'approve') {
    disputes.push({
      matter: 'scope-change',
      taskId: input.taskId,
      buyerPosition:
        `The delivery touched ${input.scopePaths.join(', ')}, outside the awarded statement of work. That is ` +
        'authority beyond the mandate, whatever its quality.',
      supplierPosition:
        'The independent reviewer accepted the delivery on its merits. The paths outside the declared globs were ' +
        'necessary to perform the contract as specified, and the statement of work was drawn too narrowly.',
      evidence: [...input.scopePaths, 'the awarded statement of work'],
    });
  }

  return disputes;
}

// ------------------------------------------------------------------ the ruling

export type RulingFor = 'buyer' | 'supplier' | 'split';

export interface WireRuling {
  ruling: RulingFor;
  rationale: string;
  /** Which party bears the cost that follows. */
  liableParty: 'buyer' | 'supplier' | 'shared';
  /** The repository evidence the judgment actually rests on. */
  evidenceCited: string[];
}

export const arbitrationSchemaDescription =
  '{ "ruling": "buyer"|"supplier"|"split", "rationale": string (1-3 plain sentences, no quotation marks, ' +
  'newlines or code fences inside it), "liableParty": "buyer"|"supplier"|"shared", "evidenceCited": string[] ' +
  '(the specific files, commands or contract terms your judgment rests on — a judgment citing nothing is void) }';

export function validateRuling(value: unknown): void {
  const v = value as Partial<WireRuling>;
  if (!v || typeof v !== 'object') throw new Error('Ruling must be an object');
  if (v.ruling !== 'buyer' && v.ruling !== 'supplier' && v.ruling !== 'split') {
    throw new Error('ruling must be "buyer", "supplier" or "split"');
  }
  if (v.liableParty !== 'buyer' && v.liableParty !== 'supplier' && v.liableParty !== 'shared') {
    throw new Error('liableParty must be "buyer", "supplier" or "shared"');
  }
  if (!isNonEmptyString(v.rationale)) throw new Error('rationale is required');
  if (!Array.isArray(v.evidenceCited)) throw new Error('evidenceCited must be an array');
}

/**
 * Whether a ruling is grounded well enough to stand.
 *
 * Section 6: "Judgments rely on repository evidence, tests, logs and signed contracts." A ruling
 * that cites none of those is an opinion about who ought to win, and this is the one part of
 * arbitration that must not be left to the arbitrator — an adjudicator who could waive its own
 * evidentiary requirement has none.
 */
export function rulingIsGrounded(ruling: WireRuling): boolean {
  return ruling.evidenceCited.some((e) => isNonEmptyString(e));
}

export interface Adjudication {
  matter: DisputeMatter;
  taskId: string;
  ruling: RulingFor;
  liableParty: 'buyer' | 'supplier' | 'shared';
  rationale: string;
  evidenceCited: string[];
  /** Whether the ruling stood, or was set aside for citing nothing. */
  stood: boolean;
}

/**
 * The ruling as it takes effect.
 *
 * An ungrounded ruling is set aside and the matter falls to the buyer — not because the buyer is
 * right, but because the supplier bears the burden of showing the contract was performed. Section 9
 * puts that burden squarely: a delivery is incomplete "when any acceptance criterion lacks
 * evidence". An unproven claim losing is the same rule applied to the adjudication itself.
 */
export function applyRuling(dispute: Dispute, ruling: WireRuling): Adjudication {
  const stood = rulingIsGrounded(ruling);
  return {
    matter: dispute.matter,
    taskId: dispute.taskId,
    ruling: stood ? ruling.ruling : 'buyer',
    liableParty: stood ? ruling.liableParty : 'supplier',
    rationale: stood
      ? ruling.rationale
      : `The ruling cited no repository evidence and is set aside. Section 6 puts judgments on evidence, and the ` +
        `burden of showing the contract was performed is the supplier's. Original reasoning: ${ruling.rationale}`,
    evidenceCited: ruling.evidenceCited.filter((e) => isNonEmptyString(e)),
    stood,
  };
}

/** Whether the supplier's position prevailed — the only thing settlement needs to know. */
export function supplierPrevailed(adjudication: Adjudication): boolean {
  return adjudication.ruling === 'supplier';
}
