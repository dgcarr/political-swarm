import type { TaskSpec } from './types.js';

/**
 * Shared goal-scale assessment so all three strategies agree on how much decomposition a goal
 * warrants. Every planner prompt used to hardcode "STRONGLY prefer a single node", which is right
 * for a small interactive task ("add isEven plus its test") but wrong for a whole-package goal:
 * one implementer call cannot deliver a multi-module engineering package in one pass, so the task
 * is always under-delivered and then correctly rejected by verification.
 *
 * This is deliberately a deterministic heuristic over the TaskSpec text rather than an LLM call —
 * it costs nothing, is unit-testable, and keeps the "how many nodes" decision auditable.
 */
export interface GoalScale {
  /** Best estimate of how many distinct requirements the goal enumerates. */
  deliverables: number;
  /** Bullet/numbered/heading lines in the goal — a proxy for enumerated deliverables. */
  structuralItems: number;
  /** Distinct concrete file paths mentioned in the goal. */
  pathHints: number;
  /** True once the goal holds clearly more than one node's worth of work. */
  large: boolean;
  /** Inclusive range of plan nodes the planner should aim for. */
  suggestedNodes: { min: number; max: number };
}

/** Hard cap on suggested nodes: beyond this, per-node overhead and budget dominate. */
export const MAX_SUGGESTED_NODES = 8;

/** Roughly how many related requirements one implementer can deliver in a single pass. */
const REQUIREMENTS_PER_NODE = 3;

/** Below this many deliverables the goal still fits in one node. */
const LARGE_GOAL_DELIVERABLES = 6;

/** Chars of prose that imply one more deliverable, for goals written without any list structure. */
const CHARS_PER_IMPLIED_REQUIREMENT = 1500;

const STRUCTURAL_LINE = /^(?:[-*+]|\d+[.)])\s+\S/;
const HEADING_LINE = /^#{1,6}\s+\S/;
const PATH_LIKE = /[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)+\.[a-zA-Z0-9]+/g;

function countStructuralItems(goal: string): number {
  let count = 0;
  for (const line of goal.split('\n')) {
    const trimmed = line.trim();
    if (STRUCTURAL_LINE.test(trimmed) || HEADING_LINE.test(trimmed)) count += 1;
  }
  return count;
}

function countPathHints(goal: string): number {
  return new Set(goal.match(PATH_LIKE) ?? []).size;
}

export function assessGoalScale(task: TaskSpec): GoalScale {
  const goal = task.goal ?? '';
  const structuralItems = countStructuralItems(goal);
  const pathHints = countPathHints(goal);
  const criteria = task.acceptanceCriteria?.length ?? 0;
  // A long goal with no list structure at all is still broad, so length provides a floor rather
  // than being summed in — otherwise verbosity alone could inflate a genuinely narrow request.
  const lengthImplied = Math.floor(goal.length / CHARS_PER_IMPLIED_REQUIREMENT);

  const deliverables = Math.max(structuralItems, pathHints, criteria, lengthImplied);
  const max = Math.min(Math.max(Math.ceil(deliverables / REQUIREMENTS_PER_NODE), 1), MAX_SUGGESTED_NODES);
  const min = Math.max(1, Math.ceil(max / 2));

  return {
    deliverables,
    structuralItems,
    pathHints,
    large: deliverables >= LARGE_GOAL_DELIVERABLES,
    suggestedNodes: { min, max },
  };
}

/**
 * Planner-prompt text telling the model how far to decompose. Injected into the user prompt (not
 * the system prompt) so the instruction sits next to the goal it describes, and so the strategies'
 * system prompts stay strategy-flavoured rather than each duplicating sizing rules.
 */
export function decompositionGuidance(task: TaskSpec, unitNoun = 'node'): string {
  const { large, suggestedNodes, deliverables } = assessGoalScale(task);
  const plural = `${unitNoun}s`;

  if (!large) {
    return (
      `Sizing: this goal is small. Return exactly ONE ${unitNoun} unless it names two or more genuinely ` +
      `independent, separately-reviewable deliverables. Do not split one coherent change per-file.`
    );
  }

  const { min, max } = suggestedNodes;
  return (
    `Sizing: this goal is LARGE — it enumerates roughly ${deliverables} distinct requirements, far more than ` +
    `one implementer can deliver in a single pass. Split it into ${min}-${max} ${plural}. Each ${unitNoun} must ` +
    `be independently implementable and verifiable on its own (a coherent slice such as one module plus its ` +
    `tests), not a vague phase like "write the rest". Use "dependsOn" to order ${plural} that genuinely build ` +
    `on each other, and make sure the ${plural} together cover the whole goal.`
  );
}
