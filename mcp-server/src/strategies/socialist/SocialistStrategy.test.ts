import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KnowledgeStore } from '../../engine/KnowledgeStore.js';
import { Ledger } from '../../engine/Ledger.js';
import { RepoWorktree } from '../../engine/RepoWorktree.js';
import type { EngineContext, RecoveryRequest } from '../../engine/SwarmStrategy.js';
import type { Decision, ReviewResult, TaskGraph, TestResult, WorkProduct } from '../../engine/types.js';
import type { RepairBrief } from '../../engine/repairBrief.js';
import type { DispatchOptions, WorkerDispatcher } from '../../engine/WorkerDispatcher.js';
import { sameObjection, SocialistStrategy } from './SocialistStrategy.js';
import { blameWithoutDiagnosis } from './constitution.js';
import type { ImplementerResponse, ReviewerResponse, SocialistState } from './types.js';
import { emptyOwnershipMap, type DeliveryPacket } from '../../engine/packets.js';
import { deliveryGovernanceDigest, GovernanceHaltError, requireGovernanceAction, restoreGovernanceFromLedger } from '../../engine/governance.js';
import { normalizeChecksConfig } from '../../util/config.js';

// Names both disciplines outright, so which councils go out is a property of the goal rather than
// an accident of the fixture's wording.
const TWO_COUNCIL_GOAL = 'Add a profile form component and the backend API endpoint behind it';

const passingTest: TestResult = { ran: true, passed: true, command: 'npm test', output: 'ok' };
const failingTest: TestResult = { ran: true, passed: false, command: 'npm test', output: 'failed' };

let tmpRoot: string;
let repoPath: string;
let worktree: RepoWorktree;

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function graph(riskClass: 'low' | 'medium' | 'high' = 'low'): TaskGraph {
  return {
    nodes: {
      task1: {
        id: 'task1',
        title: 'Add authenticated profile form',
        description: 'Implement the API and React form with unit tests',
        acceptanceCriteria: ['Profile can be saved'],
        dependsOn: [],
        targetGlobs: ['server/api/profile.ts', 'client/components/Profile.tsx', 'tests/profile.test.ts'],
        riskTags: ['backend', 'frontend', 'testing'],
        riskClass,
        phase: 'queued',
        attempts: [],
      },
    },
    order: ['task1'],
  };
}

function dependentGraph(): TaskGraph {
  const work = graph();
  work.nodes.task2 = {
    ...work.nodes.task1,
    id: 'task2',
    title: 'Shared interface',
    phase: 'settled',
    dependsOn: [],
    targetGlobs: ['shared/profile.ts'],
    attempts: [{ attempt: 1, outcome: 'approved', rationale: 'Verified', evidenceRefs: [],
      at: '2026-01-01T00:00:00Z', fingerprint: 'fixture', repeated: false }],
  };
  work.nodes.task1.dependsOn = ['task2'];
  work.order = ['task2', 'task1'];
  return work;
}

function dispatchResult<T>(value: T): { value: T; raw: string; model: string; costUsd: number } {
  return { value, raw: JSON.stringify(value), model: 'fake-model', costUsd: 0 };
}

/** Answers each dispatch by persona id, so a plan() call can drive reconnaissance then synthesis. */
function makeRoutedDispatcher(byPersona: Record<string, unknown>, fallback: unknown = {}): WorkerDispatcher {
  const dispatch = vi.fn(async (opts: DispatchOptions) => {
    const value = byPersona[opts.personaId ?? ''] ?? fallback;
    if (value instanceof Error) throw value;
    opts.validate(value);
    return dispatchResult(value);
  });
  return { dispatch } as unknown as WorkerDispatcher;
}

/** Holds every dispatch until `expected` of them are in flight, and fails if they never are — so a
 * test passes only when those calls were issued together rather than one after another. */
function makeConcurrentDispatcher(byPersona: Record<string, unknown>, expected: number): WorkerDispatcher {
  let inFlight = 0;
  let release!: () => void;
  const allStarted = new Promise<void>((resolve) => { release = resolve; });
  const dispatch = vi.fn(async (opts: DispatchOptions) => {
    inFlight += 1;
    if (inFlight === expected) release();
    await Promise.race([allStarted, new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`only ${inFlight} of ${expected} dispatches were in flight together`)), 1_000))]);
    const value = byPersona[opts.personaId ?? ''];
    opts.validate(value);
    return dispatchResult(value);
  });
  return { dispatch } as unknown as WorkerDispatcher;
}

function makeDispatcher(value: unknown): WorkerDispatcher {
  const dispatch = vi.fn(async (opts: DispatchOptions) => {
    opts.validate(value);
    return dispatchResult(value);
  });
  return { dispatch } as unknown as WorkerDispatcher;
}

function makeContext(options: {
  dispatcher?: WorkerDispatcher;
  taskGraph?: TaskGraph;
  strategyState?: Record<string, unknown>;
} = {}): EngineContext {
  const taskGraph = options.taskGraph ?? graph();
  const runDir = path.join(tmpRoot, 'run-data');
  return {
    dispatcher: options.dispatcher ?? makeDispatcher({}),
    worktree,
    ledger: new Ledger(runDir, 'test-run', 'socialist'),
    knowledge: new KnowledgeStore(runDir),
    budget: {} as EngineContext['budget'],
    config: {
      guilds: ['backend', 'frontend', 'testing', 'security'],
      initialCapabilityScore: 0.5,
      recall: { consecutivePlannerFailuresBeforeSwap: 3 },
      escalateToHuman: { securityPathGlobs: ['auth/**'] },
    },
    checks: normalizeChecksConfig({ command: 'npm', args: ['test'], timeoutMs: 1_000 }),
    runId: 'test-run',
    runState: {
      runId: 'test-run',
      strategy: 'socialist',
      task: { goal: 'Add a profile editor', acceptanceCriteria: ['Profile can be saved'] },
      repoPath,
      baseBranch: 'main',
      worktreePath: worktree.worktreePath,
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
    strategyState: options.strategyState ?? {},
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
    openApproval: vi.fn((approval) => ({ ...approval, id: 'approval-1', createdAt: '2026-01-01T00:00:00.000Z' })),
    getApprovalResolution: vi.fn(() => undefined),
  };
}

/** A packet the ordinary acceptance checks all pass, so a refusal can only come from the gate. */
function cleanDraft(): DeliveryPacket {
  return {
    runId: 'test-run',
    strategy: 'socialist',
    baseRevision: 'abc',
    branch: 'swarm/test-run',
    goal: 'Add a profile editor',
    acceptanceCriteria: ['Profile can be saved'],
    changedFiles: [],
    diffText: '',
    requirementMatrix: [],
    baseline: [],
    finalChecks: [],
    decisions: [],
    findings: [],
    minorityReports: [],
    limitations: [],
    residualRisks: [],
    rollback: 'Delete the branch.',
    integrationEvidence: { integratorId: 'integration-council', integrated: true, postIntegrationChecks: [], findings: [], rationale: 'ok' },
    independentVerification: {
      verifierId: 'peer-verifier',
      verified: true,
      criteriaTraced: ['Profile can be saved'],
      findings: [],
      rationale: 'ok',
    },
    doctrineAcceptance: { accepted: true, procedure: 'x', rationale: 'y', decidedAt: '2026-01-01T00:00:00.000Z' },
    assembledAt: '2026-01-01T00:00:00.000Z',
    remediationCycles: 0,
  };
}

function product(): WorkProduct {
  return {
    taskId: 'task1',
    assignment: { taskId: 'task1', assigneeId: 'backend-1', role: 'implementer' },
    fileOps: [{ op: 'write', path: 'server/api/profile.ts', content: 'export const profile = true;\n' }],
    rationale: 'Implemented the profile endpoint.',
    unresolvedUncertainty: 'none',
  };
}

function review(verdict: 'approve' | 'reject', testResult: TestResult): ReviewResult {
  return {
    taskId: 'task1',
    findings: [{ reviewerId: 'backend-2', verdict, rationale: `${verdict} rationale`, evidenceRefs: ['profile.ts'] }],
    testResult,
  };
}

// `outcome` is a widened runtime parameter, so it can't narrow against Decision's discriminated
// union; this helper never constructs a 'rework' outcome, so the cast is safe.
function decision(outcome: Decision['outcome'], baseApproved: boolean): Decision {
  return { taskId: 'task1', outcome, rationale: outcome, evidenceRefs: [], meta: { baseApproved } } as Decision;
}

function recoveryRequest(
  failedDecision: Decision,
  failedReview: ReviewResult,
  options: { attemptNumber?: number; repeated?: boolean } = {},
): RecoveryRequest {
  if (failedDecision.outcome !== 'rework') throw new Error('The fixture requires a rework decision.');
  return {
    product: product(),
    review: failedReview,
    decision: failedDecision,
    test: failedReview.testResult ?? failingTest,
    attemptNumber: options.attemptNumber ?? 1,
    maxAttempts: 3,
    repeated: options.repeated ?? false,
  };
}

beforeEach(async () => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'socialist-strategy-test-'));
  repoPath = path.join(tmpRoot, 'repo');
  mkdirSync(repoPath, { recursive: true });
  git(repoPath, ['init', '-q']);
  git(repoPath, ['config', 'user.email', 'test@example.com']);
  git(repoPath, ['config', 'user.name', 'Test']);
  writeFileSync(path.join(repoPath, 'README.md'), 'fixture\n', 'utf8');
  git(repoPath, ['add', '-A']);
  git(repoPath, ['commit', '-q', '-m', 'init']);
  git(repoPath, ['branch', '-M', 'main']);
  worktree = new RepoWorktree(repoPath, path.join(tmpRoot, 'worktrees'), 'test-run');
  await worktree.create('main');
});

