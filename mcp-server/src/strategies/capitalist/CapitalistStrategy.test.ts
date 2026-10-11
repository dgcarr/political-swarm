import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { Ledger } from '../../engine/Ledger.js';
import { RepoWorktree } from '../../engine/RepoWorktree.js';
import type { EngineContext, RecoveryRequest } from '../../engine/SwarmStrategy.js';
import type { WorkerDispatcher } from '../../engine/WorkerDispatcher.js';
import type {
  Assignment,
  Decision,
  PendingApproval,
  ReviewResult,
  TaskAttempt,
  TaskGraph,
  TestResult,
  WorkProduct,
} from '../../engine/types.js';
import type { RunState } from '../../engine/RunStore.js';
import { CapitalistStrategy } from './CapitalistStrategy.js';
import type { Bid, CapitalAccount, CapitalistStrategyState } from './types.js';
import { openReserve } from './insurance.js';
import { openCreditBook } from './credit.js';
import { openTreasury } from './treasury.js';
import { emptyConsumption } from './prices.js';
import { emptyOwnershipMap } from '../../engine/packets.js';
import type { DeliveryPacket } from '../../engine/packets.js';

function account(overrides: Partial<CapitalAccount> = {}): CapitalAccount {
  return {
    personaId: 'p',
    capital: 100,
    reputationScore: 0.5,
    defects: 0,
    cleanTasksInARow: 0,
    heldEscrow: 0,
    bankrupt: false,
    reputationByDomain: {},
    liabilities: 0,
    consecutiveFailures: 0,
    settlements: 0,
    ...overrides,
  };
}

function bid(overrides: Partial<Bid> = {}): Bid {
  return { priceTokens: 20, estTime: 10, confidence: 0.8, approach: 'x', ...overrides };
}

function graphWithReadyTask(): TaskGraph {
  return {
    nodes: {
      task: {
        id: 'task',
        title: 'Implement feature',
        description: 'Implement the requested feature',
        acceptanceCriteria: ['works'],
        dependsOn: [],
        targetGlobs: ['src/**'],
        riskTags: [],
        riskClass: 'low',
        phase: 'queued',
        attempts: [],
      },
    },
    order: ['task'],
  };
}

function runState(graph: TaskGraph = graphWithReadyTask()): RunState {
  return {
    runId: 'test-run',
    strategy: 'capitalist',
    task: { goal: 'Implement feature', acceptanceCriteria: ['works'] },
    repoPath: '/repo',
    baseBranch: 'main',
    worktreePath: '/worktree',
    branch: 'swarm/test-run',
    status: 'running',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    budgetUsd: 10,
    costUsd: 0,
    tokensUsed: { prompt: 0, completion: 0 },
    workerCalls: 0,
    graph,
    pendingApprovals: [],
  };
}

interface ContextOptions {
  dispatcher?: WorkerDispatcher;
  worktree?: RepoWorktree;
  config?: Record<string, unknown>;
  strategyState?: Record<string, unknown> | CapitalistStrategyState;
  graph?: TaskGraph;
}

function createContext(tmpRoot: string, options: ContextOptions = {}): EngineContext {
  const state = runState(options.graph);
  return {
    dispatcher:
      options.dispatcher ??
      ({ dispatch: vi.fn() } as unknown as WorkerDispatcher),
    worktree: options.worktree ?? ({} as RepoWorktree),
    ledger: new Ledger(path.join(tmpRoot, 'run'), state.runId, 'capitalist'),
    knowledge: {} as EngineContext['knowledge'],
    budget: {} as EngineContext['budget'],
    config: options.config ?? {},
    checks: {} as EngineContext['checks'],
    runId: state.runId,
    runState: state,
    strategyState: (options.strategyState ?? {}) as Record<string, unknown>,
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
    openApproval: vi.fn((): PendingApproval => ({
      id: 'approval-1',
      kind: 'spend_approval',
      description: 'approval',
      createdAt: '2026-01-01T00:00:00.000Z',
    })),
    getApprovalResolution: vi.fn(),
  };
}

function assignment(overrides: Partial<Assignment> = {}): Assignment {
  return {
    taskId: 'task',
    assigneeId: 'bidder-1',
    role: 'implementer',
    meta: { bid: bid({ priceTokens: 100 }) },
    ...overrides,
  };
}

function product(overrides: Partial<WorkProduct> = {}): WorkProduct {
  return {
    taskId: 'task',
    assignment: assignment(),
    fileOps: [{ op: 'write', path: 'src/feature.ts', content: 'export {};' }],
    rationale: 'Implemented feature',
    ...overrides,
  };
}

function review(testResult: TestResult, verdict: 'approve' | 'reject' = 'approve'): ReviewResult {
  return {
    taskId: 'task',
    findings: [
      { reviewerId: 'reviewer-task', verdict, rationale: `Reviewer says ${verdict}` },
      { reviewerId: 'regulator', verdict: 'approve', rationale: 'Scope is valid' },
    ],
    testResult,
  };
}

function recoveryRequest(overrides: Partial<RecoveryRequest> = {}): RecoveryRequest {
  const test = { ran: true, passed: false, output: 'assertion failed' };
  return {
    product: product(),
    review: review(test),
    decision: {
      taskId: 'task',
      outcome: 'rework',
      rationale: 'The failed contract was settled and may be repaired.',
      evidenceRefs: ['assertion failed'],
      rework: { requiredChanges: ['Fix the failing assertion and add regression coverage.'] },
      meta: { personaId: 'bidder-1', price: 100, supplierLiable: true },
    },
    test,
    attemptNumber: 1,
    maxAttempts: 3,
    repeated: false,
    ...overrides,
  };
}

/** An attempt as the engine records it before calling recover(). */
function recordedAttempt(attempt: number, outcome: TaskAttempt['outcome'] = 'rework', overrides: Partial<TaskAttempt> = {}): TaskAttempt {
  return {
    attempt,
    outcome,
    rationale: `attempt ${attempt}`,
    evidenceRefs: [],
    assigneeId: 'bidder-1',
    at: '2026-01-01T00:00:00.000Z',
    fingerprint: `attempt-${attempt}`,
    repeated: false,
    ...overrides,
  };
}

function settledState(accountOverrides: Partial<CapitalAccount> = {}): CapitalistStrategyState {
  return {
    capitalAccounts: { 'bidder-1': account({ personaId: 'bidder-1', ...accountOverrides }) },
    pendingEscrow: { task: { personaId: 'bidder-1', amount: 20, price: 100 } },
    approvals: {},
    warrantyRepairs: {},
    retenderRequiredChanges: {},
    excludedContractors: {},
    settlementDecisions: {},
    recentWinners: [],
    register: { contractors: {}, assessors: {}, subcontractors: {} },
    regulatorActions: [],
    bidRecords: {},
    consumption: {},
    contractTerms: {},
    reserve: openReserve(),
    creditBook: openCreditBook(),
    treasury: openTreasury(),
    treasuryBalance: 0,
    arbitrations: 0,
    arbitrationsDeclined: 0,
    unfilledListings: [],
    insured: {},
    settled: [],
    levied: [],
  };
}

