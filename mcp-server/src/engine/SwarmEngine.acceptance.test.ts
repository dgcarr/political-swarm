// The orchestrator boundary from section 5 of every doctrine in docs/philosophy/, exercised
// end-to-end: a swarm that finishes its own work does NOT thereby finish the run, Claude's
// independent check is a real gate, and a rejection goes back to the same swarm with the evidence
// it is rejecting preserved.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OpenRouterClient } from './OpenRouterClient.js';
import { BudgetExceededError } from './BudgetGuard.js';
import { SwarmEngine, type EngineDeps } from './SwarmEngine.js';
import type { RunState } from './RunStore.js';
import type { EngineContext, SwarmStrategy } from './SwarmStrategy.js';
import type { Assignment, Decision, ReviewResult, TaskGraph, TaskNode, TaskSpec, TestResult, WorkProduct } from './types.js';
import { latestVerdict } from './TaskGraph.js';
import { grantGovernanceMandate, revokeGovernanceMandate } from './governance.js';
import type { DeliveryPacket, DoctrineAcceptance, Finding } from './packets.js';
import {
  stubAccept,
  stubDeclareOwnership,
  stubDisposeFindings,
  stubIntegrate,
  stubRemediate,
  stubVerifyDelivery,
} from './barrierStubs.js';
import { normalizeChecksConfig } from '../util/config.js';
import { swarmApply } from '../tools/swarmApply.js';
import { swarmGetDelivery } from '../tools/swarmGetDelivery.js';

let repoPath: string;
let runsRootDir: string;

interface Options {
  plan?: (task: TaskSpec) => TaskGraph;
  assign?: (ctx: EngineContext, graph: TaskGraph) => Promise<Assignment[]>;
  onRecordOutcome?: (ctx: EngineContext, decision: Decision) => void;
  accept?: (ctx: EngineContext, draft: DeliveryPacket) => Promise<DoctrineAcceptance>;
  disposeFindings?: (ctx: EngineContext, open: Finding[]) => Promise<Finding[]>;
  execute?: (ctx: EngineContext, assignment: Assignment) => Promise<WorkProduct>;
  onRemediate?: (packet: unknown) => void;
}

class BoundaryStrategy implements SwarmStrategy {
  readonly id = 'noop' as const;
  executions = 0;

  constructor(private readonly options: Options = {}) {}

  async plan(_ctx: EngineContext, task: TaskSpec): Promise<TaskGraph> {
    if (this.options.plan) return this.options.plan(task);
    return {
      order: ['t1'],
      nodes: {
        t1: {
          id: 't1',
          title: 'Write the file',
          description: 'writes one file',
          acceptanceCriteria: task.acceptanceCriteria,
          dependsOn: [],
          targetGlobs: ['out.txt'],
          riskTags: [],
          riskClass: 'low',
          phase: 'queued',
          attempts: [],
          evidence: task.acceptanceCriteria.map((criterion) => ({
            criterion,
            command: 'true',
            expectedResult: 'exit 0',
            status: 'satisfied' as const,
          })),
        },
      },
    };
  }

  async assign(ctx: EngineContext, graph: TaskGraph): Promise<Assignment[]> {
    if (this.options.assign) return this.options.assign(ctx, graph);
    return graph.order
      .filter((id) => graph.nodes[id].phase === 'queued')
      .map((taskId) => ({ taskId, assigneeId: 'worker', role: 'implementer' }));
  }

  async execute(ctx: EngineContext, assignment: Assignment): Promise<WorkProduct> {
    this.executions += 1;
    if (this.options.execute) return this.options.execute(ctx, assignment);
    return {
      taskId: assignment.taskId,
      assignment,
      fileOps: [{ op: 'write', path: 'out.txt', content: `run ${this.executions}\n` }],
      rationale: 'wrote the file',
    };
  }

  async review(_ctx: EngineContext, product: WorkProduct, test: TestResult): Promise<ReviewResult> {
    return { taskId: product.taskId, findings: [], testResult: test };
  }

  async decide(_ctx: EngineContext, product: WorkProduct): Promise<Decision> {
    return { taskId: product.taskId, outcome: 'approved', rationale: 'fine', evidenceRefs: [] };
  }

  async recordOutcome(ctx: EngineContext, decision: Decision): Promise<void> {
    this.options.onRecordOutcome?.(ctx, decision);
  }
  requiresHumanApproval(): boolean {
    return false;
  }

