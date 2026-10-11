import { describe, expect, it, vi } from 'vitest';
import type { EngineContext } from '../engine/SwarmStrategy.js';
import type { DecideDispatchOptions } from '../engine/WorkerDispatcher.js';
import { DECISION_VOTE_FLOOR, decideCandidateBallot, decideVote } from './decisions.js';

function ctxWith(probabilities: Record<string, number>, mode: 'off' | 'pure' = 'pure') {
  // Mirrors WorkerDispatcher.decide's acceptance rule over a fixed distribution.
  const decide = vi.fn(async (opts: DecideDispatchOptions) => {
    const choice = Object.entries(probabilities).sort(([, a], [, b]) => b - a)[0]![0];
    const answers = { decision: { type: 'choice' as const, choice, confidence: 0.5, probabilities } };
    const confident = probabilities[choice]! >= opts.confidenceFloor;
    const accepted = confident && (opts.accept?.(answers) ?? true);
    return { accepted, answers, reason: accepted ? 'accepted' : 'not-accepted', costUsd: 0 };
  });
  const ctx = { dispatcher: { decide, decidesFirst: () => mode === 'pure' } } as unknown as EngineContext;
  return { ctx, decide };
}

const ballot = (ctx: EngineContext) => decideCandidateBallot(ctx, {
  personaId: 'elector-testing',
  instructions: 'Cast one ballot.',
  state: {},
  candidates: ['c1', 'c2'],
  abstainCriterion: 'Object to every candidate.',
});

describe('decideCandidateBallot', () => {
  it('takes the leading candidate however evenly the candidates are matched', async () => {
    const { ctx } = ctxWith({ c1: 0.4, c2: 0.38, abstain: 0.22 });
    await expect(ballot(ctx)).resolves.toEqual({ candidate: 'c1' });
  });

  it('abstains only when the model clearly prefers to', async () => {
    await expect(ballot(ctxWith({ c1: 0.1, c2: 0.1, abstain: 0.8 }).ctx)).resolves.toEqual({ candidate: null });
    // A narrow abstention is not a preference: the chat ballot decides instead.
    await expect(ballot(ctxWith({ c1: 0.3, c2: 0.25, abstain: 0.45 }).ctx)).resolves.toBeUndefined();
  });

  it('asks nothing when decision models are off', async () => {
    const { ctx, decide } = ctxWith({ c1: 1 }, 'off');
    await expect(ballot(ctx)).resolves.toBeUndefined();
    expect(decide).not.toHaveBeenCalled();
  });

  it('treats a test dispatcher without decision support as off', async () => {
    const ctx = { dispatcher: { dispatch: vi.fn() } } as unknown as EngineContext;
    await expect(ballot(ctx)).resolves.toBeUndefined();
  });
});

describe('decideVote', () => {
  const vote = (ctx: EngineContext) => decideVote(ctx, {
    personaId: 'rep', instructions: 'Vote.', state: {},
    criteria: { aye: 'For.', no: 'Against.', abstain: 'Neither.' },
  });

  it('records the distribution as the ballot reason', async () => {
    await expect(vote(ctxWith({ aye: 0.85, no: 0.1, abstain: 0.05 }).ctx)).resolves.toEqual({
      vote: 'aye', rationale: 'Decided by decision model: p(aye)=0.85 p(no)=0.10 p(abstain)=0.05.',
    });
  });

  it(`leaves a vote below ${DECISION_VOTE_FLOOR} to the chat ballot`, async () => {
    await expect(vote(ctxWith({ aye: 0.5, no: 0.45, abstain: 0.05 }).ctx)).resolves.toBeUndefined();
  });
});