describe('CapitalistStrategy', () => {
  it('republishes a grant-funded public-good tender and awards only from fresh bids', async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'capitalist-grant-test-'));
    try {
      const strategyState = settledState();
      strategyState.treasury.publicGoodsFund = 100;
      const graph = graphWithReadyTask();
      graph.nodes.task.title = 'Add shared test infrastructure';
      graph.nodes.task.targetGlobs = ['tests/**'];
      let round = 0;
      const dispatch = vi.fn(async () => ({
        value: bid({ priceTokens: round++ < 2 ? 145 : 140 }), raw: '{}', model: 'fake', costUsd: 0,
      }));
      const ctx = createContext(tmpRoot, {
        strategyState, graph, dispatcher: { dispatch } as unknown as WorkerDispatcher,
        config: { bidCount: 2, lowRiskBidCount: 2 },
      });

      const assignments = await new CapitalistStrategy().assign(ctx, graph);

      expect(assignments).toHaveLength(1);
      expect(dispatch).toHaveBeenCalledTimes(4);
      expect(assignments[0].meta?.bid).toMatchObject({ priceTokens: 140 });
      expect(ctx.ledger.readAll().some((event) => event.type === 'listing_republished')).toBe(true);
      expect(strategyState.treasury.grants).toHaveLength(1);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('commissions an uncertain prototype from the venture pool and requires published findings', async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'capitalist-venture-test-'));
    try {
      const strategyState = settledState();
      strategyState.treasury.venturePool = 100;
      strategyState.diligence = {
        instructions: [], manifests: [], ciConfigs: [], testLayout: [], applicableChecks: [],
        excludedChecks: [], scopeUnderstood: false, notes: [],
      };
      const graph = graphWithReadyTask();
      graph.nodes.task.title = 'Prototype a parser';
      let call = 0;
      const dispatch = vi.fn(async () => ({
        value: bid({ priceTokens: call++ < 2 ? 145 : 140 }), raw: '{}', model: 'fake', costUsd: 0,
      }));
      const ctx = createContext(tmpRoot, {
        strategyState, graph, dispatcher: { dispatch } as unknown as WorkerDispatcher,
        config: { bidCount: 2, lowRiskBidCount: 2 },
      });

      const assignments = await new CapitalistStrategy().assign(ctx, graph);

      expect(assignments).toHaveLength(1);
      expect(strategyState.treasury.grants).toContainEqual(expect.objectContaining({ taskId: 'task', amount: 20 }));
      expect(ctx.ledger.readAll().some((event) => event.type === 'venture_experiment_commissioned')).toBe(true);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('awards a listing to the bidder with the highest scoreBid score', async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'capitalist-assign-test-'));
    try {
      const bids: Record<string, Bid> = {
        'bidder-1': bid({ priceTokens: 5, confidence: 0.2, warranties: [] }),
        'bidder-2': bid({ priceTokens: 18, confidence: 0.95, warranties: ['scope', 'tests', 'fixes'] }),
        'bidder-3': bid({ priceTokens: 30, confidence: 0.6, warranties: [] }),
      };
      const dispatch = vi.fn(async (opts: { personaId?: string }) => ({
        value: bids[opts.personaId ?? ''],
        raw: '{}',
        model: 'fake',
        costUsd: 0,
      }));
      const dispatcher = { dispatch } as unknown as WorkerDispatcher;
      // Scoring is what this covers, so the full three-bid field is kept explicitly; low-risk
      // listings otherwise take two sealed bids.
      const ctx = createContext(tmpRoot, { dispatcher, config: { bidCount: 3, lowRiskBidCount: 3 } });

      const assignments = await new CapitalistStrategy().assign(ctx, ctx.runState.graph!);

      expect(assignments).toHaveLength(1);
      expect(assignments[0]).toMatchObject({
        taskId: 'task',
        assigneeId: 'bidder-2',
        role: 'implementer',
        meta: { bid: bids['bidder-2'], bidCount: 3 },
      });
      expect(assignments[0].meta?.awardScore).toBeGreaterThan(0);
      // The listing travels with the award: what was promised at tender is what settlement is
      // measured against, and a term nobody kept a copy of is not enforceable.
      expect(assignments[0].meta?.listing).toMatchObject({ taskId: 'task' });
      expect(dispatch).toHaveBeenCalledTimes(3);

      // An award allocates capital, so the losing bidders are owed the arithmetic.
      const awarded = ctx.ledger.readAll().find((e) => e.type === 'listing_awarded');
      expect(Object.keys(awarded!.data.terms as object)).toContain('comparativeAdvantage');
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('records a re-tender of an award that never ran as a new decision, not a conflicting replay', async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'capitalist-retender-test-'));
    try {
      // The engine drops an assignment whose batch never runs (an earlier task paused the run), so
      // the node comes back queued with no attempt and the next round tenders it again.
      let price = 10;
      const dispatcher = {
        dispatch: vi.fn(async () => ({ value: bid({ priceTokens: price++ }), raw: '{}', model: 'fake', costUsd: 0 })),
      } as unknown as WorkerDispatcher;
      const ctx = createContext(tmpRoot, { dispatcher, config: { bidCount: 1 } });
      const strategy = new CapitalistStrategy();

      await strategy.assign(ctx, ctx.runState.graph!);
      await strategy.assign(ctx, ctx.runState.graph!);

      expect(ctx.runState.governanceDecisions?.map((d) => d.id)).toEqual(['award:task:1', 'award:task:2']);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('logs the informational collusion watch for four consecutive wins by at most two personas', async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'capitalist-collusion-test-'));
    try {
      const dispatcher = {
        dispatch: vi.fn(async () => ({ value: bid(), raw: '{}', model: 'fake', costUsd: 0 })),
      } as unknown as WorkerDispatcher;
      const strategyState = { recentWinners: ['bidder-1', 'bidder-2', 'bidder-1'] };
      const ctx = createContext(tmpRoot, { dispatcher, strategyState, config: { bidCount: 1 } });

      const assignments = await new CapitalistStrategy().assign(ctx, ctx.runState.graph!);
      const flags = ctx.ledger.readAll().filter((entry) => entry.type === 'collusion_watch');

      expect(assignments[0]?.assigneeId).toBe('bidder-1');
      expect(flags).toHaveLength(1);
      expect(flags[0]?.data.recentWinners).toEqual(['bidder-1', 'bidder-2', 'bidder-1', 'bidder-1']);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('does not log the collusion watch when the four-win window contains three personas', async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'capitalist-collusion-boundary-test-'));
    try {
      const dispatcher = {
        dispatch: vi.fn(async () => ({ value: bid(), raw: '{}', model: 'fake', costUsd: 0 })),
      } as unknown as WorkerDispatcher;
      const strategyState = { recentWinners: ['bidder-1', 'bidder-2', 'bidder-3'] };
      const ctx = createContext(tmpRoot, { dispatcher, strategyState, config: { bidCount: 1 } });

      await new CapitalistStrategy().assign(ctx, ctx.runState.graph!);

      expect(ctx.ledger.readAll().filter((entry) => entry.type === 'collusion_watch')).toEqual([]);
      expect((ctx.strategyState as Partial<CapitalistStrategyState>).recentWinners).toEqual([
        'bidder-1',
        'bidder-2',
        'bidder-3',
        'bidder-1',
      ]);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('returns implementer file operations and records pending escrow when executing', async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'capitalist-execute-test-'));
    const repoPath = path.join(tmpRoot, 'repo');
    mkdirSync(repoPath, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repoPath });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoPath });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoPath });
    writeFileSync(path.join(repoPath, 'README.md'), 'initial\n', 'utf8');
    execFileSync('git', ['add', '-A'], { cwd: repoPath });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repoPath });
    execFileSync('git', ['branch', '-M', 'main'], { cwd: repoPath });
    const worktree = new RepoWorktree(repoPath, path.join(tmpRoot, 'run'), 'test-run');
    await worktree.create('main');
    try {
      const implementerOutput = {
        fileOps: [{ op: 'write' as const, path: 'src/feature.ts', content: 'export const value = 1;\n' }],
        rationale: 'Added the feature',
        unresolvedUncertainty: 'None',
      };
      const dispatcher = {
        dispatch: vi.fn(async () => ({ value: implementerOutput, raw: '{}', model: 'fake', costUsd: 0.01 })),
      } as unknown as WorkerDispatcher;
      const ctx = createContext(tmpRoot, { dispatcher, worktree, config: { escrowFraction: 0.2 } });

      const result = await new CapitalistStrategy().execute(ctx, assignment());

      expect(result).toEqual({ taskId: 'task', assignment: assignment(), ...implementerOutput });
      expect((ctx.strategyState as Partial<CapitalistStrategyState>).pendingEscrow?.task).toEqual({
        personaId: 'bidder-1',
        amount: 20,
        price: 100,
      });
    } finally {
      execFileSync('git', ['worktree', 'remove', '--force', worktree.worktreePath], { cwd: repoPath });
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  // Concurrent calls each saw the other's tokens in the run-wide counter's delta.
  it('meters a contract by the call\'s own tokens, not by what other calls added meanwhile', async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'capitalist-metering-test-'));
    const repoPath = path.join(tmpRoot, 'repo');
    mkdirSync(repoPath, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repoPath });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoPath });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoPath });
    writeFileSync(path.join(repoPath, 'README.md'), 'initial\n', 'utf8');
    execFileSync('git', ['add', '-A'], { cwd: repoPath });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repoPath });
    execFileSync('git', ['branch', '-M', 'main'], { cwd: repoPath });
    const worktree = new RepoWorktree(repoPath, path.join(tmpRoot, 'run'), 'test-run');
    await worktree.create('main');
    try {
      const implementerOutput = {
        fileOps: [{ op: 'write' as const, path: 'src/feature.ts', content: 'export const value = 1;\n' }],
        rationale: 'Added the feature',
        unresolvedUncertainty: 'None',
      };
      let ctx: ReturnType<typeof createContext>;
      const dispatcher = {
        dispatch: vi.fn(async () => {
          // Another task's call landing while this one is in flight.
          ctx.runState.tokensUsed.prompt += 9_000;
          ctx.runState.tokensUsed.completion += 4_000;
          return { value: implementerOutput, raw: '{}', model: 'fake', costUsd: 0.01, promptTokens: 120, completionTokens: 30 };
        }),
      } as unknown as WorkerDispatcher;
      ctx = createContext(tmpRoot, { dispatcher, worktree, config: { escrowFraction: 0.2 } });

      await new CapitalistStrategy().execute(ctx, assignment());

      expect((ctx.strategyState as Partial<CapitalistStrategyState>).consumption?.task).toMatchObject({
        promptTokens: 120,
        completionTokens: 30,
      });
    } finally {
      execFileSync('git', ['worktree', 'remove', '--force', worktree.worktreePath], { cwd: repoPath });
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('runs the lead and its subcontractors, and refuses a subcontractor rewriting the lead', async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'capitalist-firm-execute-test-'));
    try {
      const leadOutput = {
        fileOps: [{ op: 'write' as const, path: 'src/feature.ts', content: 'export const value = 1;\n' }],
        rationale: 'Added the feature',
      };
      // The test subcontractor adds a test — and also tries to rewrite the module the lead just
      // delivered. Under a naive merge its idea of the module would silently replace the real one.
      const subOutput = {
        fileOps: [
          { op: 'write' as const, path: 'test/feature.test.js', content: 'require("assert");\n' },
          { op: 'write' as const, path: 'src/feature.ts', content: 'export const value = 999;\n' },
        ],
        rationale: 'Added a test',
      };
      const dispatch = vi.fn(async (opts: { personaId?: string }) => ({
        value: opts.personaId === 'bidder-1' ? leadOutput : subOutput,
        raw: '{}',
        model: 'fake',
        costUsd: 0.01,
      }));
      const ctx = createContext(tmpRoot, { dispatcher: { dispatch } as unknown as WorkerDispatcher });

      const firm = {
        leadId: 'bidder-1',
        liableId: 'bidder-1',
        members: [
          { personaId: 'bidder-1', role: 'lead' as const, capability: 'lead' },
          { personaId: 'bidder-2', role: 'test' as const, capability: 'testing' },
        ],
      };
      const result = await new CapitalistStrategy().execute(
        ctx,
        assignment({ meta: { bid: bid({ priceTokens: 100 }), firm } }),
      );

      expect(dispatch).toHaveBeenCalledTimes(2);
      expect(result.fileOps.map((o) => o.path)).toEqual(['src/feature.ts', 'test/feature.test.js']);
      // The lead's content survives; the subcontractor's overwrite does not.
      expect(result.fileOps.find((o) => o.path === 'src/feature.ts')).toMatchObject({
        content: 'export const value = 1;\n',
      });
      // The lead is liable for the delivery, so it is told what a member of its firm attempted.
      expect(result.unresolvedUncertainty).toContain('attempted to rewrite');
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('delivers on the lead alone when a subcontractor fails, disclosing the gap', async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'capitalist-firm-fail-test-'));
    try {
      const leadOutput = {
        fileOps: [{ op: 'write' as const, path: 'src/feature.ts', content: 'x\n' }],
        rationale: 'Added the feature',
      };
      const dispatch = vi.fn(async (opts: { personaId?: string }) => {
        if (opts.personaId !== 'bidder-1') throw new Error('subcontractor unavailable');
        return { value: leadOutput, raw: '{}', model: 'fake', costUsd: 0.01 };
      });
      const ctx = createContext(tmpRoot, { dispatcher: { dispatch } as unknown as WorkerDispatcher });

      const firm = {
        leadId: 'bidder-1',
        liableId: 'bidder-1',
        members: [
          { personaId: 'bidder-1', role: 'lead' as const, capability: 'lead' },
          { personaId: 'bidder-2', role: 'test' as const, capability: 'testing' },
        ],
      };
      const result = await new CapitalistStrategy().execute(
        ctx,
        assignment({ meta: { bid: bid({ priceTokens: 100 }), firm } }),
      );

      // The contract still delivers: the lead is liable and hands over what it has. What it may not
      // do is hide that the firm came up short.
      expect(result.fileOps).toHaveLength(1);
      expect(result.unresolvedUncertainty).toContain('did not deliver');
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('combines the reviewer verdict with an approving regulator scope check', async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'capitalist-review-test-'));
    try {
      const dispatcher = {
        dispatch: vi.fn(async () => ({
          value: { verdict: 'approve', rationale: 'Implementation is correct' },
          raw: '{}',
          model: 'fake',
          costUsd: 0,
        })),
      } as unknown as WorkerDispatcher;
      const ctx = createContext(tmpRoot, { dispatcher });

      const result = await new CapitalistStrategy().review(
        ctx,
        product(),
        { ran: true, passed: true, output: 'all passed' },
      );

      expect(result.findings).toEqual([
        { reviewerId: 'reviewer-task', verdict: 'approve', rationale: 'Implementation is correct' },
        {
          reviewerId: 'regulator',
          verdict: 'approve',
          rationale: "All delivered FileOps paths fall within the listing's declared targetGlobs.",
        },
      ]);
      expect(result.testResult).toEqual({ ran: true, passed: true, output: 'all passed' });
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  // Section 8: what a firm keeps is verified value minus consumed resources and liabilities — not
  // the contract price. The price alone was the old model, and under it a firm could win on a cheap
  // quote and burn the commons for free.
  it('approves passing work and pays the price net of what the contract consumed, holding escrow', async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'capitalist-decide-pass-test-'));
    try {
      const strategyState = settledState();
      const ctx = createContext(tmpRoot, { strategyState });

      const decision = await new CapitalistStrategy().decide(
        ctx,
        product(),
        review({ ran: true, passed: true, output: 'passed' }),
      );

      expect(decision.outcome).toBe('approved');
      const resourceCost = decision.meta?.resourceCost as number;
      expect(resourceCost).toBeGreaterThan(0);
      const settled = strategyState.capitalAccounts['bidder-1'];
      // Article 9's levy comes off the profit before the firm keeps it: what a contract earns is
      // never quite what it takes home, because the commons it was delivered against costs money.
      const profit = decision.meta?.profit as number;
      const levy = strategyState.treasury.levies.find((l) => l.taskId === 'task');
      expect(levy?.amount).toBeGreaterThan(0);
      expect(settled.capital).toBeCloseTo(100 + profit - levy!.amount, 2);
      expect(settled.capital).toBeCloseTo(100 + (100 - 20) - resourceCost - levy!.amount, 2);
      expect(settled).toMatchObject({ cleanTasksInARow: 1, heldEscrow: 20, defects: 0, consecutiveFailures: 0 });
      // A delivered contract raises the firm's standing above neutral rather than by a fixed step.
      expect(settled.reputationScore).toBeGreaterThan(0.5);
      expect(strategyState.pendingEscrow).toEqual({});
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  // Sound work delivered late is a breach of the contract's terms, not a defect in the code. It used
  // to be rejected and reverted, throwing the verified code away; now the breach is priced instead.
  it('accepts sound work delivered after its deadline and settles the breach by forfeiting retention', async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'capitalist-deadline-test-'));
    try {
      const strategyState = settledState();
      strategyState.consumption.task = {
        ...emptyConsumption('task', 'low'),
        awardedAtMs: 1_000_000,
        deliveredAtMs: 1_000_000 + 61_000,
      };
      const ctx = createContext(tmpRoot, { strategyState });
      const lateProduct = product({ assignment: assignment({
        meta: { bid: bid({ priceTokens: 100 }), listing: { deadlineMinutes: 1 } },
      }) });

      const decision = await new CapitalistStrategy().decide(
        ctx, lateProduct, review({ ran: true, passed: true, output: 'passed' }),
      );

      expect(decision.outcome).toBe('approved');
      expect(decision.rationale).toContain('delivery missed the published deadline');
      expect(decision.rationale).toContain('Forfeited retention of 20.00');
      expect(ctx.ledger.readAll().some((event) => event.type === 'contract_deadline_breached')).toBe(true);
      expect(strategyState.regulatorActions).toContainEqual(expect.objectContaining({ ground: 'contract-breach' }));
      // Paid for the work less the retention, which is forfeited rather than held as a warranty lot,
      // and the failed contract is on the firm's record.
      const resourceCost = decision.meta?.resourceCost as number;
      expect(decision.meta?.profit).toBeCloseTo(100 - 20 - resourceCost, 2);
      const firm = strategyState.capitalAccounts['bidder-1'];
      expect(firm).toMatchObject({ heldEscrow: 0, defects: 1, cleanTasksInARow: 0 });
      expect(firm.escrowLots ?? []).toEqual([]);
      expect(firm.reputationScore).toBeLessThan(0.5);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('prices the contract against the published list and records the derivation, not just a total', async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'capitalist-decide-price-test-'));
    try {
      const strategyState = settledState();
      const ctx = createContext(tmpRoot, { strategyState });

      await new CapitalistStrategy().decide(ctx, product(), review({ ran: true, passed: true, output: 'passed' }));

      const priced = ctx.ledger.readAll().find((e) => e.type === 'resources_priced');
      expect(priced).toBeDefined();
      // Article 5 asks for costs that are visible. A settlement a firm cannot see the derivation of
      // is one it cannot dispute, so the lines travel with the total.
      expect((priced!.data.lines as unknown[]).length).toBeGreaterThan(0);
      expect(strategyState.settled.find((c) => c.taskId === 'task')?.resourceCost).toBe(priced!.data.total);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  // The engine compels another attempt even when no firm can take the re-tender, and used to lead
  // that directive with the settlement record: forfeiture and P&L, which there is nothing to fix in.
  it('gives a refusal an engineering-only repair directive, keeping the P&L in the rationale', async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'capitalist-repair-directive-test-'));
    try {
      const strategyState = settledState();
      const ctx = createContext(tmpRoot, { strategyState, config: { bidCount: 1 } });
      const failedReview = review({ ran: true, passed: false, output: 'assertion failed' }, 'reject');
      failedReview.findings[0]!.rationale = 'The implementation takes a fundamentally wrong approach.';

      const decision = await new CapitalistStrategy().decide(ctx, product(), failedReview);

      expect(decision.outcome).toBe('rejected');
      expect(decision.rationale).toMatch(/Forfeited retention/);
      expect(decision.repairDirective?.length).toBeGreaterThan(0);
      expect(decision.repairDirective!.join('\n')).toContain('fundamentally wrong approach');
      expect(decision.repairDirective!.join('\n')).not.toMatch(/Forfeited|retention|P&L|profit|capital/i);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('settles genuinely failing work as failed: forfeits escrow, records a defect, and declares bankruptcy below threshold', async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'capitalist-decide-fail-test-'));
    try {
      const strategyState = settledState({ cleanTasksInARow: 2, heldEscrow: 5 });
      const ctx = createContext(tmpRoot, { strategyState, config: { bankruptcyThreshold: 90 } });

      const failedReview = review({ ran: true, passed: false, output: 'assertion failed' }, 'reject');
      failedReview.findings[0]!.rationale = 'The implementation takes a fundamentally wrong approach.';
      const decision = await new CapitalistStrategy().decide(ctx, product(), failedReview);

      // Repairable by another firm: the evidence is kept and the listing is barred from warranty.
      expect(decision.outcome).toBe('rework');
      expect(decision.meta?.warrantyBarred).toBe(true);
      // Section 6: agents that consume scarce resources without producing verified value lose
      // capital. The forfeited retention is the defect penalty; the resources it burned fall on top,
      // because a failed contract spent the commons exactly as much as a successful one.
      const resourceCost = decision.meta?.resourceCost as number;
      expect(decision.meta?.profit).toBe(-resourceCost);
      const settled = strategyState.capitalAccounts['bidder-1'];
      expect(settled.capital).toBeCloseTo(100 - 20 - resourceCost, 2);
      expect(settled).toMatchObject({
        defects: 1,
        cleanTasksInARow: 0,
        consecutiveFailures: 1,
        heldEscrow: 5,
        bankrupt: true,
      });
      expect(settled.reputationScore).toBeLessThan(0.5);
      expect(strategyState.pendingEscrow).toEqual({});
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it.each(['approved', 'rejected'] as const)(
    'recordOutcome audits an %s decision without applying capital changes a second time',
    async (outcome) => {
      const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'capitalist-record-test-'));
      try {
        const strategyState = settledState({ capital: 73, defects: 2, cleanTasksInARow: 4, bankrupt: true });
        const before = structuredClone(strategyState.capitalAccounts['bidder-1']);
        const ctx = createContext(tmpRoot, { strategyState });
        const decision: Decision = { taskId: 'task', outcome, rationale: outcome, evidenceRefs: [] };

        await new CapitalistStrategy().recordOutcome(ctx, decision, { ran: true, passed: outcome === 'approved' });

        expect(strategyState.capitalAccounts['bidder-1']).toEqual(before);
        expect(ctx.ledger.readAll().at(-1)).toMatchObject({
          type: 'outcome_recorded',
          data: { taskId: 'task', outcome, testRan: true, testPassed: outcome === 'approved' },
        });
      } finally {
        rmSync(tmpRoot, { recursive: true, force: true });
      }
    },
  );

  it('settles a repairable failure once and returns concrete rework requirements', async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'capitalist-rework-settlement-test-'));
    try {
      const strategyState = settledState();
      const ctx = createContext(tmpRoot, { strategyState });
      const strategy = new CapitalistStrategy();
      const failedReview = review({
        ran: true,
        passed: false,
        command: 'npm test',
        output: 'feature returns 1 instead of 2',
        newFailures: ['feature returns the expected value'],
      });

      const decision = await strategy.decide(ctx, product(), failedReview);
      const settledOnce = structuredClone(strategyState.capitalAccounts['bidder-1']);
      const replayedDecision = await strategy.decide(ctx, product(), failedReview);

      expect(decision.outcome).toBe('rework');
      expect(decision.rework?.requiredChanges).toContain(
        'Make the failed check pass and add or strengthen regression coverage: feature returns the expected value.',
      );
      expect(settledOnce.defects).toBe(1);
      expect(settledOnce.reputationScore).toBeLessThan(0.5);
      expect(strategyState.capitalAccounts['bidder-1']).toEqual(settledOnce);
      expect(replayedDecision).toEqual(decision);
      expect(ctx.ledger.readAll().filter((entry) => entry.type === 'capital_recorded')).toHaveLength(1);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('returns rework when failed settlement bankrupts the contractor but a solvent bidder remains', async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'capitalist-bankrupt-retender-test-'));
    try {
      const strategyState = settledState();
      strategyState.capitalAccounts['bidder-2'] = account({ personaId: 'bidder-2' });
      const ctx = createContext(tmpRoot, {
        strategyState,
        config: { bankruptcyThreshold: 90, bidCount: 2 },
      });
      const warrantyProduct = product({
        assignment: assignment({
          meta: {
            bid: bid({ priceTokens: 100 }),
            warrantyRepair: { requiredChanges: ['Fix the original failure.'] },
          },
        }),
      });

      const decision = await new CapitalistStrategy().decide(
        ctx,
        warrantyProduct,
        review({ ran: true, passed: false, output: 'warranty assertion still fails' }),
      );

      expect(strategyState.capitalAccounts['bidder-1'].bankrupt).toBe(true);
      expect(strategyState.capitalAccounts['bidder-2'].bankrupt).toBe(false);
      expect(decision.outcome).toBe('rework');
      expect(decision.rework?.requiredChanges).toContain(
        'Make the failed check pass and add or strengthen regression coverage: the required check did not pass.',
      );
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('assigns the first recovery to the original contractor on the original terms without a new award or premium', async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'capitalist-warranty-assignment-test-'));
    try {
      const strategyState = settledState();
      strategyState.reserve.balance = 40;
      strategyState.reserve.premiumsCollected = 40;
      strategyState.insured.task = { personaId: 'bidder-1', premium: 8 };
      const originalAssignment = assignment({
        meta: {
          bid: bid({ priceTokens: 100, warranties: ['repair defects'] }),
          awardScore: 0.91,
          bidCount: 3,
          listing: { taskId: 'task', availableBudget: 120 },
          terms: { type: 'warranty', retentionFraction: 0.2, warrantyPeriodTasks: 2 },
        },
      });
      const dispatch = vi.fn();
      const ctx = createContext(tmpRoot, {
        dispatcher: { dispatch } as unknown as WorkerDispatcher,
        strategyState,
      });
      const strategy = new CapitalistStrategy();
      const premiumBefore = strategyState.reserve.premiumsCollected;

      await strategy.recover(ctx, recoveryRequest({ product: product({ assignment: originalAssignment }) }));
      ctx.runState.graph!.nodes.task.phase = 'queued';
      const assignments = await strategy.assign(ctx, ctx.runState.graph!);

      expect(strategyState.warrantyRepairs.task.assignment).toEqual(originalAssignment);
      expect(assignments).toHaveLength(1);
      expect(assignments[0]).toMatchObject({
        taskId: 'task',
        assigneeId: 'bidder-1',
        meta: {
          bid: originalAssignment.meta!.bid,
          listing: originalAssignment.meta!.listing,
          terms: originalAssignment.meta!.terms,
          warrantyRepair: { requiredChanges: ['Fix the failing assertion and add regression coverage.'] },
        },
      });
      expect(dispatch).not.toHaveBeenCalled();
      expect(strategyState.reserve.premiumsCollected).toBe(premiumBefore);
      expect(ctx.ledger.readAll().filter((entry) => entry.type === 'listing_awarded')).toHaveLength(0);
      expect(ctx.ledger.readAll().filter((entry) => entry.type === 'premium_charged')).toHaveLength(0);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('excludes a supplier after its liable warranty failure and awards the re-tender to a different bidder', async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'capitalist-liable-retender-test-'));
    try {
      const graph = graphWithReadyTask();
      graph.nodes.task.attempts = [{
        attempt: 1,
        outcome: 'rework',
        rationale: 'first failed settlement',
        evidenceRefs: ['assertion failed'],
        assigneeId: 'bidder-1',
        testsPassed: false,
        at: '2026-01-01T00:00:00.000Z',
        fingerprint: 'first-failure',
        repeated: false,
      }];
      const strategyState = settledState({ defects: 1, consecutiveFailures: 1, settlements: 1, capital: 80 });
      strategyState.warrantyRepairs.task = {
        assignment: assignment(),
        requiredChanges: ['Fix the failing assertion.'],
      };
      strategyState.insured.task = { personaId: 'bidder-1', premium: 8 };
      strategyState.reserve.balance = 100;
      strategyState.reserve.premiumsCollected = 100;
      strategyState.settled = [{ taskId: 'task', personaId: 'bidder-1', price: 100, resourceCost: 10 }];
      strategyState.register.contractors.task = 'bidder-1';
      const dispatch = vi.fn(async (_opts: { personaId?: string }) => ({
        value: bid({ priceTokens: 40 }),
        raw: '{}',
        model: 'fake',
        costUsd: 0,
      }));
      const ctx = createContext(tmpRoot, {
        dispatcher: { dispatch } as unknown as WorkerDispatcher,
        strategyState,
        config: { bidCount: 2 },
        graph,
      });
      const strategy = new CapitalistStrategy();
      const failedTest = { ran: true, passed: false, output: 'warranty assertion still fails' };
      const warrantyProduct = product({
        assignment: assignment({
          meta: {
            bid: bid({ priceTokens: 100 }),
            warrantyRepair: { requiredChanges: ['Fix the failing assertion.'] },
          },
        }),
      });
      const decision = await strategy.decide(ctx, warrantyProduct, review(failedTest));
      expect(decision.outcome).toBe('rework');
      if (decision.outcome !== 'rework') throw new Error('Expected the liable warranty failure to be repairable');

      await strategy.recover(ctx, {
        product: warrantyProduct,
        review: review(failedTest),
        decision,
        test: failedTest,
        attemptNumber: 2,
        maxAttempts: 3,
        repeated: false,
      });
      ctx.runState.graph!.nodes.task.phase = 'queued';
      const assignments = await strategy.assign(ctx, ctx.runState.graph!);

      expect(strategyState.excludedContractors.task).toEqual(['bidder-1']);
      // The excluded incumbent is replaced by an entrant, so bidCount firms still compete for the
      // re-tender rather than the market shrinking by one with every failure. bidder-1 is barred
      // from this listing for good; it is simply no longer the only thing standing between the
      // listing and nobody.
      expect(dispatch).toHaveBeenCalledTimes(2);
      const invited = dispatch.mock.calls.map((call) => call[0]?.personaId);
      expect(invited).toEqual(['bidder-2', 'bidder-3']);
      expect(invited).not.toContain('bidder-1');
      expect(assignments[0]?.assigneeId).toBe('bidder-2');
      expect(ctx.ledger.readAll().filter((entry) => entry.type === 'listing_awarded')).toHaveLength(1);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  /**
   * Regression: a live capitalist benchmark run cascaded into total market bankruptcy — bidder-2
   * through bidder-7 each went insolvent in turn on the same task, and every remaining listing
   * ended up unfilled. Root cause: consumptionFor's per-taskId accumulator never reset across a
   * re-tender, so each new bidder's settlement was billed for the sum of every predecessor's
   * already-separately-settled spend on top of its own — resource costs on the task climbed
   * 169.74 -> 275.93 -> 382.90 -> 463.18 -> 596.72 -> 688.98 across six reassignments of one task.
   */
  it('resets resource consumption for the incoming bidder when a listing is re-tendered', async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'capitalist-retender-consumption-test-'));
    try {
      const graph = graphWithReadyTask();
      graph.nodes.task.attempts = [{
        attempt: 1,
        outcome: 'rework',
        rationale: 'first failed settlement',
        evidenceRefs: ['assertion failed'],
        assigneeId: 'bidder-1',
        testsPassed: false,
        at: '2026-01-01T00:00:00.000Z',
        fingerprint: 'first-failure',
        repeated: false,
      }];
      const strategyState = settledState({ defects: 1, consecutiveFailures: 1, settlements: 1, capital: 80 });
      strategyState.warrantyRepairs.task = {
        assignment: assignment(),
        requiredChanges: ['Fix the failing assertion.'],
      };
      strategyState.insured.task = { personaId: 'bidder-1', premium: 8 };
      strategyState.reserve.balance = 100;
      strategyState.reserve.premiumsCollected = 100;
      strategyState.settled = [{ taskId: 'task', personaId: 'bidder-1', price: 100, resourceCost: 10 }];
      strategyState.register.contractors.task = 'bidder-1';
      // bidder-1's already-settled, already-charged spend from the failed attempt.
      strategyState.consumption.task = {
        ...emptyConsumption('task', 'low'),
        modelSpendUsd: 169.74,
        dispatches: 12,
        promptTokens: 50_000,
        completionTokens: 20_000,
      };
      const dispatch = vi.fn(async (_opts: { personaId?: string }) => ({
        value: bid({ priceTokens: 40 }),
        raw: '{}',
        model: 'fake',
        costUsd: 0,
      }));
      const ctx = createContext(tmpRoot, {
        dispatcher: { dispatch } as unknown as WorkerDispatcher,
        strategyState,
        config: { bidCount: 2 },
        graph,
      });
      const strategy = new CapitalistStrategy();
      const failedTest = { ran: true, passed: false, output: 'warranty assertion still fails' };
      const warrantyProduct = product({
        assignment: assignment({
          meta: {
            bid: bid({ priceTokens: 100 }),
            warrantyRepair: { requiredChanges: ['Fix the failing assertion.'] },
          },
        }),
      });
      const decision = await strategy.decide(ctx, warrantyProduct, review(failedTest));
      if (decision.outcome !== 'rework') throw new Error('Expected the liable warranty failure to be repairable');

      await strategy.recover(ctx, {
        product: warrantyProduct,
        review: review(failedTest),
        decision,
        test: failedTest,
        attemptNumber: 2,
        maxAttempts: 3,
        repeated: false,
      });
      ctx.runState.graph!.nodes.task.phase = 'queued';
      await strategy.assign(ctx, ctx.runState.graph!);

      expect(strategyState.consumption.task).toMatchObject({
        modelSpendUsd: 0,
        dispatches: 0,
        promptTokens: 0,
        completionTokens: 0,
      });
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('pays at most one insurance claim when liable recovery is replayed after resume', async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'capitalist-claim-idempotence-test-'));
    try {
      const strategyState = settledState();
      strategyState.insured.task = { personaId: 'bidder-1', premium: 8 };
      strategyState.reserve.balance = 100;
      strategyState.reserve.premiumsCollected = 100;
      strategyState.settled = [{ taskId: 'task', personaId: 'bidder-1', price: 100, resourceCost: 10 }];
      const ctx = createContext(tmpRoot, { strategyState });
      ctx.runState.graph!.nodes.task.attempts = [recordedAttempt(1), recordedAttempt(2)];
      const request = recoveryRequest({ attemptNumber: 2 });

      await new CapitalistStrategy().recover(ctx, request);
      const balanceAfterFirstRecovery = strategyState.reserve.balance;
      await new CapitalistStrategy().recover(ctx, request);

      expect(strategyState.reserve.claims).toHaveLength(1);
      expect(strategyState.reserve.claimsPaid).toBe(75);
      expect(strategyState.reserve.balance).toBe(balanceAfterFirstRecovery);
      expect(ctx.ledger.readAll().filter((entry) => entry.type === 'claim_paid')).toHaveLength(1);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('prepares recovery state without changing the node phase or recorded attempt outcome', async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'capitalist-recover-boundary-test-'));
    try {
      const graph = graphWithReadyTask();
      graph.nodes.task.phase = 'running';
      graph.nodes.task.attempts = [{
        attempt: 1,
        outcome: 'rework',
        rationale: 'settled failure',
        evidenceRefs: ['assertion failed'],
        assigneeId: 'bidder-1',
        testsPassed: false,
        at: '2026-01-01T00:00:00.000Z',
        fingerprint: 'attempt-one',
        repeated: false,
      }];
      const ctx = createContext(tmpRoot, { graph, strategyState: settledState() });
      const attemptsBefore = structuredClone(graph.nodes.task.attempts);

      await new CapitalistStrategy().recover(ctx, recoveryRequest());

      expect(graph.nodes.task.phase).toBe('running');
      expect(graph.nodes.task.attempts).toEqual(attemptsBefore);
      expect(graph.nodes.task.attempts[0]?.outcome).toBe('rework');
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  // A failed contract's required changes are information about the listing, not about the firm
  // that failed it. Relisting used to drop them, so the re-tender's bidders priced the original
  // description and its winner — even the same firm — was handed the original prompt and
  // regenerated the same defect.
  it('carries a failed contract\'s required changes into the re-tender\'s bids and award', async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'capitalist-retender-feedback-test-'));
    try {
      const graph = graphWithReadyTask();
      const strategyState = settledState({ defects: 1, consecutiveFailures: 1, settlements: 1, capital: 80 });
      strategyState.warrantyRepairs.task = { assignment: assignment(), requiredChanges: ['Fix the failing assertion.'] };
      strategyState.register.contractors.task = 'bidder-1';
      const implementerOutput = {
        fileOps: [{ op: 'write' as const, path: 'src/feature.ts', content: 'export const value = 2;\n' }],
        rationale: 'Fixed',
      };
      const dispatch = vi.fn(async (opts: { role?: string; personaId?: string; userPrompt?: string }) => ({
        value: opts.role === 'bidder' ? bid({ priceTokens: 40 }) : implementerOutput,
        raw: '{}',
        model: 'fake',
        costUsd: 0,
      }));
      const ctx = createContext(tmpRoot, {
        dispatcher: { dispatch } as unknown as WorkerDispatcher,
        strategyState,
        config: { bidCount: 2, firms: { maxSubcontractors: 0 } },
        graph,
      });
      const strategy = new CapitalistStrategy();
      const failedTest = { ran: true, passed: false, output: 'E   AssertionError: feature returned 1, expected 2' };
      const warrantyProduct = product({
        assignment: assignment({
          meta: { bid: bid({ priceTokens: 100 }), warrantyRepair: { requiredChanges: ['Fix the failing assertion.'] } },
        }),
      });
      const decision = await strategy.decide(ctx, warrantyProduct, review(failedTest));
      if (decision.outcome !== 'rework') throw new Error('Expected the liable warranty failure to be repairable');
      const requiredChanges = decision.rework.requiredChanges;
      graph.nodes.task.attempts = [recordedAttempt(1), recordedAttempt(2)];

      await strategy.recover(ctx, {
        product: warrantyProduct, review: review(failedTest), decision, test: failedTest,
        attemptNumber: 2, maxAttempts: 3, repeated: false,
      });
      ctx.runState.graph!.nodes.task.phase = 'queued';
      const assignments = await strategy.assign(ctx, ctx.runState.graph!);

      const bidPrompts = dispatch.mock.calls.map((call) => call[0]?.userPrompt ?? '');
      expect(bidPrompts.length).toBeGreaterThan(0);
      for (const prompt of bidPrompts) {
        for (const change of requiredChanges) expect(prompt).toContain(change);
      }
      // Only the information carries over. The new award is a fresh contract, not a warranty repair,
      // so a failure on it is settled on the market's ordinary terms.
      expect(assignments[0]?.meta?.warrantyRepair).toBeUndefined();

      dispatch.mockClear();
      await strategy.execute(ctx, assignments[0]!);
      const implementerPrompt = dispatch.mock.calls[0]?.[0]?.userPrompt ?? '';
      for (const change of requiredChanges) expect(implementerPrompt).toContain(change);
      expect(implementerPrompt).not.toMatch(/WARRANTY REPAIR/);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  // A warranty repair that cannot go back to its contractor (insolvent, or barred from the listing)
  // is re-auctioned. The repair order is cancelled; what it said needed fixing is not.
  it('re-auctions a warranty repair its contractor cannot take with the required changes intact', async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'capitalist-bankrupt-warranty-feedback-test-'));
    try {
      const strategyState = settledState({ bankrupt: true });
      strategyState.warrantyRepairs.task = {
        assignment: assignment(),
        requiredChanges: ['Rename tests/tests_feature.py to tests/test_feature.py so pytest collects it.'],
      };
      const implementerOutput = { fileOps: [], rationale: 'Renamed' };
      const dispatch = vi.fn(async (opts: { role?: string; userPrompt?: string }) => ({
        value: opts.role === 'bidder' ? bid({ priceTokens: 40 }) : implementerOutput,
        raw: '{}',
        model: 'fake',
        costUsd: 0,
      }));
      const ctx = createContext(tmpRoot, {
        dispatcher: { dispatch } as unknown as WorkerDispatcher,
        strategyState,
        config: { bidCount: 2, firms: { maxSubcontractors: 0 } },
      });
      const strategy = new CapitalistStrategy();

      const assignments = await strategy.assign(ctx, ctx.runState.graph!);

      expect(assignments[0]?.assigneeId).not.toBe('bidder-1');
      const bidPrompts = dispatch.mock.calls.map((call) => call[0]?.userPrompt ?? '');
      expect(bidPrompts.length).toBeGreaterThan(0);
      for (const prompt of bidPrompts) expect(prompt).toContain('Rename tests/tests_feature.py');

      dispatch.mockClear();
      await strategy.execute(ctx, assignments[0]!);
      expect(dispatch.mock.calls[0]?.[0]?.userPrompt).toContain('Rename tests/tests_feature.py');
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  // The engine's repair brief carries the check output to the next implementer. The directive names
  // what to turn green; a second copy of the output in it reached the implementer twice.
  it('names the failing checks in the required changes without pasting their output', async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'capitalist-required-changes-output-test-'));
    try {
      const ctx = createContext(tmpRoot, { strategyState: settledState() });
      const output = 'E       AssertionError: feature returned 1, expected 2\nFAILED tests/test_feature.py::test_value';
      const decision = await new CapitalistStrategy().decide(
        ctx,
        product(),
        review({
          ran: true, passed: false, output, newFailures: ['tests'],
          checks: [{ categoryId: 'tests', status: 'new', output }],
        }),
      );

      expect(decision.outcome).toBe('rework');
      const changes = decision.rework?.requiredChanges ?? [];
      expect(changes).toContain(
        'Make the failed check pass and add or strengthen regression coverage: tests (passed before this change).',
      );
      expect(changes.join('\n')).not.toContain('AssertionError');
      expect(decision.rationale).not.toContain('AssertionError');
      // Commercial consequences belong to the settlement, not to the engineering directive.
      expect(changes.join('\n')).not.toMatch(/retention|profit|loss of|forfeit/i);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('carries every review finding that rejects or flags, with its evidence', async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'capitalist-required-changes-findings-test-'));
    try {
      const ctx = createContext(tmpRoot, { strategyState: settledState() });
      const failed = review({ ran: true, passed: true }, 'reject');
      failed.findings[0].rationale = 'composition() ignores the nickel column';
      failed.findings[0].evidenceRefs = ['alloy/composition.py'];
      failed.findings.push({ reviewerId: 'reviewer-task-2', verdict: 'flag', rationale: 'no test covers empty input' });

      const decision = await new CapitalistStrategy().decide(ctx, product(), failed);

      expect(decision.rework?.requiredChanges).toEqual([
        'Address the independent review finding: composition() ignores the nickel column. Evidence: alloy/composition.py.',
        'Address the independent review finding: no test covers empty input.',
      ]);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  // Each reopened listing is told its own defect and the evidence for it, not a list of every
  // listing's summaries with the evidence dropped.
  it('gives each remediated listing its own findings with their evidence', async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'capitalist-remediate-note-test-'));
    try {
      const graph = graphWithReadyTask();
      graph.nodes.other = { ...graph.nodes.task, id: 'other', title: 'Other' };
      graph.order.push('other');
      const ctx = createContext(tmpRoot, { graph, strategyState: settledState() });

      await new CapitalistStrategy().remediate(ctx, {
        runId: 'test-run',
        submittedAt: '2026-01-01T00:00:00.000Z',
        cycle: 1,
        findings: [
          { summary: 'Final check failed for task', evidence: 'E   KeyError: missing column "ni"', affectedTaskIds: ['task'], severity: 'high' },
          { summary: 'Other listing broke the CLI', evidence: 'E   SystemExit: 2', affectedTaskIds: ['other'], severity: 'medium' },
        ],
      });

      expect(graph.nodes.task.remediationOf).toContain('E   KeyError: missing column "ni"');
      expect(graph.nodes.task.remediationOf).not.toContain('Other listing broke the CLI');
      expect(graph.nodes.other.remediationOf).toContain('E   SystemExit: 2');
      expect(graph.nodes.other.remediationOf).not.toContain('Final check failed for task');
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  // A test-author subcontractor writes the regression test for the defect; it cannot do that
  // without being told what the defect was.
  it('tells a firm\'s subcontractors the remediation and warranty context the lead was given', async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'capitalist-subcontractor-feedback-test-'));
    try {
      const graph = graphWithReadyTask();
      graph.nodes.task.remediationOf = 'Final acceptance: composition() rejects valid YAML with comments.';
      const dispatch = vi.fn(async () => ({
        value: { fileOps: [], rationale: 'done' }, raw: '{}', model: 'fake', costUsd: 0,
      }));
      const ctx = createContext(tmpRoot, { graph, dispatcher: { dispatch } as unknown as WorkerDispatcher });
      const firm = {
        leadId: 'bidder-1',
        liableId: 'bidder-1',
        members: [
          { personaId: 'bidder-1', role: 'lead' as const, capability: 'lead' },
          { personaId: 'bidder-2', role: 'test' as const, capability: 'testing' },
        ],
      };

      await new CapitalistStrategy().execute(ctx, assignment({
        meta: {
          bid: bid({ priceTokens: 100 }),
          firm,
          warrantyRepair: { requiredChanges: ['Add a regression test for YAML comments.'] },
        },
      }));

      const subPrompt = (dispatch.mock.calls as unknown as Array<[{ personaId?: string; userPrompt?: string }]>)
        .find(([opts]) => opts.personaId === 'bidder-2')?.[0].userPrompt;
      expect(subPrompt).toContain('composition() rejects valid YAML with comments.');
      expect(subPrompt).toContain('Add a regression test for YAML comments.');
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('accepts sound work that breached only its spend cap, settling the breach commercially', async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'capitalist-cap-breach-test-'));
    try {
      const strategyState = settledState();
      strategyState.contractTerms.task = {
        type: 'time-and-materials', retentionFraction: 0.2, warrantyPeriodTasks: 1, spendCapMultiple: 0.01,
        competingSuppliers: 1, risk: '', rationale: '',
      };
      strategyState.consumption.task = { ...emptyConsumption('task', 'low'), modelSpendUsd: 5, dispatches: 4 };
      const ctx = createContext(tmpRoot, { strategyState });

      const decision = await new CapitalistStrategy().decide(ctx, product(), review({ ran: true, passed: true }));

      expect(decision.outcome).toBe('approved');
      expect(decision.rationale).toContain('the contract consumed past its agreed spend cap');
      expect(ctx.ledger.readAll().some((event) => event.type === 'spend_cap_breached')).toBe(true);
      expect(strategyState.capitalAccounts['bidder-1']).toMatchObject({ heldEscrow: 0, defects: 1 });
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  // The reviewer said the approach was fundamentally wrong. Handing the same firm the same work under
  // warranty starts the repair from that approach, so the listing goes to re-tender instead.
  it('re-tenders a fundamentally wrong first delivery instead of returning it under warranty', async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'capitalist-wrong-approach-test-'));
    try {
      const strategyState = settledState();
      const ctx = createContext(tmpRoot, { strategyState });
      ctx.runState.graph!.nodes.task.attempts = [recordedAttempt(1)];
      const request = recoveryRequest();
      request.decision.meta = { ...request.decision.meta, warrantyBarred: true };

      await new CapitalistStrategy().recover(ctx, request);

      expect(strategyState.warrantyRepairs.task).toBeUndefined();
      expect(strategyState.excludedContractors.task).toEqual(['bidder-1']);
      expect(strategyState.retenderRequiredChanges.task).toEqual([
        { attempt: 1, requiredChanges: ['Fix the failing assertion and add regression coverage.'] },
      ]);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  // Warranty covers a contract's first failure. A listing reopened by remediation after it was
  // accepted is a new contract on accepted work; counting the attempts before the acceptance meant
  // it could never have one. A transient provider failure is not a failure of the contract either.
  it.each([
    ['the first failure after a remediation reopen', [recordedAttempt(1), recordedAttempt(2, 'approved'), recordedAttempt(3)], 3, true],
    ['a failure after a transient attempt', [recordedAttempt(1, 'rework', { transient: true }), recordedAttempt(2)], 2, true],
    ['the second failure after a reopen', [recordedAttempt(1, 'approved'), recordedAttempt(2), recordedAttempt(3)], 3, false],
  ] as const)('decides warranty for %s', async (_label, attempts, attemptNumber, warranty) => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'capitalist-warranty-reopen-test-'));
    try {
      const strategyState = settledState();
      const ctx = createContext(tmpRoot, { strategyState });
      ctx.runState.graph!.nodes.task.attempts = [...attempts];

      await new CapitalistStrategy().recover(ctx, recoveryRequest({ attemptNumber }));

      expect(Boolean(strategyState.warrantyRepairs.task)).toBe(warranty);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  // A firm that wins a re-tender hears every recent round's required changes, labelled, so it does
  // not undo a fix an earlier round made. Bidders get a clipped summary: they price, they don't fix.
  it('accumulates a bounded, labelled history of failed rounds for the re-tender', async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'capitalist-retender-history-test-'));
    try {
      const strategyState = settledState();
      const longChange = `Keep the nickel column. ${'x'.repeat(1000)}`;
      const dispatch = vi.fn(async (opts: { role?: string; userPrompt?: string }) => ({
        value: opts.role === 'bidder' ? bid({ priceTokens: 40 }) : { fileOps: [], rationale: 'done' },
        raw: '{}', model: 'fake', costUsd: 0,
      }));
      const ctx = createContext(tmpRoot, {
        strategyState,
        dispatcher: { dispatch } as unknown as WorkerDispatcher,
        config: { bidCount: 2, firms: { maxSubcontractors: 0 } },
      });
      const strategy = new CapitalistStrategy();
      const node = ctx.runState.graph!.nodes.task;
      const changesFor = (n: number) => (n === 3 ? [longChange] : [`Fix defect ${n}.`]);
      for (let n = 1; n <= 4; n += 1) {
        node.attempts.push(recordedAttempt(n));
        const request = recoveryRequest({ attemptNumber: n });
        request.decision.rework = { requiredChanges: changesFor(n) };
        await strategy.recover(ctx, request);
      }

      expect(strategyState.retenderRequiredChanges.task.map((round) => round.attempt)).toEqual([2, 3, 4]);

      node.phase = 'queued';
      const assignments = await strategy.assign(ctx, ctx.runState.graph!);
      const bidPrompt = dispatch.mock.calls[0]?.[0]?.userPrompt ?? '';
      expect(bidPrompt).toContain('(attempt 2) Fix defect 2.');
      expect(bidPrompt).toContain('(attempt 4) Fix defect 4.');
      expect(bidPrompt).toContain('(attempt 3) Keep the nickel column.');
      expect(bidPrompt).not.toContain(longChange);
      expect(assignments[0]?.meta?.retender).toEqual({
        requiredChanges: ['(attempt 2) Fix defect 2.', `(attempt 3) ${longChange}`, '(attempt 4) Fix defect 4.'],
      });
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('runs a firm\'s subcontractors concurrently on the lead\'s delivery, merging them in firm order', async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'capitalist-firm-concurrent-test-'));
    try {
      let inFlight = 0;
      let maxInFlight = 0;
      const outputs: Record<string, { fileOps: Array<{ op: 'write'; path: string; content: string }>; rationale: string }> = {
        'bidder-1': { fileOps: [{ op: 'write', path: 'src/feature.ts', content: 'lead\n' }], rationale: 'lead' },
        'bidder-2': { fileOps: [{ op: 'write', path: 'docs/shared.md', content: 'tests\n' }], rationale: 'tests' },
        'bidder-3': { fileOps: [{ op: 'write', path: 'docs/shared.md', content: 'docs\n' }], rationale: 'docs' },
      };
      const dispatch = vi.fn(async (opts: { personaId?: string }) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        // The test subcontractor finishes last; its operations must still merge first.
        await new Promise((resolve) => setTimeout(resolve, opts.personaId === 'bidder-2' ? 20 : 1));
        inFlight -= 1;
        return { value: outputs[opts.personaId!], raw: '{}', model: 'fake', costUsd: 0 };
      });
      const ctx = createContext(tmpRoot, { dispatcher: { dispatch } as unknown as WorkerDispatcher });
      const firm = {
        leadId: 'bidder-1',
        liableId: 'bidder-1',
        members: [
          { personaId: 'bidder-1', role: 'lead' as const, capability: 'lead' },
          { personaId: 'bidder-2', role: 'test' as const, capability: 'testing' },
          { personaId: 'bidder-3', role: 'documentation' as const, capability: 'documentation' },
        ],
      };

      const result = await new CapitalistStrategy().execute(ctx, assignment({ meta: { bid: bid(), firm } }));

      expect(maxInFlight).toBe(2);
      expect(result.fileOps).toEqual([...outputs['bidder-1'].fileOps, ...outputs['bidder-2'].fileOps]);
      expect(result.unresolvedUncertainty).toContain('bidder-3 (documentation) attempted to rewrite docs/shared.md');
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('hears independent disputes together on one fetch of the diff', async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'capitalist-arbitration-concurrent-test-'));
    try {
      let inFlight = 0;
      let maxInFlight = 0;
      const dispatch = vi.fn(async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return {
          value: { ruling: 'supplier', rationale: 'runner never started', liableParty: 'buyer', evidenceCited: ['npm test output'] },
          raw: '{}', model: 'fake', costUsd: 0,
        };
      });
      const diff = vi.fn(async () => ({ diffText: '+++ b/src/feature.ts' }));
      const strategyState = settledState();
      const ctx = createContext(tmpRoot, {
        strategyState,
        dispatcher: { dispatch } as unknown as WorkerDispatcher,
        worktree: { diff } as unknown as RepoWorktree,
      });
      const disputed = review({ ran: true, passed: false, output: 'Error: spawn npm ENOENT' });
      disputed.findings[1] = { reviewerId: 'regulator', verdict: 'flag', rationale: 'outside scope', evidenceRefs: ['deploy/x.yaml'] };

      const decision = await new CapitalistStrategy().decide(ctx, product(), disputed);

      expect(dispatch).toHaveBeenCalledTimes(2);
      expect(maxInFlight).toBe(2);
      expect(diff).toHaveBeenCalledTimes(1);
      expect(strategyState.arbitrations).toBe(2);
      expect(ctx.ledger.readAll().filter((e) => e.type === 'arbitration_ruled').map((e) => e.data.matter))
        .toEqual(['regression-cause', 'scope-change']);
      // Both rulings went to the supplier: the regression ruling lifts the test block. The scope flag
      // itself still stands — a ruling decides liability, not whether the regulator flagged.
      expect(decision.meta?.supplierLiable).toBe(false);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('requires human approval only for needs_human decisions', () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'capitalist-approval-test-'));
    try {
      const ctx = createContext(tmpRoot);
      const strategy = new CapitalistStrategy();
      // `outcome` is a widened runtime parameter, so it can't narrow against Decision's
      // discriminated union; this test never constructs a 'rework' outcome, so the cast is safe.
      const makeDecision = (outcome: Decision['outcome']): Decision =>
        ({ taskId: 'task', outcome, rationale: outcome, evidenceRefs: [] }) as Decision;

      expect(strategy.requiresHumanApproval(ctx, makeDecision('needs_human'))).toBe(true);
      expect(strategy.requiresHumanApproval(ctx, makeDecision('approved'))).toBe(false);
      expect(strategy.requiresHumanApproval(ctx, makeDecision('rejected'))).toBe(false);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe('the constitutional gate at acceptance', () => {
  function delivery(overrides: Partial<DeliveryPacket> = {}): DeliveryPacket {
    return {
      runId: 'test-run',
      strategy: 'capitalist',
      goal: 'Implement feature',
      acceptanceCriteria: ['works'],
      changedFiles: ['src/feature.ts'],
      diffText: '',
      decisions: [],
      requirementMatrix: [{ criterion: 'works', command: 'npm test', expectedResult: 'exit 0', status: 'satisfied' }],
      finalChecks: [],
      findings: [],
      limitations: [],
      residualRisks: [],
      rollbackNotes: [],
      integrationEvidence: {
        integratorId: 'integration-assessor',
        integrated: true,
        postIntegrationChecks: [],
        findings: [],
        rationale: 'Assembled cleanly.',
      },
      independentVerification: {
        verifierId: 'contractual-assessor',
        verified: true,
        criteriaTraced: ['works'],
        findings: [],
        rationale: 'Traced.',
      },
      assembledAt: '2026-01-01T00:00:00.000Z',
      ...overrides,
    } as DeliveryPacket;
  }

  function stateWith(over: Partial<CapitalistStrategyState> = {}): CapitalistStrategyState {
    return {
      capitalAccounts: {},
      pendingEscrow: {},
      approvals: {},
      warrantyRepairs: {},
      retenderRequiredChanges: {},
      excludedContractors: {},
      settlementDecisions: {},
      recentWinners: [],
      register: { contractors: { task: 'firm-a' }, assessors: { task: 'assessor-1' }, subcontractors: {} },
      regulatorActions: [],
      bidRecords: {},
      consumption: {},
      contractTerms: {},
      reserve: openReserve(),
      creditBook: openCreditBook(),
      treasury: openTreasury(),
      treasuryBalance: 0,
      arbitrations: 0,
    arbitrationsDeclined: 0,
    unfilledListings: [],
      insured: {},
      settled: [{ taskId: 'task', personaId: 'firm-a', price: 100, resourceCost: 40 }],
      levied: ['task'],
      ...over,
    };
  }

  const checksConfig = { categories: [], testPathGlobs: [] } as unknown as EngineContext['checks'];

  async function acceptWith(state: CapitalistStrategyState, packet = delivery()) {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'capitalist-gate-test-'));
    try {
      const ctx = createContext(tmpRoot, { strategyState: state });
      (ctx as { checks: EngineContext['checks'] }).checks = checksConfig;
      return await new CapitalistStrategy().accept(ctx, packet);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  }

  it('releases escrow when the market kept to its own constitution', async () => {
    const result = await acceptWith(stateWith());
    expect(result.accepted).toBe(true);
  });

  // Article 4: a delivery certified by the firm that was paid for it has not been assessed at all,
  // and no amount of commercial agreement between buyer and seller can supply the missing check.
  it('refuses escrow when the firm that was paid also certified the work', async () => {
    const result = await acceptWith(
      stateWith({ register: { contractors: { task: 'firm-a' }, assessors: { task: 'firm-a' }, subcontractors: {} } }),
    );
    expect(result.accepted).toBe(false);
    expect(result.rationale).toContain('article 4');
    expect(result.rationale).toContain('self-dealing');
  });

  it('refuses escrow when one party integrated and then verified the assembled product', async () => {
    const packet = delivery({
      independentVerification: {
        verifierId: 'integration-assessor',
        verified: true,
        criteriaTraced: ['works'],
        findings: [],
        rationale: 'Traced.',
      },
    });
    const result = await acceptWith(stateWith(), packet);
    expect(result.accepted).toBe(false);
    expect(result.rationale).toContain('essential facilities');
  });

  // Article 10 binds the enforcer, not only the firms. A regulator inventing its own grounds is
  // the capture section 14 warns about, and the acceptance would rest on an unauthorised act.
  it('refuses escrow when the regulator blocked on a ground it never published', async () => {
    const result = await acceptWith(
      stateWith({ regulatorActions: [{ taskId: 'task', ground: 'the buyer preferred otherwise', rationale: 'no reason' }] }),
    );
    expect(result.accepted).toBe(false);
    expect(result.rationale).toContain('article 10');
  });

  it('lets a regulator block on a published ground stand without failing the gate', async () => {
    const result = await acceptWith(
      stateWith({ regulatorActions: [{ taskId: 'task', ground: 'contract-breach', rationale: 'out of scope' }] }),
    );
    expect(result.accepted).toBe(true);
  });

  // The reported articles are deliberately not blocking: their remedies are to record, collect or
  // redraw, and refusing sound work over an accounting gap would be its own kind of waste.
  it('records concentration, unpriced consumption and free-riding without refusing the delivery', async () => {
    const result = await acceptWith(
      stateWith({
        register: {
          contractors: { task: 'firm-a', 'task-2': 'firm-a' },
          assessors: { task: 'assessor-1', 'task-2': 'assessor-2' },
          subcontractors: {},
        },
        settled: [
          { taskId: 'task', personaId: 'firm-a', price: 100 },
          { taskId: 'task-2', personaId: 'firm-a', price: 50 },
        ],
        levied: [],
      }),
    );
    expect(result.accepted).toBe(true);
  });
});