afterEach(() => {
  try {
    git(repoPath, ['worktree', 'remove', '--force', worktree.worktreePath]);
  } catch {
    // The temporary root removal below remains sufficient if git cannot unregister the worktree.
  }
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('SocialistStrategy lifecycle', () => {
  it('lets a single guild assign its highest-capability member without coordinator arbitration', async () => {
    const strategy = new SocialistStrategy();
    const taskGraph = graph();
    taskGraph.nodes.task1.title = 'Add API profile endpoint';
    taskGraph.nodes.task1.description = 'Implement the backend route with unit tests';
    taskGraph.nodes.task1.targetGlobs = ['server/api/profile.ts', 'tests/profile.test.ts'];
    const dispatcher = makeDispatcher({});
    const strategyState = { capability: { backend: { 'backend-1': 0.4, 'backend-2': 0.9 } } };
    const ctx = makeContext({ dispatcher, taskGraph, strategyState });

    const assignments = await strategy.assign(ctx, taskGraph);

    expect(assignments).toEqual([{
      taskId: 'task1',
      assigneeId: 'backend-2',
      role: 'implementer',
      meta: { guilds: ['backend', 'testing'], leadGuild: 'backend', coordinated: false },
    }]);
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('sends the councils out before the plan is written, and synthesises over what they published', async () => {
    const strategy = new SocialistStrategy();
    const dispatcher = makeRoutedDispatcher({
      'council-test-mandate': { items: [] },
      'frontend-delegate': {
        scopes: ['the profile form'],
        risks: ['Unsaved edits are lost when the form remounts'],
        dependencies: ['the profile API shape'],
        proposedCriteria: ['Editing and saving a profile round-trips'],
      },
      'backend-delegate': { scopes: ['the profile route'], risks: [], dependencies: [], proposedCriteria: ['The profile route saves edits'] },
      'planner-1': {
        nodes: [
          {
            id: 'n1',
            title: 'Add the profile form',
            description: 'A React component that keeps unsaved edits across a remount',
            targetGlobs: ['client/Profile.tsx'],
          },
        ],
      },
    });
    const ctx = makeContext({ dispatcher });

    await strategy.plan(ctx, { ...ctx.runState.task, goal: TWO_COUNCIL_GOAL, repoPath, baseBranch: 'main' });
    const entries = ctx.ledger.readAll();

    // Both councils publish, and both do so before the planner is asked for anything.
    const published = entries.filter((e) => e.type === 'reconnaissance_published');
    expect(published.map((e) => e.data.council)).toEqual(['backend', 'frontend']);

    const calls = (dispatcher.dispatch as unknown as { mock: { calls: [DispatchOptions][] } }).mock.calls.map(
      (c) => c[0].personaId,
    );
    expect(calls.indexOf('frontend-delegate')).toBeLessThan(calls.indexOf('planner-1'));

    // The planner is handed what they found, rather than being asked to invent a plan privately.
    const synthesis = (dispatcher.dispatch as unknown as { mock: { calls: [DispatchOptions][] } }).mock.calls.find(
      (c) => c[0].personaId === 'planner-1',
    )![0];
    expect(synthesis.userPrompt).toContain('Unsaved edits are lost when the form remounts');

    // The plan engaged the risk, so there is nothing to challenge.
    expect(entries.some((e) => e.type === 'plan_challenged')).toBe(false);
  });

  // Article 9. A planner can be told to synthesise and simply not, so the guarantee is the
  // comparison against the plan, never the instruction.
  it('carries a risk the plan ignored into the delivery in the council\'s name', async () => {
    const strategy = new SocialistStrategy();
    const dispatcher = makeRoutedDispatcher({
      'council-test-mandate': { items: [] },
      'frontend-delegate': { scopes: [], risks: [], dependencies: [], proposedCriteria: ['The form renders'] },
      'backend-delegate': {
        scopes: [],
        risks: ['Rotating the signing secret invalidates every issued token'],
        dependencies: [],
        proposedCriteria: ['Issued tokens stay valid'],
      },
      'planner-1': {
        nodes: [{ id: 'n1', title: 'Add the profile form', description: 'A React component', targetGlobs: ['client/Profile.tsx'] }],
      },
    });
    const ctx = makeContext({ dispatcher });

    await strategy.plan(ctx, { ...ctx.runState.task, goal: TWO_COUNCIL_GOAL, repoPath, baseBranch: 'main' });

    expect(ctx.ledger.readAll().find((e) => e.type === 'plan_challenged')?.data).toMatchObject({
      council: 'backend',
      carriedForward: true,
    });
    expect(ctx.addFinding).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'backend-council', disposition: 'deferred', owner: 'backend-council' }),
    );
  });

  it('treats a risk the planner answered as heard, not ignored', async () => {
    const strategy = new SocialistStrategy();
    const risk = 'Rotating the signing secret invalidates every issued token';
    const dispatcher = makeRoutedDispatcher({
      'council-test-mandate': { items: [] },
      'frontend-delegate': { scopes: [], risks: [], dependencies: [], proposedCriteria: ['The form renders'] },
      'backend-delegate': { scopes: [], risks: [risk], dependencies: [], proposedCriteria: ['Issued tokens stay valid'] },
      'planner-1': {
        nodes: [{ id: 'n1', title: 'Add the profile form', description: 'A React component', targetGlobs: ['client/Profile.tsx'] }],
        synthesis: { adopted: [], setAside: [{ finding: risk, reason: 'Secret rotation is out of scope for this task.' }] },
      },
    });
    const ctx = makeContext({ dispatcher });

    await strategy.plan(ctx, { ...ctx.runState.task, goal: TWO_COUNCIL_GOAL, repoPath, baseBranch: 'main' });

    expect(ctx.ledger.readAll().find((e) => e.type === 'plan_challenged')?.data).toMatchObject({ carriedForward: false });
    expect(ctx.addFinding).not.toHaveBeenCalled();
  });

  // Losing one discipline's view is a worse plan; refusing to plan because a delegate's model was
  // unavailable would be a worse run.
  it('plans on what the other councils found when one cannot report', async () => {
    const strategy = new SocialistStrategy();
    const dispatcher = makeRoutedDispatcher({
      'council-test-mandate': { items: [] },
      'frontend-delegate': new Error('model unavailable'),
      'backend-delegate': { scopes: ['the route'], risks: [], dependencies: [], proposedCriteria: ['The route responds'] },
      'planner-1': {
        nodes: [{ id: 'n1', title: 'Add the route', description: 'Backend', targetGlobs: ['server/route.ts'] }],
      },
    });
    const ctx = makeContext({ dispatcher });

    const graph = await strategy.plan(ctx, { ...ctx.runState.task, goal: TWO_COUNCIL_GOAL, repoPath, baseBranch: 'main' });

    expect(graph.order).toEqual(['n1']);
    const shortfall = ctx.ledger.readAll().find((e) => e.type === 'reconnaissance_published' && e.data.council === 'frontend');
    expect(String(shortfall?.data.model)).toContain('unavailable');
  });

  it('requires a council-approved plan version before assigning work', async () => {
    const strategy = new SocialistStrategy();
    const dispatcher = makeRoutedDispatcher({
      'council-test-mandate': { items: [] },
      'planner-1': { nodes: [{ id: 'n1', title: 'Add route', description: 'Build route', targetGlobs: ['server/route.ts'] }] },
    }, { choice: 'approve' });
    const ctx = makeContext({ dispatcher });
    (ctx.config as Record<string, unknown>).councils = { requirePlanRatification: true };

    const planned = await strategy.plan(ctx, { ...ctx.runState.task, repoPath, baseBranch: 'main' });
    expect(ctx.ledger.readAll().some((entry) => entry.type === 'governance_mandate_granted')).toBe(true);
    expect((await strategy.assign(ctx, planned)).map((assignment) => assignment.taskId)).toEqual(['n1']);

    planned.nodes.n1.description = 'Changed after approval';
    await expect(strategy.assign(ctx, planned)).rejects.toThrow('lacks council ratification');
  });

  it('ratifies a plan by equal worker ballots and lets the delegate carry their result', async () => {
    const strategy = new SocialistStrategy();
    const dispatcher = makeRoutedDispatcher({
      'council-test-mandate': { items: [] },
      'planner-1': { nodes: [{ id: 'n1', title: 'Add route', description: 'Build route', targetGlobs: ['server/route.ts'] }] },
    }, { choice: 'approve', recallGround: '', recallReason: '' });
    const ctx = makeContext({ dispatcher });
    (ctx.config as Record<string, unknown>).councils = { requirePlanRatification: true, memberBallots: true };

    await strategy.plan(ctx, { ...ctx.runState.task, repoPath, baseBranch: 'main' });

    const council = (ctx.strategyState as Record<string, unknown>).councils as Record<string, { members: string[] }>;
    const decision = ctx.runState.governanceDecisions?.find((entry) => entry.rule === 'member-council-ratification-v1');
    expect(decision?.positions).toHaveLength(council.n1.members.length);
    expect(decision?.result).toBe('approve');
    expect(ctx.ledger.readAll().some((entry) => entry.type === 'council_member_ballots')).toBe(true);
    const dispatchCalls = vi.mocked(dispatcher.dispatch).mock.calls.map(([options]) => options);
    expect(dispatchCalls.filter((options) => council.n1.members.includes(options.personaId ?? ''))
      .every((options) => options.repositoryTools === false)).toBe(true);
  });

  it('shows each council the rest of the plan so it judges its own mandate only', async () => {
    const strategy = new SocialistStrategy();
    const dispatcher = makeRoutedDispatcher({
      'council-test-mandate': { items: [] },
      'planner-1': { nodes: [
        { id: 'n1', title: 'Add route', description: 'Build route', targetGlobs: ['server/route.ts'] },
        { id: 'n2', title: 'Plot results', description: 'Plot', targetGlobs: ['server/plot.ts'], dependsOn: ['n1'] },
      ] },
    }, { choice: 'approve' });
    const ctx = makeContext({ dispatcher });
    (ctx.config as Record<string, unknown>).councils = { requirePlanRatification: true, memberBallots: true };

    await strategy.plan(ctx, { ...ctx.runState.task, repoPath, baseBranch: 'main' });

    const ballot = vi.mocked(dispatcher.dispatch).mock.calls.map(([options]) => options)
      .find((options) => options.institutionalReplayKey?.startsWith('plan-ballot:') && options.taskId === 'n2');
    expect(JSON.parse(ballot!.userPrompt).otherMandates)
      .toEqual([{ id: 'n1', title: 'Add route', targetGlobs: ['server/route.ts'] }]);
  });

  it('reuses durable council ballots when planning resumes before the graph was saved', async () => {
    const strategy = new SocialistStrategy();
    const dispatcher = makeRoutedDispatcher({
      'council-test-mandate': { items: [] },
      'planner-1': { nodes: [{ id: 'n1', title: 'Add route', description: 'Build route',
        targetGlobs: ['server/route.ts'] }] },
    }, { choice: 'approve' });
    const ctx = makeContext({ dispatcher });
    (ctx.config as Record<string, unknown>).councils = { requirePlanRatification: true, memberBallots: true };

    await strategy.plan(ctx, { ...ctx.runState.task, repoPath, baseBranch: 'main' });
    const calls = vi.mocked(dispatcher.dispatch).mock.calls;
    const ballotsBefore = calls.filter(([options]) => options.institutionalReplayKey?.startsWith('plan-ballot:')).length;
    ctx.strategyState = {};
    ctx.runState.governanceDecisions = [];
    ctx.runState.governanceMandates = [];
    restoreGovernanceFromLedger(ctx.runState, ctx.ledger.readAll());

    await strategy.plan(ctx, { ...ctx.runState.task, repoPath, baseBranch: 'main' });

    const ballotsAfter = calls.filter(([options]) => options.institutionalReplayKey?.startsWith('plan-ballot:')).length;
    expect(ballotsBefore).toBeGreaterThan(0);
    expect(ballotsAfter).toBe(ballotsBefore);
    expect(ctx.runState.governanceDecisions?.filter((entry) => entry.rule === 'member-council-ratification-v1'))
      .toHaveLength(1);
  });

  it('ratifies unfinished work before dispatching a legacy snapshot without council mandates', async () => {
    const taskGraph = dependentGraph();
    const completedDescription = taskGraph.nodes.task2.description;
    const dispatcher = makeRoutedDispatcher({
      coordinator: { leadGuild: 'backend', assigneeId: 'backend-1',
        rationale: 'The backend owns the shared interface.', subject: 'interface' },
    }, { choice: 'approve' });
    const ctx = makeContext({ dispatcher, taskGraph });
    (ctx.config as Record<string, unknown>).councils = { requirePlanRatification: true, memberBallots: true };

    const assignments = await new SocialistStrategy().assign(ctx, taskGraph);

    expect(assignments).toHaveLength(1);
    expect(assignments[0].taskId).toBe('task1');
    expect(assignments[0].meta?.authority).toBeDefined();
    expect(taskGraph.nodes.task2.description).toBe(completedDescription);
    expect(ctx.runState.governanceDecisions?.filter((decision) =>
      decision.rule === 'member-council-ratification-v1').map((decision) => decision.subject)).toEqual(['task1']);
    expect(ctx.ledger.readAll().some((entry) => entry.type === 'legacy_plan_ratified')).toBe(true);
  });

  it('waits for in-flight council ballots before propagating a failed ballot', async () => {
    const strategy = new SocialistStrategy();
    let slowerBallotFinished = false;
    const dispatch = vi.fn(async (opts: DispatchOptions) => {
      let value: unknown;
      if (opts.personaId === 'council-test-mandate') value = { items: [] };
      else if (opts.personaId === 'planner-1') {
        value = { nodes: [{ id: 'n1', title: 'Add route', description: 'Build route', targetGlobs: ['server/route.ts'] }] };
      } else if (opts.personaId?.endsWith('-1')) {
        throw new Error('Ballot unavailable');
      } else {
        await new Promise((resolve) => setTimeout(resolve, 15));
        slowerBallotFinished = true;
        value = { choice: 'approve' };
      }
      opts.validate(value);
      return dispatchResult(value);
    });
    const ctx = makeContext({ dispatcher: { dispatch } as unknown as WorkerDispatcher });
    (ctx.config as Record<string, unknown>).councils = { requirePlanRatification: true, memberBallots: true };

    await expect(strategy.plan(ctx, { ...ctx.runState.task, repoPath, baseBranch: 'main' }))
      .rejects.toThrow('Ballot unavailable');
    expect(slowerBallotFinished).toBe(true);
  });

  it('lets a member initiate recall and transfers the work mandate after a majority vote', async () => {
    const strategy = new SocialistStrategy();
    const dispatch = vi.fn(async (opts: DispatchOptions) => {
      let value: unknown;
      if (opts.personaId === 'council-test-mandate') value = { items: [] };
      else if (opts.personaId === 'planner-1') {
        value = { nodes: [{ id: 'n1', title: 'Add route', description: 'Build route', targetGlobs: ['server/route.ts'] }] };
      } else if (opts.systemPrompt.includes('Vote independently on the motion to recall')) {
        value = { choice: 'recall' };
      } else {
        value = { choice: 'approve', recallGround: 'lost-confidence', recallReason: 'The delegate withheld the plan record.' };
      }
      opts.validate(value);
      return dispatchResult(value);
    });
    const ctx = makeContext({ dispatcher: { dispatch } as unknown as WorkerDispatcher });
    (ctx.config as Record<string, unknown>).councils = { requirePlanRatification: true, memberBallots: true };

    await strategy.plan(ctx, { ...ctx.runState.task, repoPath, baseBranch: 'main' });

    const state = ctx.strategyState as { councils: Record<string, { delegate: string }>;
      councilMandateIds: Record<string, string> };
    const recall = ctx.ledger.readAll().find((entry) => entry.type === 'delegate_recalled');
    expect(recall?.data).toMatchObject({ ground: 'lost-confidence' });
    expect(state.councils.n1.delegate).toBe(recall?.data.incoming);
    const mandate = ctx.runState.governanceMandates?.find((entry) => entry.id === state.councilMandateIds.n1);
    expect(mandate?.holder).toBe(recall?.data.incoming);
    expect(ctx.runState.governanceDecisions?.some((entry) =>
      entry.rule === 'member-initiated-absolute-majority-recall-v1' && entry.result === 'recalled')).toBe(true);
  });

  it('stops a rejected council plan before any work is dispatched', async () => {
    const strategy = new SocialistStrategy();
    const dispatcher = makeRoutedDispatcher({
      'council-test-mandate': { items: [] },
      'planner-1': { nodes: [{ id: 'n1', title: 'Add route', description: 'Build route', targetGlobs: ['server/route.ts'] }] },
    }, { choice: 'reject', amendment: 'The interface breaks existing callers.' });
    const ctx = makeContext({ dispatcher });
    (ctx.config as Record<string, unknown>).councils = { requirePlanRatification: true };

    await expect(strategy.plan(ctx, { ...ctx.runState.task, repoPath, baseBranch: 'main' }))
      .rejects.toThrow(GovernanceHaltError);
    expect(ctx.runState.governanceMandates?.some((mandate) => mandate.scope.includes('n1'))).toBe(false);
  });

  // socialist pure r2, 2026-10-04: a council asked three times to remove a contradictory
  // "clamped" criterion. The revision prompt only offered scope and ordering repairs, the planner
  // left the criterion in place, and the amendment was appended beside it as a new criterion.
  it('revises the criterion a council objects to, and refuses a revision that leaves its task unchanged', async () => {
    const strategy = new SocialistStrategy();
    const node = { id: 'damage', title: 'Damage', description: 'Compute damage', targetGlobs: ['app/damage.py'],
      dependsOn: [], acceptanceCriteria: ['Requested energies are clamped to the data range', 'Out-of-range energies raise an error'] };
    const fixed = { ...node, acceptanceCriteria: ['Out-of-range energies raise an error'] };
    const docs = { id: 'docs', title: 'Docs', description: 'Write README', targetGlobs: ['README.md'], dependsOn: [],
      acceptanceCriteria: ['README documents the CLI'] };
    const docsEdited = { ...docs, description: 'Write README and usage' };
    let plannerCalls = 0;
    let unchangedRefusal = '';
    let revisionPrompt = '';
    const dispatch = vi.fn(async (options: DispatchOptions) => {
      let value: unknown;
      if (options.personaId === 'council-test-mandate') value = { items: [] };
      else if (options.personaId === 'planner-1') {
        plannerCalls += 1;
        if (plannerCalls === 2) {
          revisionPrompt = options.systemPrompt;
          // Changes a different task but not the one its council objected to.
          try { options.validate({ nodes: [node, docsEdited] }); } catch (error) { unchangedRefusal = String(error); }
        }
        value = { nodes: plannerCalls === 1 ? [node, docs] : [fixed, docs] };
      } else if (options.role === 'reviewer' && options.phase === 'institutional') {
        const task = (JSON.parse(options.userPrompt) as { task?: { id?: string } }).task;
        value = plannerCalls === 1 && task?.id === 'damage'
          ? { choice: 'amend', amendment: 'Remove the clamped criterion; it contradicts the error criterion.' }
          : { choice: 'approve' };
      } else value = {};
      options.validate(value);
      return dispatchResult(value);
    });
    const ctx = makeContext({ dispatcher: { dispatch } as unknown as WorkerDispatcher });
    (ctx.config as Record<string, unknown>).councils = { requirePlanRatification: true, memberBallots: true };

    const plan = await strategy.plan(ctx, { ...ctx.runState.task, repoPath, baseBranch: 'main' });

    expect(plan.nodes.damage.acceptanceCriteria).toEqual(['Out-of-range energies raise an error']);
    expect(revisionPrompt).toContain('rewrite or remove its acceptanceCriteria');
    expect(unchangedRefusal).toContain('unchanged');
    expect(unchangedRefusal).toContain('damage');
    expect(ctx.ledger.readAll().some((entry) => entry.type === 'plan_amended_by_council')).toBe(true);
  });

  it('lets a scope objection revise ownership before the councils ratify a new version', async () => {
    const strategy = new SocialistStrategy();
    const initial = { nodes: [
      { id: 'cli', title: 'CLI', description: 'Implement CLI', targetGlobs: ['app/cli.py'],
        dependsOn: [], acceptanceCriteria: ['Run using examples/304L.yaml'] },
      { id: 'docs', title: 'Docs', description: 'Document CLI', targetGlobs: ['README.md', 'examples/304L.yaml'],
        dependsOn: ['cli'], acceptanceCriteria: ['Document example'] },
    ] };
    const revised = { nodes: [
      { ...initial.nodes[0], targetGlobs: ['app/cli.py', 'examples/304L.yaml'] },
      { ...initial.nodes[1], targetGlobs: ['README.md'] },
    ] };
    let plannerCalls = 0;
    const dispatch = vi.fn(async (options: DispatchOptions) => {
      let value: unknown;
      if (options.personaId === 'council-test-mandate') value = { items: [] };
      else if (options.personaId === 'planner-1') value = ++plannerCalls === 1 ? initial : revised;
      else if (options.role === 'reviewer' && options.phase === 'institutional') {
        const task = (JSON.parse(options.userPrompt) as { task?: { id?: string } }).task;
        value = task?.id === 'cli' && plannerCalls === 1
          ? { choice: 'amend', amendment: 'Move examples/304L.yaml into the CLI work scope.' }
          : { choice: 'approve' };
      } else value = {};
      options.validate(value);
      return dispatchResult(value);
    });
    const ctx = makeContext({ dispatcher: { dispatch } as unknown as WorkerDispatcher });
    (ctx.config as Record<string, unknown>).councils = { requirePlanRatification: true, memberBallots: true };

    const plan = await strategy.plan(ctx, { ...ctx.runState.task, repoPath, baseBranch: 'main' });

    expect(plannerCalls).toBe(2);
    expect(plan.nodes.cli.targetGlobs).toContain('examples/304L.yaml');
    expect(plan.nodes.docs.targetGlobs).not.toContain('examples/304L.yaml');
    expect(ctx.runState.governanceDecisions?.filter((decision) => decision.subject === 'cli')
      .map((decision) => decision.result)).toEqual(['amend', 'approve']);
    expect(dispatch.mock.calls.find(([options]) => options.systemPrompt.includes('councils have withheld'))?.[0])
      .toEqual(expect.objectContaining({ reasoningEffort: 'low', repositoryTools: false }));
    expect(ctx.ledger.readAll().some((entry) => entry.type === 'plan_revision_proposed')).toBe(true);
  });

  // socialist-musgr8is: the scaffold council's first objection (test files) was met, and its second,
  // different one (__main__.py needs a later mandate's cli.py) ended the run because round two was
  // the last. A new objection gets another revision; only a repeated one stands.
  it('revises again for a new objection, and stops only when an objection is repeated', async () => {
    const strategy = new SocialistStrategy();
    const plan = (version: number) => ({ nodes: [{ id: 'n1', title: 'Add route', description: 'Build route',
      targetGlobs: ['server/route.ts'], dependsOn: [], acceptanceCriteria: [`The route answers (v${version})`] }] });
    const objectionsByRound = [
      'Remove tests/test_route.py from targetGlobs; the test mandate owns it.',
      'Drop the criterion that python -m server runs, since cli.py belongs to a later mandate.',
    ];
    let plannerCalls = 0;
    const dispatch = vi.fn(async (options: DispatchOptions) => {
      let value: unknown;
      if (options.personaId === 'council-test-mandate') value = { items: [] };
      else if (options.personaId === 'planner-1') { plannerCalls += 1; value = plan(plannerCalls); }
      else if (options.role === 'reviewer' && options.phase === 'institutional') {
        const objection = objectionsByRound[plannerCalls - 1];
        value = objection ? { choice: 'amend', amendment: objection } : { choice: 'approve' };
      } else value = {};
      options.validate(value);
      return dispatchResult(value);
    });
    const ctx = makeContext({ dispatcher: { dispatch } as unknown as WorkerDispatcher });
    (ctx.config as Record<string, unknown>).councils = { requirePlanRatification: true, memberBallots: true };

    await strategy.plan(ctx, { ...ctx.runState.task, repoPath, baseBranch: 'main' });

    expect(plannerCalls).toBe(3);
    expect(ctx.runState.governanceDecisions?.filter((decision) => decision.subject === 'n1')
      .map((decision) => decision.result)).toEqual(['amend', 'amend', 'approve']);
  });

  it('treats a reworded objection as the same one, and a different ask as new', () => {
    const asked = 'Amend targetGlobs to remove tests/test_route.py; the test-suite mandate owns tests/.';
    expect(sameObjection(asked, 'Please drop tests/test_route.py from targetGlobs: the test-suite mandate owns tests/.')).toBe(true);
    expect(sameObjection(asked, 'Drop the criterion that python -m server runs, since cli.py belongs to a later mandate.')).toBe(false);
  });

  // Section 6: "Such a return is useful planning information, not insubordination."
  it('offers returned work to the next council member rather than pressing the same one', async () => {
    const strategy = new SocialistStrategy();
    const work: ImplementerResponse = {
      fileOps: [{ op: 'write', path: 'server/api/profile.ts', content: 'export const profile = true;\n' }],
      rationale: 'Implemented.',
      filesChanged: ['server/api/profile.ts'],
      unresolvedUncertainty: 'none',
    };
    const dispatcher = makeRoutedDispatcher({
      'backend-1': { fileOps: [], rationale: 'Cannot take this.', filesChanged: [], unresolvedUncertainty: 'none',
        assignmentReturn: { returned: true, reason: 'No acceptance criteria were given for this node.' } },
      'backend-2': work,
    });
    const strategyState: Record<string, unknown> = {
      assignments: { task1: { assigneeId: 'backend-1', leadGuild: 'backend', allGuilds: ['backend'], coordinated: false } },
      capability: { backend: { 'backend-1': 0.9, 'backend-2': 0.4 } },
    };
    const ctx = makeContext({ dispatcher, strategyState });

    const result = await strategy.execute(ctx, { taskId: 'task1', assigneeId: 'backend-1', role: 'implementer' });

    expect(result.assignment.assigneeId).toBe('backend-2');
    expect(result.fileOps).toHaveLength(1);
    expect(ctx.ledger.readAll().find((e) => e.type === 'assignment_returned')?.data).toMatchObject({
      workerId: 'backend-1',
      reallocatedTo: 'backend-2',
    });
    // The work still lands, so this is not a planning defect.
    expect((ctx.strategyState as unknown as SocialistState).planningDefects).toEqual([]);
  });

  // Article 11: blame may not substitute for diagnosis. Charging the last worker offered the node
  // would be exactly that.
  it('calls a node the whole council returned a planning defect, not a worker failure', async () => {
    const strategy = new SocialistStrategy();
    const handBack = {
      fileOps: [],
      rationale: 'Cannot take this.',
      filesChanged: [],
      unresolvedUncertainty: 'none',
      assignmentReturn: { returned: true, reason: 'This node conflicts with another change in flight.' },
    };
    const dispatcher = makeRoutedDispatcher({}, handBack);
    const strategyState: Record<string, unknown> = {
      assignments: { task1: { assigneeId: 'backend-1', leadGuild: 'backend', allGuilds: ['backend'], coordinated: false } },
    };
    const ctx = makeContext({ dispatcher, strategyState });

    const result = await strategy.execute(ctx, { taskId: 'task1', assigneeId: 'backend-1', role: 'implementer' });
    const state = ctx.strategyState as unknown as SocialistState;

    expect(state.planningDefects).toEqual(['task1']);
    expect(result.unresolvedUncertainty).toContain('conflicts with another change');

    // And the capability score of whoever held it last is left exactly where it was.
    const before = { ...(state.capability.backend ?? {}) };
    await strategy.recordOutcome(ctx, { taskId: 'task1', outcome: 'rejected', rationale: 'r', evidenceRefs: [], meta: { baseApproved: false } }, failingTest);
    expect(state.capability.backend).toEqual(before);
    expect(ctx.ledger.readAll().some((e) => e.type === 'capability_updated')).toBe(false);
  });

  it('measures what the work needs before deciding who gets it, and never reads the worker', async () => {
    const strategy = new SocialistStrategy();
    const taskGraph = graph('high');
    taskGraph.nodes.task1.targetGlobs = ['server/api/profile.ts', 'tests/profile.test.ts'];
    taskGraph.nodes.task1.title = 'Add API profile endpoint';
    taskGraph.nodes.task1.description = 'Implement the backend route with unit tests';
    const ctx = makeContext({ taskGraph, strategyState: { capability: { backend: { 'backend-1': 0.9, 'backend-2': 0.1 } } } });

    await strategy.assign(ctx, taskGraph);
    const entries = ctx.ledger.readAll();

    const needs = entries.find((e) => e.type === 'needs_assessed');
    expect(needs?.data).toMatchObject({ taskId: 'task1', riskClass: 'high' });
    expect(Number(needs?.data.lessonBudget)).toBeGreaterThan(3);

    // Recorded before the assignment, so the resourcing cannot have been fitted to whoever won it.
    expect(entries.findIndex((e) => e.type === 'needs_assessed')).toBeLessThan(
      entries.findIndex((e) => e.type === 'guild_assigned'),
    );
  });

  it('records that a single council kept its own work', async () => {
    const strategy = new SocialistStrategy();
    const local = graph();
    local.nodes.task1.title = 'Add API profile endpoint';
    local.nodes.task1.description = 'Implement the backend route with unit tests';
    local.nodes.task1.targetGlobs = ['server/api/profile.ts'];
    const ctx = makeContext({ taskGraph: local });

    await strategy.assign(ctx, local);

    expect(ctx.ledger.readAll().find((e) => e.type === 'subsidiarity_applied')?.data).toMatchObject({
      decidedBy: 'council',
      escalated: false,
    });
  });

  it('records that a node spanning councils went to the coordinating council', async () => {
    const strategy = new SocialistStrategy();
    const ctx = makeContext({
      taskGraph: dependentGraph(),
      dispatcher: makeDispatcher({ leadGuild: 'frontend', assigneeId: 'frontend-2', rationale: 'UI leads.', subject: 'interface' }),
    });

    await strategy.assign(ctx, ctx.runState.graph!);

    expect(ctx.ledger.readAll().find((e) => e.type === 'subsidiarity_applied')?.data).toMatchObject({
      decidedBy: 'coordinating-council',
      escalated: true,
    });
  });

  // The gap this closes: no strategy in the repo had ever called ctx.addFinding, so
  // DeliveryPacket.minorityReports was structurally always empty.
  it('carries an objection the council overruled into the delivery as a minority report', async () => {
    const strategy = new SocialistStrategy();
    const ctx = makeContext({ strategyState: { assignments: { task1: { assigneeId: 'backend-1', leadGuild: 'backend', allGuilds: ['backend'], coordinated: false } } } });
    const flagged: ReviewResult = {
      taskId: 'task1',
      findings: [{ reviewerId: 'backend-2', verdict: 'flag', rationale: 'The error path is untested.', evidenceRefs: ['profile.ts'] }],
      testResult: passingTest,
    };

    // An outright approval records nothing: there was no objection to preserve.
    const approving: ReviewResult = { ...flagged, findings: [{ ...flagged.findings[0], verdict: 'approve' }] };
    await strategy.decide(ctx, product(), approving);
    expect(ctx.addFinding).not.toHaveBeenCalled();

    // A flag with passing tests: the council proceeds, and the objection survives that.
    const decision = await strategy.decide(ctx, product(), flagged);
    expect(decision.outcome).toBe('approved');
    expect(ctx.addFinding).toHaveBeenCalledWith(
      expect.objectContaining({ minority: true, source: 'backend-2', taskId: 'task1' }),
    );
  });

  // Section 7 stage 7: reviewers distinguish blocking correctness problems from optional
  // improvements. Treating the two alike made a preserved objection impossible.
  it('lets a flag record dissent without blocking, while a reject still blocks', async () => {
    const strategy = new SocialistStrategy();
    const ctx = makeContext();
    const withVerdict = (verdict: 'approve' | 'reject' | 'flag'): ReviewResult => ({
      taskId: 'task1',
      findings: [{ reviewerId: 'backend-2', verdict, rationale: 'r', evidenceRefs: [] }],
      testResult: passingTest,
    });

    expect((await strategy.decide(ctx, product(), withVerdict('flag'))).outcome).toBe('approved');
    expect((await strategy.decide(ctx, product(), withVerdict('reject'))).outcome).toBe('rework');
  });

  // Section 9 rule 10: "a failed material test reopens the work." Evidence is not subject to the
  // blocking/non-blocking distinction the way a reviewer's opinion is.
  it('still blocks a flag over failing tests', async () => {
    const strategy = new SocialistStrategy();
    const ctx = makeContext();
    const overFailure: ReviewResult = {
      taskId: 'task1',
      findings: [{ reviewerId: 'backend-2', verdict: 'flag', rationale: 'Minor.', evidenceRefs: [] }],
      testResult: failingTest,
    };

    expect((await strategy.decide(ctx, product(), overFailure)).outcome).toBe('rework');
  });

  it('summons mutual aid for a blocked worker, and publishes it to the commons', async () => {
    const strategy = new SocialistStrategy();
    const aid = {
      context: 'The test runner needs NODE_ENV=test.',
      fixture: 'NODE_ENV=test npm test -- profile',
      priorAttempts: 'Running npm test bare.',
    };
    const dispatcher = makeRoutedDispatcher({ 'mutual-aid': aid });
    const ctx = makeContext({
      dispatcher,
      taskGraph: graph(),
      strategyState: {
        assignments: { task1: { assigneeId: 'backend-1', leadGuild: 'backend', allGuilds: ['backend'], coordinated: false } },
        needs: { task1: { taskId: 'task1', difficulty: 0.8, riskClass: 'high', lessonBudget: 6, aidEligible: true, rationale: 'r' } },
      },
    });
    const rejected: ReviewResult = {
      taskId: 'task1',
      findings: [{ reviewerId: 'backend-2', verdict: 'reject', rationale: 'Tests do not run.', evidenceRefs: [] }],
      testResult: failingTest,
    };

    const blocked = await strategy.decide(ctx, product(), rejected);
    await strategy.recover(ctx, recoveryRequest(blocked, rejected));
    const entries = ctx.ledger.readAll();

    expect(entries.find((e) => e.type === 'mutual_aid_supplied')?.data).toMatchObject({
      requesterId: 'backend-1',
      aiderId: 'mutual-aid',
      kind: 'repeated-rejection',
    });
    // Article 7: aid is written back, not handed over privately.
    expect(entries.some((e) => e.type === 'commons_contribution')).toBe(true);
    expect(ctx.knowledge.queryByTags(['mutual-aid'], 5)[0]?.content).toContain('NODE_ENV=test npm test -- profile');

    // And it reaches the next worker, rather than being a report filed about the blockage.
    const implementer = makeRoutedDispatcher({
      'backend-1': { fileOps: [{ op: 'write', path: 'a.ts', content: 'x' }], rationale: 'r', filesChanged: ['a.ts'], unresolvedUncertainty: 'none' },
    });
    const retry = { ...ctx, dispatcher: implementer };
    await strategy.execute(retry, { taskId: 'task1', assigneeId: 'backend-1', role: 'implementer' });
    const prompt = (implementer.dispatch as unknown as { mock: { calls: [DispatchOptions][] } }).mock.calls[0][0].userPrompt;
    expect(prompt).toContain('NODE_ENV=test npm test -- profile');
    // The rejected attempt itself reaches the worker through the engine's repair brief, rendered at
    // the dispatcher for every doctrine; the strategy no longer replays it alongside.
    expect(prompt).not.toContain('previous proposal was rejected');
    expect(prompt).not.toContain('export const profile = true');

    // Under a revised plan the draft no longer describes the work, and the worker is told so, with
    // what that rejection required.
    ctx.runState.graph!.nodes.task1.description = 'A newly ratified, different task scope';
    await strategy.execute(retry, { taskId: 'task1', assigneeId: 'backend-1', role: 'implementer' });
    const changedScopePrompt = (implementer.dispatch as unknown as { mock: { calls: [DispatchOptions][] } }).mock.calls[1][0].userPrompt;
    expect(changedScopePrompt).toContain('rejected before the plan was revised');
    expect(changedScopePrompt).toContain('Tests do not run.');
  });

  it('does not spend a second dispatch restating aid the commons already holds', async () => {
    const strategy = new SocialistStrategy();
    const dispatcher = makeRoutedDispatcher({ 'mutual-aid': { context: 'c', fixture: 'f', priorAttempts: 'p' } });
    const ctx = makeContext({
      dispatcher,
      taskGraph: graph(),
      strategyState: {
        assignments: { task1: { assigneeId: 'backend-1', leadGuild: 'backend', allGuilds: ['backend'], coordinated: false } },
        needs: { task1: { taskId: 'task1', difficulty: 0.8, riskClass: 'high', lessonBudget: 6, aidEligible: true, rationale: 'r' } },
      },
    });
    const rejected: ReviewResult = {
      taskId: 'task1',
      findings: [{ reviewerId: 'backend-2', verdict: 'reject', rationale: 'No.', evidenceRefs: [] }],
      testResult: failingTest,
    };

    const first = await strategy.decide(ctx, product(), rejected);
    await strategy.recover(ctx, recoveryRequest(first, rejected));
    const second = await strategy.decide(ctx, product(), rejected);
    await strategy.recover(ctx, recoveryRequest(second, rejected, { attemptNumber: 2, repeated: true }));

    const aidCalls = (dispatcher.dispatch as unknown as { mock: { calls: [DispatchOptions][] } }).mock.calls.filter(
      (c) => c[0].personaId === 'mutual-aid',
    );
    expect(aidCalls).toHaveLength(1);
    expect(aidCalls[0]![0].repositoryTools).toBe(false);
  });

  it('proceeds without help when the mutual-aid worker cannot answer', async () => {
    const strategy = new SocialistStrategy();
    const dispatcher = makeRoutedDispatcher({ 'mutual-aid': new Error('model unavailable') });
    const ctx = makeContext({
      dispatcher,
      taskGraph: graph(),
      strategyState: {
        assignments: { task1: { assigneeId: 'backend-1', leadGuild: 'backend', allGuilds: ['backend'], coordinated: false } },
        needs: { task1: { taskId: 'task1', difficulty: 0.8, riskClass: 'high', lessonBudget: 6, aidEligible: true, rationale: 'r' } },
      },
    });
    const rejected: ReviewResult = {
      taskId: 'task1',
      findings: [{ reviewerId: 'backend-2', verdict: 'reject', rationale: 'No.', evidenceRefs: [] }],
      testResult: failingTest,
    };

    const decision = await strategy.decide(ctx, product(), rejected);
    await strategy.recover(ctx, recoveryRequest(decision, rejected));
    expect(decision.taskId).toBe('task1');
    expect(ctx.ledger.readAll().some((e) => e.type === 'mutual_aid_supplied')).toBe(false);
  });

  // Article 11: taking work away from a worker is the swarm asserting the worker was the problem,
  // and doing it without having established that is blame wearing a procedure's clothes.
  it('records a diagnosed cause with every reassignment', async () => {
    const strategy = new SocialistStrategy();
    const ctx = makeContext({
      strategyState: {
        assignments: { task1: { assigneeId: 'backend-1', leadGuild: 'backend', allGuilds: ['backend'], coordinated: false } },
      },
    });

    await strategy.remediate(ctx, {
      cycle: 2,
      findings: [{ id: 'f1', source: 'claude', summary: 'Still failing.', evidenceRefs: [], disposition: 'unresolved', dispositionRationale: 'r', affectedTaskIds: ['task1'] }],
      delivery: undefined,
    } as unknown as Parameters<typeof strategy.remediate>[1]);

    const state = ctx.strategyState as unknown as SocialistState;
    expect(state.reassignments).toHaveLength(1);
    expect(state.reassignments[0]).toMatchObject({ taskId: 'task1', from: 'backend-1' });
    expect(state.reassignments[0].cause).toBeTruthy();
    expect(blameWithoutDiagnosis(state.reassignments)).toEqual([]);
  });

  it('commissions an independent diagnosis only once the record stops explaining the failure', async () => {
    const strategy = new SocialistStrategy();
    const diagnosis = { cause: 'specification', remedy: 'Re-scope the node.', rationale: 'Two workers failed it identically.', confident: true };
    const dispatcher = makeRoutedDispatcher({ 'independent-diagnostician': diagnosis });
    const ctx = makeContext({
      dispatcher,
      strategyState: {
        assignments: { task1: { assigneeId: 'backend-1', leadGuild: 'backend', allGuilds: ['backend'], coordinated: false } },
      },
    });
    // The engine's baseline shows the checks ran, so 'infrastructure' is ruled out and the
    // deterministic pass falls through to its residual answer.
    ctx.runState.baseline = [{ categoryId: 'unit', command: 'npm', args: ['test'], ran: true, passed: true }];

    await strategy.remediate(ctx, {
      cycle: 2,
      findings: [{ id: 'f1', source: 'claude', summary: 'Still failing.', evidence: 'E   AssertionError: profile.save returned None',
        severity: 'high', evidenceRefs: [], disposition: 'unresolved', dispositionRationale: 'r', affectedTaskIds: ['task1'] }],
      delivery: undefined,
    } as unknown as Parameters<typeof strategy.remediate>[1]);

    // The diagnostician reads what reopened the node, not only how many times it failed.
    const diagnosisCall = (dispatcher.dispatch as unknown as { mock: { calls: [DispatchOptions][] } }).mock.calls
      .find((call) => call[0].personaId === 'independent-diagnostician')![0];
    expect(diagnosisCall.userPrompt).toContain('E   AssertionError: profile.save returned None');
    expect(ctx.ledger.readAll().find((e) => e.type === 'independent_diagnosis')?.data).toMatchObject({
      taskId: 'task1',
      cause: 'specification',
      diagnostician: 'independent-diagnostician',
    });
    expect((ctx.strategyState as unknown as SocialistState).reassignments[0].cause).toBe('specification');
  });

  it('discloses a node that reached the retry limit rather than attempting it again', async () => {
    const strategy = new SocialistStrategy();
    const ctx = makeContext({
      strategyState: {
        assignments: { task1: { assigneeId: 'backend-1', leadGuild: 'backend', allGuilds: ['backend'], coordinated: false } },
      },
    });

    await strategy.remediate(ctx, {
      cycle: 3,
      findings: [{ id: 'f1', source: 'claude', summary: 'Still failing.', evidenceRefs: [], disposition: 'unresolved', dispositionRationale: 'r', affectedTaskIds: ['task1'] }],
      delivery: undefined,
    } as unknown as Parameters<typeof strategy.remediate>[1]);

    expect(ctx.addFinding).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'task1', disposition: 'unresolved', source: 'coordinating-council' }),
    );
  });

  // pytest's session header comes first and the failing assertion last, so a directive cut to the
  // first 240 characters with its newlines collapsed handed the reopened worker only the header.
  it('carries the end of a finding\'s check output, and the diagnosis, into the remediation directive', async () => {
    const strategy = new SocialistStrategy();
    const ctx = makeContext({
      strategyState: {
        assignments: { task1: { assigneeId: 'backend-1', leadGuild: 'backend', allGuilds: ['backend'], coordinated: false } },
      },
    });
    const evidence = `${'platform linux -- Python 3.12, pytest-8 collected 4 items\n'.repeat(10)}` +
      'E   AssertionError: profile.save returned None\n1 failed, 3 passed';

    await strategy.remediate(ctx, {
      cycle: 1,
      findings: [{ summary: 'Required final check unit failed.', evidence, severity: 'high', affectedTaskIds: ['task1'] }],
      delivery: undefined,
    } as unknown as Parameters<typeof strategy.remediate>[1]);

    const directive = ctx.runState.graph!.nodes.task1.remediationOf ?? '';
    expect(directive).toContain('E   AssertionError: profile.save returned None\n1 failed, 3 passed');
    // No baseline ran in this fixture, so the record itself establishes the cause.
    expect(directive).toContain('The checks did not run');
  });

  // A second cycle takes the node off its worker, which used to discard the diagnosis recover()
  // had prepared for whoever picked it up next.
  it('keeps a prepared recovery diagnosis when a second cycle reallocates the node', async () => {
    const strategy = new SocialistStrategy();
    const ctx = makeContext({
      strategyState: {
        assignments: { task1: {
          assigneeId: 'backend-2', leadGuild: 'backend', allGuilds: ['backend'], coordinated: false,
          recoveryReason: 'implementation: the save handler drops the null branch',
        } },
      },
    });

    await strategy.remediate(ctx, {
      cycle: 2,
      findings: [{ summary: 'Still failing.', severity: 'high', affectedTaskIds: ['task1'] }],
      delivery: undefined,
    } as unknown as Parameters<typeof strategy.remediate>[1]);

    expect((ctx.strategyState as unknown as SocialistState).assignments.task1).toBeUndefined();
    expect(ctx.runState.graph!.nodes.task1.remediationOf).toContain('the save handler drops the null branch');
  });

  // The engine rolls a rejected proposal back, so its draft is the only record of what the
  // reviewers asked for. A plan revision makes the draft's file operations unreliable, not its
  // required changes.
  it('still hands the implementer the required changes after the plan was revised', async () => {
    const response: ImplementerResponse = {
      fileOps: [{ op: 'write', path: 'server/api/profile.ts', content: 'export const profile = true;\n' }],
      rationale: 'r', filesChanged: ['server/api/profile.ts'], unresolvedUncertainty: 'none',
    };
    const dispatcher = makeDispatcher(response);
    const ctx = makeContext({
      dispatcher,
      strategyState: {
        assignments: { task1: { assigneeId: 'backend-1', leadGuild: 'backend', allGuilds: ['backend'], coordinated: false } },
        reworkDrafts: { task1: {
          planDigest: 'digest-of-the-plan-before-revision',
          requiredChanges: ['Make the failing check pass. E   AssertionError: profile.save returned None'],
          fileOps: [{ op: 'write', path: 'server/api/stale.ts', content: 'stale draft body\n' }],
        } },
      },
    });

    await new SocialistStrategy().execute(ctx, product().assignment);

    const prompt = (dispatcher.dispatch as unknown as { mock: { calls: [DispatchOptions][] } }).mock.calls[0][0].userPrompt;
    expect(prompt).toContain('E   AssertionError: profile.save returned None');
    expect(prompt).not.toContain('stale draft body');
  });

  // A draft is deleted only on approval. A node that ran out of attempts keeps it, and when
  // remediation reopens the node that draft must not be presented as the attempt just rejected.
  it('does not present an earlier attempt\'s draft as current once remediation reopens the node', async () => {
    const response: ImplementerResponse = {
      fileOps: [{ op: 'write', path: 'server/api/profile.ts', content: 'export const profile = true;\n' }],
      rationale: 'r', filesChanged: ['server/api/profile.ts'], unresolvedUncertainty: 'none',
    };
    const dispatcher = makeDispatcher(response);
    const ctx = makeContext({
      dispatcher,
      strategyState: {
        assignments: { task1: { assigneeId: 'backend-1', leadGuild: 'backend', allGuilds: ['backend'], coordinated: false } },
      },
    });
    const strategy = new SocialistStrategy();
    const failedReview = review('reject', failingTest);
    const failedDecision = await strategy.decide(ctx, product(), failedReview);
    (ctx.config as { mutualAid?: { enabled: boolean } }).mutualAid = { enabled: false };
    await strategy.recover(ctx, recoveryRequest(failedDecision, failedReview));

    await strategy.remediate(ctx, {
      cycle: 1,
      findings: [{ summary: 'External oracle check failed.', severity: 'high', affectedTaskIds: ['task1'] }],
      delivery: undefined,
    } as unknown as Parameters<typeof strategy.remediate>[1]);
    await strategy.execute(ctx, product().assignment);

    const calls = (dispatcher.dispatch as unknown as { mock: { calls: [DispatchOptions][] } }).mock.calls;
    const prompt = calls.filter((call) => call[0].role === 'implementer').at(-1)![0].userPrompt;
    expect(prompt).not.toContain('The previous proposal was rejected');
    expect(prompt).toContain('earlier attempt');
  });

  // Section 8: paths are declared before editing so the comparison at convergence has something to
  // compare against.
  it('hears a council\'s appeal when the work wrote outside its declared allocation', async () => {
    const strategy = new SocialistStrategy();
    const ctx = makeContext({
      strategyState: {
        assignments: { task1: { assigneeId: 'backend-1', leadGuild: 'backend', allGuilds: ['backend'], coordinated: false } },
        agreedScope: { task1: ['server/**/*.ts'] },
        touchedPaths: { task1: ['server/api/profile.ts', 'client/components/Login.tsx'] },
        councils: {
          task1: { id: 'council-task1', taskId: 'task1', guilds: ['backend'], members: ['backend-1', 'backend-2'], delegate: 'backend-1', termId: 1 },
        },
      },
    });

    await strategy.remediate(ctx, {
      cycle: 1,
      findings: [{ id: 'f1', source: 'claude', summary: 'Out of scope.', evidenceRefs: [], disposition: 'unresolved', dispositionRationale: 'r', affectedTaskIds: ['task1'] }],
      delivery: undefined,
    } as unknown as Parameters<typeof strategy.remediate>[1]);

    const appeal = ctx.ledger.readAll().find((e) => e.type === 'appeal_panel_convened');
    expect(appeal?.data).toMatchObject({ appellant: 'council-task1', granted: true });
    // Independence is structural: the panel simply cannot contain anyone with a stake.
    expect(appeal?.data.panel).not.toContain('backend-1');
    expect(appeal?.data.panel).not.toContain('backend-2');
  });

  it('does not convene a panel for a council with nothing to appeal', async () => {
    const strategy = new SocialistStrategy();
    const ctx = makeContext({
      strategyState: {
        assignments: { task1: { assigneeId: 'backend-1', leadGuild: 'backend', allGuilds: ['backend'], coordinated: false } },
        agreedScope: { task1: ['server/**/*.ts'] },
        touchedPaths: { task1: ['server/api/profile.ts'] },
        councils: {
          task1: { id: 'council-task1', taskId: 'task1', guilds: ['backend'], members: ['backend-1'], delegate: 'backend-1', termId: 1 },
        },
      },
    });

    await strategy.remediate(ctx, {
      cycle: 1,
      findings: [{ id: 'f1', source: 'claude', summary: 'Failing.', evidenceRefs: [], disposition: 'unresolved', dispositionRationale: 'r', affectedTaskIds: ['task1'] }],
      delivery: undefined,
    } as unknown as Parameters<typeof strategy.remediate>[1]);

    expect(ctx.ledger.readAll().some((e) => e.type === 'appeal_panel_convened')).toBe(false);
  });

  // The report is filed at the end of disposeFindings, not in accept(): assembleDelivery reads the
  // notes before accept() runs, so a report written there would disclose nothing at all.
  it('files the commons report where the delivery packet can still read it', async () => {
    const strategy = new SocialistStrategy();
    const dispatcher = makeRoutedDispatcher({
      'common-ledger': { dispositions: [{ id: 'f1', disposition: 'unresolved', rationale: 'Still open.' }] },
    });
    const ctx = makeContext({
      dispatcher,
      strategyState: {
        finalChecks: [{ categoryId: 'types', command: 'tsc', args: [], ran: false, passed: false, skippedReason: 'no tsconfig' }],
        contributions: ['lesson:backend+low+rejection'],
        failedTaskIds: ['task1'],
        publishedTaskIds: [],
        planningDefects: [],
        approvals: [{ taskId: 'task1', implementerId: 'backend-1', reviewerId: 'frontend-2' }],
        coordinating: { termId: 1, delegates: { 'council-task1': 'backend-1' }, convener: 'backend-1', seatedAt: 0 },
      },
    });

    await strategy.disposeFindings(ctx, [
      { id: 'f1', source: 'peer-verifier', summary: 'The retry path is untested.', evidenceRefs: [], disposition: 'unresolved', dispositionRationale: 'r' },
    ]);

    const state = ctx.strategyState as unknown as SocialistState;
    expect(state.deliveryNotes).toBeDefined();
    expect(state.deliveryNotes!.residualRisks.join(' ')).toContain('The retry path is untested.');
    expect(state.deliveryNotes!.limitations.join(' ')).toContain('no tsconfig');
    // Articles 2 and 7: a failure nobody wrote down is knowledge held privately.
    expect(state.deliveryNotes!.limitations.join(' ')).toContain('task1');
    expect(ctx.ledger.readAll().some((e) => e.type === 'commons_report')).toBe(true);
  });

  it('replaces the commons report on a second cycle rather than stacking it', async () => {
    const strategy = new SocialistStrategy();
    const dispatcher = makeRoutedDispatcher({ 'common-ledger': { dispositions: [] } });
    const ctx = makeContext({
      dispatcher,
      strategyState: {
        finalChecks: [{ categoryId: 'types', command: 'tsc', args: [], ran: false, passed: false, skippedReason: 'no tsconfig' }],
        approvals: [],
      },
    });

    await strategy.disposeFindings(ctx, [
      { id: 'f1', source: 'x', summary: 'A.', evidenceRefs: [], disposition: 'unresolved', dispositionRationale: 'r' },
    ]);
    const first = (ctx.strategyState as unknown as SocialistState).deliveryNotes!.limitations.length;
    await strategy.disposeFindings(ctx, [
      { id: 'f1', source: 'x', summary: 'A.', evidenceRefs: [], disposition: 'unresolved', dispositionRationale: 'r' },
    ]);
    expect((ctx.strategyState as unknown as SocialistState).deliveryNotes!.limitations).toHaveLength(first);
  });

  it('refuses acceptance when the constitution was breached, and says which article', async () => {
    const strategy = new SocialistStrategy();
    const ctx = makeContext({
      strategyState: {
        // The same persona implemented and reviewed: article 8.
        approvals: [{ taskId: 'task1', implementerId: 'backend-1', reviewerId: 'backend-1' }],
        reassignments: [{ taskId: 'task1', from: 'backend-1', to: 'backend-2' }],
        coordinating: { termId: 1, delegates: { 'council-task1': 'backend-1' }, convener: 'backend-1', seatedAt: 0 },
      },
    });

    const decision = await strategy.accept(ctx, cleanDraft());

    expect(decision.accepted).toBe(false);
    expect(decision.rationale).toContain('constitutional breach');
    const gate = ctx.ledger.readAll().find((e) => e.type === 'constitutional_gate');
    expect(gate?.data.accepted).toBe(false);
    // Article 8 (self-approval) and article 11 (a reassignment with no diagnosed cause).
    expect(String(gate?.data.breaches)).toContain('implementer + reviewer');
    expect(String(gate?.data.breaches)).toContain('article 11');
  });

  it('accepts a run whose record shows the constitution kept', async () => {
    const strategy = new SocialistStrategy();
    const ctx = makeContext({
      strategyState: {
        approvals: [{ taskId: 'task1', implementerId: 'backend-1', reviewerId: 'frontend-2' }],
        reassignments: [{ taskId: 'task1', from: 'backend-1', to: 'backend-2', cause: 'specification' }],
        coordinating: { termId: 1, delegates: { 'council-task1': 'backend-1' }, convener: 'backend-1', seatedAt: 0 },
      },
    });

    const decision = await strategy.accept(ctx, cleanDraft());

    expect(decision.accepted).toBe(true);
    expect(ctx.ledger.readAll().find((e) => e.type === 'constitutional_gate')?.data.accepted).toBe(true);
  });

  it('lets an affected work council withhold final consent on an otherwise passing delivery', async () => {
    const strategy = new SocialistStrategy();
    const ctx = makeContext({
      dispatcher: makeDispatcher({ choice: 'reject', reason: 'The security fixture is missing.' }),
      strategyState: {
        councils: { task1: { id: 'council-task1', taskId: 'task1', guilds: ['backend'],
          members: ['backend-1', 'backend-2'], delegate: 'backend-1', termId: 1 } },
      },
    });
    (ctx.config as Record<string, unknown>).councils = { requirePlanRatification: true };

    const result = await strategy.accept(ctx, cleanDraft());
    expect(result.accepted).toBe(false);
    expect(result.rationale).toContain('The security fixture is missing');
    expect(ctx.runState.governanceDecisions?.[0]).toMatchObject({ body: 'council-task1', result: 'reject' });
  });

  it('returns the exact council decisions authorizing a passing delivery', async () => {
    const strategy = new SocialistStrategy();
    const ctx = makeContext({
      dispatcher: makeDispatcher({ choice: 'approve', reason: 'Integrated checks passed.' }),
      strategyState: {
        councils: { task1: { id: 'council-task1', taskId: 'task1', guilds: ['backend'],
          members: ['backend-1', 'backend-2'], delegate: 'backend-1', termId: 1 } },
      },
    });
    (ctx.config as Record<string, unknown>).councils = { requirePlanRatification: true };
    const draft = cleanDraft();

    const result = await strategy.accept(ctx, draft);

    expect(result.accepted).toBe(true);
    expect(() => requireGovernanceAction(ctx.runState, result.authorityProof,
      deliveryGovernanceDigest(draft), 'accept-delivery', ['task1'])).not.toThrow();
  });

  it('requires an absolute majority of eligible workers for final council consent', async () => {
    const strategy = new SocialistStrategy();
    const dispatcher = makeRoutedDispatcher({
      'backend-1': { choice: 'approve', reason: 'Checks passed.' },
      'backend-2': { choice: 'reject', reason: 'The contract is incomplete.' },
    });
    const ctx = makeContext({
      dispatcher,
      strategyState: {
        councils: { task1: { id: 'council-task1', taskId: 'task1', guilds: ['backend'],
          members: ['backend-1', 'backend-2'], delegate: 'backend-1', termId: 1 } },
      },
    });
    (ctx.config as Record<string, unknown>).councils = { requirePlanRatification: true, memberBallots: true };

    const result = await strategy.accept(ctx, cleanDraft());

    expect(result.accepted).toBe(false);
    expect(ctx.runState.governanceDecisions?.[0]).toMatchObject({
      rule: 'member-council-majority-acceptance-v1', result: 'reject',
      eligible: ['backend-1', 'backend-2'],
    });
    const calls = vi.mocked(dispatcher.dispatch).mock.calls.map(([options]) => options);
    expect(calls.map((options) => options.institutionalReplayKey)).toEqual([
      expect.stringMatching(/^delivery-ballot:[a-f0-9]{64}:council-task1:1:backend-1$/),
      expect.stringMatching(/^delivery-ballot:[a-f0-9]{64}:council-task1:1:backend-2$/),
    ]);
    expect(calls.every((options) => options.reasoningEffort === 'low')).toBe(true);
  });

  // Section 6 lets a guild nominate on high-risk work. The nomination has to outrank the lead
  // guild, or the work's own guild answers for it anyway and the nomination decides nothing.
  it('lets the guild carrying the risk review high-risk work, over the guild that wrote it', async () => {
    const strategy = new SocialistStrategy();
    const taskGraph = graph('high');
    taskGraph.nodes.task1.title = 'Add authenticated profile endpoint';
    taskGraph.nodes.task1.description = 'Backend route behind auth';
    taskGraph.nodes.task1.targetGlobs = ['server/auth/profile.ts'];
    const dispatcher = makeDispatcher({ verdict: 'approve', rationale: 'Fine.', evidenceRefs: [] });
    const ctx = makeContext({
      dispatcher,
      taskGraph,
      strategyState: {
        assignments: { task1: { assigneeId: 'backend-1', leadGuild: 'backend', allGuilds: ['backend', 'security'], coordinated: false } },
      },
    });

    const result = await strategy.review(ctx, product(), passingTest);

    expect(result.meta?.reviewerGuild).toBe('security');
  });

  it('leaves ordinary work to any peer outside the authorship chain', async () => {
    const strategy = new SocialistStrategy();
    const dispatcher = makeDispatcher({ verdict: 'approve', rationale: 'Fine.', evidenceRefs: [] });
    const ctx = makeContext({
      dispatcher,
      taskGraph: graph('low'),
      strategyState: {
        assignments: { task1: { assigneeId: 'backend-1', leadGuild: 'backend', allGuilds: ['backend', 'security'], coordinated: false } },
      },
    });

    const result = await strategy.review(ctx, product(), passingTest);

    expect(result.meta?.reviewerGuild).toBe('backend');
    expect(result.findings[0].reviewerId).not.toBe('backend-1');
  });

  it('seats a worker council around every work unit, and a coordinating council from their delegates', async () => {
    const strategy = new SocialistStrategy();
    const dispatcher = makeDispatcher({
      nodes: [
        { id: 'n1', title: 'Add the API route', description: 'Backend endpoint', targetGlobs: ['server/api/x.ts'] },
        { id: 'n2', title: 'Add the form', description: 'Frontend component', targetGlobs: ['client/components/Form.tsx'] },
      ],
    });
    const ctx = makeContext({ dispatcher });

    // RunState.task deliberately carries only the goal and criteria — repoPath and baseBranch live
    // on the RunState itself — so plan() takes the full TaskSpec the engine assembles for it.
    await strategy.plan(ctx, { ...ctx.runState.task, repoPath, baseBranch: 'main' });
    const state = ctx.strategyState as unknown as SocialistState;

    expect(Object.keys(state.councils)).toEqual(['n1', 'n2']);
    expect(state.councils.n1.members).toContain(state.councils.n1.delegate);
    expect(state.coordinating!.delegates).toEqual({
      'council-n1': state.councils.n1.delegate,
      'council-n2': state.councils.n2.delegate,
    });
    // The chair is one of the delegates, not a separate office with its own authority.
    expect(Object.values(state.coordinating!.delegates)).toContain(state.coordinating!.convener);

    const seated = ctx.ledger.readAll().find((e) => e.type === 'councils_constituted');
    expect(seated?.data).toMatchObject({ termId: 1, method: 'lot' });
  });

  // Section 8: "the coordinating council owns ordering, not technical truth."
  it('returns a coordinating decision on technical truth to the council that owns it', async () => {
    const strategy = new SocialistStrategy();
    const dispatcher = makeDispatcher({
      leadGuild: 'frontend',
      assigneeId: 'frontend-1',
      rationale: 'React is the better fit.',
      subject: 'which-framework',
    });
    const strategyState = { capability: { frontend: { 'frontend-1': 0.2, 'frontend-2': 0.9 } } };
    const ctx = makeContext({ dispatcher, strategyState, taskGraph: dependentGraph() });

    const assignments = await strategy.assign(ctx, ctx.runState.graph!);

    // The council's own capability ordering decides, not the coordinator's name.
    expect(assignments[0].assigneeId).toBe('frontend-2');
    const breach = ctx.ledger.readAll().find((e) => e.type === 'mandate_breach');
    expect(breach?.data).toMatchObject({ article: 'article-5', decision: 'which-framework' });
  });

  it('does not let the convener arbitrate work onto itself', async () => {
    const strategy = new SocialistStrategy();
    const strategyState: Record<string, unknown> = {
      capability: { frontend: { 'frontend-1': 0.2, 'frontend-2': 0.9 } },
      coordinating: { termId: 1, delegates: { 'council-task1': 'frontend-1' }, convener: 'frontend-1', seatedAt: 0 },
    };
    const dispatcher = makeDispatcher({
      leadGuild: 'frontend',
      assigneeId: 'frontend-1',
      rationale: 'I will take it.',
      subject: 'interface',
    });
    const ctx = makeContext({ dispatcher, strategyState, taskGraph: dependentGraph() });

    const assignments = await strategy.assign(ctx, ctx.runState.graph!);

    expect(assignments[0].assigneeId).toBe('frontend-2');
    expect((ctx.strategyState as unknown as SocialistState).delegateMisallocations['frontend-1']).toBe(1);
  });

  it('recalls a delegate that keeps having its allocations taken back', async () => {
    const strategy = new SocialistStrategy();
    const strategyState: Record<string, unknown> = {
      completedTasks: 0,
      delegateMisallocations: { 'backend-1': 3 },
      councils: {
        task1: { id: 'council-task1', taskId: 'task1', guilds: ['backend'], members: ['backend-1', 'backend-2'], delegate: 'backend-1', termId: 1 },
      },
      coordinating: { termId: 1, delegates: { 'council-task1': 'backend-1' }, convener: 'backend-1', seatedAt: 0 },
    };
    const ctx = makeContext({ strategyState });

    await strategy.recordOutcome(ctx, decision('approved', true), passingTest);
    const state = ctx.strategyState as unknown as SocialistState;

    expect(state.councils.task1.delegate).toBe('backend-2');
    // A recalled delegate does not stay in the chair.
    expect(state.coordinating!.convener).toBe('backend-2');
    expect(ctx.ledger.readAll().find((e) => e.type === 'delegate_recalled')?.data).toMatchObject({
      outgoing: 'backend-1',
      ground: 'misallocated-work',
    });
  });

  // Article 5: coordination authority is temporary. A term that never ended would be the
  // permanent managerial layer section 14 warns about.
  it('rotates the chair when the coordinating council\'s term expires', async () => {
    const strategy = new SocialistStrategy();
    const strategyState: Record<string, unknown> = {
      completedTasks: 5,
      councils: {
        t1: { id: 'council-t1', taskId: 't1', guilds: ['backend'], members: ['backend-1'], delegate: 'backend-1', termId: 1 },
        t2: { id: 'council-t2', taskId: 't2', guilds: ['frontend'], members: ['frontend-1'], delegate: 'frontend-1', termId: 1 },
      },
      coordinating: { termId: 1, delegates: { 'council-t1': 'backend-1', 'council-t2': 'frontend-1' }, convener: 'backend-1', seatedAt: 0 },
    };
    const ctx = makeContext({ strategyState });

    await strategy.recordOutcome(ctx, decision('approved', true), passingTest);
    const state = ctx.strategyState as unknown as SocialistState;

    expect(state.completedTasks).toBe(6);
    expect(state.coordinating!.termId).toBe(2);
    expect(state.coordinating!.convener).toBe('frontend-1');
    expect(ctx.ledger.readAll().some((e) => e.type === 'rotation_recorded')).toBe(true);
  });

  it('uses coordinator arbitration when a task depends on another council', async () => {
    const strategy = new SocialistStrategy();
    const dispatcher = makeDispatcher({ leadGuild: 'frontend', assigneeId: 'frontend-2', rationale: 'UI owns the integration.', subject: 'interface' });
    const ctx = makeContext({ dispatcher, taskGraph: dependentGraph() });

    const assignments = await strategy.assign(ctx, ctx.runState.graph!);

    expect(assignments[0]).toMatchObject({ assigneeId: 'frontend-2', meta: { leadGuild: 'frontend', coordinated: true } });
    expect(dispatcher.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      role: 'generalist', personaId: 'coordinator', repositoryTools: false,
    }));
  });

  it('does not arbitrate a retry of the same node again until the plan or remediation changes it', async () => {
    const strategy = new SocialistStrategy();
    const dispatcher = makeDispatcher({ leadGuild: 'frontend', assigneeId: 'frontend-2', rationale: 'UI leads.', subject: 'interface' });
    const ctx = makeContext({ dispatcher, taskGraph: dependentGraph() });
    const coordinatorCalls = () => (dispatcher.dispatch as unknown as { mock: { calls: [DispatchOptions][] } }).mock.calls
      .filter((call) => call[0].personaId === 'coordinator').length;

    await strategy.assign(ctx, ctx.runState.graph!);
    const [retry] = await strategy.assign(ctx, ctx.runState.graph!);

    expect(coordinatorCalls()).toBe(1);
    expect(retry.meta).toMatchObject({ leadGuild: 'frontend', coordinated: true });
    expect(retry.assigneeId).toMatch(/^frontend-/);
    expect(ctx.ledger.readAll().filter((e) => e.type === 'guild_assigned').at(-1)?.data)
      .toMatchObject({ reusedArbitration: true });

    await strategy.remediate(ctx, {
      cycle: 1,
      findings: [{ summary: 'External oracle check failed.', severity: 'high', affectedTaskIds: ['task1'] }],
      delivery: undefined,
    } as unknown as Parameters<typeof strategy.remediate>[1]);
    await strategy.assign(ctx, ctx.runState.graph!);
    expect(coordinatorCalls()).toBe(2);

    ctx.runState.graph!.nodes.task1.description = 'A revised mandate';
    await strategy.assign(ctx, ctx.runState.graph!);
    expect(coordinatorCalls()).toBe(3);
  });

  it('shows the reviewer of a rework what the last round required', async () => {
    const dispatcher = makeDispatcher({ verdict: 'approve', rationale: 'The null branch is handled now.' });
    const ctx = makeContext({
      dispatcher,
      strategyState: {
        assignments: { task1: { assigneeId: 'backend-1', leadGuild: 'backend', allGuilds: ['backend'], coordinated: false } },
        reworkDrafts: { task1: { planDigest: 'any', requiredChanges: ["Address backend-2's objection: the save handler drops the null branch"] } },
      },
    });

    await new SocialistStrategy().review(ctx, product(), passingTest);

    const prompt = (dispatcher.dispatch as unknown as { mock: { calls: [DispatchOptions][] } }).mock.calls[0][0].userPrompt;
    expect(prompt).toContain('The previous attempt was returned with these required changes');
    expect(prompt).toContain('the save handler drops the null branch');
  });

  it('gives the mutual-aid worker the check evidence it must name a fixture from', async () => {
    const strategy = new SocialistStrategy();
    const dispatcher = makeRoutedDispatcher({ 'mutual-aid': { context: 'c', fixture: 'pytest -k save', priorAttempts: 'p' } });
    const ctx = makeContext({
      dispatcher,
      strategyState: {
        assignments: { task1: { assigneeId: 'backend-1', leadGuild: 'backend', allGuilds: ['backend'], coordinated: false } },
        needs: { task1: { taskId: 'task1', difficulty: 0.8, riskClass: 'low', lessonBudget: 6, aidEligible: true, rationale: 'r' } },
      },
    });
    const brief: RepairBrief = {
      attempt: 1, maxAttempts: 3, advisoryFailures: [], findings: [], reviewRequiredChanges: [],
      checks: [{ categoryId: 'unit', status: 'new', output: 'E   AssertionError: profile.save returned None' }],
      priorAttempt: '', history: [], repeatCount: 1,
    };
    const failedReview = review('reject', failingTest);
    const failedDecision = await strategy.decide(ctx, product(), failedReview);

    await strategy.recover(ctx, { ...recoveryRequest(failedDecision, failedReview), brief });

    const aidCall = (dispatcher.dispatch as unknown as { mock: { calls: [DispatchOptions][] } }).mock.calls
      .find((call) => call[0].personaId === 'mutual-aid')![0];
    expect(aidCall.userPrompt).toContain('E   AssertionError: profile.save returned None');
  });

  it('stops presenting aid once the node is approved, reopened, or the aid worker fails', async () => {
    const strategy = new SocialistStrategy();
    const staleAid = { context: 'old', fixture: 'npm test -- old', priorAttempts: 'old' };
    const withAid = (dispatcher?: WorkerDispatcher) => makeContext({
      dispatcher,
      strategyState: {
        assignments: { task1: { assigneeId: 'backend-1', leadGuild: 'backend', allGuilds: ['backend'], coordinated: false } },
        needs: { task1: { taskId: 'task1', difficulty: 0.8, riskClass: 'low', lessonBudget: 6, aidEligible: true, rationale: 'r' } },
        aid: { task1: staleAid },
      },
    });
    const aidOf = (ctx: EngineContext) => (ctx.strategyState as unknown as SocialistState).aid.task1;

    const approvedCtx = withAid();
    await strategy.decide(approvedCtx, product(), review('approve', passingTest));
    expect(aidOf(approvedCtx)).toBeUndefined();

    const reopenedCtx = withAid();
    await strategy.remediate(reopenedCtx, {
      cycle: 1,
      findings: [{ summary: 'External oracle check failed.', severity: 'high', affectedTaskIds: ['task1'] }],
      delivery: undefined,
    } as unknown as Parameters<typeof strategy.remediate>[1]);
    expect(aidOf(reopenedCtx)).toBeUndefined();

    const failedAidCtx = withAid(makeRoutedDispatcher({ 'mutual-aid': new Error('model unavailable') }));
    const failedReview = review('reject', failingTest);
    const failedDecision = await strategy.decide(failedAidCtx, product(), failedReview);
    await strategy.recover(failedAidCtx, recoveryRequest(failedDecision, failedReview, { attemptNumber: 2 }));
    expect(aidOf(failedAidCtx)).toBeUndefined();
  });

  it('does not pay for a recovery diagnosis when no one is left to hand the work to', async () => {
    const strategy = new SocialistStrategy();
    const dispatcher = makeRoutedDispatcher({
      'independent-diagnostician': { cause: 'implementation', remedy: 'r', rationale: 'r', confident: true },
    });
    const ctx = makeContext({
      dispatcher,
      strategyState: {
        assignments: { task1: {
          assigneeId: 'backend-1', leadGuild: 'backend', allGuilds: ['backend'], coordinated: false,
          recoveryReason: 'implementation: an earlier attempt dropped the null branch',
        } },
        // Both members of the backend guild have already held it.
        reassignments: [{ taskId: 'task1', from: 'backend-2', to: 'backend-1', cause: 'implementation: earlier' }],
      },
    });
    (ctx.config as { mutualAid?: { enabled: boolean } }).mutualAid = { enabled: false };
    (ctx.config as { recovery?: { failuresBeforeDiagnosis: number } }).recovery = { failuresBeforeDiagnosis: 1 };
    const failedReview = review('reject', failingTest);
    const failedDecision = await strategy.decide(ctx, product(), failedReview);

    await strategy.recover(ctx, recoveryRequest(failedDecision, failedReview));

    expect(dispatcher.dispatch).not.toHaveBeenCalled();
    expect((ctx.strategyState as unknown as SocialistState).assignments.task1.recoveryReason).toBeUndefined();
  });

  it('does not hand work to another worker on a diagnosis its diagnostician was unsure of', async () => {
    const strategy = new SocialistStrategy();
    const dispatcher = makeRoutedDispatcher({
      'independent-diagnostician': { cause: 'implementation', remedy: 'Reassign it.', rationale: 'Nothing else stands out.', confident: false },
    });
    const ctx = makeContext({
      dispatcher,
      strategyState: {
        assignments: { task1: { assigneeId: 'backend-1', leadGuild: 'backend', allGuilds: ['backend'], coordinated: false } },
      },
    });
    (ctx.config as { mutualAid?: { enabled: boolean } }).mutualAid = { enabled: false };
    (ctx.config as { recovery?: { failuresBeforeDiagnosis: number } }).recovery = { failuresBeforeDiagnosis: 1 };
    const failedReview = review('reject', failingTest);
    const failedDecision = await strategy.decide(ctx, product(), failedReview);

    await strategy.recover(ctx, recoveryRequest(failedDecision, failedReview));

    const state = ctx.strategyState as unknown as SocialistState;
    expect(state.assignments.task1.assigneeId).toBe('backend-1');
    expect(state.reassignments).toEqual([]);
    expect(ctx.ledger.readAll().find((e) => e.type === 'independent_diagnosis')?.data).toMatchObject({ confident: false });
  });

  it('runs the recovery diagnosis and mutual aid side by side', async () => {
    const strategy = new SocialistStrategy();
    const dispatcher = makeConcurrentDispatcher({
      'independent-diagnostician': { cause: 'implementation', remedy: 'r', rationale: 'The save branch is wrong.', confident: true },
      'mutual-aid': { context: 'c', fixture: 'npm test -- profile', priorAttempts: 'p' },
    }, 2);
    const ctx = makeContext({
      dispatcher,
      strategyState: {
        assignments: { task1: { assigneeId: 'backend-1', leadGuild: 'backend', allGuilds: ['backend'], coordinated: false } },
        needs: { task1: { taskId: 'task1', difficulty: 0.8, riskClass: 'low', lessonBudget: 6, aidEligible: true, rationale: 'r' } },
      },
    });
    (ctx.config as { recovery?: { failuresBeforeDiagnosis: number } }).recovery = { failuresBeforeDiagnosis: 1 };
    const failedReview = review('reject', failingTest);
    const failedDecision = await strategy.decide(ctx, product(), failedReview);

    await strategy.recover(ctx, recoveryRequest(failedDecision, failedReview));

    const state = ctx.strategyState as unknown as SocialistState;
    expect(state.aid.task1?.fixture).toBe('npm test -- profile');
    expect(state.assignments.task1.recoveryReason).toContain('The save branch is wrong.');
  });

  it('diagnoses every reopened node together, each against its own evidence', async () => {
    const strategy = new SocialistStrategy();
    const taskGraph = graph();
    taskGraph.nodes.task2 = { ...taskGraph.nodes.task1, id: 'task2', title: 'Second unit', targetGlobs: ['server/api/other.ts'] };
    taskGraph.order = ['task1', 'task2'];
    const dispatcher = makeConcurrentDispatcher({
      'independent-diagnostician': { cause: 'specification', remedy: 'r', rationale: 'r', confident: true },
    }, 2);
    const ctx = makeContext({ dispatcher, taskGraph });
    ctx.runState.baseline = [{ categoryId: 'unit', command: 'npm', args: ['test'], ran: true, passed: true }];

    await strategy.remediate(ctx, {
      cycle: 2,
      findings: [
        { summary: 'First broke.', evidence: 'E   first-evidence', severity: 'high', affectedTaskIds: ['task1'] },
        { summary: 'Second broke.', evidence: 'E   second-evidence', severity: 'high', affectedTaskIds: ['task2'] },
      ],
      delivery: undefined,
    } as unknown as Parameters<typeof strategy.remediate>[1]);

    const prompts = (dispatcher.dispatch as unknown as { mock: { calls: [DispatchOptions][] } }).mock.calls
      .map((call) => call[0].userPrompt);
    expect(prompts).toHaveLength(2);
    expect(prompts.find((prompt) => prompt.includes('first-evidence'))).not.toContain('second-evidence');
    // Run one after another, the first diagnosis times out waiting and falls back to the record.
    expect(ctx.runState.graph!.nodes.task1.remediationOf).toContain('Diagnosed cause (specification)');
    expect(ctx.runState.graph!.nodes.task2.remediationOf).toContain('Diagnosed cause (specification)');
  });

  it('round-trips validated implementer output into a work product', async () => {
    const response: ImplementerResponse = {
      fileOps: [
        { op: 'write', path: 'server/api/profile.ts', content: 'export const profile = true;\n' },
        { op: 'edit', path: 'README.md', find: 'fixture', replace: 'profile fixture' },
        { op: 'delete', path: 'obsolete.txt' },
      ],
      rationale: 'Implemented and documented the profile endpoint.',
      filesChanged: ['server/api/profile.ts', 'README.md', 'obsolete.txt'],
      unresolvedUncertainty: 'The persistence adapter remains mocked.',
    };
    const dispatcher = makeDispatcher(response);
    const ctx = makeContext({
      dispatcher,
      strategyState: {
        assignments: { task1: { assigneeId: 'backend-1', leadGuild: 'backend', allGuilds: ['backend', 'testing'], coordinated: false } },
      },
    });

    const result = await new SocialistStrategy().execute(ctx, product().assignment);

    expect(result.fileOps).toEqual(response.fileOps);
    expect(result).toMatchObject({
      taskId: 'task1',
      rationale: response.rationale,
      unresolvedUncertainty: response.unresolvedUncertainty,
      meta: { filesChanged: response.filesChanged, model: 'fake-model', guilds: ['backend', 'testing'] },
    });
    expect(dispatcher.dispatch).toHaveBeenCalledWith(expect.objectContaining({ role: 'implementer', personaId: 'backend-1' }));
  });

  it('uses a different guild member to review validated implementer work', async () => {
    const response: ReviewerResponse = { verdict: 'approve', rationale: 'Implementation meets the criteria.', evidenceRefs: ['profile.ts:1'] };
    const dispatcher = makeDispatcher(response);
    const ctx = makeContext({
      dispatcher,
      strategyState: {
        assignments: { task1: { assigneeId: 'backend-1', leadGuild: 'backend', allGuilds: ['backend'], coordinated: false } },
      },
    });

    const result = await new SocialistStrategy().review(ctx, product(), passingTest);

    expect(result.findings).toEqual([{
      reviewerId: 'backend-2',
      verdict: 'approve',
      rationale: response.rationale,
      evidenceRefs: response.evidenceRefs,
    }]);
    expect(result.testResult).toBe(passingTest);
    expect(dispatcher.dispatch).toHaveBeenCalledWith(expect.objectContaining({ role: 'reviewer', personaId: 'backend-2' }));
  });

  // Every socialist arm on 2026-10-04 breached section 6 this way: backend-1 convened, allocated
  // the node to backend-2, and as the other backend member was handed the review.
  it('never hands the review to the coordinator who allocated the work', async () => {
    const response: ReviewerResponse = { verdict: 'approve', rationale: 'Meets the criteria.', evidenceRefs: ['profile.ts:1'] };
    const dispatcher = makeDispatcher(response);
    const ctx = makeContext({
      dispatcher,
      strategyState: {
        assignments: { task1: { assigneeId: 'backend-2', leadGuild: 'backend', allGuilds: ['backend'], coordinated: true } },
        coordinating: { termId: 1, delegates: { 'council-task1': 'backend-1' }, convener: 'backend-1', seatedAt: 0 },
      },
    });

    await new SocialistStrategy().review(ctx, product(), passingTest);

    const reviewer = (dispatcher.dispatch as ReturnType<typeof vi.fn>).mock.calls
      .map(([opts]) => opts).find((opts) => opts.role === 'reviewer')!.personaId;
    expect(reviewer).not.toBe('backend-1');
    expect(reviewer).not.toBe('backend-2');
    const state = ctx.strategyState as unknown as SocialistState;
    expect(state.approvals!.at(-1)).toMatchObject({ allocatedBy: 'backend-1', reviewerId: reviewer });
  });

  it('approves only when both peer review and tests pass', async () => {
    const strategy = new SocialistStrategy();
    const ctx = makeContext();

    const approved = await strategy.decide(ctx, product(), review('approve', passingTest));
    const failedReview = review('approve', failingTest);
    const failedTests = await strategy.decide(ctx, product(), failedReview);
    await strategy.recover(ctx, recoveryRequest(failedTests, failedReview));

    expect(approved).toMatchObject({ outcome: 'approved', meta: { baseApproved: true, rejectionCount: 0 } });
    expect(failedTests).toMatchObject({ outcome: 'rework', meta: { baseApproved: false, rejectionCount: 1 } });
    expect(ctx.knowledge.queryByTags(['rejection'])).toHaveLength(1);
  });

  it('rejects when tests pass but the peer reviewer rejects', async () => {
    const result = await new SocialistStrategy().decide(makeContext(), product(), review('reject', passingTest));

    expect(result).toMatchObject({ outcome: 'rework', evidenceRefs: ['profile.ts'], meta: { baseApproved: false, rejectionCount: 1 } });
  });

  it('returns concrete rework requirements while preserving both human escalation paths', async () => {
    const strategy = new SocialistStrategy();
    const ctx = makeContext();
    const failedCheck: TestResult = {
      ran: true,
      passed: false,
      command: 'npm test -- profile',
      output: '[unit]\nExpected 201, received 500',
      checks: [{ categoryId: 'unit', status: 'new', output: 'Expected 201, received 500' }],
    };
    const blockingReview: ReviewResult = {
      taskId: 'task1',
      findings: [{
        reviewerId: 'backend-2',
        verdict: 'reject',
        rationale: 'The save handler drops persistence errors.',
        evidenceRefs: ['server/api/profile.ts:20'],
      }],
      testResult: failedCheck,
    };

    const ordinary = await strategy.decide(ctx, product(), blockingReview);
    const repeated = await strategy.decide(ctx, product(), blockingReview);
    const highRisk = await strategy.decide(makeContext({ taskGraph: graph('high') }), product(), review('approve', passingTest));

    expect(ordinary).toMatchObject({
      outcome: 'rework',
      rework: {
        requiredChanges: [
          expect.stringContaining('The save handler drops persistence errors.'),
          'Failing check: unit (passed before this change)',
        ],
      },
    });
    // The output reaches the implementer once, in the engine's repair brief, not again in the
    // council's directive.
    expect(JSON.stringify(ordinary)).not.toContain('Expected 201, received 500');
    // Section 11: repeated rejection stays with the councils; only the safety case goes to the human.
    expect(repeated.outcome).toBe('rework');
    expect(highRisk.outcome).toBe('needs_human');
  });

  it('lists a flagged concern in the rework directive when failing tests send the work back', async () => {
    const flagged: ReviewResult = {
      taskId: 'task1',
      findings: [{ reviewerId: 'backend-2', verdict: 'flag', rationale: 'The handler swallows a store error.', evidenceRefs: [] }],
      testResult: failingTest,
    };

    const result = await new SocialistStrategy().decide(makeContext(), product(), flagged);

    expect(result).toMatchObject({
      outcome: 'rework',
      rework: { requiredChanges: [
        "Weigh backend-2's flagged concern: The handler swallows a store error.",
        'Make the failing check (npm test) pass.',
      ] },
    });
  });

  it('does not keep presenting an earlier reassignment diagnosis after a later failure', async () => {
    const strategy = new SocialistStrategy();
    const dispatcher = makeRoutedDispatcher({
      'mutual-aid': { context: 'c', fixture: 'npm test', priorAttempts: 'p' },
    });
    const ctx = makeContext({
      dispatcher,
      strategyState: {
        assignments: { task1: {
          assigneeId: 'backend-2', leadGuild: 'backend', allGuilds: ['backend'], coordinated: false,
          recoveryReason: 'implementation: an earlier attempt dropped the null branch',
        } },
        capability: { backend: { 'backend-1': 0.9, 'backend-2': 0.4 } },
        needs: { task1: { taskId: 'task1', difficulty: 0.8, riskClass: 'low', lessonBudget: 6, aidEligible: true, rationale: 'r' } },
      },
    });
    (ctx.config as { recovery?: { failuresBeforeDiagnosis: number } }).recovery = { failuresBeforeDiagnosis: 99 };
    const failedReview = review('reject', failingTest);
    const failedDecision = await strategy.decide(ctx, product(), failedReview);

    await strategy.recover(ctx, recoveryRequest(failedDecision, failedReview));

    const state = ctx.strategyState as unknown as SocialistState;
    expect(state.assignments.task1.recoveryReason).toBeUndefined();
  });

  it('diagnoses before preparing a different worker and carries the reason into the next prompt', async () => {
    const strategy = new SocialistStrategy();
    const diagnosis = {
      cause: 'implementation',
      remedy: 'Hand the node to another backend member with the failing assertion.',
      rationale: 'The check output isolates an incorrect save-handler branch.',
      confident: true,
    };
    const dispatcher = makeRoutedDispatcher({
      'independent-diagnostician': diagnosis,
      'mutual-aid': { context: 'The route uses an injected store.', fixture: 'npm test -- profile', priorAttempts: 'Ignored store errors.' },
      'backend-2': {
        fileOps: [{ op: 'write', path: 'server/api/profile.ts', content: 'export const profile = true;\n' }],
        rationale: 'Corrected the save handler.',
        filesChanged: ['server/api/profile.ts'],
        unresolvedUncertainty: 'none',
      },
    });
    const ctx = makeContext({
      dispatcher,
      strategyState: {
        assignments: { task1: { assigneeId: 'backend-1', leadGuild: 'backend', allGuilds: ['backend'], coordinated: false } },
        capability: { backend: { 'backend-1': 0.9, 'backend-2': 0.4 } },
        needs: { task1: { taskId: 'task1', difficulty: 0.8, riskClass: 'low', lessonBudget: 6, aidEligible: true, rationale: 'r' } },
      },
    });
    (ctx.config as { recovery?: { failuresBeforeDiagnosis: number } }).recovery = { failuresBeforeDiagnosis: 1 };
    const failedReview = review('reject', failingTest);
    const failedDecision = await strategy.decide(ctx, product(), failedReview);

    await strategy.recover(ctx, recoveryRequest(failedDecision, failedReview));

    const calls = (dispatcher.dispatch as unknown as { mock: { calls: [DispatchOptions][] } }).mock.calls;
    const diagnosisCall = calls.find((call) => call[0].personaId === 'independent-diagnostician')![0];
    const state = ctx.strategyState as unknown as SocialistState;
    expect(diagnosisCall.userPrompt).toContain('implementation — Nothing in the record distinguishes the causes');
    expect(diagnosisCall).toMatchObject({ reasoningEffort: 'low', timeoutMs: 60_000 });
    expect(state.assignments.task1).toMatchObject({
      assigneeId: 'backend-2',
      recoveryReason: expect.stringContaining('incorrect save-handler branch'),
    });
    expect(state.reassignments).toContainEqual(expect.objectContaining({
      taskId: 'task1',
      from: 'backend-1',
      to: 'backend-2',
      cause: expect.stringContaining('implementation'),
    }));

    const [assignment] = await strategy.assign(ctx, ctx.runState.graph!);
    await strategy.execute(ctx, assignment);
    const implementerCall = calls.find((call) => call[0].personaId === 'backend-2')![0];
    expect(implementerCall.userPrompt).toContain('incorrect save-handler branch');
  });

  it('refreshes aid and the commons lesson only for a materially different failure', async () => {
    const strategy = new SocialistStrategy();
    const dispatcher = makeRoutedDispatcher({
      'mutual-aid': { context: 'Inspect the route fixture.', fixture: 'npm test -- profile', priorAttempts: 'The previous patch.' },
    });
    const ctx = makeContext({
      dispatcher,
      strategyState: {
        assignments: { task1: { assigneeId: 'backend-1', leadGuild: 'backend', allGuilds: ['backend'], coordinated: false } },
        needs: { task1: { taskId: 'task1', difficulty: 0.8, riskClass: 'low', lessonBudget: 6, aidEligible: true, rationale: 'r' } },
      },
    });
    (ctx.config as { recovery?: { failuresBeforeDiagnosis: number } }).recovery = { failuresBeforeDiagnosis: 0 };
    const firstReview = review('reject', failingTest);
    const firstDecision = await strategy.decide(ctx, product(), firstReview);
    await strategy.recover(ctx, recoveryRequest(firstDecision, firstReview));

    const repeatedDecision = await strategy.decide(ctx, product(), firstReview);
    await strategy.recover(ctx, recoveryRequest(repeatedDecision, firstReview, { attemptNumber: 2, repeated: true }));

    const changedTest = { ...failingTest, output: 'A different assertion failed' };
    const changedReview = review('reject', changedTest);
    const changedDecision = await strategy.decide(ctx, product(), changedReview);
    await strategy.recover(ctx, recoveryRequest(changedDecision, changedReview, { attemptNumber: 3 }));

    const aidCalls = (dispatcher.dispatch as unknown as { mock: { calls: [DispatchOptions][] } }).mock.calls.filter(
      (call) => call[0].personaId === 'mutual-aid',
    );
    const lessonEntries = ctx.ledger.readAll().filter(
      (entry) => entry.type === 'commons_contribution' && entry.data.kind === 'lesson',
    );
    expect(aidCalls).toHaveLength(2);
    expect(lessonEntries).toHaveLength(2);
  });

  it('prepares recovery state without changing the engine-owned phase or attempt outcome', async () => {
    const strategy = new SocialistStrategy();
    const taskGraph = graph();
    taskGraph.nodes.task1.phase = 'running';
    taskGraph.nodes.task1.attempts = [{
      attempt: 1,
      outcome: 'rework',
      rationale: 'Recorded by the engine.',
      evidenceRefs: ['profile.ts'],
      assigneeId: 'backend-1',
      testsPassed: false,
      at: '2026-01-01T00:00:00.000Z',
      fingerprint: 'engine-owned',
      repeated: false,
    }];
    const ctx = makeContext({
      taskGraph,
      strategyState: {
        assignments: { task1: { assigneeId: 'backend-1', leadGuild: 'backend', allGuilds: ['backend'], coordinated: false } },
      },
    });
    (ctx.config as { mutualAid?: { enabled: boolean }; recovery?: { failuresBeforeDiagnosis: number } }).mutualAid = { enabled: false };
    (ctx.config as { recovery?: { failuresBeforeDiagnosis: number } }).recovery = { failuresBeforeDiagnosis: 0 };
    const failedReview = review('reject', failingTest);
    const failedDecision = await strategy.decide(ctx, product(), failedReview);
    const attemptsBefore = structuredClone(taskGraph.nodes.task1.attempts);

    await strategy.recover(ctx, recoveryRequest(failedDecision, failedReview));

    expect(taskGraph.nodes.task1.phase).toBe('running');
    expect(taskGraph.nodes.task1.attempts).toEqual(attemptsBefore);
  });

  it('scores a rework once and clears the node rejection count after eventual approval', async () => {
    const strategy = new SocialistStrategy();
    const ctx = makeContext({
      strategyState: {
        assignments: { task1: { assigneeId: 'backend-1', leadGuild: 'backend', allGuilds: ['backend'], coordinated: false } },
        capability: { backend: { 'backend-1': 0.5, 'backend-2': 0.5 } },
      },
    });
    (ctx.config as { mutualAid?: { enabled: boolean } }).mutualAid = { enabled: false };
    const failedReview = review('reject', failingTest);
    const failedDecision = await strategy.decide(ctx, product(), failedReview);
    await strategy.recordOutcome(ctx, failedDecision, failingTest);
    const state = ctx.strategyState as unknown as SocialistState;
    const countersAfterOutcome = {
      rejections: state.rejectionCounts.task1,
      plannerFailures: state.plannerFailureCount,
    };

    await strategy.recover(ctx, recoveryRequest(failedDecision, failedReview));

    expect(state.capability.backend['backend-1']).toBeCloseTo(0.45);
    expect({ rejections: state.rejectionCounts.task1, plannerFailures: state.plannerFailureCount }).toEqual(countersAfterOutcome);

    await strategy.decide(ctx, product(), review('approve', passingTest));
    expect(state.rejectionCounts.task1).toBe(0);
  });

  it('does not blame the planner for an undiagnosed review or test failure', async () => {
    const strategyState = { currentPlannerPersonaId: 'planner-1', plannerFailureCount: 0 };
    const ctx = makeContext({ strategyState });
    const strategy = new SocialistStrategy();

    await strategy.recordOutcome(ctx, decision('rejected', false), failingTest);
    await strategy.recordOutcome(ctx, decision('rejected', false), failingTest);
    expect(strategyState).toMatchObject({ currentPlannerPersonaId: 'planner-1', plannerFailureCount: 0 });

    await strategy.recordOutcome(ctx, decision('rejected', false), failingTest);

    expect(strategyState).toMatchObject({ currentPlannerPersonaId: 'planner-1', plannerFailureCount: 0 });
    expect(ctx.ledger.readAll().some((entry) => entry.type === 'planner_recall')).toBe(false);
  });

  it('recalls the planner and replans unfinished work after diagnosed specification failures', async () => {
    const strategyState = {
      currentPlannerPersonaId: 'planner-1', plannerFailureCount: 2, planningDefects: ['task1'],
    };
    const revised = graph().nodes.task1;
    const dispatcher = makeDispatcher({ nodes: [{
      id: 'task1', title: revised.title, description: 'Clarify the profile save flow',
      acceptanceCriteria: ['Save persists after reload'], targetGlobs: revised.targetGlobs,
    }] });
    const ctx = makeContext({ dispatcher, strategyState });
    ctx.runState.baseline = [{ categoryId: 'test', command: 'npm', args: ['test'], ran: true, passed: true }];

    await new SocialistStrategy().remediate(ctx, {
      cycle: 1,
      findings: [{ summary: 'Criteria unclear', affectedTaskIds: ['task1'] }],
    } as Parameters<SocialistStrategy['remediate']>[1]);

    expect(strategyState).toMatchObject({ currentPlannerPersonaId: 'planner-2', plannerFailureCount: 0 });
    expect(ctx.runState.graph!.nodes.task1.description).toBe('Clarify the profile save flow');
    expect(ctx.ledger.readAll().some((entry) => entry.type === 'planner_recall')).toBe(true);
  });

  it('returns a recalled planner\'s unauthorized path additions for correction', async () => {
    const original = graph().nodes.task1;
    const corrected = { nodes: [{
      id: 'task1', title: original.title, description: 'Clarified without changing ownership',
      acceptanceCriteria: ['Save persists after reload'], targetGlobs: [...original.targetGlobs],
    }] };
    const dispatcher = { dispatch: vi.fn(async (options: DispatchOptions) => {
      expect(() => options.validate({ nodes: [{ ...corrected.nodes[0],
        targetGlobs: [...original.targetGlobs, 'tmp-output.csv'] }] }))
        .toThrow(/agreed path scope/);
      options.validate(corrected);
      return dispatchResult(corrected);
    }) } as unknown as WorkerDispatcher;
    const ctx = makeContext({ dispatcher, strategyState: {
      currentPlannerPersonaId: 'planner-1', plannerFailureCount: 2, planningDefects: ['task1'],
    } });
    ctx.runState.baseline = [{ categoryId: 'test', command: 'npm', args: ['test'], ran: true, passed: true }];

    await new SocialistStrategy().remediate(ctx, {
      cycle: 1, findings: [{ summary: 'Criteria unclear', affectedTaskIds: ['task1'] }],
    } as Parameters<SocialistStrategy['remediate']>[1]);

    expect(ctx.runState.graph!.nodes.task1.targetGlobs).toEqual(original.targetGlobs);
    expect(ctx.runState.graph!.nodes.task1.description).toBe('Clarified without changing ownership');
  });

  it('an approved outcome clears prior planner failures without swapping planners', async () => {
    const strategyState = { currentPlannerPersonaId: 'planner-1', plannerFailureCount: 2 };
    const ctx = makeContext({ strategyState });

    await new SocialistStrategy().recordOutcome(ctx, decision('approved', true), passingTest);

    expect(strategyState).toMatchObject({ currentPlannerPersonaId: 'planner-1', plannerFailureCount: 0 });
  });

  it('does not swap planners below the configured failure threshold', async () => {
    const strategyState = { currentPlannerPersonaId: 'planner-2', plannerFailureCount: 1 };
    const ctx = makeContext({ strategyState });

    await new SocialistStrategy().recordOutcome(ctx, decision('rejected', false), failingTest);

    expect(strategyState).toMatchObject({ currentPlannerPersonaId: 'planner-2', plannerFailureCount: 1 });
  });

  it('requires human approval only for needs_human decisions', () => {
    const strategy = new SocialistStrategy();
    const ctx = makeContext();

    expect(strategy.requiresHumanApproval(ctx, decision('needs_human', false))).toBe(true);
    expect(strategy.requiresHumanApproval(ctx, decision('approved', true))).toBe(false);
    expect(strategy.requiresHumanApproval(ctx, decision('rejected', false))).toBe(false);
  });
});

describe('SocialistStrategy safety floor (section 10)', () => {
  it('marks what the integration council finds on non-waivable ground, and refuses delivery while it is open', async () => {
    const strategy = new SocialistStrategy();
    const ctx = makeContext({
      dispatcher: makeDispatcher({
        integrated: true,
        rationale: 'Assembled.',
        findings: [
          { summary: 'The login handler logs the session token.', evidence: 'app/login.py', severity: 'high' },
          { summary: 'This helper could be simpler.', evidence: 'app/util.py', severity: 'low' },
        ],
      }),
    });

    const result = await strategy.integrate(ctx, [], 'diff');

    expect(result.findings.map((f) => f.nonWaivable === true)).toEqual([true, false]);
    expect(result.findings[0]!.summary).toMatch(/^On non-waivable ground \(security, section 10\)/);
    expect(ctx.ledger.readAll().some((e) => e.type === 'safety_floor_applied')).toBe(true);

    const draft = cleanDraft();
    draft.findings = [{ ...result.findings[0]!, id: 'f-1', disposition: 'deferred', owner: 'x', returnCondition: 'later' }];
    const acceptance = await strategy.accept(ctx, draft);
    expect(acceptance.accepted).toBe(false);
  });
});
