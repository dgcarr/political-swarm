import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OpenRouterClient } from './OpenRouterClient.js';
import {
  summarizeRemediationOrigin,
  SwarmEngine,
  type EngineDeps,
} from './SwarmEngine.js';
import type { RunState } from './RunStore.js';
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
import type { DeliveryPacket, EvidenceItem, IntegrationResult } from './packets.js';
import { latestVerdict } from './TaskGraph.js';
import { normalizeChecksConfig } from '../util/config.js';
import {
  stubAccept,
  stubDeclareOwnership,
  stubDisposeFindings,
  stubIntegrate,
  stubRemediate,
  stubVerifyDelivery,
} from './barrierStubs.js';

type FakeStrategyOptions = {
  graph?: TaskGraph;
  execute?: (ctx: EngineContext, assignment: Assignment) => Promise<WorkProduct>;
  decide?: (ctx: EngineContext, product: WorkProduct, review: ReviewResult) => Promise<Decision>;
  evidence?: EvidenceItem[];
  integrate?: SwarmStrategy['integrate'];
  accept?: SwarmStrategy['accept'];
  remediate?: SwarmStrategy['remediate'];
};

class FakeStrategy implements SwarmStrategy {
  declareOwnership = stubDeclareOwnership;
  integrationCalls = 0;
  acceptanceCalls = 0;
  integrate: SwarmStrategy['integrate'] = async (...args) => {
    this.integrationCalls += 1;
    return (this.options.integrate ?? stubIntegrate)(...args);
  };
  verifyDelivery: SwarmStrategy['verifyDelivery'] = async (...args) => stubVerifyDelivery(...args);
  disposeFindings = stubDisposeFindings;
  accept: SwarmStrategy['accept'] = async (...args) => {
    this.acceptanceCalls += 1;
    return (this.options.accept ?? stubAccept)(...args);
  };
  remediate: SwarmStrategy['remediate'] = async (...args) => (this.options.remediate ?? stubRemediate)(...args);

  readonly id = 'noop' as const;

  constructor(private readonly options: FakeStrategyOptions = {}) {}

  async plan(ctx: EngineContext, task: TaskSpec): Promise<TaskGraph> {
    ctx.runState.evidence = (
      this.options.evidence ??
      task.acceptanceCriteria.map((criterion) => ({
        criterion,
        command: 'git status --short',
        expectedResult: 'The repository status check exits successfully.',
        status: 'unavailable' as const,
        note: 'check:unit',
      }))
    ).map((item) => ({ ...item }));
    return this.options.graph ?? graphFor(['task-1']);
  }

  async assign(_ctx: EngineContext, graph: TaskGraph): Promise<Assignment[]> {
    return graph.order
      .filter((taskId) => graph.nodes[taskId].phase === 'queued')
      .map((taskId) => ({ taskId, assigneeId: 'fake-worker', role: 'implementer' }));
  }

  async execute(ctx: EngineContext, assignment: Assignment): Promise<WorkProduct> {
    if (this.options.execute) return this.options.execute(ctx, assignment);
    return productFor(assignment);
  }

  async review(_ctx: EngineContext, product: WorkProduct, test: TestResult): Promise<ReviewResult> {
    return { taskId: product.taskId, findings: [], testResult: test };
  }

  async decide(ctx: EngineContext, product: WorkProduct, review: ReviewResult): Promise<Decision> {
    if (this.options.decide) return this.options.decide(ctx, product, review);
    return { taskId: product.taskId, outcome: 'approved', rationale: 'accepted', evidenceRefs: [] };
  }

  async recordOutcome(): Promise<void> {}
  requiresHumanApproval(): boolean {
    return false;
  }
}

let tmpRoot: string;
let repoPath: string;
let runsRootDir: string;

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'swarm-artifacts-test-'));
  repoPath = path.join(tmpRoot, 'repo');
  runsRootDir = path.join(tmpRoot, 'runs');
  mkdirSync(repoPath, { recursive: true });
  git(repoPath, ['init', '-q']);
  git(repoPath, ['config', 'user.email', 'test@example.com']);
  git(repoPath, ['config', 'user.name', 'Test']);
  writeFileSync(path.join(repoPath, 'initial.txt'), 'initial\n', 'utf8');
  git(repoPath, ['add', '-A']);
  git(repoPath, ['commit', '-q', '-m', 'initial']);
  git(repoPath, ['branch', '-M', 'main']);
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function graphFor(order: string[], dependencies: Record<string, string[]> = {}): TaskGraph {
  return {
    order,
    nodes: Object.fromEntries(
      order.map((id) => [
        id,
        {
          id,
          title: id,
          description: `Implement ${id}`,
          acceptanceCriteria: ['works'],
          dependsOn: dependencies[id] ?? [],
          targetGlobs: [`${id}.txt`],
          riskTags: [],
          riskClass: 'low' as const,
          phase: 'queued' as const,
          attempts: [],
        },
      ]),
    ),
  };
}