describe('the market report reaches the packet', () => {
  const checksConfig = { categories: [], testPathGlobs: [] } as unknown as EngineContext['checks'];

  // Regression. disposeFindings used to return early when there was nothing to dispose, before the
  // report was filed — so the tidier the run, the less it disclosed, and a flawless run's delivery
  // packet carried nothing at all. Found by running the smoke test, not by the unit suite: scenario
  // 1 reached acceptance with no findings and filed no account of itself.
  it('files an account even when there are no findings to dispose', async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'capitalist-report-clean-test-'));
    try {
      const strategyState = settledState();
      strategyState.settled = [{ taskId: 'task', personaId: 'bidder-1', price: 100, resourceCost: 40 }];
      strategyState.levied = [];
      const ctx = createContext(tmpRoot, { strategyState });
      (ctx as { checks: EngineContext['checks'] }).checks = checksConfig;

      const disposed = await new CapitalistStrategy().disposeFindings(ctx, []);

      expect(disposed).toEqual([]);
      expect(ctx.ledger.readAll().some((e) => e.type === 'market_report')).toBe(true);
      // The notes are the only channel a market has for disclosing anything that is neither a check
      // result nor a finding, and on a clean run that is all of it.
      const notes = strategyState.deliveryNotes;
      expect(notes).toBeDefined();
      expect(notes!.rollbackNotes.join(' ')).toContain('Closing positions at settlement');
      // A contract that settled without paying its levy is free-riding, and stays disclosed whether
      // or not anything else went wrong.
      expect(notes!.limitations.join(' ')).toContain('free-riding');
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe('CapitalistStrategy safety floor (article 11)', () => {
  it('marks what the integration assessor finds on non-waivable ground', async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'capitalist-floor-'));
    try {
      const ctx = createContext(tmpRoot, {
        dispatcher: {
          dispatch: vi.fn(async () => ({
            value: {
              integrated: true,
              rationale: 'Assembled.',
              findings: [
                { summary: 'A secret is committed in config.', evidence: 'config.yaml', severity: 'high' },
                { summary: 'This helper could be simpler.', evidence: 'app/util.py', severity: 'low' },
              ],
            },
            raw: '{}',
            model: 'fake',
            costUsd: 0,
          })),
        } as unknown as WorkerDispatcher,
      });

      const result = await new CapitalistStrategy().integrate(ctx, [], 'diff');

      expect(result.findings.map((f) => f.nonWaivable === true)).toEqual([true, false]);
      expect(result.findings[0]!.summary).toMatch(/^On non-waivable ground \(security, article 11\)/);
      expect(ctx.ledger.readAll().some((e) => e.type === 'safety_floor_applied')).toBe(true);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
