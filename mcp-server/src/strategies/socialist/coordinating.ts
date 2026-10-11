// Section 6's recallable coordinating council: "composed of temporary delegates from affected
// worker councils". It consolidates the shared plan, identifies dependencies and integration order,
// allocates scarce resources, brokers conflicts, and "returns decisions to worker councils when
// they do not require federation-wide action".
//
// Section 14 names the failure this body invites — bureaucratic capture, "a permanent coordinating
// layer [that] may monopolise context and issue instructions without contributing to production" —
// and lists the safeguards: "short mandates, rotation, recall, public records, no privileged
// knowledge, productive duties and separation from final verification". Every one of those is
// checked here rather than described:
//
//   short mandate   -> a term counted in completed work units, after which the council reforms
//   rotation        -> the convener is redrawn, and never the outgoing one while anyone else is free
//   recall          -> councils/recallDelegate, plus the coordinating-level swap the strategy keeps
//   no privileged knowledge, separation from verification -> constitution/monopolyBreaches
//   productive duty -> productiveDutyMet, checked against who actually implemented and reviewed
//   narrow mandate  -> constitution/mandateBreaches, so it cannot decide technical truth
//
// Deterministic throughout. The one thing this body genuinely needs a model for — arbitrating a
// live cross-council collision — it already has, and that dispatch is unchanged.

import { drawByLot, seededRandom } from '../../util/lots.js';
import { mandateBreaches, type CoordinatingDecision, type MandateBreach } from './constitution.js';
import type { WorkerCouncil } from './councils.js';
import type { SocialistConfig } from './types.js';
import { SOCIALIST_DEFAULTS } from '../../constitution/schema.js';

export interface CoordinatingCouncil {
  termId: number;
  /** council id -> the delegate that council sent. */
  delegates: Record<string, string>;
  /** The delegate currently chairing. Holds no extra authority; only convenes. */
  convener: string;
  /** How many work units had been completed when this term was seated. */
  seatedAt: number;
}

/**
 * Seats a coordinating council from the delegates the worker councils chose.
 *
 * The convener is drawn by lot from among them, and `previousConvener` is excluded while anyone
 * else is available — rotation that can return the same chair by chance is not rotation. With one
 * council there is nothing to federate and the sole delegate convenes by default.
 */
export function formCoordinatingCouncil(input: {
  councils: readonly WorkerCouncil[];
  termId: number;
  seed: string;
  seatedAt: number;
  previousConvener?: string;
}): CoordinatingCouncil {
  const { councils, termId, seed, seatedAt } = input;
  const delegates: Record<string, string> = {};
  for (const council of councils) delegates[council.id] = council.delegate;

  const pool = [...new Set(Object.values(delegates))].filter((d) => d.length > 0);
  const rotatable = pool.filter((d) => d !== input.previousConvener);
  const eligible = rotatable.length > 0 ? rotatable : pool;
  const random = seededRandom(`${seed}:convener:term-${termId}`);
  const convener = drawByLot(eligible, 1, random)[0] ?? '';

  return { termId, delegates, convener, seatedAt };
}

/** Article 5: the mandate expires. A term length of 0 disables rotation entirely. */
export function termExpired(completedTasks: number, council: CoordinatingCouncil, cfg: SocialistConfig): boolean {
  const term = cfg.coordinating?.termLengthInTasks ?? SOCIALIST_DEFAULTS.coordinating.termLengthInTasks;
  return term > 0 && completedTasks - council.seatedAt >= term;
}

/** Reforms the council for a new term, carrying the outgoing convener forward only to exclude it. */
export function rotateCoordinatingCouncil(
  previous: CoordinatingCouncil,
  councils: readonly WorkerCouncil[],
  seed: string,
  completedTasks: number,
): CoordinatingCouncil {
  return formCoordinatingCouncil({
    councils,
    termId: previous.termId + 1,
    seed,
    seatedAt: completedTasks,
    previousConvener: previous.convener,
  });
}

// ------------------------------------------------------------- the mandate

/**
 * Articles 5 and 6, applied to one decision the coordinating council is about to take.
 *
 * Returns the breach if there is one, so the caller can record it and return the matter to the
 * council that owns it. The configured mandate list is honoured, but only ever to *narrow* the
 * default: a config that added a subject would be a doctrine editing its own constitution, and
 * article 6 is not a tunable.
 */
export function checkMandate(decision: CoordinatingDecision, cfg: SocialistConfig): MandateBreach | null {
  const configured = cfg.coordinating?.mandate;
  if (Array.isArray(configured) && configured.length > 0 && !(configured as readonly string[]).includes(decision.subject)) {
    return {
      body: decision.decidedBy,
      taskId: decision.taskId,
      decision: decision.subject,
      article: 'article-5',
      remedy: `Article 5: this swarm's coordinating mandate covers ${configured.join(', ')}. Return the matter to the affected council.`,
    };
  }
  return mandateBreaches([decision])[0] ?? null;
}

// -------------------------------------------------- no approving your own work

export interface ArbitrationOutcome {
  assigneeId: string;
  /** True when the convener's own name was replaced by the council's capability ordering. */
  overrodeSelfAllocation: boolean;
}

/**
 * Section 6: coordinators "cannot approve their own consequential decisions".
 *
 * A convener that arbitrates a cross-council collision and names itself as the worker has done
 * exactly that — decided the allocation and taken its benefit. The seat is not punished for it; the
 * allocation simply falls back to the council's own capability ordering, which is where article 3
 * puts it anyway.
 */
export function withoutSelfAllocation(
  convener: string,
  proposedAssignee: string,
  councilPreference: string,
): ArbitrationOutcome {
  if (proposedAssignee && proposedAssignee === convener && councilPreference && councilPreference !== convener) {
    return { assigneeId: councilPreference, overrodeSelfAllocation: true };
  }
  return { assigneeId: proposedAssignee, overrodeSelfAllocation: false };
}

// ----------------------------------------------------------- productive duty

export interface ProductiveDuty {
  convener: string;
  met: boolean;
  /** What the convener actually did, for the record. */
  contributed: string[];
}

/**
 * Section 6: "Coordinators must also perform inspectable productive or verification work when
 * feasible."
 *
 * Checked against who actually implemented and reviewed in this run — not against a claim. A
 * convener that coordinated and produced nothing is disclosed, never blocked: on a one-node run
 * there may genuinely have been no second piece of work to take, and section 6's own "when
 * feasible" says as much. Refusing a delivery over it would punish the shape of the task.
 */
export function productiveDutyMet(
  convener: string,
  implementers: readonly string[],
  reviewers: readonly string[],
  cfg: SocialistConfig,
): ProductiveDuty {
  if (!(cfg.coordinating?.requireProductiveDuty ?? SOCIALIST_DEFAULTS.coordinating.requireProductiveDuty) || !convener) {
    return { convener, met: true, contributed: [] };
  }
  const contributed: string[] = [];
  if (implementers.includes(convener)) contributed.push('implementation');
  if (reviewers.includes(convener)) contributed.push('verification');
  return { convener, met: contributed.length > 0, contributed };
}
