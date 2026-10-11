import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Ledger } from '../../engine/Ledger.js';
import { RepoWorktree } from '../../engine/RepoWorktree.js';
import type { EngineContext, RecoveryRequest } from '../../engine/SwarmStrategy.js';
import type { DispatchOptions, WorkerDispatcher } from '../../engine/WorkerDispatcher.js';
import type { Assignment, Decision, ReviewResult, TaskGraph, WorkProduct } from '../../engine/types.js';
import { DemocraticStrategy } from './DemocraticStrategy.js';
import type { CommitteeFinding, DemocraticConfig } from './types.js';
import { emptyOwnershipMap, type RemediationPacket } from '../../engine/packets.js';
import { normalizeChecksConfig } from '../../util/config.js';

describe('constituency authorization', () => {
  it('uses recorded equal ballots to replace the performance appointment', async () => {
    const dispatch = vi.fn(async (opts: DispatchOptions) => {
      const id = opts.personaId ?? '';
      let value: { candidate: string };
      if (id.startsWith('elector-')) value = { candidate: 'prime-coordinator-t1c2' };
      else if (id.includes('-constituent-')) {
        const constituency = id.replace(/-constituent-\d+$/, '');
        value = { candidate: `representative-${constituency}-t1c2` };
      } else throw new Error('Stop after the representative elections.');
      opts.validate(value);
      return dispatchResult(value);
    });
    const ctx = context({ dispatch } as unknown as WorkerDispatcher);
    ctx.config = { ...config, offices: { constituentBallots: true } } as unknown as Record<string, unknown>;
    await expect(new DemocraticStrategy().plan(ctx, {
      ...ctx.runState.task, repoPath: '/tmp/repo', baseBranch: 'main',
    })).rejects.toThrow('Stop after');
    const state = ctx.strategyState as Record<string, unknown>;
    expect((state.offices as { primeCoordinator: string }).primeCoordinator).toBe('prime-coordinator-t1c2');
    expect((state.offices as { representatives: Record<string, string> }).representatives.frontend)
      .toBe('representative-frontend-t1c2');
    expect(ctx.runState.governanceDecisions).toHaveLength(9);
    expect(ctx.runState.governanceDecisions?.[0].positions).toHaveLength(8);
    expect(ctx.runState.governanceMandates?.[0].holder).toBe('prime-coordinator-t1c2');
  });
});

describe('constituency authorization by decision model', () => {
  // The run that prompted decision models: solar-mini4 abstained on 7 of 8 chat ballots. Here every
  // ballot goes to the decision model, and no chat ballot is cast at all.
  it('elects every office from decisive decision-model ballots without a chat ballot', async () => {
    const dispatch = vi.fn(async (_opts: DispatchOptions) => {
      throw new Error('Stop after the elections.');
    });
    const decide = vi.fn(async (opts: { questions: Record<string, { criteria: Record<string, string> }> }) => {
      const options = Object.keys(opts.questions.decision!.criteria);
      const choice = options.find((option) => option.endsWith('-t1c3'))!;
      return {
        accepted: true,
        reason: 'accepted',
        costUsd: 0.00005,
        answers: { decision: { type: 'choice', choice, confidence: 0.9, probabilities: { [choice]: 0.95, abstain: 0.01 } } },
      };
    });
    const ctx = context({ dispatch, decide, decidesFirst: () => true } as unknown as WorkerDispatcher);
    ctx.config = { ...config, offices: { constituentBallots: true } } as unknown as Record<string, unknown>;

    await expect(new DemocraticStrategy().plan(ctx, {
      ...ctx.runState.task, repoPath: '/tmp/repo', baseBranch: 'main',
    })).rejects.toThrow('Stop after');

    const state = ctx.strategyState as { offices: { primeCoordinator: string; representatives: Record<string, string> } };
    expect(state.offices.primeCoordinator).toBe('prime-coordinator-t1c3');
    expect(state.offices.representatives.frontend).toBe('representative-frontend-t1c3');
    expect(ctx.runState.governanceDecisions?.[0].positions.every((p) => p.choice === 'prime-coordinator-t1c3')).toBe(true);
    // 8 Prime Coordinator ballots + 8 constituencies x 2 constituents; the first chat call is the
    // planner's, after both elections.
    expect(decide).toHaveBeenCalledTimes(24);
    expect(dispatch.mock.calls.every(([opts]) => !String(opts.personaId ?? '').startsWith('elector-'))).toBe(true);
  });
});

const config = {
  voteThresholds: {
    routine: 'simple_majority',
    cross_module: 'three_fifths',
    security_boundary: 'two_thirds_plus_security_committee',
    constitutional_amendment: 'two_thirds_both_chambers',
    test_waiver: 'human_required',
  },
  riskClassification: { securityPathGlobs: ['**/auth/**'], crossModuleThreshold: 2 },
  committee: { electedSpecialistCalls: 2, sortitionCalls: 2 },
  confidenceVote: { consecutiveFailuresBeforeSwap: 2 },
  questionTimeEveryNTasks: 2,
} as unknown as DemocraticConfig;

function graph(status: 'pending' | 'approved' | 'rejected' = 'pending'): TaskGraph {
  const outcome = status === 'pending' ? undefined : status;
  return {
    order: ['motion-1'],
    nodes: {
      'motion-1': {
        id: 'motion-1',
        title: 'Improve greeting',
        description: 'Update the greeting implementation.',
        acceptanceCriteria: ['Greeting is updated'],
        dependsOn: [],
        targetGlobs: ['src/greeting.ts'],
        riskTags: [],
        riskClass: 'low',
        phase: status === 'pending' ? 'queued' : status === 'approved' ? 'settled' : 'abandoned',
        attempts: outcome
          ? [{ attempt: 1, outcome, rationale: `${outcome} by test`, evidenceRefs: [], fingerprint: '', repeated: false, at: '2026-01-01T00:00:00.000Z' }]
          : [],
      },
    },
  };
}

function dispatchResult<T>(value: T) {
  return { value, raw: JSON.stringify(value), model: 'fake-model', costUsd: 0 };
}

function context(dispatcher: WorkerDispatcher, strategyState: Record<string, unknown> = {}, taskGraph = graph()): EngineContext {
  const runDir = mkdtempSync(path.join(os.tmpdir(), 'democratic-ledger-'));
  return {
    dispatcher,
    worktree: {} as RepoWorktree,
    ledger: new Ledger(runDir, 'test-run', 'democratic'),
    knowledge: {} as EngineContext['knowledge'],
    budget: {} as EngineContext['budget'],
    config: config as unknown as Record<string, unknown>,
    checks: normalizeChecksConfig({ command: 'npm', args: ['test'], timeoutMs: 60_000 }),
    runId: 'test-run',
    runState: {
      runId: 'test-run',
      strategy: 'democratic',
      task: { goal: 'test', acceptanceCriteria: [] },
      repoPath: '/tmp/repo',
      baseBranch: 'main',
      worktreePath: '/tmp/worktree',
      branch: 'swarm/test-run',
      status: 'running',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      budgetUsd: 1,
      costUsd: 0,
      tokensUsed: { prompt: 0, completion: 0 },
      workerCalls: 0,
      graph: taskGraph,
      pendingApprovals: [],
    },
    strategyState,
    syncPacket: async () => ({
      runId: 'test-run',
      baseRevision: 'test-base',
      decisions: [],
      ownershipMap: emptyOwnershipMap(),
      changedFileManifest: [],
      evidence: [],
      openFindings: [],
      capturedAt: '2026-01-01T00:00:00.000Z',
    }),
    addFinding: vi.fn((finding) => ({ ...finding, id: finding.id ?? 'finding-1' })),
    findings: () => [],
    openApproval: vi.fn((approval) => ({
      ...approval,
      id: 'approval-1',
      createdAt: '2026-01-01T00:00:00.000Z',
    })),
    getApprovalResolution: vi.fn(),
  };
}

function findings(verdicts: CommitteeFinding['verdict'][]): CommitteeFinding[] {
  return verdicts.map((verdict, index) => ({
    personaId: `member-${index + 1}`,
    portfolioTag: 'backend',
    seat: index < 2 ? 'elected' : 'sortition',
    verdict,
    rationale: `${verdict} rationale`,
  }));
}

function productWith(verdicts: CommitteeFinding['verdict'][]): WorkProduct {
  const assignment: Assignment = {
    taskId: 'motion-1',
    assigneeId: 'implementer-backend',
    role: 'implementer',
    meta: { motionClass: 'routine', riskClass: 'low', portfolioTag: 'backend', committeeFindings: findings(verdicts) },
  };
  return {
    taskId: 'motion-1',
    assignment,
    fileOps: [{ op: 'write', path: 'src/greeting.ts', content: 'export const greeting = "hello";\n' }],
    rationale: 'Updates the greeting.',
  };
}

function reviewWithOpposition(verdict: 'approve' | 'reject' | 'flag' = 'approve'): ReviewResult {
  return {
    taskId: 'motion-1',
    findings: [{ reviewerId: 'opposition', verdict, rationale: 'Opposition rationale' }],
    testResult: { ran: true, passed: true },
    meta: { oppositionVerdict: verdict, oppositionSeverity: 'low' },
  };
}

function reworkRequest(product = productWith(['approve', 'approve'])): RecoveryRequest {
  return {
    product,
    review: reviewWithOpposition('flag'),
    decision: {
      taskId: product.taskId,
      outcome: 'rework',
      rationale: 'The close division defeated the motion.',
      evidenceRefs: ['testing:reject'],
      rework: { requiredChanges: ['Add a regression test for the missing boundary case.'] },
    },
    test: { ran: true, passed: false, newFailures: ['boundary case failed'] },
    attemptNumber: 1,
    maxAttempts: 3,
    repeated: false,
  };
}

function closeDivisionState(): Record<string, unknown> {
  return {
    taskMeta: { 'motion-1': { title: 'Improve greeting', riskClass: 'low', portfolioTag: 'backend' } },
    divisions: {
      'motion-1': {
        ayes: 1,
        noes: 1,
        abstentions: 6,
        oppositionVerdict: 'flag',
        oppositionSeverity: 'low',
        voted: ['backend', 'testing'],
      },
    },
  };
}

/**
 * The Chair rules every motion routine / committee / emergency, and that ruling used to be recorded
 * and then ignored when sizing the committee: 52 of 101 motions across the recorded runs were ruled
 * ROUTINE and got the full chamber anyway. This doctrine was spending 90.7% of its model calls
 * deliberating and 9.3% building, and twice failed an entire run on the maxWorkerCalls ceiling.
 * Expediting routine business is the chamber using its own procedure, not abandoning it.
 */