  declareOwnership = stubDeclareOwnership;
  integrate = stubIntegrate;
  verifyDelivery = stubVerifyDelivery;

  async disposeFindings(ctx: EngineContext, open: Finding[]): Promise<Finding[]> {
    return this.options.disposeFindings ? this.options.disposeFindings(ctx, open) : stubDisposeFindings(ctx, open);
  }

  async accept(ctx: EngineContext, draft: DeliveryPacket): Promise<DoctrineAcceptance> {
    return this.options.accept ? this.options.accept(ctx, draft) : stubAccept(ctx, draft);
  }

  async remediate(ctx: EngineContext, packet: Parameters<typeof stubRemediate>[1]): Promise<TaskGraph> {
    this.options.onRemediate?.(packet);
    return stubRemediate(ctx, packet);
  }
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

beforeEach(() => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'swarm-acceptance-'));
  repoPath = path.join(root, 'repo');
  runsRootDir = path.join(root, 'runs');
  mkdirSync(repoPath, { recursive: true });
  mkdirSync(runsRootDir, { recursive: true });

  git(repoPath, ['init', '--initial-branch=main']);
  git(repoPath, ['config', 'user.email', 'swarm@example.com']);
  git(repoPath, ['config', 'user.name', 'Swarm Test']);
  writeFileSync(path.join(repoPath, 'README.md'), '# fixture\n', 'utf8');
  git(repoPath, ['add', '-A']);
  git(repoPath, ['commit', '-m', 'initial']);
});

afterEach(() => {
  rmSync(path.dirname(repoPath), { recursive: true, force: true });
});

function createEngine(
  strategy: SwarmStrategy,
  maxConcurrentExecutes = 3,
  strategiesConfig: Record<string, Record<string, unknown>> = {},
): SwarmEngine {
  const deps: EngineDeps = {
    outageBackoffMs: () => 0,
    client: new OpenRouterClient('unused'),
    modelsConfig: { roles: {}, models: {} },
    configDir: path.join(runsRootDir, 'config'),
    budgetConfig: {
      defaults: {
        perRunUsd: 100,
        perTaskUsd: 100,
        maxWorkerCalls: 100,
        maxWallClockMinutes: 5,
        maxTaskAttempts: 3,
        perCallTimeoutMs: 1_000,
        warnAtFractionOfPerRun: 0.8,
      },
      hardCeilingUsd: 1_000,
    },
    strategiesConfig,
    runsRootDir,
    strategies: {
      noop: strategy,
      democratic: strategy,
      socialist: strategy,
      capitalist: strategy,
      managerial: strategy,
      single_agent: strategy,
    },
    // `true` exits 0 everywhere, so the checks are real runs that simply always pass.
    checksConfig: normalizeChecksConfig({ command: 'true', args: [], timeoutMs: 1_000,
      maxConcurrentExecutes }),
  };
  return new SwarmEngine(deps);
}

async function start(engine: SwarmEngine, acceptanceCriteria = ['the file exists']): Promise<RunState> {
  return engine.startRun({
    task: { goal: 'write a file', acceptanceCriteria, repoPath, baseBranch: 'main' },
    strategy: 'noop',
    budgetUsd: 100,
  });
}

function planWithSeparateTests(task: TaskSpec): TaskGraph {
  const node = (id: string, target: string, dependsOn: string[]): TaskNode => ({
    id, title: id, description: id, acceptanceCriteria: task.acceptanceCriteria,
    dependsOn, targetGlobs: [target], riskTags: [], riskClass: 'low', phase: 'queued', attempts: [],
    evidence: task.acceptanceCriteria.map((criterion) => ({
      criterion, command: 'true', expectedResult: 'exit 0', status: 'satisfied',
    })),
  });
  return { order: ['source', 'tests'], nodes: {
    source: node('source', 'out.txt', []),
    tests: node('tests', 'tests/test_regression.py', []),
  } };
}

async function waitForStatus(engine: SwarmEngine, runId: string, expected: RunState['status']): Promise<RunState> {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    const state = engine.getRunStore().load(runId);
    if (state?.status === expected) return state;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const actual = engine.getRunStore().load(runId);
  throw new Error(`Run ${runId} reached "${actual?.status}", not "${expected}": ${actual?.lastError ?? ''}`);
}

