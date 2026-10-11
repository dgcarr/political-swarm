// Bounded decisions through a decision model (WorkerDispatcher.decide), shared by every doctrine so
// the arms stay symmetric. Each helper returns undefined whenever the decision model is off, failed,
// or not decisive enough; the call site then makes its ordinary chat call, unchanged. The answer
// that comes back is the argmax, so every tally and threshold downstream counts it exactly as it
// counts a chat vote today.

import type { EngineContext } from '../engine/SwarmStrategy.js';
import type { DecisionAnswer } from '../engine/OpenRouterClient.js';
import type { DecideDispatchOptions } from '../engine/WorkerDispatcher.js';

/** For a vote with a real alternative (aye/no, recall/retain): below this, the chat ballot decides. */
export const DECISION_VOTE_FLOOR = 0.6;

function enabled(ctx: EngineContext): boolean {
  // Strategy tests build dispatchers with only dispatch(); those run as mode 'off'.
  return typeof ctx.dispatcher.decidesFirst === 'function' && ctx.dispatcher.decidesFirst();
}

/** Several independent questions about one state, in one request; all must clear the floor. */
export async function decideQuestions(
  ctx: EngineContext,
  opts: Omit<DecideDispatchOptions, 'role'>,
): Promise<Record<string, DecisionAnswer> | undefined> {
  if (!enabled(ctx)) return undefined;
  const outcome = await ctx.dispatcher.decide(opts);
  return outcome.accepted ? outcome.answers : undefined;
}

/** "p(aye)=0.82 p(no)=0.11 …" for one answer, recorded where a chat call would write a rationale. */
export function summariseAnswer(answer: DecisionAnswer): string {
  if (answer.type === 'noul') return `p(yes)=${answer.noul.toFixed(2)}`;
  return Object.entries(answer.probabilities)
    .sort(([, a], [, b]) => b - a)
    .map(([option, p]) => `p(${option})=${p.toFixed(2)}`)
    .join(' ');
}

export interface ChoiceDecision<K extends string> {
  choice: K;
  probabilities: Record<string, number>;
  /** "p(aye)=0.82 p(no)=0.11 …", recorded where a chat ballot would have written a rationale. */
  summary: string;
}

/** One choice among `options`, each described by its criterion. */
export async function decideChoice<K extends string>(
  ctx: EngineContext,
  opts: {
    personaId?: string;
    taskId?: string;
    instructions: string;
    state: DecideDispatchOptions['state'];
    options: Record<K, string>;
    floor: number;
    accept?: (answer: DecisionAnswer & { type: 'choice' }) => boolean;
    institutionalReplayKey?: string;
  },
): Promise<ChoiceDecision<K> | undefined> {
  if (!enabled(ctx)) return undefined;
  const outcome = await ctx.dispatcher.decide({
    personaId: opts.personaId,
    taskId: opts.taskId,
    state: opts.state,
    questions: { decision: { type: 'choice', instructions: opts.instructions, criteria: opts.options } },
    confidenceFloor: opts.floor,
    accept: opts.accept ? (answers) => opts.accept!(answers.decision as DecisionAnswer & { type: 'choice' }) : undefined,
    institutionalReplayKey: opts.institutionalReplayKey,
  });
  const answer = outcome.answers?.decision;
  if (!outcome.accepted || answer?.type !== 'choice') return undefined;
  return { choice: answer.choice as K, probabilities: answer.probabilities, summary: summariseAnswer(answer) };
}

/**
 * A ballot among candidates, or an abstention. Candidates of equal standing are interchangeable, so
 * no floor applies to which one is chosen; an abstention is only taken when the model clearly
 * prefers it, because a ballot that abstains for want of a preference leaves an office empty.
 */
export async function decideCandidateBallot(
  ctx: EngineContext,
  opts: {
    personaId: string;
    instructions: string;
    state: DecideDispatchOptions['state'];
    candidates: readonly string[];
    abstainCriterion: string;
  },
): Promise<{ candidate: string | null } | undefined> {
  const options = Object.fromEntries([
    ...opts.candidates.map((candidate) => [candidate, `Vote for ${candidate}.`]),
    ['abstain', opts.abstainCriterion],
  ]) as Record<string, string>;
  const decided = await decideChoice(ctx, {
    personaId: opts.personaId,
    instructions: opts.instructions,
    state: opts.state,
    options,
    floor: 0,
    accept: (answer) => answer.choice !== 'abstain' || (answer.probabilities.abstain ?? 0) >= DECISION_VOTE_FLOOR,
  });
  if (!decided) return undefined;
  return { candidate: decided.choice === 'abstain' ? null : decided.choice };
}

export type Vote = 'aye' | 'no' | 'abstain';

/**
 * An aye/no/abstain ballot. Taken from the decision model only when it is decisive; the probability
 * summary stands in for the ballot's written reason, which these call sites only record.
 */
export async function decideVote(
  ctx: EngineContext,
  opts: {
    personaId: string;
    taskId?: string;
    instructions: string;
    state: DecideDispatchOptions['state'];
    criteria: Record<Vote, string>;
  },
): Promise<{ vote: Vote; rationale: string } | undefined> {
  const decided = await decideChoice<Vote>(ctx, {
    personaId: opts.personaId,
    taskId: opts.taskId,
    instructions: opts.instructions,
    state: opts.state,
    options: opts.criteria,
    floor: DECISION_VOTE_FLOOR,
  });
  return decided && { vote: decided.choice, rationale: `Decided by decision model: ${decided.summary}.` };
}
