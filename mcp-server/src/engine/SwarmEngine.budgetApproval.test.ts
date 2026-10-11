import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BudgetExceededError } from './BudgetGuard.js';
import { OpenRouterClient } from './OpenRouterClient.js';
import type { RunState } from './RunStore.js';
import { SwarmEngine, type EngineDeps } from './SwarmEngine.js';
import type { EngineContext, SwarmStrategy } from './SwarmStrategy.js';
import type {
  Assignment,
  Decision,
  ReviewResult,
  TaskGraph,
  TaskSpec,
  TestResult,
  WorkProduct,
} from './types.js';
import { recordAttempt } from './TaskGraph.js';
import { normalizeChecksConfig } from '../util/config.js';
import {
  stubAccept,
  stubDeclareOwnership,
  stubDisposeFindings,
  stubIntegrate,
  stubRemediate,
  stubVerifyDelivery,
} from './barrierStubs.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

class BudgetFailureStrategy implements SwarmStrategy {
  declareOwnership = stubDeclareOwnership;
  integrate = stubIntegrate;
  verifyDelivery = stubVerifyDelivery;
  disposeFindings = stubDisposeFindings;
  accept = stubAccept;
  remediate = stubRemediate;

  readonly id = 'noop' as const;
  assignCalls = 0;

  constructor(
    private readonly errorKind: BudgetExceededError['kind'],
    private readonly errorMessage: string,
  ) {}

  async plan(_ctx: EngineContext, _task: TaskSpec): Promise<TaskGraph> {
    return {
      nodes: {
        task: {
          id: 'task',
          title: 'Test task',
          description: 'Exercise budget handling',
          acceptanceCriteria: [],
          dependsOn: [],
          targetGlobs: [],
          riskTags: [],
          riskClass: 'low',
          phase: 'queued',
          attempts: [],
        },
      },
      order: ['task'],
    };
  }

  async assign(_ctx: EngineContext, graph: TaskGraph): Promise<Assignment[]> {
    this.assignCalls += 1;
    if (this.assignCalls === 1 || this.errorKind !== 'per_run') {
      throw new BudgetExceededError(this.errorMessage, this.errorKind);
    }
    recordAttempt(graph.nodes.task, {
      outcome: 'approved',
      rationale: 'budget test completes after resume',
      evidenceRefs: [],
      at: new Date().toISOString(),
      fingerprint: 'budget-resume',
      repeated: false,
    });
    graph.nodes.task.phase = 'settled';
    return [];
  }

  async execute(_ctx: EngineContext, _assignment: Assignment): Promise<WorkProduct> {
    throw new Error('Unexpected execute call');
  }

  async review(_ctx: EngineContext, _product: WorkProduct, _test: TestResult): Promise<ReviewResult> {
    throw new Error('Unexpected review call');
  }

  async decide(_ctx: EngineContext, _product: WorkProduct, _review: ReviewResult): Promise<Decision> {
    throw new Error('Unexpected decide call');
  }

  async recordOutcome(_ctx: EngineContext, _decision: Decision, _test: TestResult): Promise<void> {}

  requiresHumanApproval(_ctx: EngineContext, _decision: Decision): boolean {
    return false;
  }
}

