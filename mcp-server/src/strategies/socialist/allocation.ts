// Article 4: "Work is allocated according to capability and capacity; resources and mutual aid are
// allocated according to demonstrated need, difficulty and risk." Article 6: "Decisions remain with
// the smallest affected council unless cross-council dependencies require collective coordination."
// Section 6: a worker "may refuse or return an assignment when it exceeds their capability, lacks
// acceptance criteria, conflicts with another change or cannot be performed safely with available
// resources. Such a return is useful planning information, not insubordination."
//
// Three rules, one file, all deterministic and all free — the right to return rides the implementer
// dispatch that was happening anyway, and the other two are arithmetic over signals already
// collected.
//
// The distinction article 4 draws is easy to lose and worth stating: *work* follows capability,
// *resources* follow need. Those pull in opposite directions on purpose. Giving the hardest work to
// the highest scorer and also giving that worker the most context would compound a recorded metric
// into a privilege, which is section 14's "metric productivism" arriving through the back door. So
// the needs assessment below reads the work — its risk, its breadth, its dependencies, its history
// of failure — and never reads who holds it.

import type { RiskClass, TaskNode } from '../../engine/types.js';
import type { SocialistConfig } from './types.js';
import { SOCIALIST_DEFAULTS } from '../../constitution/schema.js';

// ------------------------------------------------------------ needs (article 4)

export interface NeedsAssessment {
  taskId: string;
  /** 0..1, from the work itself. Never from the worker. */
  difficulty: number;
  riskClass: RiskClass;
  /** How many commons lessons this node's review may draw on. */
  lessonBudget: number;
  /** Whether work of this difficulty warrants mutual aid the moment it blocks. */
  aidEligible: boolean;
  rationale: string;
}

const RISK_WEIGHT: Record<RiskClass, number> = { low: 0, medium: 0.5, high: 1 };

/** Beyond this many target paths a node is as broad as the measure can usefully say. */
const BREADTH_SATURATION = 6;
/** Beyond this many dependencies, likewise. */
const DEPENDENCY_SATURATION = 3;
/** Beyond this many prior rejections the node is plainly in trouble. */
const REJECTION_SATURATION = 2;

/** Below this, work is simple enough that failing it points at the plan rather than at the worker. */
const AID_NEED_FLOOR = 0.34;

const DEFAULT_WEIGHTS = SOCIALIST_DEFAULTS.allocation.needsWeighting;
const DEFAULT_LESSON_BUDGET = SOCIALIST_DEFAULTS.allocation.lessonBudget;

function ratio(value: number, saturation: number): number {
  return Math.max(0, Math.min(1, value / saturation));
}

/**
 * How much of the commons this work needs, from the work alone.
 *
 * Prior rejections carry the same weight as risk class, deliberately. A node that has already come
 * back twice has demonstrated need in the most direct way available — section 11's remedy for
 * repeated failure is to "supply aid, reduce scope, change approach or reassign", and supplying aid
 * comes first in that list.
 */
export function assessNeeds(
  node: Pick<TaskNode, 'id' | 'riskClass' | 'targetGlobs' | 'dependsOn'>,
  priorRejections: number,
  cfg: SocialistConfig,
): NeedsAssessment {
  const w = { ...DEFAULT_WEIGHTS, ...(cfg.allocation?.needsWeighting ?? {}) };
  const budget = { ...DEFAULT_LESSON_BUDGET, ...(cfg.allocation?.lessonBudget ?? {}) };

  const riskClass = node.riskClass ?? 'low';
  const parts: [string, number, number][] = [
    ['risk', RISK_WEIGHT[riskClass] ?? 0, w.riskClass],
    ['breadth', ratio(node.targetGlobs?.length ?? 0, BREADTH_SATURATION), w.breadth],
    ['dependencies', ratio(node.dependsOn?.length ?? 0, DEPENDENCY_SATURATION), w.dependencies],
    ['prior failures', ratio(priorRejections, REJECTION_SATURATION), w.priorRejections],
  ];

  const totalWeight = parts.reduce((sum, [, , weight]) => sum + Math.max(0, weight), 0);
  const difficulty =
    totalWeight === 0 ? 0 : parts.reduce((sum, [, value, weight]) => sum + value * Math.max(0, weight), 0) / totalWeight;

  const min = Math.max(0, Math.min(budget.min, budget.max));
  const max = Math.max(min, budget.max);
  const lessonBudget = min + Math.round(difficulty * (max - min));

  const named = parts.filter(([, value, weight]) => value > 0 && weight > 0).map(([label]) => label);

  return {
    taskId: node.id,
    difficulty,
    riskClass,
    lessonBudget,
    aidEligible: difficulty >= AID_NEED_FLOOR || riskClass !== 'low',
    rationale:
      named.length > 0
        ? `Need is driven by ${named.join(', ')}; the work draws ${lessonBudget} lessons from the commons.`
        : `Nothing about this work raises its need above the floor; it draws ${lessonBudget} lessons from the commons.`,
  };
}