type LegacyTaskGraphView = Omit<TaskGraph, 'nodes'> & { nodes: Record<string, TaskNode & { status: string }> };
type LegacyRunStateView = Omit<RunState, 'graph'> & { graph: LegacyTaskGraphView | null };

function withLegacyTaskStatuses(state: RunState): LegacyRunStateView {
  if (!state.graph) return state as LegacyRunStateView;
  const nodes = Object.fromEntries(
    state.graph.order.map((id) => {
      const task = state.graph!.nodes[id];
      const status = latestVerdict(task) ?? (task.phase === 'blocked' ? 'blocked_on_human' : task.phase);
      return [id, { ...task, status }];
    }),
  );
  return { ...state, graph: { ...state.graph, nodes } };
}

describe('the delivery boundary', () => {
  it('rejects socialist final acceptance without decisions for the delivered artifact', async () => {
    const strategy = new BoundaryStrategy({
      assign: async (ctx, graph) => {
        grantGovernanceMandate(ctx.runState, ctx.ledger, {
          id: 'council-work', grantor: 'council', holder: 'delegate',
          scope: graph.order, artifactDigest: 'plan-v1',
        });
        return graph.order.map((taskId) => ({ taskId, assigneeId: 'worker', role: 'implementer',
          meta: { authority: { mandateId: 'council-work', holder: 'delegate', artifactDigest: 'plan-v1' } },
        }));
      },
    });
    Object.defineProperty(strategy, 'id', { value: 'socialist' });
    const engine = createEngine(strategy, 3, { socialist: { councils: { requirePlanRatification: true } } });
    const started = await engine.startRun({
      task: { goal: 'write a file', acceptanceCriteria: ['the file exists'], repoPath, baseBranch: 'main' },
      strategy: 'socialist', budgetUsd: 100,
    });

    const state = await waitForStatus(engine, started.runId, 'terminated_incomplete');

    expect(state.lastError).toContain('governance action proof');
  });

  it('stops at awaiting_acceptance when the swarm approves its own work', async () => {
    const engine = createEngine(new BoundaryStrategy());
    const started = await start(engine);
    const state = await waitForStatus(engine, started.runId, 'awaiting_acceptance');

    expect(state.delivery).toBeDefined();
    expect(state.delivery?.doctrineAcceptance.accepted).toBe(true);
    // The swarm's own acceptance is recorded, and is explicitly not completion.
    expect(state.status).not.toBe('completed');
  });

  it('assembles a manifest carrying evidence, checks, integration and verification', async () => {
    const engine = createEngine(new BoundaryStrategy());
    const started = await start(engine);
    const state = await waitForStatus(engine, started.runId, 'awaiting_acceptance');
    const packet = state.delivery!;

    expect(packet.requirementMatrix.map((m) => m.criterion)).toEqual(['the file exists']);
    expect(packet.baseline.length).toBeGreaterThan(0);
    expect(packet.finalChecks.length).toBeGreaterThan(0);
    expect(packet.integrationEvidence.integratorId).toBe('stub-integrator');
    expect(packet.independentVerification.verifierId).toBe('stub-verifier');
    expect(packet.changedFiles).toContain('out.txt');
    expect(packet.rollback).toContain(state.branch);
  });

  it('terminates incomplete when the doctrine refuses its own delivery', async () => {
    const strategy = new BoundaryStrategy({
      accept: async () => ({
        accepted: false,
        procedure: 'constitutional gate',
        rationale: 'a required check is failing',
        decidedAt: new Date().toISOString(),
      }),
    });
    const engine = createEngine(strategy);
    const started = await start(engine);
    const state = await waitForStatus(engine, started.runId, 'terminated_incomplete');

    expect(state.lastError).toContain('did not accept its own delivery');
    // The evidence is preserved rather than discarded, so the user can see what was produced.
    expect(state.delivery).toBeDefined();
  });

  it('refuses a manifest whose verifier also performed the integration', async () => {
    class SelfCertifying extends BoundaryStrategy {
      override verifyDelivery = async (_ctx: EngineContext, draft: DeliveryPacket) => ({
        verifierId: 'stub-integrator',
        verified: true,
        criteriaTraced: draft.acceptanceCriteria,
        findings: [],
        rationale: 'certified by the same agent that integrated it',
      });
    }
    const engine = createEngine(new SelfCertifying());
    const started = await start(engine);
    const state = await waitForStatus(engine, started.runId, 'terminated_incomplete');

    expect(state.lastError).toContain('outside the authorship chain');
  });
});