describe('DemocraticStrategy committee sizing', () => {
  function countingDispatch() {
    return vi.fn(async (opts: DispatchOptions) => {
      const value = { verdict: 'approve' as const, rationale: 'Sound.' };
      opts.validate(value);
      return dispatchResult(value);
    });
  }

  it('seats one specialist for business the Chair ruled routine', async () => {
    const dispatch = countingDispatch();
    const ctx = context({ dispatch } as unknown as WorkerDispatcher, {
      taskMeta: { 'motion-1': { title: 'T', riskClass: 'low', portfolioTag: 'backend', treatment: 'routine' } },
    });

    await new DemocraticStrategy().assign(ctx, graph());

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]![0].personaId).toBe('committee-backend#1');
  });

  it('still seats the full chamber, sortition included, for substantive business', async () => {
    const dispatch = countingDispatch();
    const ctx = context({ dispatch } as unknown as WorkerDispatcher, {
      taskMeta: { 'motion-1': { title: 'T', riskClass: 'high', portfolioTag: 'backend', treatment: 'emergency' } },
    });

    await new DemocraticStrategy().assign(ctx, graph());

    expect(dispatch).toHaveBeenCalledTimes(4);
    expect(dispatch.mock.calls.map(([o]) => o.role)).toContain('generalist');
  });

  it('returns a recommittal to the committee that already ruled rather than re-polling the chamber', async () => {
    const dispatch = countingDispatch();
    const ctx = context({ dispatch } as unknown as WorkerDispatcher, {
      taskMeta: { 'motion-1': { title: 'T', riskClass: 'high', portfolioTag: 'backend', treatment: 'committee' } },
      recommittals: {
        'motion-1': { requiredChanges: ['Fix it.'], attemptNumber: 2, maxAttempts: 6, repeated: false, appealGranted: false },
      },
    });

    await new DemocraticStrategy().assign(ctx, graph());

    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('records that the chamber expedited, so a smaller committee is never silent', async () => {
    const dispatch = countingDispatch();
    const ctx = context({ dispatch } as unknown as WorkerDispatcher, {
      taskMeta: { 'motion-1': { title: 'T', riskClass: 'low', portfolioTag: 'backend', treatment: 'routine' } },
    });

    await new DemocraticStrategy().assign(ctx, graph());
    const entry = ctx.ledger.readAll().find((e) => e.type === 'committee_expedited');

    expect(entry?.data.seated).toBe(1);
    expect(entry?.data.fullChamber).toBe(4);
  });
});