function productFor(assignment: Assignment): WorkProduct {
  return {
    taskId: assignment.taskId,
    assignment,
    fileOps: [{ op: 'write', path: `${assignment.taskId}.txt`, content: `${assignment.taskId}\n` }],
    rationale: 'fake implementation',
  };
}

function csvWritingChecks(): EngineDeps['finalOnlyChecks'] {
  return [
    {
      id: 'benchmark-cli',
      command: process.execPath,
      args: ['-e', "require('fs').writeFileSync('generated.csv', 'energy_MeV,xs\\n1,2\\n')"],
      required: true,
      timeoutMs: 5_000,
    },
  ];
}

function createEngine(
  strategy: SwarmStrategy,
  overrides: { finalOnlyChecks?: EngineDeps['finalOnlyChecks'] } = {},
): SwarmEngine {
  const deps: EngineDeps = {
    outageBackoffMs: () => 0,
    client: new OpenRouterClient('test-key'),
    modelsConfig: { roles: {}, models: {} },
    configDir: tmpRoot,
    budgetConfig: {
      defaults: {
        perRunUsd: 100,
        perTaskUsd: 100,
        maxWorkerCalls: 100,
        maxWallClockMinutes: 10,
        maxTaskAttempts: 3,
        perCallTimeoutMs: 1_000,
        warnAtFractionOfPerRun: 0.8,
      },
      hardCeilingUsd: 1_000,
    },
    strategiesConfig: {},
    runsRootDir,
    strategies: {
      noop: strategy,
      democratic: strategy,
      socialist: strategy,
      capitalist: strategy,
      managerial: strategy,
      single_agent: strategy,
    },
    checksConfig: normalizeChecksConfig({ command: 'git', args: ['status', '--short'], timeoutMs: 1_000 }),
    finalOnlyChecks: overrides.finalOnlyChecks,
  };
  return new SwarmEngine(deps);
}

async function start(engine: SwarmEngine): Promise<RunState> {
  return engine.startRun({
    task: { goal: 'characterize artifact boundary', acceptanceCriteria: ['done'], repoPath, baseBranch: 'main' },
    strategy: 'noop',
    budgetUsd: 100,
  });
}

async function waitForStatus(
  engine: SwarmEngine,
  runId: string,
  expected: RunState['status'],
): Promise<RunState> {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    const state = engine.getRunStore().load(runId);
    if (state?.status === expected) return state;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const actual = engine.getRunStore().load(runId);
  throw new Error(
    `Run ${runId} reached "${actual?.status}", not "${expected}"` +
      (actual?.lastError ? ` (${actual.lastError})` : ''),
  );
}

