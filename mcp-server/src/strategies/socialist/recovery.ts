// Section 11's recovery path. "When work fails, the swarm preserves the failure evidence, contains
// or reverts unsafe changes, and determines whether the cause was implementation, specification,
// allocation, integration or infrastructure. It then supplies aid, reduces scope, changes approach
// or reassigns the task. After repeated failure, councils replace the responsible coordinator or
// owner and commission an independent diagnosis."
//
// The order in that paragraph is the design. Diagnosis comes *before* the remedy, and article 11
// says why: "blame may not substitute for diagnosis and repair". Taking work away from a worker is
// the swarm asserting the worker was the problem, and doing it without having established that is
// blame wearing a procedure's clothes. So every reassignment here carries a cause, and
// constitution.blameWithoutDiagnosis() checks that it does.
//
// The deterministic pass below answers most cases from signals already collected, for nothing. It
// is also willing to say it does not know — and that, plus repeated failure, is what commissions the
// one independent diagnosis dispatch. A run where the first attempt lands pays for neither.

import { matchesAnyGlob } from '../../util/glob.js';
import { drawByLot, seededRandom } from '../../util/lots.js';
import type { SocialistConfig } from './types.js';
import { SOCIALIST_DEFAULTS } from '../../constitution/schema.js';

/** Section 11's taxonomy, exactly as the doctrine lists it. */
export type FailureCause = 'implementation' | 'specification' | 'allocation' | 'integration' | 'infrastructure';

export interface FailureSignals {
  taskId: string;
  /** Whether the check harness produced a result at all. */
  checksRan: boolean;
  /** Whether the node carries acceptance criteria to have been judged against. */
  hasCriteria: boolean;
  /** A worker handed the node back. */
  wasReturned: boolean;
  /** Every eligible worker handed it back. */
  returnedByAll: boolean;
  /** It failed again after a different worker took it on. */
  survivedReassignment: boolean;
  /** The failure surfaced at integration or verification rather than on the node itself. */
  atBarrier: boolean;
}

export interface CauseFinding {
  cause: FailureCause;
  /** False when nothing in the record distinguished the causes and this is the residual answer. */
  confident: boolean;
  rationale: string;
}

/**
 * What went wrong, from what the run already recorded.
 *
 * Note the residual case. When no signal distinguishes the causes, the answer is "implementation"
 * with `confident: false` — because "the worker got it wrong" is exactly the conclusion that is
 * cheapest to reach and easiest to be wrong about, and the honest label for it is a default rather
 * than a finding. That is the case worth spending a diagnosis dispatch on.
 */
export function classifyCause(signals: FailureSignals): CauseFinding {
  if (!signals.checksRan) {
    return {
      cause: 'infrastructure',
      confident: true,
      rationale: 'The checks did not run, so nothing was established about the work itself.',
    };
  }
  if (signals.atBarrier) {
    return {
      cause: 'integration',
      confident: true,
      rationale: 'The work passed on its own and failed in combination, which is a property of the tree rather than the node.',
    };
  }
  if (signals.returnedByAll) {
    return {
      cause: 'specification',
      confident: true,
      rationale: 'Every worker offered this node declined it. A whole council refusing the same work is a statement about the work.',
    };
  }
  if (!signals.hasCriteria) {
    return {
      cause: 'specification',
      confident: true,
      rationale: 'The node carries no acceptance criteria, so there was nothing for the work to be judged against.',
    };
  }
  if (signals.wasReturned) {
    return {
      cause: 'allocation',
      confident: true,
      rationale: 'The worker it was given to handed it back, and another took it — the council routed it wrongly the first time.',
    };
  }
  if (signals.survivedReassignment) {
    return {
      cause: 'specification',
      confident: true,
      rationale: 'A second worker failed it the same way, which rules out the first worker as the cause.',
    };
  }
  return {
    cause: 'implementation',
    confident: false,
    rationale: 'Nothing in the record distinguishes the causes; this is the residual answer, not a finding.',
  };
}

/** Section 11: repeated failure "commissions an independent diagnosis". */
export function diagnosisDue(attempts: number, deterministic: CauseFinding, cfg: SocialistConfig): boolean {
  const threshold = cfg.recovery?.failuresBeforeDiagnosis ?? SOCIALIST_DEFAULTS.recovery.failuresBeforeDiagnosis;
  if (threshold <= 0) return false;
  return attempts >= threshold && !deterministic.confident;
}

/** Section 14's retry limit: "define retry limits… re-scope or reassign work". */
export function retryLimitReached(attempts: number, cfg: SocialistConfig): boolean {
  const max = cfg.recovery?.maxAttemptsPerNode ?? SOCIALIST_DEFAULTS.recovery.maxAttemptsPerNode;
  return max > 0 && attempts >= max;
}

export interface Diagnosis {
  cause: FailureCause;
  remedy: string;
  rationale: string;
  /** Whether the evidence actually points at this cause, rather than nothing else standing out. */
  confident: boolean;
}

