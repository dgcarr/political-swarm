// Section 6's constitutional guardian — "a constrained constitutional guardian analogous to a
// ceremonial head of state… Its reserve powers must be explicit and rarely used."
//
// Explicit and rarely used are both design requirements, so this file is a short list of named
// powers with a precondition each, and nothing else. There is no general "the guardian may
// intervene when something seems wrong": a reserve power that can be reached by judgment is not a
// reserve power, it is a second executive.
//
// Nothing here dispatches. Every precondition is a fact about the run, and section 6 is explicit
// that this office does not govern day to day.

import { ARTICLES, charterDigest } from './constitution.js';
import type { Finding } from '../../engine/packets.js';
import type { FileOp } from '../../engine/types.js';
import type { DemocraticConfig } from './types.js';
import { DEMOCRATIC_DEFAULTS } from '../../constitution/schema.js';

export type ReservePower =
  | 'appoint-coordinator'
  | 'refuse-unconstitutional-instruction'
  | 'trigger-election'
  | 'preserve-charter'
  | 'authorise-emergency-rollback';

export interface ReservePowerExercise {
  power: ReservePower;
  subject: string;
  rationale: string;
}

/**
 * Section 6: "refuse an obviously unconstitutional instruction."
 *
 * "Obviously" is the operative word, and it is why this checks the change rather than forming a
 * view about it. The one thing a change can do that is unconstitutional on its face, without
 * anybody needing to judge whether it is a good idea, is delete a test — every doctrine forbids
 * weakening a test to obtain a passing result, and the engine holds the same floor independently.
 * Anything subtler than that belongs to the committees and the courts, not to a reserve power.
 */
export function refusesInstruction(
  fileOps: readonly FileOp[],
  isTestPath: (path: string) => boolean,
): ReservePowerExercise | null {
  const deletedTests = fileOps.filter((op) => op.op === 'delete' && isTestPath(op.path)).map((op) => op.path);
  if (deletedTests.length === 0) return null;

  return {
    power: 'refuse-unconstitutional-instruction',
    subject: deletedTests.join(', '),
    rationale:
      'The instruction would delete a test. No office, committee or majority may weaken a test to obtain a ' +
      'passing result, so the guardian refuses it on its face.',
  };
}

export interface RollbackInput {
  remediationCycles: number;
  openNonWaivable: readonly Finding[];
  cfg: DemocraticConfig;
}

export interface TaskAttemptRollbackInput {
  attemptNumber: number;
  taskId: string;
  requiredChanges: readonly string[];
  cfg: DemocraticConfig;
}

/**
 * Section 6: "authorise emergency rollback under narrowly defined conditions."
 *
 * The narrow condition: the same delivery has come back for remediation more times than the charter
 * allows and still carries an unremedied constitutional finding. That is a swarm which has had its
 * chances and is not converging, and section 14's answer to endless deliberation is an automatic
 * closure rule rather than another round. The power is to put it in front of a human — the guardian
 * does not roll anything back itself, because article 12 leaves that with the project owner.
 */
export function authorisesEmergencyRollback(input: RollbackInput): ReservePowerExercise | null {
  const ceiling = input.cfg.ceremonialHead?.emergencyRollbackAfterRemediationCycles ?? DEMOCRATIC_DEFAULTS.ceremonialHead.emergencyRollbackAfterRemediationCycles;
  if (ceiling <= 0 || input.remediationCycles < ceiling) return null;
  if (input.openNonWaivable.length === 0) return null;

  // The findings reaching here are already marked non-waivable by whoever raised them, so naming
  // what is outstanding is more use than re-deriving a category they all share.
  const outstanding = input.openNonWaivable.map((f) => f.summary);

  return {
    power: 'authorise-emergency-rollback',
    subject: `${input.remediationCycles} remediation cycles`,
    rationale:
      `After ${input.remediationCycles} cycles the delivery still carries ` +
      `${outstanding.length} unremedied constitutional finding(s): ${outstanding.join('; ')}. The guardian puts ` +
      'an emergency rollback before the human project owner, in whom article 12 vests the decision.',
  };
}

/**
 * Applies the same automatic closure rule while a motion is still being recommitted, before a
 * delivery exists. The live rework directive is the unresolved defect record at this stage.
 */
export function authorisesTaskAttemptRollback(input: TaskAttemptRollbackInput): ReservePowerExercise | null {
  const ceiling = input.cfg.ceremonialHead?.emergencyRollbackAfterRemediationCycles ?? DEMOCRATIC_DEFAULTS.ceremonialHead.emergencyRollbackAfterRemediationCycles;
  if (ceiling <= 0 || input.attemptNumber < ceiling || input.requiredChanges.length === 0) return null;

  return {
    power: 'authorise-emergency-rollback',
    subject: `${input.taskId}: ${input.attemptNumber} task attempts`,
    rationale:
      `After ${input.attemptNumber} attempts the motion still carries ${input.requiredChanges.length} ` +
      `required repair(s): ${input.requiredChanges.join('; ')}. The guardian puts an emergency rollback ` +
      'before the human project owner, in whom article 12 vests the decision.',
  };
}

/** Section 6: "formally appoint the coordinator who commands confidence." */
export function appointsCoordinator(incoming: string, outgoing: string): ReservePowerExercise {
  return {
    power: 'appoint-coordinator',
    subject: incoming,
    rationale: `${outgoing} no longer commands the confidence of the House; ${incoming} is called to form a government.`,
  };
}

/** Section 6: "trigger an election after loss of confidence." */
export function triggersElection(termId: number): ReservePowerExercise {
  return {
    power: 'trigger-election',
    subject: `term ${termId}`,
    rationale: 'Confidence is lost and no alternative commands the House, so the offices return to the country.',
  };
}

/**
 * Section 6: "preserve the constitutional charter."
 *
 * Returns the charter as it stands together with the count of articles, so the delivery record
 * carries what the run was actually governed by rather than a claim that it was governed.
 */
export function preservesCharter(): ReservePowerExercise & { articles: number; digest: string } {
  return {
    power: 'preserve-charter',
    subject: `${ARTICLES.length} articles`,
    rationale: 'The charter under which this run was conducted, recorded with the delivery.',
    articles: ARTICLES.length,
    digest: charterDigest(),
  };
}