describe('DemocraticStrategy lifecycle', () => {
  it('dispatches elected and sortition committee seats and aggregates their findings into an assignment', async () => {
    const responses = [
      { verdict: 'approve' as const, rationale: 'Technically sound.' },
      { verdict: 'reject' as const, rationale: 'Scope is too broad.' },
      { verdict: 'flag' as const, rationale: 'Needs a clearer explanation.' },
      { verdict: 'approve' as const, rationale: 'Reasonable to a generalist.' },
    ];
    const dispatch = vi.fn(async (opts: DispatchOptions) => {
      const value = responses.shift();
      opts.validate(value);
      return dispatchResult(value);
    });
    const ctx = context({ dispatch } as unknown as WorkerDispatcher, {
      // Ruled 'committee' by the Chair, so the full chamber sits. Routine business is expedited
      // to a single specialist — covered separately below.
      taskMeta: { 'motion-1': { title: 'Improve greeting', riskClass: 'low', portfolioTag: 'backend', treatment: 'committee' } },
    });

    const assignments = await new DemocraticStrategy().assign(ctx, graph());

    expect(dispatch).toHaveBeenCalledTimes(4);
    expect(dispatch.mock.calls.map(([opts]) => [opts.role, opts.personaId])).toEqual([
      ['reviewer', 'committee-backend#1'],
      ['reviewer', 'committee-backend#2'],
      ['generalist', 'sortition-citizen#1'],
      ['generalist', 'sortition-citizen#2'],
    ]);
    expect(assignments).toEqual([
      expect.objectContaining({
        taskId: 'motion-1',
        assigneeId: 'implementer-backend',
        role: 'implementer',
        meta: expect.objectContaining({
          motionClass: 'committee',
          riskClass: 'low',
          portfolioTag: 'backend',
          committeeFindings: [
            expect.objectContaining({ seat: 'elected', verdict: 'approve' }),
            expect.objectContaining({ seat: 'elected', verdict: 'reject' }),
            expect.objectContaining({ seat: 'sortition', verdict: 'flag' }),
            expect.objectContaining({ seat: 'sortition', verdict: 'approve' }),
          ],
        }),
      }),
    ]);
  });

  it('translates implementer filePath wire operations to path-keyed engine operations', async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'democratic-execute-'));
    const repoPath = path.join(tmpRoot, 'repo');
    mkdirSync(repoPath, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repoPath });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoPath });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoPath });
    writeFileSync(path.join(repoPath, 'existing.txt'), 'old\n', 'utf8');
    execFileSync('git', ['add', '-A'], { cwd: repoPath });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repoPath });
    execFileSync('git', ['branch', '-M', 'main'], { cwd: repoPath });
    const worktree = new RepoWorktree(repoPath, path.join(tmpRoot, 'run'), 'test-run');
    await worktree.create('main');

    try {
      const wireOutput = {
        fileOps: [
          { op: 'write' as const, filePath: 'src/new.ts', content: 'export const value = 1;\n' },
          { op: 'edit' as const, filePath: 'existing.txt', find: 'old', replace: 'new' },
          { op: 'delete' as const, filePath: 'obsolete.txt' },
        ],
        rationale: 'Implements the motion.',
        unresolvedUncertainty: 'None.',
      };
      const dispatch = vi.fn(async (opts: DispatchOptions) => {
        opts.validate(wireOutput);
        return dispatchResult(wireOutput);
      });
      const strategyState: Record<string, unknown> = {};
      const ctx = context({ dispatch } as unknown as WorkerDispatcher, strategyState);
      ctx.worktree = worktree;

      const result = await new DemocraticStrategy().execute(ctx, productWith(['approve']).assignment);

      expect(result.fileOps).toEqual([
        { op: 'write', path: 'src/new.ts', content: 'export const value = 1;\n' },
        { op: 'edit', path: 'existing.txt', find: 'old', replace: 'new' },
        { op: 'delete', path: 'obsolete.txt' },
      ]);
      expect(result).toMatchObject({ rationale: 'Implements the motion.', unresolvedUncertainty: 'None.' });
      expect(strategyState.taskFileOps).toEqual({
        'motion-1': [
          { op: 'write', path: 'src/new.ts' },
          { op: 'edit', path: 'existing.txt' },
          { op: 'delete', path: 'obsolete.txt' },
        ],
      });
    } finally {
      execFileSync('git', ['worktree', 'remove', '--force', worktree.worktreePath], { cwd: repoPath });
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  const opposition = {
    verdict: 'flag' as const,
    severity: 'high' as const,
    rationale: 'The implementation lacks a boundary check.',
    counterBrief: 'src/greeting.ts does not validate input.',
  };

  /** review() makes up to two calls: the shadow minister's brief, then the government's reply. */
  function debateDispatcher(reply: unknown, brief: unknown = opposition) {
    return vi.fn(async (opts: DispatchOptions) => {
      const value = opts.role === 'opposition' ? brief : reply;
      opts.validate(value);
      return dispatchResult(value);
    });
  }

  it('combines committee and opposition findings during review', async () => {
    const dispatch = debateDispatcher({
      conceded: false,
      objectionsAnswered: ['The boundary is checked by the caller.'],
      citations: [],
      rationale: 'The objection does not hold.',
    });

    const result = await new DemocraticStrategy().review(
      context({ dispatch } as unknown as WorkerDispatcher),
      productWith(['approve', 'reject']),
      { ran: true, passed: false, output: 'failure' },
    );

    expect(result.findings).toEqual([
      expect.objectContaining({ reviewerId: 'member-1', verdict: 'approve' }),
      expect.objectContaining({ reviewerId: 'member-2', verdict: 'reject' }),
      {
        reviewerId: 'shadow-general-reviewer',
        verdict: 'flag',
        rationale: '[severity=high] The implementation lacks a boundary check.',
        evidenceRefs: ['src/greeting.ts does not validate input.'],
      },
    ]);
    // The reply cited nothing, so it is a repeated conclusion and the objection stands at full weight.
    expect(result.meta).toEqual({
      oppositionVerdict: 'flag',
      oppositionSeverity: 'high',
      ministerConceded: false,
      governmentReply: {
        conceded: false,
        objectionsAnswered: ['The boundary is checked by the caller.'],
        rationale: 'The objection does not hold.',
      },
    });
    expect(result.testResult).toEqual({ ran: true, passed: false, output: 'failure' });
  });

  it('lets a reply that cites evidence soften a flag', async () => {
    const dispatch = debateDispatcher({
      conceded: false,
      objectionsAnswered: ['The boundary is checked in the caller.'],
      citations: ['src/greeting.ts'],
      rationale: 'The check exists one level up.',
    });

    const result = await new DemocraticStrategy().review(
      context({ dispatch } as unknown as WorkerDispatcher),
      productWith(['approve', 'reject']),
      { ran: true, passed: true },
    );

    expect(result.meta).toMatchObject({ oppositionSeverity: 'medium' });
  });

  it('records a concession, and lets the objection stand at full weight', async () => {
    const dispatch = debateDispatcher({
      conceded: true,
      objectionsAnswered: [],
      citations: [],
      rationale: 'The Opposition is right; the boundary is unchecked.',
    });
    const strategyState: Record<string, unknown> = {};
    const ctx = context({ dispatch } as unknown as WorkerDispatcher, strategyState);

    const result = await new DemocraticStrategy().review(ctx, productWith(['approve', 'reject']), { ran: true, passed: true });

    expect(result.meta).toMatchObject({ ministerConceded: true, oppositionSeverity: 'high' });
    expect(strategyState.ministerConcessions).toEqual({ 'motion-1': true });
    expect(ctx.ledger.readAll().find((e) => e.type === 'government_reply')?.data).toMatchObject({ conceded: true });
  });

  it('does not pay for a reply when the Opposition did not object', async () => {
    const dispatch = debateDispatcher(null, { verdict: 'approve', severity: 'low', rationale: 'No objection.' });

    await new DemocraticStrategy().review(
      context({ dispatch } as unknown as WorkerDispatcher),
      productWith(['approve', 'approve']),
      { ran: true, passed: true },
    );

    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('leaves the objection standing when the minister cannot be reached', async () => {
    const dispatch = vi.fn(async (opts: DispatchOptions) => {
      if (opts.role === 'opposition') {
        opts.validate(opposition);
        return dispatchResult(opposition);
      }
      throw new Error('the minister is unreachable');
    });
    const ctx = context({ dispatch } as unknown as WorkerDispatcher);

    const result = await new DemocraticStrategy().review(ctx, productWith(['approve', 'reject']), { ran: true, passed: true });

    expect(result.meta).toMatchObject({ oppositionSeverity: 'high', ministerConceded: false });
    expect(ctx.ledger.readAll().find((e) => e.type === 'government_reply')?.data).toMatchObject({ citesEvidence: false });
  });

  it.each([
    { label: 'clearly approves', verdicts: ['approve', 'approve', 'approve'] as CommitteeFinding['verdict'][], outcome: 'approved', score: 1 },
    { label: 'clearly rejects', verdicts: ['reject', 'reject', 'reject'] as CommitteeFinding['verdict'][], outcome: 'rejected', score: 0 },
    { label: 'rejects an exact split because routine simple majority is strict', verdicts: ['approve', 'flag', 'reject'] as CommitteeFinding['verdict'][], outcome: 'rejected', score: 0.5 },
  ])('$label', async ({ verdicts, outcome, score }) => {
    const ctx = context({ dispatch: vi.fn() } as unknown as WorkerDispatcher);

    const decision = await new DemocraticStrategy().decide(ctx, productWith(verdicts), reviewWithOpposition());

    expect(decision.outcome).toBe(outcome);
    expect(decision.meta).toMatchObject({
      category: 'routine',
      thresholdLabel: 'simple_majority',
      committeeApproveScore: score,
      voteWouldPass: outcome === 'approved',
    });
    expect(ctx.openApproval).not.toHaveBeenCalled();
  });

  it('requires human approval only for needs_human decisions', () => {
    const strategy = new DemocraticStrategy();
    const ctx = context({ dispatch: vi.fn() } as unknown as WorkerDispatcher);
    // `outcome` is a widened runtime parameter, so it can't narrow against Decision's
    // discriminated union; this test never constructs a 'rework' outcome, so the cast is safe.
    const decision = (outcome: Decision['outcome']): Decision =>
      ({ taskId: 'motion-1', outcome, rationale: 'result', evidenceRefs: [] }) as Decision;

    expect(strategy.requiresHumanApproval(ctx, decision('needs_human'))).toBe(true);
    expect(strategy.requiresHumanApproval(ctx, decision('approved'))).toBe(false);
    expect(strategy.requiresHumanApproval(ctx, decision('rejected'))).toBe(false);
  });

  it('tracks rejection confidence, swaps the portfolio minister, and resets failures after approval', async () => {
    const strategyState: Record<string, unknown> = {
      taskMeta: { 'motion-1': { title: 'Improve greeting', riskClass: 'low', portfolioTag: 'backend' } },
    };
    const ctx = context({ dispatch: vi.fn() } as unknown as WorkerDispatcher, strategyState, graph('rejected'));
    const rejected: Decision = { taskId: 'motion-1', outcome: 'rejected', rationale: 'no', evidenceRefs: [] };
    const approved: Decision = { taskId: 'motion-1', outcome: 'approved', rationale: 'yes', evidenceRefs: [] };

    await new DemocraticStrategy().recordOutcome(ctx, rejected, { ran: true, passed: true });
    expect(strategyState).toMatchObject({ portfolioFailures: { backend: 1 }, completedTaskCount: 1 });

    await new DemocraticStrategy().recordOutcome(ctx, rejected, { ran: true, passed: true });
    expect(strategyState).toMatchObject({
      portfolioFailures: { backend: 0 },
      portfolioVersions: { backend: 2 },
      portfolioMinisters: { backend: 'committee-backend-v2' },
      completedTaskCount: 2,
      questionTime: {
        asOfCompletedTasks: 2,
        whatChanged: [],
        whatsUnmet: ['Improve greeting [rejected]'],
        risksIncreased: [],
        irreversible: [],
      },
    });
    expect(ctx.ledger.readAll().map((entry) => entry.type)).toEqual(['confidence_vote', 'question_time']);

    (strategyState.portfolioFailures as Record<string, number>).backend = 1;
    await new DemocraticStrategy().recordOutcome(ctx, approved, { ran: true, passed: true });
    expect(strategyState).toMatchObject({ portfolioFailures: { backend: 0 }, completedTaskCount: 3 });
  });
});

describe('defeat recommittal', () => {
  const representatives = Object.fromEntries(
    ['frontend', 'backend', 'data', 'security', 'testing', 'documentation', 'user-experience', 'operations'].map(
      (constituency) => [constituency, `rep-${constituency}`],
    ),
  );

  it('recommits an actionable close defeat but leaves serious and constitutional defeats untouched', async () => {
    const strategy = new DemocraticStrategy();
    const closeCtx = context(
      { dispatch: vi.fn() } as unknown as WorkerDispatcher,
      { offices: { representatives } },
    );
    const closeReview: ReviewResult = {
      taskId: 'motion-1',
      findings: [{ reviewerId: 'opposition', verdict: 'flag', rationale: 'Cover the failing edge case.' }],
      testResult: {
        ran: true,
        passed: false,
        command: 'npm test',
        newFailures: ['greeting rejects an empty name'],
      },
      meta: { oppositionVerdict: 'flag', oppositionSeverity: 'low' },
    };

    const close = await strategy.decide(closeCtx, productWith(['approve', 'approve']), closeReview);

    expect(close.outcome).toBe('rework');
    expect(close.outcome === 'rework' ? close.rework.requiredChanges : []).not.toHaveLength(0);
    expect(close.outcome === 'rework' ? close.rework.requiredChanges.join(' ') : '').toContain('empty name');

    const seriousReview: ReviewResult = {
      ...closeReview,
      findings: [{ reviewerId: 'opposition', verdict: 'reject', rationale: 'The change crosses a trust boundary.' }],
      testResult: { ran: true, passed: true },
      meta: { oppositionVerdict: 'reject', oppositionSeverity: 'high' },
    };
    const serious = await strategy.decide(
      context({ dispatch: vi.fn() } as unknown as WorkerDispatcher, { offices: { representatives } }),
      productWith(['approve', 'approve']),
      seriousReview,
    );
    expect(serious.outcome).toBe('rejected');

    const constitutionalProduct = productWith(['approve', 'approve']);
    constitutionalProduct.fileOps = [{ op: 'write', path: 'mcp-server/src/engine/types.ts', content: 'export {};' }];
    const constitutional = await strategy.decide(
      context({ dispatch: vi.fn() } as unknown as WorkerDispatcher, { offices: { representatives } }),
      constitutionalProduct,
      reviewWithOpposition('approve'),
    );
    expect(constitutional.outcome).toBe('needs_human');
  });

  it('puts recommittal instructions before a fresh committee and the next implementer', async () => {
    const dispatch = vi.fn(async (opts: DispatchOptions) => {
      const value = opts.role === 'implementer'
        ? {
            fileOps: [{ op: 'write', filePath: 'src/greeting.ts', content: 'export const greeting = "hello";\n' }],
            rationale: 'Adds the repaired greeting.',
          }
        : { verdict: 'approve', rationale: 'The recommitted scope is now sound.' };
      opts.validate(value);
      return dispatchResult(value);
    });
    const strategyState = closeDivisionState();
    const ctx = context({ dispatch } as unknown as WorkerDispatcher, strategyState);
    const strategy = new DemocraticStrategy();

    await strategy.recover(ctx, reworkRequest());
    const assignments = await strategy.assign(ctx, ctx.runState.graph!);
    await strategy.execute(ctx, assignments[0]);

    const prompts = dispatch.mock.calls.map(([opts]) => opts.userPrompt);
    // A recommittal returns to the committee that already ruled rather than re-polling the whole
    // chamber: the motion's wording is unchanged between attempts, so a fresh full inquiry re-asks
    // a question already answered. The seated member is still told the motion stands as tabled.
    expect(prompts.filter((prompt) => prompt.includes('The motion stands as tabled'))).toHaveLength(1);
    expect(prompts.at(-1)).toContain('Add a regression test for the missing boundary case.');
    expect(ctx.ledger.readAll().some((entry) => entry.type === 'motions_recommitted')).toBe(true);
    // The seated member sees the defeated attempt's evidence, not only the refusal it produced.
    expect(prompts.find((prompt) => prompt.includes('The motion stands as tabled')))
      .toContain('What the last attempt showed: required checks failed; the Opposition, which read the diff, recorded a "flag".');
  });

  it('hears the deterministic close-division appeal only once per task', async () => {
    const strategyState = closeDivisionState();
    const ctx = context({ dispatch: vi.fn() } as unknown as WorkerDispatcher, strategyState);
    const strategy = new DemocraticStrategy();

    await strategy.recover(ctx, reworkRequest());
    await strategy.recover(ctx, { ...reworkRequest(), attemptNumber: 2 });

    expect(strategyState.appealsHeard).toEqual(['motion-1']);
    expect(ctx.ledger.readAll().filter((entry) => entry.type === 'appeal_recorded')).toHaveLength(1);
  });

  it('does not set a node phase or alter attempt history during recovery', async () => {
    const strategyState = closeDivisionState();
    const taskGraph = graph();
    taskGraph.nodes['motion-1'].phase = 'running';
    taskGraph.nodes['motion-1'].attempts.push({
      attempt: 1,
      outcome: 'rework',
      rationale: 'close defeat',
      evidenceRefs: [],
      fingerprint: 'first',
      repeated: false,
      at: '2026-01-01T00:00:00.000Z',
    });
    const ctx = context({ dispatch: vi.fn() } as unknown as WorkerDispatcher, strategyState, taskGraph);
    const before = structuredClone(taskGraph.nodes['motion-1']);

    await new DemocraticStrategy().recover(ctx, reworkRequest());

    expect(taskGraph.nodes['motion-1']).toEqual(before);
  });

  it('counts a rework as one defeat but completes a reworked-then-approved task only once', async () => {
    const strategyState = closeDivisionState();
    const ctx = context({ dispatch: vi.fn() } as unknown as WorkerDispatcher, strategyState);
    const strategy = new DemocraticStrategy();
    const request = reworkRequest();

    await strategy.recordOutcome(ctx, request.decision, request.test);
    await strategy.recover(ctx, request);
    await strategy.recordOutcome(
      ctx,
      { taskId: 'motion-1', outcome: 'approved', rationale: 'carried', evidenceRefs: [] },
      { ran: true, passed: true },
    );

    expect(strategyState.completedTaskCount).toBe(1);
    expect(strategyState.termTally).toEqual({ carried: 1, defeated: 1 });
    expect(strategyState.portfolioTally).toEqual({ backend: { carried: 1, defeated: 1 } });
  });

  it('puts a still-defeated motion to a human at the task-attempt remediation ceiling', async () => {
    const taskGraph = graph();
    taskGraph.nodes['motion-1'].attempts.push({
      attempt: 1,
      outcome: 'rework',
      rationale: 'first close defeat',
      evidenceRefs: [],
      fingerprint: 'first',
      repeated: false,
      at: '2026-01-01T00:00:00.000Z',
    });
    const ctx = context(
      { dispatch: vi.fn() } as unknown as WorkerDispatcher,
      { offices: { representatives } },
      taskGraph,
    );
    const review: ReviewResult = {
      taskId: 'motion-1',
      findings: [{ reviewerId: 'opposition', verdict: 'flag', rationale: 'The edge case remains.' }],
      testResult: { ran: true, passed: false, newFailures: ['empty name still fails'] },
      meta: { oppositionVerdict: 'flag', oppositionSeverity: 'low' },
    };

    const decision = await new DemocraticStrategy().decide(ctx, productWith(['approve', 'approve']), review);

    expect(decision.outcome).toBe('needs_human');
    expect(ctx.ledger.readAll().some((entry) => entry.type === 'reserve_power_exercised')).toBe(true);
    expect(ctx.openApproval).toHaveBeenCalledTimes(1);
  });
});

describe('the stage 9 report reaching the manifest', () => {
  // A regression guard with a specific bug behind it: the report was originally filed inside
  // accept(), which runs after assembleDelivery has already read strategyState.deliveryNotes — so
  // every stage 9 disclosure was silently dropped from the packet on a run that never remediated.
  // It has to be written at or before the disposition barrier to be read at all.
  it('writes its disclosures at the disposition barrier, not after the packet is built', async () => {
    const dispatch = vi.fn(async (opts: DispatchOptions) => {
      const value = { dispositions: [{ id: 'f1', disposition: 'unresolved', rationale: 'stands' }] };
      opts.validate(value);
      return dispatchResult(value);
    });
    const strategyState: Record<string, unknown> = {
      motionEstimates: { 'motion-1': { estimatedCostUsd: 0.01, foreseeableRisks: [], rollbackConditions: 'Revert the greeting.' } },
      requirementMatrix: [{ criterion: 'Greeting is updated', command: 'npm test', expectedResult: 'passes', status: 'unsatisfied' }],
    };
    const ctx = context({ dispatch } as unknown as WorkerDispatcher, strategyState);
    ctx.worktree = { diff: async () => ({ diffText: 'diff', filesChanged: [] }) } as unknown as RepoWorktree;

    await new DemocraticStrategy().disposeFindings(ctx, [
      {
        id: 'f1',
        source: 'committee',
        summary: 'An outstanding point.',
        evidenceRefs: [],
        disposition: 'unresolved',
        dispositionRationale: 'raised',
      },
    ]);

    const notes = strategyState.deliveryNotes as { limitations: string[]; residualRisks: string[]; rollbackNotes: string[] };
    expect(notes.limitations.some((l) => l.includes('Greeting is updated'))).toBe(true);
    expect(notes.residualRisks.some((r) => r.includes('An outstanding point.'))).toBe(true);
    expect(notes.rollbackNotes).toEqual(['Motion "motion-1" stated its rollback condition as: Revert the greeting.']);
    expect(ctx.ledger.readAll().some((e) => e.type === 'accountability_report')).toBe(true);
  });

  it('replaces its disclosures on a second pass rather than stacking them up', async () => {
    const dispatch = vi.fn(async (opts: DispatchOptions) => {
      const value = { dispositions: [] };
      opts.validate(value);
      return dispatchResult(value);
    });
    const strategyState: Record<string, unknown> = {
      requirementMatrix: [{ criterion: 'Greeting is updated', command: 'npm test', expectedResult: 'passes', status: 'unsatisfied' }],
    };
    const ctx = context({ dispatch } as unknown as WorkerDispatcher, strategyState);
    ctx.worktree = { diff: async () => ({ diffText: 'diff', filesChanged: [] }) } as unknown as RepoWorktree;
    const open = [
      {
        id: 'f1',
        source: 'committee',
        summary: 'A point.',
        evidenceRefs: [],
        disposition: 'unresolved' as const,
        dispositionRationale: 'raised',
      },
    ];

    await new DemocraticStrategy().disposeFindings(ctx, open);
    const first = (strategyState.deliveryNotes as { limitations: string[] }).limitations.length;
    await new DemocraticStrategy().disposeFindings(ctx, open);

    expect((strategyState.deliveryNotes as { limitations: string[] }).limitations).toHaveLength(first);
  });
});

describe('the division and article 8', () => {
  const noDispatch = { dispatch: vi.fn() } as unknown as WorkerDispatcher;

  /** One shared state object, so the strategy's mutations are visible to the assertions. */
  function decideWith(verdicts: CommitteeFinding['verdict'][], review: ReviewResult) {
    const strategyState: Record<string, unknown> = {
      offices: {
        representatives: Object.fromEntries(
          ['frontend', 'backend', 'data', 'security', 'testing', 'documentation', 'user-experience', 'operations'].map(
            (c) => [c, `rep-${c}`],
          ),
        ),
      },
    };
    const ctx = context(noDispatch, strategyState);
    return { ctx, strategyState, decision: new DemocraticStrategy().decide(ctx, productWith(verdicts), review) };
  }

  it('records the division roll, with the untouched constituencies abstaining', async () => {
    const { ctx, decision } = decideWith(['approve', 'approve'], reviewWithOpposition('approve'));
    await decision;

    const division = ctx.ledger.readAll().find((e) => e.type === 'division_recorded');
    expect(division?.data).toMatchObject({ taskId: 'motion-1', ayes: 2, noes: 0, departures: [] });
    // backend (the referred constituency) and testing (a check ran) — the other six abstain.
    expect(division!.data.abstentions).toBe(6);
  });

  it('uses expressed ballots from elected representatives instead of the advisory division', async () => {
    const representatives = Object.fromEntries(
      ['frontend', 'backend', 'data', 'security', 'testing', 'documentation', 'user-experience', 'operations']
        .map((constituency) => [constituency, `rep-${constituency}`]),
    );
    const representativeMandates = Object.fromEntries(Object.keys(representatives)
      .map((constituency) => [constituency, { id: `seat-${constituency}`, digest: 'term-1' }]));
    const dispatch = vi.fn(async (options: DispatchOptions) => {
      const value = { vote: options.personaId === 'rep-backend' ? 'no' : 'aye', rationale: 'I inspected the evidence.' };
      options.validate(value);
      return dispatchResult(value);
    });
    const ctx = context({ dispatch } as unknown as WorkerDispatcher, {
      offices: { representatives }, representativeMandates,
    });
    ctx.config = { ...config, offices: { constituentBallots: true } } as unknown as Record<string, unknown>;
    ctx.runState.governanceMandates = Object.keys(representatives).map((constituency) => ({
      id: `seat-${constituency}`, grantor: constituency, holder: `rep-${constituency}`,
      scope: ['commons-division'], artifactDigest: 'term-1',
    }));

    await new DemocraticStrategy().decide(ctx, productWith(['approve', 'approve']), reviewWithOpposition('approve'));

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(ctx.ledger.readAll().find((event) => event.type === 'division_recorded')?.data)
      .toMatchObject({ ayes: 1, noes: 1, abstentions: 6 });
    expect(ctx.runState.governanceDecisions?.at(-1)?.positions).toContainEqual({ actor: 'backend', choice: 'no' });
  });

  it('requires a separate Commons ballot to adopt a minority repair amendment', async () => {
    const representatives = Object.fromEntries(
      ['frontend', 'backend', 'data', 'security', 'testing', 'documentation', 'user-experience', 'operations']
        .map((constituency) => [constituency, `rep-${constituency}`]),
    );
    const representativeMandates = Object.fromEntries(Object.keys(representatives)
      .map((constituency) => [constituency, { id: `seat-${constituency}`, digest: 'term-1' }]));
    // Attempt 2 of a motion: the guardian's rollback threshold, where an adopted amendment changes
    // what happens next. Below it the ballot decides nothing and is not held (next test).
    const decideWithAmendment = async (amendmentVote: 'aye' | 'no', taskGraph = graph('rejected')) => {
      const dispatch = vi.fn(async (options: DispatchOptions) => {
        const vote = options.systemPrompt.includes('minority amendment') ? amendmentVote : 'no';
        const value = { vote, rationale: 'The proposal was inspected separately.' };
        options.validate(value);
        return dispatchResult(value);
      });
      const ctx = context({ dispatch } as unknown as WorkerDispatcher, {
        offices: { representatives }, representativeMandates,
      }, taskGraph);
      ctx.config = { ...config, offices: { constituentBallots: true } } as unknown as Record<string, unknown>;
      ctx.runState.governanceMandates = Object.keys(representatives).map((constituency) => ({
        id: `seat-${constituency}`, grantor: constituency, holder: `rep-${constituency}`,
        scope: ['commons-division'], artifactDigest: 'term-1',
      }));
      const result = await new DemocraticStrategy().decide(
        ctx, productWith(['approve', 'approve']), reviewWithOpposition('flag'),
      );
      return { ctx, dispatch, result };
    };

    const defeated = await decideWithAmendment('no');
    expect(defeated.result.outcome).toBe('rejected');
    expect(defeated.ctx.runState.governanceDecisions?.find((decision) =>
      decision.id.startsWith('amendment:'))?.result).toBe('defeated');

    const adopted = await decideWithAmendment('aye');
    expect(adopted.result.outcome).toBe('needs_human');
    expect(adopted.ctx.runState.governanceDecisions?.find((decision) =>
      decision.id.startsWith('amendment:'))?.result).toBe('adopted');
    expect(adopted.ctx.runState.governanceDecisions?.find((decision) =>
      decision.id.startsWith('division:'))?.result).toBe('rejected');
    expect(adopted.dispatch).toHaveBeenCalledTimes(4);

    // On a first attempt the engine reworks the defeated motion whichever way the amendment goes,
    // so its ballot is not held: only the division's two ballots are cast.
    const firstAttempt = await decideWithAmendment('aye', graph());
    expect(firstAttempt.result.outcome).toBe('rejected');
    expect(firstAttempt.dispatch).toHaveBeenCalledTimes(2);
    expect(firstAttempt.ctx.runState.governanceDecisions?.some((decision) =>
      decision.id.startsWith('amendment:'))).toBe(false);
    expect(firstAttempt.ctx.ledger.readAll().find((event) => event.type === 'minority_amendment_considered')?.data)
      .toMatchObject({ adoptedForRework: false, balloted: false });
  });

  it('requires two-thirds support in both chambers before a constitutional motion reaches a human', async () => {
    const representatives = Object.fromEntries(
      ['frontend', 'backend', 'data', 'security', 'testing', 'documentation', 'user-experience', 'operations']
        .map((constituency) => [constituency, `rep-${constituency}`]),
    );
    const houseOfReview = ['senior-verifier', 'security-reviewer', 'maintainability-reviewer'];
    const representativeMandates = Object.fromEntries(Object.keys(representatives)
      .map((constituency) => [constituency, { id: `seat-${constituency}`, digest: 'term-1' }]));
    const decideWithHouse = async (houseVote: 'aye' | 'no') => {
      const dispatch = vi.fn(async (options: DispatchOptions) => {
        const value = { vote: houseOfReview.includes(options.personaId ?? '') ? houseVote : 'aye',
          rationale: 'I inspected the constitutional motion.' };
        options.validate(value);
        return dispatchResult(value);
      });
      const ctx = context({ dispatch } as unknown as WorkerDispatcher, {
        offices: { representatives, houseOfReview }, representativeMandates,
      });
      ctx.config = { ...config, offices: { constituentBallots: true } } as unknown as Record<string, unknown>;
      ctx.runState.governanceMandates = Object.keys(representatives).map((constituency) => ({
        id: `seat-${constituency}`, grantor: constituency, holder: `rep-${constituency}`,
        scope: ['commons-division'], artifactDigest: 'term-1',
      }));
      const product = productWith(['approve', 'approve']);
      product.fileOps = [{ op: 'write', path: 'mcp-server/src/engine/types.ts', content: 'export {};' }];
      const result = await new DemocraticStrategy().decide(ctx, product, reviewWithOpposition('approve'));
      return { ctx, result, dispatch };
    };

    const refused = await decideWithHouse('no');
    expect(refused.result.outcome).toBe('rejected');
    expect(refused.ctx.runState.governanceDecisions?.find((decision) =>
      decision.body === 'house-of-review')?.result).toBe('defeated');

    const carried = await decideWithHouse('aye');
    expect(carried.result.outcome).toBe('needs_human');
    expect(carried.ctx.runState.governanceDecisions?.find((decision) =>
      decision.body === 'house-of-review')?.result).toBe('carried');
    expect(carried.ctx.openApproval).toHaveBeenCalled();
    expect(carried.dispatch).toHaveBeenCalledTimes(11);
  });

  it('requires an independent Security Committee ballot before human referral', async () => {
    const constituencies = ['frontend', 'backend', 'data', 'security', 'testing', 'documentation', 'user-experience', 'operations'];
    const representatives = Object.fromEntries(constituencies.map((seat) => [seat, `rep-${seat}`]));
    const representativeMandates = Object.fromEntries(constituencies.map((seat) =>
      [seat, { id: `seat-${seat}`, digest: 'term-1' }]));
    const panel = ['security-committee-verification-t1', 'security-committee-threat-review-t1', 'security-committee-operations-t1'];
    const decideWithPanel = async (panelVote: 'aye' | 'no', roster?: string[]) => {
      const dispatch = vi.fn(async (options: DispatchOptions) => {
        const value = { vote: panel.includes(options.personaId ?? '') ? panelVote : 'aye',
          rationale: 'I inspected the security evidence.' };
        options.validate(value);
        return dispatchResult(value);
      });
      const ctx = context({ dispatch } as unknown as WorkerDispatcher, {
        offices: { representatives, termId: 1, holders: [], securityCommittee: roster }, representativeMandates,
      });
      ctx.config = { ...config, offices: { constituentBallots: true } } as unknown as Record<string, unknown>;
      ctx.runState.governanceMandates = constituencies.map((seat) => ({
        id: `seat-${seat}`, grantor: seat, holder: `rep-${seat}`,
        scope: ['commons-division'], artifactDigest: 'term-1',
      }));
      const product = productWith(['approve', 'approve']);
      product.assignment.meta!.riskClass = 'high';
      product.fileOps = [{ op: 'write', path: 'src/auth/login.ts', content: 'export {};' }];
      const result = await new DemocraticStrategy().decide(ctx, product, reviewWithOpposition('approve'));
      return { ctx, dispatch, result };
    };

    const refused = await decideWithPanel('no');
    expect(refused.result.outcome).toBe('rejected');
    expect(refused.ctx.runState.governanceDecisions?.find((decision) =>
      decision.body === 'security-committee')?.result).toBe('withheld');
    expect(refused.ctx.openApproval).not.toHaveBeenCalled();

    const carried = await decideWithPanel('aye');
    expect(carried.result.outcome).toBe('needs_human');
    expect(carried.ctx.runState.governanceDecisions?.find((decision) =>
      decision.body === 'security-committee')?.result).toBe('approved');
    expect(carried.ctx.ledger.readAll().some((entry) => entry.type === 'security_committee_constituted')).toBe(true);
    expect(carried.ctx.openApproval).toHaveBeenCalled();
    expect(carried.dispatch.mock.calls.filter(([options]) =>
      panel.includes(options.personaId ?? ''))).toHaveLength(3);
    await expect(decideWithPanel('aye', [panel[0], panel[0], panel[1]]))
      .rejects.toThrow('three distinct members outside both chambers');
  });

  // Two of three approving carries the motion; an evenly split committee would abstain instead.
  it('preserves committee dissent on a carried motion as a minority report', async () => {
    const { ctx, decision } = decideWith(['approve', 'approve', 'reject'], reviewWithOpposition('approve'));
    const result = await decision;

    expect(result.outcome).toBe('approved');
    const raised = (ctx.addFinding as ReturnType<typeof vi.fn>).mock.calls.map(([f]) => f);
    const committeeDissent = raised.find((f) => String(f.source).startsWith('member-'));
    expect(committeeDissent).toMatchObject({ minority: true, taskId: 'motion-1', disposition: 'unresolved' });
    expect(String(committeeDissent.summary)).toContain('reject');
  });

  it('preserves an Opposition objection on a carried motion', async () => {
    const { ctx, decision } = decideWith(['approve', 'approve'], reviewWithOpposition('flag'));
    await decision;

    const raised = (ctx.addFinding as ReturnType<typeof vi.fn>).mock.calls.map(([f]) => f);
    expect(raised.some((f) => f.source === 'opposition' && f.minority === true)).toBe(true);
    expect(ctx.ledger.readAll().find((event) => event.type === 'minority_amendment_considered')?.data)
      .toMatchObject({ taskId: 'motion-1', adoptedForRework: false });
  });

  it('records no minority report on a defeated motion — the dissent already won', async () => {
    const { ctx, decision } = decideWith(['reject', 'reject'], reviewWithOpposition('reject'));
    const result = await decision;

    expect(result.outcome).toBe('rejected');
    expect((ctx.addFinding as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    expect(ctx.ledger.readAll().find((event) => event.type === 'minority_amendment_considered')?.data)
      .toMatchObject({ taskId: 'motion-1', adoptedForRework: false });
  });

  it('counts a member who carried a motion the House then refused', async () => {
    // A medium-severity Opposition reject blocks the motion but is not evidence strong enough to
    // make the members depart — so they vote aye, the motion falls, and that is misrepresentation.
    const blocked: ReviewResult = {
      taskId: 'motion-1',
      findings: [{ reviewerId: 'opposition', verdict: 'reject', rationale: 'The diff breaks a caller.' }],
      testResult: { ran: true, passed: true },
      meta: { oppositionVerdict: 'reject', oppositionSeverity: 'medium' },
    };
    const { strategyState, decision } = decideWith(['approve', 'approve'], blocked);

    expect((await decision).outcome).toBe('rejected');
    expect(strategyState.representativeDepartures).toEqual({ backend: 1, testing: 1 });
  });
});

describe('first reading', () => {
  const task = {
    goal: 'add parity helpers',
    acceptanceCriteria: ['isEven exists'],
    repoPath: '/tmp/repo',
    baseBranch: 'main',
  };

  /** Drives plan(): the test mandate, then the planner, then one Speaker ruling per surviving motion. */
  function planningDispatcher(motions: unknown[], rulings: unknown[]) {
    const speakerRulings = [...rulings];
    return vi.fn(async (opts: DispatchOptions) => {
      if (opts.personaId === 'testing-and-evidence-committee') {
        const mandate = { entries: [{ criterion: 'isEven exists', checkId: 'unit', expectedResult: 'passes' }] };
        opts.validate(mandate);
        return dispatchResult(mandate);
      }
      if (opts.role === 'planner') {
        const value = { motions };
        opts.validate(value);
        return dispatchResult(value);
      }
      if (opts.role === 'speaker') {
        const value = speakerRulings.shift();
        opts.validate(value);
        return dispatchResult(value);
      }
      throw new Error(`unexpected dispatch: ${opts.role}`);
    });
  }

  const goodMotion = {
    id: 'm1',
    title: 'Add an isEven helper',
    description: 'Introduce isEven with a test.',
    acceptanceCriteria: ['isEven exists'],
    targetGlobs: ['src/even.ts'],
    dependsOn: [],
    portfolioTag: 'backend',
  };

  it('refuses a duplicate motion without paying for a ruling on it', async () => {
    const duplicate = { ...goodMotion, id: 'm2' };
    const dispatch = planningDispatcher(
      [goodMotion, duplicate],
      [{ admissible: true, treatment: 'routine', rationale: 'In order.' }],
    );
    const ctx = context({ dispatch } as unknown as WorkerDispatcher, {}, graph());

    const built = await new DemocraticStrategy().plan(ctx, task);

    expect(built.order).toEqual(['m1']);
    // One ruling, not two: the screen refused the duplicate before the Chair was asked.
    expect(dispatch.mock.calls.filter(([opts]) => opts.role === 'speaker')).toHaveLength(1);
    const struck = ctx.ledger.readAll().filter((e) => e.type === 'speaker_ruling' && e.data.admissible === false);
    expect(struck).toHaveLength(1);
    expect(struck[0].data).toMatchObject({ motionId: 'm2', duplicateOf: 'm1' });
  });

  it('keeps a motion the Chair rules inadmissible off the Order Paper', async () => {
    const dispatch = planningDispatcher(
      [goodMotion, { ...goodMotion, id: 'm2', title: 'Rewrite the auth stack', targetGlobs: ['src/auth/login.ts'] }],
      [
        { admissible: true, treatment: 'routine', rationale: 'In order.' },
        { admissible: false, treatment: 'emergency', rationale: 'Outside the scope of the goal before the House.' },
      ],
    );
    const ctx = context({ dispatch } as unknown as WorkerDispatcher, {}, graph());

    const built = await new DemocraticStrategy().plan(ctx, task);

    expect(built.order).toEqual(['m1']);
  });

  it('carries the Chair’s treatment forward instead of re-deriving it from risk', async () => {
    const dispatch = planningDispatcher([goodMotion], [{ admissible: true, treatment: 'emergency', rationale: 'In order.' }]);
    const strategyState: Record<string, unknown> = {};
    const ctx = context({ dispatch } as unknown as WorkerDispatcher, strategyState, graph());

    await new DemocraticStrategy().plan(ctx, task);

    // The motion is low-risk, so risk alone would have made it 'routine'.
    expect((strategyState.taskMeta as Record<string, { treatment: string }>).m1.treatment).toBe('emergency');
  });

  it('restores a motion rather than letting the Chair cancel the whole programme', async () => {
    const dispatch = planningDispatcher(
      [goodMotion],
      [{ admissible: false, treatment: 'routine', rationale: 'The Chair is unpersuaded.' }],
    );
    const ctx = context({ dispatch } as unknown as WorkerDispatcher, {}, graph());

    const built = await new DemocraticStrategy().plan(ctx, task);

    expect(built.order).toEqual(['m1']);
    expect(ctx.ledger.readAll().some((e) => e.type === 'order_paper_restored')).toBe(true);
  });

  it('admits the motion when the Chair cannot be reached, rather than striking it', async () => {
    const dispatch = vi.fn(async (opts: DispatchOptions) => {
      if (opts.personaId === 'testing-and-evidence-committee') {
        const mandate = { entries: [{ criterion: 'isEven exists', checkId: 'unit', expectedResult: 'passes' }] };
        opts.validate(mandate);
        return dispatchResult(mandate);
      }
      if (opts.role === 'planner') {
        const value = { motions: [goodMotion] };
        opts.validate(value);
        return dispatchResult(value);
      }
      throw new Error('the Chair is unreachable');
    });
    const ctx = context({ dispatch } as unknown as WorkerDispatcher, {}, graph());

    const built = await new DemocraticStrategy().plan(ctx, task);

    expect(built.order).toEqual(['m1']);
    const ruling = ctx.ledger.readAll().find((e) => e.type === 'speaker_ruling');
    expect(ruling?.data).toMatchObject({ admissible: true });
    expect(String(ruling?.data.rationale)).toContain('could not be reached');
  });

  it('constitutes the offices before anyone acts, and separates the Speaker from the government', async () => {
    const dispatch = planningDispatcher([goodMotion], [{ admissible: true, treatment: 'routine', rationale: 'In order.' }]);
    const strategyState: Record<string, unknown> = {};
    const ctx = context({ dispatch } as unknown as WorkerDispatcher, strategyState, graph());

    await new DemocraticStrategy().plan(ctx, task);

    const register = strategyState.offices as { speaker: string; primeCoordinator: string; termId: number };
    expect(register.termId).toBe(1);
    expect(register.speaker).not.toBe(register.primeCoordinator);
    expect(ctx.ledger.readAll()[0].type).toBe('offices_constituted');
    // The Chair that ruled is the Chair the register returned.
    expect(dispatch.mock.calls.find(([opts]) => opts.role === 'speaker')?.[0].personaId).toBe(register.speaker);
  });
});

describe('single-owner mandates at first reading', () => {
  function planningDispatcher(motions: unknown[]) {
    return vi.fn(async (opts: DispatchOptions) => {
      if (opts.personaId === 'testing-and-evidence-committee') {
        const mandate = { evidence: [{ criterion: 'tests pass', checkCategoryId: 'unit', expectedResult: 'passes' }] };
        opts.validate(mandate);
        return dispatchResult(mandate);
      }
      if (opts.role === 'planner') {
        const value = { motions };
        opts.validate(value);
        return dispatchResult(value);
      }
      if (opts.role === 'speaker') {
        const value = { admissible: true, treatment: 'committee', rationale: 'In order.' };
        opts.validate(value);
        return dispatchResult(value);
      }
      throw new Error(`unexpected dispatch: ${opts.role}`);
    });
  }

  function motion(id: string, targetGlobs: string[], dependsOn: string[] = []) {
    return {
      id,
      title: `Motion ${id}`,
      description: `Implement the ${id} work.`,
      acceptanceCriteria: [`${id} works`],
      targetGlobs,
      dependsOn,
      portfolioTag: 'backend',
    };
  }

  const task = {
    goal: 'Build pkg. Required paths: pkg/__init__.py, pkg/cli.py, pkg/core.py and pkg/extra.py.',
    acceptanceCriteria: ['tests pass'],
    repoPath: '/tmp/repo',
    baseBranch: 'main',
  };

  it('does not hand every motion the paths the goal names', async () => {
    const dispatch = planningDispatcher([motion('cli', ['pkg/cli.py']), motion('core', ['pkg/core.py'])]);
    const ctx = context({ dispatch } as unknown as WorkerDispatcher, {}, graph());

    const built = await new DemocraticStrategy().plan(ctx, task);

    expect(built.nodes.cli.targetGlobs).toEqual(['pkg/cli.py']);
    expect(built.nodes.core.targetGlobs).toEqual(['pkg/core.py']);
    expect(built.nodes.cli.riskClass).toBe('low');
  });

  it('strikes a skeleton motion\'s claim on files a narrower motion implements', async () => {
    const dispatch = planningDispatcher([
      motion('skeleton', ['pkg/__init__.py', 'pkg/cli.py', 'pkg/core.py']),
      motion('cli', ['pkg/cli.py'], ['skeleton']),
      motion('core', ['pkg/core.py'], ['skeleton']),
    ]);
    const ctx = context({ dispatch } as unknown as WorkerDispatcher, {}, graph());

    const built = await new DemocraticStrategy().plan(ctx, task);

    expect(built.nodes.skeleton.targetGlobs).toEqual(['pkg/__init__.py']);
    expect(built.nodes.cli.targetGlobs).toEqual(['pkg/cli.py']);
    expect(built.nodes.core.targetGlobs).toEqual(['pkg/core.py']);
    expect(ctx.ledger.readAll().find((e) => e.type === 'speaker_amendment')?.data).toMatchObject({
      motionId: 'skeleton',
      struck: ['pkg/cli.py', 'pkg/core.py'],
      keptBy: { 'pkg/cli.py': 'cli', 'pkg/core.py': 'core' },
    });
  });

  it('drops a motion whose every file is owned elsewhere, and redirects its dependents to the owners', async () => {
    const dispatch = planningDispatcher([
      motion('wrapper', ['pkg/cli.py', 'pkg/core.py']),
      motion('cli', ['pkg/cli.py']),
      motion('core', ['pkg/core.py']),
      motion('tests', ['tests/test_pkg.py'], ['wrapper']),
    ]);
    const ctx = context({ dispatch } as unknown as WorkerDispatcher, {}, graph());

    const built = await new DemocraticStrategy().plan(ctx, task);

    expect(built.order).not.toContain('wrapper');
    expect(built.nodes.tests.dependsOn).toEqual(['cli', 'core']);
  });
});

describe('the Opposition names its remedy', () => {
  it('carries the remedy on the finding the next attempt is built from', async () => {
    const brief = {
      verdict: 'flag' as const,
      severity: 'low' as const,
      rationale: 'An empty name is accepted.',
      remedy: 'Raise ValueError for an empty name and add a test for it.',
    };
    const dispatch = vi.fn(async (opts: DispatchOptions) => {
      const value = opts.role === 'opposition'
        ? brief
        : { conceded: true, objectionsAnswered: [], citations: [], rationale: 'Agreed.' };
      opts.validate(value);
      return dispatchResult(value);
    });
    const ctx = context({ dispatch } as unknown as WorkerDispatcher);

    const result = await new DemocraticStrategy().review(ctx, productWith(['approve', 'approve']), { ran: true, passed: true });

    const finding = result.findings.find((f) => f.verdict === 'flag');
    expect(finding?.rationale).toContain(`Remedy proposed: ${brief.remedy}`);
    expect(ctx.ledger.readAll().find((e) => e.type === 'opposition_brief')?.data).toMatchObject({ remedy: brief.remedy });
  });

  it('records no remedy on an approval', async () => {
    const dispatch = vi.fn(async (opts: DispatchOptions) => {
      const value = { verdict: 'approve', severity: 'low', rationale: 'Sound.', remedy: 'n/a' };
      opts.validate(value);
      return dispatchResult(value);
    });
    const ctx = context({ dispatch } as unknown as WorkerDispatcher);

    const result = await new DemocraticStrategy().review(ctx, productWith(['approve', 'approve']), { ran: true, passed: true });

    expect(result.findings.every((f) => !f.rationale.includes('Remedy proposed'))).toBe(true);
  });
});

describe('the closure rule for routine recommittals', () => {
  function committeeDispatcher(verdict: CommitteeFinding['verdict']) {
    return vi.fn(async (opts: DispatchOptions) => {
      const value = { verdict, rationale: `${verdict} at inquiry` };
      opts.validate(value);
      return dispatchResult(value);
    });
  }

  function recommittal() {
    return { requiredChanges: ['Fix the boundary case.'], attemptNumber: 1, maxAttempts: 8, repeated: false, appealGranted: false };
  }

  function routineState(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      taskMeta: { 'motion-1': { title: 'Improve greeting', riskClass: 'low', portfolioTag: 'backend', treatment: 'routine' } },
      ...extra,
    };
  }

  it('records the committee\'s authorisation of a routine motion at its first sitting', async () => {
    const state = routineState();
    const ctx = context({ dispatch: committeeDispatcher('approve') } as unknown as WorkerDispatcher, state);

    await new DemocraticStrategy().assign(ctx, ctx.runState.graph!);

    expect((state.committeeAuthorisations as Record<string, CommitteeFinding[]>)['motion-1']).toHaveLength(1);
  });

  it('carries that authorisation to a retry instead of re-convening the committee', async () => {
    const authorised = findings(['approve']);
    const dispatch = committeeDispatcher('reject');
    const ctx = context(
      { dispatch } as unknown as WorkerDispatcher,
      routineState({ committeeAuthorisations: { 'motion-1': authorised }, recommittals: { 'motion-1': recommittal() } }),
    );

    const [assignment] = await new DemocraticStrategy().assign(ctx, ctx.runState.graph!);

    expect(dispatch).not.toHaveBeenCalled();
    expect((assignment.meta as { committeeFindings: CommitteeFinding[] }).committeeFindings).toEqual(authorised);
    expect(ctx.ledger.readAll().find((e) => e.type === 'closure_applied')?.data).toMatchObject({ taskId: 'motion-1', attemptNumber: 1 });
  });

  it('re-convenes the committee on a retry when it never authorised the motion', async () => {
    const dispatch = committeeDispatcher('approve');
    const ctx = context(
      { dispatch } as unknown as WorkerDispatcher,
      routineState({ recommittals: { 'motion-1': recommittal() } }),
    );

    await new DemocraticStrategy().assign(ctx, ctx.runState.graph!);

    expect(dispatch).toHaveBeenCalled();
    expect(ctx.ledger.readAll().some((e) => e.type === 'closure_applied')).toBe(false);
  });

  it('does not close debate on a motion the Speaker did not rule routine', async () => {
    const dispatch = committeeDispatcher('approve');
    const ctx = context({ dispatch } as unknown as WorkerDispatcher, {
      taskMeta: { 'motion-1': { title: 'Improve greeting', riskClass: 'low', portfolioTag: 'backend', treatment: 'committee' } },
      committeeAuthorisations: { 'motion-1': findings(['approve']) },
      recommittals: { 'motion-1': recommittal() },
    });

    await new DemocraticStrategy().assign(ctx, ctx.runState.graph!);

    expect(dispatch).toHaveBeenCalled();
  });

  it('puts only motions whose dependencies have carried before a committee', async () => {
    const taskGraph = graph();
    taskGraph.order.push('motion-2');
    taskGraph.nodes['motion-2'] = { ...taskGraph.nodes['motion-1'], id: 'motion-2', dependsOn: ['motion-1'], targetGlobs: ['src/other.ts'] };
    const dispatch = committeeDispatcher('approve');
    const ctx = context({ dispatch } as unknown as WorkerDispatcher, {}, taskGraph);

    const assignments = await new DemocraticStrategy().assign(ctx, taskGraph);

    expect(assignments.map((a) => a.taskId)).toEqual(['motion-1']);
    expect(ctx.ledger.readAll().filter((e) => e.type === 'committee_inquiry').map((e) => e.data.taskId)).toEqual(['motion-1']);
  });
});

describe('DemocraticStrategy closure rule at acceptance (section 14)', () => {
  it('refuses a stalled delivery with the guardian\'s ruling, and opens no approval it cannot act on', async () => {
    const ctx = context({ dispatch: vi.fn() } as unknown as WorkerDispatcher);
    const draft = {
      runId: 'test-run',
      strategy: 'democratic',
      baseRevision: 'abc',
      branch: 'swarm/test-run',
      goal: 'test',
      acceptanceCriteria: [],
      changedFiles: [],
      diffText: '',
      requirementMatrix: [],
      baseline: [],
      finalChecks: [],
      decisions: [],
      findings: [{
        id: 'f-1',
        source: 'house-of-review',
        summary: 'On non-waivable ground (security): a secret is committed.',
        evidenceRefs: ['config.yaml'],
        disposition: 'unresolved',
        dispositionRationale: 'open',
        nonWaivable: true,
      }],
      minorityReports: [],
      limitations: [],
      residualRisks: [],
      rollback: 'Delete the branch.',
      integrationEvidence: { integratorId: 'integration-committee', integrated: true, postIntegrationChecks: [], findings: [], rationale: 'ok' },
      independentVerification: { verifierId: 'commons-verifier', verified: true, criteriaTraced: [], findings: [], rationale: 'ok' },
      doctrineAcceptance: { accepted: true, procedure: 'x', rationale: 'y', decidedAt: '2026-01-01T00:00:00.000Z' },
      assembledAt: '2026-01-01T00:00:00.000Z',
      remediationCycles: 5,
    } as Parameters<DemocraticStrategy['accept']>[1];

    const acceptance = await new DemocraticStrategy().accept(ctx, draft);

    expect(acceptance.accepted).toBe(false);
    expect(acceptance.rationale).toMatch(/closure rule/);
    expect(ctx.openApproval).not.toHaveBeenCalled();
  });
});

/**
 * Why an attempt failed has to reach the implementer of the next one, or it regenerates the same
 * bug. Each of these was a path where the reason stopped short: in the ledger, in a one-line
 * summary, in a directive from an older attempt, or cut off before pytest's error lines.
 */
describe('failure reasons reaching the next implementer', () => {
  const representatives = Object.fromEntries(
    ['frontend', 'backend', 'data', 'security', 'testing', 'documentation', 'user-experience', 'operations'].map(
      (constituency) => [constituency, `rep-${constituency}`],
    ),
  );
  const pytestTail = 'E   FileNotFoundError: nuclear_data.py:36 DATA_DIR points at pkg/data, not data/';

  function implementerDispatcher() {
    return vi.fn(async (opts: DispatchOptions) => {
      const value = {
        fileOps: [{ op: 'write', filePath: 'src/greeting.ts', content: 'export const greeting = "hello";\n' }],
        rationale: 'Repairs the greeting.',
      };
      opts.validate(value);
      return dispatchResult(value);
    });
  }

  function remediationPacket(): RemediationPacket {
    return {
      runId: 'test-run',
      submittedAt: '2026-01-01T00:00:00.000Z',
      cycle: 1,
      findings: [{
        summary: 'Required final check unit failed on the partial combined tree',
        evidence: `${'collected 12 items\n'.repeat(40)}${pytestTail}`,
        affectedTaskIds: ['motion-1'],
        severity: 'high',
      }],
    };
  }

  async function implementerPromptAfter(ctx: EngineContext, dispatch: ReturnType<typeof implementerDispatcher>) {
    await new DemocraticStrategy().execute(ctx, productWith(['approve']).assignment);
    return dispatch.mock.calls.at(-1)![0].userPrompt;
  }

  it('gives a task reopened by remediation its remediation directive, evidence included', async () => {
    const dispatch = implementerDispatcher();
    const ctx = context({ dispatch } as unknown as WorkerDispatcher, closeDivisionState(), graph('approved'));

    await new DemocraticStrategy().remediate(ctx, remediationPacket());
    const prompt = await implementerPromptAfter(ctx, dispatch);

    expect(prompt).toContain('Required final check unit failed on the partial combined tree');
    expect(prompt).toContain(pytestTail);
  });

  // The engine reports a rejection it then reworks as `rejected`; clearing the directive there left
  // a reopened motion's third attempt with no record of why it had been reopened.
  it('keeps a remediation directive through a rejected attempt and clears it once the motion carries', async () => {
    const dispatch = implementerDispatcher();
    const strategyState = closeDivisionState();
    const ctx = context({ dispatch } as unknown as WorkerDispatcher, strategyState, graph('approved'));
    const strategy = new DemocraticStrategy();
    await strategy.remediate(ctx, remediationPacket());

    await strategy.recordOutcome(
      ctx,
      { taskId: 'motion-1', outcome: 'rejected', rationale: 'The division did not carry it.', evidenceRefs: [] },
      { ran: true, passed: false },
    );
    expect(await implementerPromptAfter(ctx, dispatch)).toContain('Required final check unit failed on the partial combined tree');

    await strategy.recordOutcome(
      ctx,
      { taskId: 'motion-1', outcome: 'approved', rationale: 'Carried.', evidenceRefs: [] },
      { ran: true, passed: true },
    );
    expect(await implementerPromptAfter(ctx, dispatch)).not.toContain('Required final check unit failed');
  });

  it('does not present a pre-remediation recommittal as the current directive', async () => {
    const dispatch = implementerDispatcher();
    const strategyState = {
      ...closeDivisionState(),
      recommittals: {
        'motion-1': { requiredChanges: ['Rename the stale helper.'], attemptNumber: 2, maxAttempts: 6, repeated: false, appealGranted: false },
      },
    };
    const ctx = context({ dispatch } as unknown as WorkerDispatcher, strategyState, graph('approved'));

    await new DemocraticStrategy().remediate(ctx, remediationPacket());
    const prompt = await implementerPromptAfter(ctx, dispatch);

    expect(prompt).not.toContain('Rename the stale helper.');
    expect(prompt).toContain(pytestTail);
  });

  it('does not leave an older recommittal standing after a motion goes to a human', async () => {
    const dispatch = implementerDispatcher();
    const strategyState = {
      ...closeDivisionState(),
      recommittals: {
        'motion-1': { requiredChanges: ['Rename the stale helper.'], attemptNumber: 1, maxAttempts: 6, repeated: false, appealGranted: false },
      },
    };
    const ctx = context({ dispatch } as unknown as WorkerDispatcher, strategyState);

    await new DemocraticStrategy().recordOutcome(
      ctx,
      { taskId: 'motion-1', outcome: 'needs_human', rationale: 'emergency rollback put to the owner', evidenceRefs: [] },
      { ran: true, passed: false },
    );
    const prompt = await implementerPromptAfter(ctx, dispatch);

    expect(prompt).not.toContain('Rename the stale helper.');
  });

  async function requiredChangesAfterDebate(reply: Record<string, unknown>) {
    const dispatch = vi.fn(async (opts: DispatchOptions) => {
      const value = opts.role === 'opposition'
        ? { verdict: 'flag', severity: 'low', rationale: 'The data loader reads the wrong directory.' }
        : reply;
      opts.validate(value);
      return dispatchResult(value);
    });
    const strategy = new DemocraticStrategy();
    const product = productWith(['approve', 'approve']);

    const review = await strategy.review(context({ dispatch } as unknown as WorkerDispatcher), product, {
      ran: true, passed: false, command: 'npm test', newFailures: ['loads nuclear data'],
    });
    const decision = await strategy.decide(
      context({ dispatch: vi.fn() } as unknown as WorkerDispatcher, { offices: { representatives } }),
      product,
      review,
    );

    expect(decision.outcome).toBe('rework');
    return decision.outcome === 'rework' ? decision.rework.requiredChanges : [];
  }

  // A concession answers no objections, so what was conceded lives only in its rationale — which
  // was never stored, leaving the "fix what the minister conceded" directive unreachable.
  it('carries what the minister conceded into the required changes', async () => {
    const changes = await requiredChangesAfterDebate({
      conceded: true,
      objectionsAnswered: [],
      citations: [],
      rationale: 'DATA_DIR at nuclear_data.py:36 points to the wrong directory.',
    });

    expect(changes).toContain(
      'Fix what the minister conceded to the Opposition: DATA_DIR at nuclear_data.py:36 points to the wrong directory.',
    );
  });

  it('presents a defence the House refused as context, not as a change to make', async () => {
    const changes = await requiredChangesAfterDebate({
      conceded: false,
      objectionsAnswered: ['The loader reads pkg/data by design.'],
      citations: ['nuclear_data.py'],
      rationale: 'The directory is intended.',
    });

    const ministerial = changes.filter((change) => change.includes('The loader reads pkg/data by design.'));
    expect(ministerial).toEqual([
      'Context, not a required change — the government argued: The loader reads pkg/data by design. The House did not accept it.',
    ]);
  });

  function failingReview(): ReviewResult {
    return {
      taskId: 'motion-1',
      findings: [{ reviewerId: 'opposition', verdict: 'flag', rationale: 'Cover the failing edge case.' }],
      testResult: {
        ran: true,
        passed: false,
        command: 'npm test',
        newFailures: ['unit'],
        output: `${'tests/test_data.py::test_load PASSED\n'.repeat(60)}${pytestTail}`,
        checks: [
          { categoryId: 'unit', status: 'new', output: pytestTail },
          { categoryId: 'lint', status: 'still_failing', output: 'E501 line too long' },
        ],
      },
      meta: { oppositionVerdict: 'flag', oppositionSeverity: 'low' },
    };
  }

  // The engine's repair brief carries the output to every doctrine's implementer alike. A close
  // division used to paste its own copy here, so it differed in evidence from a non-close one.
  it('names the failing checks without pasting their output', async () => {
    const ctx = context({ dispatch: vi.fn() } as unknown as WorkerDispatcher, { offices: { representatives } });

    const decision = await new DemocraticStrategy().decide(ctx, productWith(['approve', 'approve']), failingReview());

    const changes = decision.outcome === 'rework' ? decision.rework.requiredChanges : [];
    expect(changes).toContain('Fix the new verification failure: unit');
    expect(changes).toContain('Make the required check pass: lint (still failing)');
    expect(changes.join('\n')).not.toContain(pytestTail);
    expect(changes.join('\n')).not.toContain('E501');
  });

  it('puts no check output in the guardian\'s rollback rationale', async () => {
    const ctx = context({ dispatch: vi.fn() } as unknown as WorkerDispatcher, { offices: { representatives } }, graph('rejected'));

    const decision = await new DemocraticStrategy().decide(ctx, productWith(['approve', 'approve']), failingReview());

    expect(decision.outcome).toBe('needs_human');
    expect(decision.rationale).toContain('Fix the new verification failure: unit');
    expect(decision.rationale).not.toContain(pytestTail);
  });

  // The closure rule carries the first sitting's findings, judged before any code existed. Replayed
  // on every retry, a plan-stage remark became a required code change each attempt had to answer.
  it('does not replay a carried committee finding as a required change', async () => {
    const ctx = context({ dispatch: vi.fn() } as unknown as WorkerDispatcher, { offices: { representatives } });
    const product = productWith(['approve', 'approve', 'flag']);
    const fresh = await new DemocraticStrategy().decide(ctx, product, failingReview());
    const carried = { ...product, assignment: { ...product.assignment, meta: { ...product.assignment.meta, committeeCarried: true } } };
    const replayed = await new DemocraticStrategy().decide(
      context({ dispatch: vi.fn() } as unknown as WorkerDispatcher, { offices: { representatives } }),
      carried,
      failingReview(),
    );

    const committeeLines = (decision: Decision) => (decision.outcome === 'rework' ? decision.rework.requiredChanges : [])
      .filter((change) => change.includes('committee finding'));
    expect(committeeLines(fresh)).toHaveLength(1);
    expect(replayed.outcome).toBe('rework');
    expect(committeeLines(replayed)).toEqual([]);
  });

  it('keeps carried committee findings out of a retry\'s review findings', async () => {
    const dispatch = vi.fn(async (opts: DispatchOptions) => {
      const value = { verdict: 'approve', severity: 'low', rationale: 'Sound.' };
      opts.validate(value);
      return dispatchResult(value);
    });
    const product = productWith(['approve', 'flag']);
    product.assignment.meta = { ...product.assignment.meta, committeeCarried: true };

    const review = await new DemocraticStrategy().review(context({ dispatch } as unknown as WorkerDispatcher), product, { ran: true, passed: true });

    expect(review.findings.map((finding) => finding.reviewerId)).toEqual(['shadow-general-reviewer']);
  });

  // A medium/high Opposition reject is decided `rejected`, and the engine replaces the House's
  // wording with its own directive — so the minister's concession, made exactly then, was lost.
  it('carries a concession on an Opposition-rejected motion through recover() to the next implementer', async () => {
    const dispatch = vi.fn(async (opts: DispatchOptions) => {
      const value = opts.role === 'opposition'
        ? { verdict: 'reject', severity: 'high', rationale: 'The loader reads the wrong directory.', remedy: 'Point DATA_DIR at data/.' }
        : opts.role === 'implementer'
          ? { fileOps: [{ op: 'write', filePath: 'src/greeting.ts', content: 'x\n' }], rationale: 'Repairs it.' }
          : { conceded: true, objectionsAnswered: [], citations: [], rationale: 'DATA_DIR at nuclear_data.py:36 is wrong.' };
      opts.validate(value);
      return dispatchResult(value);
    });
    const strategy = new DemocraticStrategy();
    const product = productWith(['approve', 'approve']);
    const test = { ran: true, passed: false, output: pytestTail, checks: [{ categoryId: 'unit', status: 'new' as const, output: pytestTail }] };
    const ctx = context({ dispatch } as unknown as WorkerDispatcher, { offices: { representatives } });

    const review = await strategy.review(context({ dispatch } as unknown as WorkerDispatcher), product, test);
    const decision = await strategy.decide(ctx, product, review);
    expect(decision.outcome).toBe('rejected');

    // What the engine hands recover() for a rejection it reworks.
    const nextCtx = context({ dispatch } as unknown as WorkerDispatcher, closeDivisionState());
    await strategy.recover(nextCtx, {
      product, review, test, attemptNumber: 1, maxAttempts: 6, repeated: false,
      decision: { ...decision, outcome: 'rework', rework: { requiredChanges: [decision.rationale, 'Failing check: unit (passed before this change)'] } },
    });
    await strategy.execute(nextCtx, product.assignment);

    const prompt = dispatch.mock.calls.at(-1)![0].userPrompt;
    expect(prompt).toContain('Fix what the minister conceded to the Opposition: DATA_DIR at nuclear_data.py:36 is wrong.');
    expect(prompt).toContain('Remedy proposed: Point DATA_DIR at data/.');
    expect(prompt).toContain('Failing check: unit (passed before this change)');
    expect(prompt).not.toContain(pytestTail);
  });

  // Shown only the new diff, the Opposition could not tell whether the last round's objection had
  // been met, and raised a fresh one each round.
  it('shows the Opposition the required changes the previous attempt was returned with', async () => {
    const dispatch = vi.fn(async (opts: DispatchOptions) => {
      const value = { verdict: 'approve', severity: 'low', rationale: 'Sound.' };
      opts.validate(value);
      return dispatchResult(value);
    });
    const ctx = context({ dispatch } as unknown as WorkerDispatcher, {
      recommittals: {
        'motion-1': { requiredChanges: ['Raise ValueError for an empty name.'], attemptNumber: 1, maxAttempts: 6, repeated: false, appealGranted: false },
      },
    });

    await new DemocraticStrategy().review(ctx, productWith(['approve']), { ran: true, passed: true });

    const prompt = dispatch.mock.calls.find(([opts]) => opts.role === 'opposition')![0].userPrompt;
    expect(prompt).toContain('- Raise ValueError for an empty name.');
    expect(prompt).toContain('Check first whether this change makes each of them');
  });
});

describe('successor elections', () => {
  // abdm2-off-r2: confidence was lost twice in term 2 before another task completed. Both successor
  // elections were keyed by the completed-task count, so the second reused the first's id with
  // different ballots, the replay guard threw, and the task being settled was killed twice.
  it('gives each successor election in a term its own id when confidence is lost twice', async () => {
    const constituencies = ['frontend', 'backend', 'data', 'security', 'testing', 'documentation', 'user-experience', 'operations'];
    const representatives = Object.fromEntries(constituencies.map((seat) => [seat, `rep-${seat}`]));
    const strategyState: Record<string, unknown> = {
      offices: { primeCoordinator: 'prime-coordinator-t2c1', termId: 2, representatives, holders: [], shadowCabinet: {} },
      completedTaskCount: 7,
      governmentFailures: 3,
      termTally: { carried: 1, defeated: 4 },
    };
    const dispatch = vi.fn(async (opts: DispatchOptions) => {
      const prompt = `${opts.systemPrompt}\n${opts.userPrompt}`;
      const incumbent = (strategyState.offices as { primeCoordinator: string }).primeCoordinator;
      const value = prompt.includes('retains your confidence')
        ? { choice: 'no' }
        : { candidate: [...prompt.matchAll(/prime-coordinator-t2c\d+/g)].map((m) => m[0]).find((c) => c !== incumbent) };
      opts.validate(value);
      return dispatchResult(value);
    });
    const ctx = context({ dispatch } as unknown as WorkerDispatcher, strategyState);
    ctx.config = { ...config, offices: { constituentBallots: true } } as unknown as Record<string, unknown>;
    const strategy = new DemocraticStrategy() as unknown as {
      putTheQuestionOfConfidence(ctx: EngineContext, cfg: DemocraticConfig): Promise<void>;
    };

    await strategy.putTheQuestionOfConfidence(ctx, ctx.config as unknown as DemocraticConfig);
    const first = (strategyState.offices as { primeCoordinator: string }).primeCoordinator;
    await strategy.putTheQuestionOfConfidence(ctx, ctx.config as unknown as DemocraticConfig);
    const second = (strategyState.offices as { primeCoordinator: string }).primeCoordinator;

    const elections = (ctx.runState.governanceDecisions ?? []).filter((d) => d.id.startsWith('prime-coordinator-election-'));
    expect(elections).toHaveLength(2);
    expect(new Set(elections.map((d) => d.id)).size).toBe(2);
    expect(first).not.toBe('prime-coordinator-t2c1');
    expect(second).not.toBe(first);
  });
});

describe('lot seed', () => {
  // The benchmark seeds every arm of a trial alike, so a run's random id no longer changes who sits
  // in the sortition pool or the House of Review.
  it('draws the same offices for two runs that share a lot seed, and different ones otherwise', () => {
    const draw = (runId: string, seed?: string) => {
      const ctx = context({ dispatch: vi.fn() } as unknown as WorkerDispatcher);
      ctx.runId = runId;
      ctx.runState.runId = runId;
      if (seed) ctx.runState.lotSeed = seed;
      const strategy = new DemocraticStrategy() as unknown as {
        constituteOfficesFor(ctx: EngineContext, cfg: DemocraticConfig, termId: number): { sortitionPool: string[]; houseOfReview: string[] };
      };
      const { sortitionPool, houseOfReview } = strategy.constituteOfficesFor(ctx, config, 1);
      return { sortitionPool, houseOfReview };
    };
    expect(draw('democratic-run-a', 'benchmark-trial-0')).toEqual(draw('democratic-run-b', 'benchmark-trial-0'));
    const seeds = ['benchmark-trial-0', 'benchmark-trial-1', 'benchmark-trial-2', 'benchmark-trial-3'];
    expect(new Set(seeds.map((seed) => JSON.stringify(draw('democratic-run-a', seed)))).size).toBeGreaterThan(1);
  });
});