const CAUSES: readonly FailureCause[] = ['implementation', 'specification', 'allocation', 'integration', 'infrastructure'];

export function validateDiagnosis(value: unknown): void {
  if (typeof value !== 'object' || value === null) throw new Error('A diagnosis must be a JSON object.');
  const v = value as Record<string, unknown>;
  if (typeof v.cause !== 'string' || !CAUSES.includes(v.cause as FailureCause)) {
    throw new Error(`A diagnosis "cause" must be one of: ${CAUSES.join(', ')}.`);
  }
  for (const field of ['remedy', 'rationale']) {
    if (typeof v[field] !== 'string' || (v[field] as string).trim().length === 0) {
      throw new Error(`A diagnosis must include a non-empty "${field}" string.`);
    }
  }
  if (typeof v.confident !== 'boolean') {
    throw new Error('A diagnosis must say whether the evidence establishes the cause: "confident" true or false.');
  }
}

// ------------------------------------------------------------ the appeal panel

/**
 * Section 11: "A council may appeal a decision that changes its agreed scope or violates the
 * constitution to a temporary, independently selected review panel."
 *
 * Both grounds are recorded facts rather than opinions, which is why nothing here is dispatched. An
 * appeal heard by asking a model whether it sympathises would be an appeal decided on rhetoric, and
 * section 9 puts evidence over eloquence in as many words.
 */
export type AppealGround = 'scope-change' | 'constitutional-breach';

export interface AppealInput {
  taskId: string;
  appellant: string;
  /** The globs the plan allocated to this council — what it declared before editing. */
  agreedScope: readonly string[];
  /** The paths the work actually wrote to. */
  touchedPaths: readonly string[];
  /** Constitutional breaches recorded against this node. */
  breaches: readonly string[];
}

/** Paths the work wrote that its own declared allocation does not cover. */
export function pathsOutsideScope(input: Pick<AppealInput, 'agreedScope' | 'touchedPaths'>): string[] {
  if (input.agreedScope.length === 0) return [];
  return input.touchedPaths.filter((p) => !matchesAnyGlob(p, [...input.agreedScope]));
}

/**
 * The ground an appeal stands on, or null if it has none.
 *
 * The scope ground is section 8's comparison, not a re-reading of the plan: "workers declare
 * intended paths before editing and compare repository status, diffs and shared call paths at
 * convergence". Only an expansion counts. Work that came in under its allocation has not had its
 * scope changed against it, and a council appealing that it was asked to do less would be appealing
 * its own good fortune.
 */
export function appealGround(input: AppealInput): AppealGround | null {
  if (input.breaches.length > 0) return 'constitutional-breach';
  if (pathsOutsideScope(input).length > 0) return 'scope-change';
  return null;
}

/**
 * A temporary panel, drawn by lot from outside the affected council and outside the authorship
 * chain.
 *
 * Independence here is structural, not a claim: the draw simply cannot return anyone with a stake.
 * Returns an empty panel when the swarm has nobody left who qualifies, and the caller records that
 * the appeal could not be heard — which is a truthful outcome, and better than convening a panel of
 * the people being appealed against.
 */
export function convenePanel(
  pool: readonly string[],
  excluded: readonly string[],
  size: number,
  seed: string,
): string[] {
  const barred = new Set(excluded);
  const eligible = pool.filter((p) => !barred.has(p));
  return drawByLot(eligible, Math.max(0, size), seededRandom(seed));
}

export interface Appeal {
  taskId: string;
  appellant: string;
  panel: string[];
  granted: boolean;
  rationale: string;
}

export function hearAppeal(input: AppealInput, panel: string[], cfg: SocialistConfig): Appeal {
  const ground = appealGround(input);

  if (ground === 'scope-change' && !(cfg.recovery?.appealOnScopeChange ?? SOCIALIST_DEFAULTS.recovery.appealOnScopeChange)) {
    return {
      taskId: input.taskId,
      appellant: input.appellant,
      panel,
      granted: false,
      rationale: 'This swarm does not hear scope-change appeals.',
    };
  }
  if (!ground) {
    return {
      taskId: input.taskId,
      appellant: input.appellant,
      panel,
      granted: false,
      rationale: 'The appeal names no ground: the agreed scope stands and no constitutional breach was recorded.',
    };
  }
  if (panel.length === 0) {
    return {
      taskId: input.taskId,
      appellant: input.appellant,
      panel,
      granted: false,
      rationale:
        `The appeal stands on ${ground.replace(/-/g, ' ')}, but no panel could be drawn from outside the ` +
        'affected council and the authorship chain, so it could not be heard independently.',
    };
  }
  return {
    taskId: input.taskId,
    appellant: input.appellant,
    panel,
    granted: true,
    rationale:
      ground === 'constitutional-breach'
        ? `Granted: a constitutional breach was recorded against this work (${input.breaches.join('; ')}).`
        : `Granted: the work wrote outside the scope the plan allocated to this council (${pathsOutsideScope(input).join(', ')}).`,
  };
}