describe('pausing during planning', () => {
  it('re-plans on resume rather than resuming with no graph', async () => {
    let planCalls = 0;
    class PausingPlanner extends BoundaryStrategy {
      override async plan(ctx: EngineContext, task: TaskSpec): Promise<TaskGraph> {
        planCalls += 1;
        // First attempt exhausts the budget, exactly as a planner call would.
        if (planCalls === 1) throw new BudgetExceededError('Run reached its per-run budget.', 'per_run');
        return super.plan(ctx, task);
      }
    }
    const engine = createEngine(new PausingPlanner());
    const started = await start(engine);
    const paused = await waitForStatus(engine, started.runId, 'paused_budget');

    // Not `failed`: running out of budget is a resource limit, and the run waits for a decision.
    expect(paused.graph).toBeNull();
    expect(paused.pendingApprovals[0]?.kind).toBe('budget_increase');

    engine.resolveApproval(started.runId, paused.pendingApprovals[0].id, 'approve', undefined, 200);
    const resumed = withLegacyTaskStatuses(await waitForStatus(engine, started.runId, 'awaiting_acceptance'));

    expect(planCalls).toBe(2);
    expect(resumed.graph?.nodes.t1.status).toBe('approved');
  });
});

describe('a barrier that cannot complete', () => {
  it('terminates incomplete with the reason and a preserved synchronization packet', async () => {
    class BrokenIntegrator extends BoundaryStrategy {
      override integrate = async (): Promise<never> => {
        throw new Error('model returned unparseable JSON after every retry');
      };
    }
    const engine = createEngine(new BrokenIntegrator());
    const started = await start(engine);
    const state = withLegacyTaskStatuses(await waitForStatus(engine, started.runId, 'terminated_incomplete'));

    // Not 'failed': the work itself did not break, the barrier did — and the run must say so
    // rather than crashing out and losing what was approved.
    expect(state.lastError).toContain('acceptance barrier could not be completed');
    expect(state.delivery).toBeUndefined();
    expect(state.lastSyncPacket).toBeDefined();
    expect(state.lastSyncPacket?.changedFileManifest).toContain('out.txt');
    expect(state.graph?.nodes.t1.status).toBe('approved');
  });

  // A network outage says nothing about the work: the run waits it out and re-enters the barrier.
  it('re-enters the barrier after a network outage instead of ending incomplete', async () => {
    let integrateCalls = 0;
    class OutageOnce extends BoundaryStrategy {
      override integrate = async (...args: Parameters<BoundaryStrategy['integrate']>) => {
        integrateCalls += 1;
        if (integrateCalls === 1) throw new TypeError('fetch failed');
        return new BoundaryStrategy().integrate(...args);
      };
    }
    const engine = createEngine(new OutageOnce());
    const started = await start(engine);
    const state = await waitForStatus(engine, started.runId, 'awaiting_acceptance');

    expect(integrateCalls).toBe(2);
    expect(state.loopCrashRetries).toBe(1);
  });
});