function readLedger(runId: string): Array<{ type: string; data: Record<string, unknown> }> {
  return readFileSync(path.join(runsRootDir, runId, 'ledger.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { type: string; data: Record<string, unknown> });
}

function scopedRemediate(): NonNullable<SwarmStrategy['remediate']> {
  return async (ctx, packet) => {
    const graph = ctx.runState.graph!;
    const named = new Set(packet.findings.flatMap((finding) => finding.affectedTaskIds ?? []));
    for (const id of named) {
      if (graph.nodes[id]) graph.nodes[id].phase = 'queued';
    }
    return graph;
  };
}

describe('summarizeRemediationOrigin', () => {
  it('returns the task id when origin is empty', () => {
    expect(summarizeRemediationOrigin(undefined, 'cli')).toBe('cli');
    expect(summarizeRemediationOrigin('   ', 'cli')).toBe('cli');
  });

  it('collects finding ids instead of embedding a prior packet', () => {
    expect(
      summarizeRemediationOrigin(
        'Finding 1 [high]: interpolation duplicated\nEvidence: f-ab12cd34 and f-deadbeef',
        'cli',
      ),
    ).toBe('cli:f-ab12cd34,f-deadbeef');
  });

  it('slices prose that has no finding ids', () => {
    const origin = 'x'.repeat(200);
    expect(summarizeRemediationOrigin(origin, 'cli')).toBe(`cli:${'x'.repeat(160)}`);
  });
});

describe('SwarmEngine final-check artifacts', () => {
  it('keeps CLI-generated files as check artifacts, not authored delivery', async () => {
    const strategy = new FakeStrategy({ graph: graphFor(['task-1']) });
    const engine = createEngine(strategy, { finalOnlyChecks: csvWritingChecks() });

    const started = await start(engine);
    const state = await waitForStatus(engine, started.runId, 'awaiting_acceptance');

    expect(state.delivery?.changedFiles).toEqual(['task-1.txt']);
    expect(state.delivery?.changedFiles).not.toContain('generated.csv');
    expect(state.delivery?.checkArtifacts).toEqual([
      expect.objectContaining({
        path: 'generated.csv',
        checkCategoryId: 'benchmark-cli',
        evidencePath: 'check-artifacts/0/benchmark-cli/generated.csv',
      }),
    ]);
    expect(existsSync(path.join(state.worktreePath, 'generated.csv'))).toBe(false);
    expect(
      readFileSync(path.join(runsRootDir, started.runId, 'check-artifacts/0/benchmark-cli/generated.csv'), 'utf8'),
    ).toContain('energy_MeV');
    expect(readLedger(started.runId).some((entry) => entry.type === 'final_check_artifacts')).toBe(true);
  });

  it('strips artifacts before each remediation cycle and copies the next under the new cycle', async () => {
    let accepts = 0;
    const strategy = new FakeStrategy({
      graph: graphFor(['task-1']),
      accept: async (ctx, packet) => {
        accepts += 1;
        if (accepts === 1) {
          return {
            accepted: false,
            procedure: 'gate',
            rationale: 'Assent refused: task-1.txt is incomplete.',
            decidedAt: new Date().toISOString(),
          };
        }
        return stubAccept(ctx, packet);
      },
      remediate: scopedRemediate(),
    });
    const engine = createEngine(strategy, { finalOnlyChecks: csvWritingChecks() });

    const started = await start(engine);
    const state = await waitForStatus(engine, started.runId, 'awaiting_acceptance');

    expect(state.deliveryRemediationCycles).toBe(1);
    expect(state.delivery?.changedFiles).toEqual(['task-1.txt']);
    expect(state.delivery?.changedFiles).not.toContain('generated.csv');
    expect(state.delivery?.checkArtifacts?.map((item) => item.evidencePath).sort()).toEqual([
      'check-artifacts/0/benchmark-cli/generated.csv',
      'check-artifacts/1/benchmark-cli/generated.csv',
    ]);
    expect(existsSync(path.join(state.worktreePath, 'generated.csv'))).toBe(false);
    expect(existsSync(path.join(runsRootDir, started.runId, 'check-artifacts/1/benchmark-cli/generated.csv'))).toBe(
      true,
    );
  });

  it('reopens only the tasks a two-path integration finding actually names', async () => {
    let integrates = 0;
    const strategy = new FakeStrategy({
      graph: graphFor(['composition', 'cli', 'damage', 'docs']),
      integrate: async (ctx, approved, diffText) => {
        integrates += 1;
        if (integrates === 1) {
          return {
            integratorId: 'stub-integrator',
            integrated: false,
            postIntegrationChecks: [],
            findings: [
              {
                source: 'integrator',
                summary: 'CLI and damage disagree on interpolation.',
                evidenceRefs: ['cli.txt', 'damage.txt'],
                disposition: 'unresolved',
                dispositionRationale: 'Raised at integration.',
              },
            ],
            rationale: 'cli.txt and damage.txt do not hold together.',
          } satisfies IntegrationResult;
        }
        return stubIntegrate(ctx, approved, diffText);
      },
      accept: async (ctx, packet: DeliveryPacket) => {
        if (!packet.integrationEvidence.integrated) {
          return {
            accepted: false,
            procedure: 'gate',
            rationale: 'The councils refuse: integration findings stand.',
            decidedAt: new Date().toISOString(),
          };
        }
        return stubAccept(ctx, packet);
      },
      remediate: scopedRemediate(),
    });
    const engine = createEngine(strategy);

    const started = await start(engine);
    const state = await waitForStatus(engine, started.runId, 'awaiting_acceptance');

    expect(state.graph?.nodes.composition.phase).toBe('settled');
    expect(state.graph?.nodes.docs.phase).toBe('settled');
    expect(state.graph?.nodes.composition.attempts).toHaveLength(1);
    expect(state.graph?.nodes.docs.attempts).toHaveLength(1);
    expect(latestVerdict(state.graph!.nodes.cli)).toBe('approved');
    expect(latestVerdict(state.graph!.nodes.damage)).toBe('approved');
    expect(state.graph?.nodes.cli.attempts.length).toBeGreaterThan(1);
    expect(state.graph?.nodes.damage.attempts.length).toBeGreaterThan(1);
  });
});