/** A half-sized minimum keeps simple work funded; difficult work may draw up to 1.5 times the
 * common base. The final grant is still bounded by the run's uncommitted budget. */
export function requestedEnvelopeUsd(needs: NeedsAssessment, baseUsd: number): number {
  return Math.round(Math.max(0, baseUsd) * (0.5 + needs.difficulty) * 10000) / 10000;
}

// ------------------------------------------------------ subsidiarity (article 6)

export interface SubsidiarityDecision {
  taskId: string;
  decidedBy: 'council' | 'coordinating-council';
  councils: string[];
  escalated: boolean;
  rationale: string;
}

/**
 * Where a node's allocation is decided.
 *
 * Section 14's "central bottleneck": every local choice waiting on the coordinating council, whose
 * safeguard is "subsidiarity — councils decide local implementation while coordinators handle only
 * shared interfaces, ordering and scarce resources". The rule was already in the code as an unnamed
 * `primary.length <= 1` shortcut; naming it means a reader can see the choice being made and check
 * it, and means an escalation that should not have happened is visible as one.
 */
export function routeBySubsidiarity(taskId: string, contendingCouncils: readonly string[]): SubsidiarityDecision {
  const councils = [...contendingCouncils];
  const escalated = councils.length > 1;
  return {
    taskId,
    decidedBy: escalated ? 'coordinating-council' : 'council',
    councils,
    escalated,
    rationale: escalated
      ? `The work spans ${councils.length} councils, so the dependency between them is genuinely federal.`
      : 'One council is affected and settles this itself; federation-wide action was not required.',
  };
}

// -------------------------------------------------- the right to return (section 6)

export interface AssignmentReturn {
  returned: boolean;
  reason: string;
}

/**
 * Reads a worker's refusal out of unvalidated model output.
 *
 * Every field is `typeof`-guarded before it is touched. This runs inside execute(), on the task
 * loop, where a thrown TypeError is not a rejected node but a crashed run — and the value being
 * read is whatever a model chose to emit.
 */
export function readAssignmentReturn(value: unknown): AssignmentReturn | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = (value as Record<string, unknown>).assignmentReturn;
  if (typeof raw !== 'object' || raw === null) return null;

  const r = raw as Record<string, unknown>;
  if (r.returned !== true) return null;
  const reason = typeof r.reason === 'string' && r.reason.trim().length > 0 ? r.reason.trim() : 'No reason given.';
  return { returned: true, reason };
}

/**
 * The next worker the council would have chosen, excluding everyone who has already handed the work
 * back. Returns null when the council has nobody left — at which point the node is not a worker
 * problem but a planning one, and the caller says so.
 */
export function nextAssignee(
  members: readonly string[],
  alreadyReturned: readonly string[],
  capability: Record<string, number> = {},
): string | null {
  const declined = new Set(alreadyReturned);
  const eligible = members.filter((m) => !declined.has(m));
  if (eligible.length === 0) return null;
  return eligible.reduce((best, m) => ((capability[m] ?? 0) > (capability[best] ?? 0) ? m : best), eligible[0]);
}

/** How many times a node may be handed back before it stops being a worker problem. */
export function returnsBeforeReplan(cfg: SocialistConfig): number {
  const configured = cfg.allocation?.returnsBeforeReplan;
  return typeof configured === 'number' && configured >= 0 ? configured : SOCIALIST_DEFAULTS.allocation.returnsBeforeReplan;
}