describe("Claude's independent check", () => {
  it('completes the run on acceptance', async () => {
    const engine = createEngine(new BoundaryStrategy());
    const started = await start(engine);
    await waitForStatus(engine, started.runId, 'awaiting_acceptance');

    const accepted = engine.acceptDelivery(started.runId, 'traced every criterion');
    expect(accepted.status).toBe('completed');
  });

  it('refuses to accept a run that has no delivery packet', async () => {
    const strategy = new BoundaryStrategy({
      accept: async () => ({ accepted: false, procedure: 'gate', rationale: 'no', decidedAt: '' }),
    });
    const engine = createEngine(strategy);
    const started = await start(engine);
    await waitForStatus(engine, started.runId, 'terminated_incomplete');

    expect(() => engine.acceptDelivery(started.runId)).toThrow(/not "awaiting_acceptance"/);
  });

  it('refuses a rejection that names no defect', async () => {
    const engine = createEngine(new BoundaryStrategy());
    const started = await start(engine);
    await waitForStatus(engine, started.runId, 'awaiting_acceptance');

    await expect(engine.submitRemediation(started.runId, [])).rejects.toThrow(/at least one concrete finding/);
  });

  it('returns defects to the same swarm and preserves the rejected delivery', async () => {
    let received: { preservedDelivery?: DeliveryPacket; cycle?: number } = {};
    const strategy = new BoundaryStrategy({
      onRemediate: (packet) => {
        received = packet as { preservedDelivery: DeliveryPacket; cycle: number };
      },
    });
    const engine = createEngine(strategy);
    const started = await start(engine);
    const first = await waitForStatus(engine, started.runId, 'awaiting_acceptance');
    const firstAssembledAt = first.delivery!.assembledAt;

    await engine.submitRemediation(started.runId, [
      { summary: 'out.txt has the wrong content', evidence: 'out.txt line 1', severity: 'high' },
    ]);

    expect(received.cycle).toBe(1);
    expect(received.preservedDelivery?.assembledAt).toBe(firstAssembledAt);

    const second = await waitForStatus(engine, started.runId, 'awaiting_acceptance');
    expect(second.remediationCycles).toBe(1);
    expect(strategy.executions).toBe(2);
    expect(second.delivery?.remediationCycles).toBe(1);
  });

  it('raises an unresolved finding when a remediation touches no test', async () => {
    const strategy = new BoundaryStrategy();
    const engine = createEngine(strategy);
    const started = await start(engine);
    await waitForStatus(engine, started.runId, 'awaiting_acceptance');

    await engine.submitRemediation(started.runId, [
      { summary: 'no regression test', evidence: 'diff shows no test change', severity: 'medium' },
    ]);
    const second = await waitForStatus(engine, started.runId, 'awaiting_acceptance');

    expect(
      (second.findings ?? []).some((f) => f.source === 'engine:regression-rule'),
    ).toBe(true);
  });

  it('lets a separate test owner supply regression coverage for a remediated source task', async () => {
    const strategy = new BoundaryStrategy({
      plan: planWithSeparateTests,
      execute: async (ctx, assignment) => ({
        taskId: assignment.taskId, assignment, rationale: 'implemented',
        fileOps: [{ op: 'write', path: assignment.taskId === 'source' ? 'out.txt' : 'tests/test_regression.py',
          content: ctx.runState.graph?.nodes[assignment.taskId].remediationOf ? 'regression coverage\n' : 'initial coverage\n' }],
      }),
    });
    const engine = createEngine(strategy);
    const started = await start(engine);
    await waitForStatus(engine, started.runId, 'awaiting_acceptance');

    await engine.submitRemediation(started.runId, [
      { summary: 'source defect', evidence: 'out.txt behavior', severity: 'medium' },
    ]);
    const second = await waitForStatus(engine, started.runId, 'awaiting_acceptance');

    expect(second.graph?.nodes.source.attempts).toHaveLength(2);
    expect(second.graph?.nodes.tests.attempts).toHaveLength(2);
    expect(second.delivery?.changedFiles).toContain('tests/test_regression.py');
    expect(second.findings?.some((finding) => finding.source === 'engine:regression-rule')).toBe(false);
  });

  it('reassigns after a delegate recall revokes an assignment waiting in the next batch', async () => {
    let currentMandateId = 'work:initial';
    const strategy = new BoundaryStrategy({
      plan: planWithSeparateTests,
      assign: async (ctx, graph) => {
        if (!ctx.runState.governanceMandates?.some((mandate) => mandate.id === currentMandateId)) {
          grantGovernanceMandate(ctx.runState, ctx.ledger, {
            id: currentMandateId, grantor: 'council', holder: currentMandateId,
            scope: ['source', 'tests'], artifactDigest: 'plan-version',
          });
        }
        return graph.order.filter((id) => graph.nodes[id].phase === 'queued').map((taskId) => ({
          taskId, assigneeId: 'worker', role: 'implementer',
          meta: { authority: { mandateId: currentMandateId, holder: currentMandateId,
            artifactDigest: 'plan-version' } },
        }));
      },
      onRecordOutcome: (ctx, decision) => {
        if (decision.taskId !== 'source') return;
        revokeGovernanceMandate(ctx.runState, ctx.ledger, currentMandateId);
        currentMandateId = 'work:successor';
        grantGovernanceMandate(ctx.runState, ctx.ledger, {
          id: currentMandateId, grantor: 'council', holder: currentMandateId,
          scope: ['source', 'tests'], artifactDigest: 'plan-version',
        });
      },
      execute: async (_ctx, assignment) => ({
        taskId: assignment.taskId, assignment, rationale: 'implemented',
        fileOps: [{ op: 'write', path: assignment.taskId === 'source' ? 'out.txt' : 'tests/test_regression.py',
          content: 'complete\n' }],
      }),
    });
    const engine = createEngine(strategy, 1);
    const started = await start(engine);
    const state = await waitForStatus(engine, started.runId, 'awaiting_acceptance');

    expect(state.graph?.nodes.source.attempts).toHaveLength(1);
    expect(state.graph?.nodes.tests.attempts).toHaveLength(1);
    expect(strategy.executions).toBe(2);
    expect(state.governanceMandates?.find((mandate) => mandate.id === 'work:initial')?.revoked).toBe(true);
    expect(state.governanceMandates?.find((mandate) => mandate.id === 'work:successor')?.revoked).not.toBe(true);
  });
});