function createEngine(strategy: SwarmStrategy): { engine: SwarmEngine; task: TaskSpec; runId: string } {
  const runsRootDir = mkdtempSync(path.join(tmpdir(), 'swarm-budget-approval-'));
  temporaryDirectories.push(runsRootDir);
  const deps: EngineDeps = {
    outageBackoffMs: () => 0,
    client: new OpenRouterClient('unused-test-key'),
    modelsConfig: { roles: {}, models: {} },
    configDir: runsRootDir,
    budgetConfig: {
      defaults: {
        perRunUsd: 1,
        perTaskUsd: 1,
        maxWorkerCalls: 1,
        maxWallClockMinutes: 1,
        maxTaskAttempts: 3,
        perCallTimeoutMs: 1_000,
        warnAtFractionOfPerRun: 0.8,
      },
      hardCeilingUsd: 10,
    },
    strategiesConfig: {},
    runsRootDir,
    checksConfig: normalizeChecksConfig({ command: 'true', args: [], timeoutMs: 1_000 }),
    strategies: {
      noop: strategy,
      democratic: strategy,
      socialist: strategy,
      capitalist: strategy,
      managerial: strategy,
      single_agent: strategy,
    },
  };
  const engine = new SwarmEngine(deps);
  const runId = 'budget-test-run';
  const task: TaskSpec = {
    goal: 'Test budget handling',
    acceptanceCriteria: [],
    repoPath: runsRootDir,
    baseBranch: 'main',
  };
  const now = new Date().toISOString();
  const state: RunState = {
    runId,
    strategy: 'noop',
    task: { goal: task.goal, acceptanceCriteria: task.acceptanceCriteria },
    repoPath: task.repoPath,
    baseBranch: task.baseBranch,
    worktreePath: path.join(runsRootDir, runId, 'worktree'),
    branch: `swarm/${runId}`,
    status: 'running',
    createdAt: now,
    updatedAt: now,
    budgetUsd: 1,
    costUsd: 1,
    tokensUsed: { prompt: 0, completion: 0 },
    workerCalls: 0,
    graph: null,
    pendingApprovals: [],
    strategyState: {},
  };
  engine.getRunStore().save(state);
  return { engine, task, runId };
}

async function runLoop(engine: SwarmEngine, runId: string, task: TaskSpec): Promise<void> {
  await (
    engine as unknown as {
      runLoop(id: string, taskSpec: TaskSpec, resuming?: boolean): Promise<void>;
    }
  ).runLoop(runId, task);
}

async function waitUntilNotPaused(engine: SwarmEngine, runId: string): Promise<RunState> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const state = engine.getRunStore().load(runId);
    if (state && state.status !== 'paused_budget') return state;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Run ${runId} remained paused_budget`);
}

describe('SwarmEngine budget approvals', () => {
  it('opens a raisable approval for a per-run budget failure and resumes after approval', async () => {
    const strategy = new BudgetFailureStrategy('per_run', 'Run reached its per-run budget.');
    const { engine, task, runId } = createEngine(strategy);

    await runLoop(engine, runId, task);

    const paused = engine.getRunStore().load(runId);
    expect(paused?.status).toBe('paused_budget');
    const approval = paused?.pendingApprovals.find((candidate) => candidate.kind === 'budget_increase');
    expect(approval).toBeDefined();

    engine.resolveApproval(runId, approval!.id, 'approve', undefined, 2);

    const resumed = await waitUntilNotPaused(engine, runId);
    expect(resumed.status).not.toBe('paused_budget');
    expect(strategy.assignCalls).toBe(2);
  });

  it('fails terminally at the hard ceiling without opening a budget approval', async () => {
    const message = 'Run reached the hard ceiling of $10.00. This cannot be raised via swarm_decide.';
    const strategy = new BudgetFailureStrategy('hard_ceiling', message);
    const { engine, task, runId } = createEngine(strategy);

    await runLoop(engine, runId, task);

    const state = engine.getRunStore().load(runId);
    expect(state?.status).toBe('failed');
    expect(state?.lastError).toContain('hard ceiling');
    expect(state?.pendingApprovals.filter((approval) => approval.kind === 'budget_increase')).toHaveLength(0);
    expect(strategy.assignCalls).toBe(1);
  });

  it('fails terminally at the worker-call limit without entering an approval cycle', async () => {
    const message = 'Run hit maxWorkerCalls (1).';
    const strategy = new BudgetFailureStrategy('call_count', message);
    const { engine, task, runId } = createEngine(strategy);

    await runLoop(engine, runId, task);

    const state = engine.getRunStore().load(runId);
    expect(state?.status).toBe('failed');
    expect(state?.lastError).toContain('maxWorkerCalls');
    expect(state?.pendingApprovals.filter((approval) => approval.kind === 'budget_increase')).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(strategy.assignCalls).toBe(1);
  });
});