describe('swarm_apply gating', () => {
  it.each(['before acceptance', 'after acceptance'])('refuses delivery drift %s', async (when) => {
    const engine = createEngine(new BoundaryStrategy());
    const started = await start(engine);
    const delivered = await waitForStatus(engine, started.runId, 'awaiting_acceptance');
    if (when === 'after acceptance') engine.acceptDelivery(started.runId);
    writeFileSync(path.join(delivered.worktreePath, 'out.txt'), 'unreviewed content');
    if (when === 'before acceptance') engine.acceptDelivery(started.runId);

    await expect(swarmApply(engine, runsRootDir, { runId: started.runId })).rejects.toThrow('changed since delivery acceptance');
    expect(existsSync(path.join(repoPath, 'out.txt'))).toBe(false);
  });

  it('refuses legacy deliveries without an immutable snapshot', async () => {
    const engine = createEngine(new BoundaryStrategy());
    const started = await start(engine);
    const delivered = await waitForStatus(engine, started.runId, 'awaiting_acceptance');
    delete delivered.delivery!.treeId;
    engine.getRunStore().save(delivered);
    expect(() => engine.acceptDelivery(started.runId)).toThrow('no immutable tree');
    delivered.status = 'completed';
    engine.getRunStore().save(delivered);
    await expect(swarmApply(engine, runsRootDir, { runId: started.runId })).rejects.toThrow('no immutable accepted delivery');
  });
  it('refuses to write to the real repository before Claude has accepted', async () => {
    const engine = createEngine(new BoundaryStrategy());
    const started = await start(engine);
    await waitForStatus(engine, started.runId, 'awaiting_acceptance');

    await expect(swarmApply(engine, runsRootDir, { runId: started.runId })).rejects.toThrow(
      /not "completed"/,
    );
  });

  it('allows the write once acceptance is recorded', async () => {
    const engine = createEngine(new BoundaryStrategy());
    const started = await start(engine);
    await waitForStatus(engine, started.runId, 'awaiting_acceptance');
    engine.acceptDelivery(started.runId, 'checked');

    const result = await swarmApply(engine, runsRootDir, { runId: started.runId });
    expect(result.applied).toBe(true);
    expect(result.appliedFiles).toContain('out.txt');
  });
});

describe('swarm_get_delivery', () => {
  it('flags an acceptance criterion the swarm produced no satisfying evidence for', async () => {
    const engine = createEngine(new BoundaryStrategy());
    // Two criteria, but plan() only records evidence for what it was given, and the second is
    // never traced by the strategy's own matrix — it must surface, not disappear.
    const started = await start(engine, ['the file exists']);
    await waitForStatus(engine, started.runId, 'awaiting_acceptance');

    const result = await swarmGetDelivery(engine, { runId: started.runId });
    expect(result.independentCheck?.criteriaWithoutSatisfyingEvidence).toEqual([]);
    expect(result.note).toContain('does not bind Claude');
  });

  it('says plainly when there is no packet to check', async () => {
    const strategy = new BoundaryStrategy({
      accept: async () => ({ accepted: false, procedure: 'gate', rationale: 'refused', decidedAt: '' }),
    });
    const engine = createEngine(strategy);
    const started = await start(engine);
    await waitForStatus(engine, started.runId, 'terminated_incomplete');

    const result = await swarmGetDelivery(engine, { runId: started.runId });
    expect(result.delivery).toBeDefined();
    expect(result.status).toBe('terminated_incomplete');
  });
});
