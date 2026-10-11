import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { LedgerEntry } from '../engine/Ledger.js';
import type { RunState } from '../engine/RunStore.js';
import type { PendingApproval } from '../engine/types.js';
import type { BudgetConfig } from '../util/config.js';
import { BenchmarkAllowance } from './evaluatorPolicy.js';
import {
  aggregateMechanismUsage,
  aggregateModelUsage,
  aggregatePhaseUsage,
  aggregateSovereignUsage,
  benchmarkVerificationChecks,
  benchmarkTaskGoal,
  BENCHMARK_ACCEPTANCE_CRITERIA,
  buildApprovalResolutionPlan,
  buildProvenanceChanged,
  executeStrategyRuns,
  fingerprintTree,
  latestIndependentChecks,
  parseArgs,
  reachedStage,
  strategiesForTrial,
  summarizeOracle,
  NEVER_EVALUATED_PREFIXES,
  PROGRAM_CHECK_IDS,
} from './runBenchmark.js';

describe('--stop-after', () => {
  const withNodes = (phases: string[]) => ({
    graph: phases.length ? { nodes: Object.fromEntries(phases.map((phase, i) => [`n${i}`, { phase }])) } : undefined,
  }) as unknown as RunState;

  it('parses plan and first-task and rejects any other stage', () => {
    expect(parseArgs(['--label', 'x']).stopAfter).toBeUndefined();
    expect(parseArgs(['--label', 'x', '--stop-after', 'plan']).stopAfter).toBe('plan');
    expect(parseArgs(['--label', 'x', '--stop-after', 'first-task']).stopAfter).toBe('first-task');
    expect(() => parseArgs(['--label', 'x', '--stop-after', 'delivery'])).toThrow(/Unknown --stop-after/);
  });

  it('reaches plan once a plan exists and first-task once one task has settled or been abandoned', () => {
    expect(reachedStage(withNodes([]), 'plan')).toBe(false);
    expect(reachedStage(withNodes(['pending', 'pending']), 'plan')).toBe(true);
    expect(reachedStage(withNodes(['pending', 'pending']), 'first-task')).toBe(false);
    expect(reachedStage(withNodes(['settled', 'pending']), 'first-task')).toBe(true);
    expect(reachedStage(withNodes(['abandoned', 'pending']), 'first-task')).toBe(true);
  });
});

describe('fingerprintTree', () => {
  it('tracks included file paths and bytes while ignoring excluded files', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'benchmark-fingerprint-'));
    try {
      mkdirSync(path.join(root, 'nested'));
      writeFileSync(path.join(root, 'a.ts'), 'one');
      writeFileSync(path.join(root, 'nested', 'b.ts'), 'two');
      const include = (file: string) => file.endsWith('.ts');
      const original = fingerprintTree(root, include);

      writeFileSync(path.join(root, 'notes.md'), 'excluded');
      expect(fingerprintTree(root, include)).toBe(original);
      writeFileSync(path.join(root, 'nested', 'b.ts'), 'changed');
      expect(fingerprintTree(root, include)).not.toBe(original);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('buildProvenanceChanged', () => {
  const current = { sourceFingerprint: 'source', configFingerprint: 'config', dependencyLockFingerprint: 'lock' };

  it('keeps an exact build eligible for a clean resume', () => {
    const manifest = current as Parameters<typeof buildProvenanceChanged>[0];
    expect(buildProvenanceChanged(manifest, current)).toBe(false);
  });

  it('marks legacy runs with unknown original fingerprints as mixed-build', () => {
    const manifest = {} as Parameters<typeof buildProvenanceChanged>[0];
    expect(buildProvenanceChanged(manifest, current)).toBe(true);
  });

  it('detects a configuration change even when source is unchanged', () => {
    const manifest = { ...current, configFingerprint: 'old' } as Parameters<typeof buildProvenanceChanged>[0];
    expect(buildProvenanceChanged(manifest, current)).toBe(true);
  });
});

describe('aggregateMechanismUsage', () => {
  it('counts binding activations and nets a reversed public-good grant', () => {
    const entries = [
      { type: 'governance_decision', data: { rule: 'delegated-council-ratification-v1', result: 'approve' } },
      { type: 'governance_decision', data: { rule: 'delegated-council-ratification-v1', result: 'reject' } },
      { type: 'governance_mandate_revoked', data: {} },
      { type: 'council_member_ballots', data: { taskId: 'a', council: 'council-a', planDigest: 'v1', ballots: [{}, {}] } },
      { type: 'council_member_ballots', data: { taskId: 'a', council: 'council-a', planDigest: 'v1', ballots: [{}, {}] } },
      { type: 'council_member_ballots', data: { taskId: 'a', council: 'council-a', planDigest: 'v2', ballots: [{}, {}] } },
      { type: 'resource_envelope_topped_up', data: {} },
      { type: 'public_good_granted', data: {} },
      { type: 'public_good_grant_reversed', data: {} },
      { type: 'contract_deadline_breached', data: {} },
    ];
    expect(aggregateMechanismUsage(entries)).toMatchObject({
      decisions: 2, planRatifications: 1, mandatesRevoked: 1, councilMemberBallots: 4,
      resourceTopUps: 1, publicGoodGrants: 0, deadlineBreaches: 1,
    });
  });
});

describe('aggregatePhaseUsage', () => {
  it('includes failed provider calls in institutional overhead and time', () => {
    expect(aggregatePhaseUsage([
      { type: 'worker_call', data: { phase: 'institutional', durationMs: 100, costUsd: 0.01 } },
      { type: 'worker_call_unmetered', data: { phase: 'institutional', durationMs: 200 } },
      { type: 'worker_call', data: { phase: 'engineering', durationMs: 30, costUsd: 0.02 } },
    ])).toEqual({
      institutional: { calls: 2, unmeteredCalls: 1, durationMs: 300, costUsd: 0.01 },
      engineering: { calls: 1, unmeteredCalls: 0, durationMs: 30, costUsd: 0.02 },
    });
  });
});

describe('benchmarkVerificationChecks', () => {
  it('refuses manual evidence, matching the headless evaluator', () => {
    expect(benchmarkVerificationChecks('/benchmark/python').checksConfig.manualEvidenceAccepted).toBe(false);
  });

  it('rejects malformed Python per task and checks package imports before the literal CLI', () => {
    const verification = benchmarkVerificationChecks('/benchmark/python');

    expect(verification.checksConfig.categories).toEqual([
      expect.objectContaining({
        id: 'python-syntax',
        command: '/benchmark/python',
        args: ['-m', 'compileall', '-q', '.'],
        required: true,
      }),
      expect.objectContaining({ id: 'unit', required: true }),
      expect.objectContaining({ id: 'package-import', args: ['-c', 'import alloydamage'], required: true }),
    ]);
    expect(verification.finalOnlyChecks.map((check) => check.id)).toEqual([
      'benchmark-import',
      'benchmark-cli',
    ]);
    expect(verification.finalOnlyChecks[0].args).toEqual([
      '-c',
      'import alloydamage; import alloydamage.cli',
    ]);
  });

  it('lets critics run the CLI and chosen tests, without naming any oracle probe', () => {
    const { reviewCommands } = benchmarkVerificationChecks('/benchmark/python').checksConfig;

    expect(reviewCommands.map((command) => [command.id, command.command, command.args])).toEqual([
      ['alloydamage', '/benchmark/python', ['-m', 'alloydamage']],
      ['python', '/benchmark/python', ['-c']],
      ['pytest', '/benchmark/python', ['-m', 'pytest', '-q', '-p', 'no:cacheprovider']],
    ]);
    // The descriptions reach the swarm; an example energy below Fe's range would hand it check 7's probe.
    expect(JSON.stringify(reviewCommands)).not.toMatch(/--emin|--emax|1e-5|1e-4/);
  });
});

describe('benchmarkTaskGoal', () => {
  it('gives every strategy exact source paths while reserving runtime artifacts for final checks', () => {
    const goal = benchmarkTaskGoal('# Task\nBuild the calculator.');

    expect(goal).toContain('alloydamage/__main__.py');
    expect(goal).toContain('alloydamage/plotting.py');
    expect(goal).toContain('examples/304L.yaml');
    expect(goal).toContain('CSV and PNG outputs are check artifacts, not authored FileOps');
  });

  it('forbids a task inventing stricter self-authored criteria or tests than the brief requires', () => {
    const goal = benchmarkTaskGoal('# Task\nBuild the calculator.');

    expect(goal).toContain('must not be stricter than those require');
    expect(goal).toContain('never bitwise/exact equality against a value derived from irrational or repeated floating-point');
  });
});

describe('BENCHMARK_ACCEPTANCE_CRITERIA', () => {
  it('states the output-contract evidence the engine must collect, not philosophy', () => {
    expect(BENCHMARK_ACCEPTANCE_CRITERIA).toEqual(expect.arrayContaining([
      'python -m pytest passes',
      'python -m alloydamage calculate examples/304L.yaml produces the calculated alloy cross-section and plot',
      'CSV energy header states explicit MeV units',
      'interpolation is implemented in one place, not duplicated across modules',
      'runtime-generated CSV and PNG outputs are not authored repository files',
    ]));
    expect(BENCHMARK_ACCEPTANCE_CRITERIA).toHaveLength(9);
  });
});

describe('executeStrategyRuns', () => {
  it('awaits each strategy before starting the next when concurrent is false', async () => {
    const events: string[] = [];
    const args = parseArgs(['--label', 'sequential-test']);

    const results = await executeStrategyRuns({
      orderedStrategies: ['democratic', 'socialist', 'capitalist'],
      concurrent: args.concurrent,
      run: async (strategy) => {
        events.push(`start:${strategy}`);
        await Promise.resolve();
        events.push(`end:${strategy}`);
        return strategy;
      },
    });

    expect(events).toEqual([
      'start:democratic',
      'end:democratic',
      'start:socialist',
      'end:socialist',
      'start:capitalist',
      'end:capitalist',
    ]);
    expect(results).toEqual(['democratic', 'socialist', 'capitalist']);
  });

  it('starts every strategy before awaiting results when concurrent is true', async () => {
    const events: string[] = [];
    const args = parseArgs(['--label', 'concurrent-test', '--concurrent']);

    await executeStrategyRuns({
      orderedStrategies: ['democratic', 'socialist', 'capitalist'],
      concurrent: args.concurrent,
      run: async (strategy) => {
        events.push(`start:${strategy}`);
        await Promise.resolve();
        events.push(`end:${strategy}`);
        return strategy;
      },
    });

    expect(events.slice(0, 3)).toEqual(['start:democratic', 'start:socialist', 'start:capitalist']);
  });
});

describe('strategiesForTrial', () => {
  it('integrates trial rotation before execution', () => {
    expect(strategiesForTrial(['democratic', 'socialist', 'capitalist'], 1)).toEqual([
      'socialist',
      'capitalist',
      'democratic',
    ]);
  });
});

describe('aggregateModelUsage', () => {
  it('aggregates fallback, retry, timeout, and unique-provider usage from worker calls', () => {
    const metrics = aggregateModelUsage([
      {
        type: 'worker_call',
        data: { fallbackIndex: 0, networkRetries: 2, timedOut: false, provider: 'provider-a' },
      },
      {
        type: 'worker_call',
        data: { fallbackIndex: 1, networkRetries: 0, timedOut: true, provider: 'provider-b' },
      },
      {
        type: 'worker_call',
        data: { fallbackIndex: 2, networkRetries: 3, timedOut: true, provider: 'provider-a' },
      },
      { type: 'verification_result', data: { fallbackIndex: 8, networkRetries: 100, timedOut: true } },
    ]);

    expect(metrics).toEqual({
      fallbackCount: 2,
      retryCount: 5,
      timeoutCount: 2,
      unmeteredCalls: 0,
      estimatedCostCalls: 0,
      providersUsed: ['provider-a', 'provider-b'],
      stalledCount: 0,
      decisionCalls: 0,
      decisionsAccepted: 0,
      decisionsEscalated: 0,
      decisionFailures: 0,
    });
  });

  it('counts stalls and how decision-model calls ended', () => {
    const metrics = aggregateModelUsage([
      { type: 'worker_call', data: { fallbackIndex: 0, networkRetries: 0, timedOut: true, stalled: true } },
      { type: 'worker_call_unmetered', data: { timedOut: true, stalled: true } },
      { type: 'worker_call_unmetered', data: { timedOut: true } },
      { type: 'decision_call', data: { outcome: 'accepted' } },
      { type: 'decision_call', data: { outcome: 'accepted' } },
      { type: 'decision_call', data: { outcome: 'low-confidence' } },
      { type: 'decision_call', data: { outcome: 'not-accepted' } },
      { type: 'decision_call_failed', data: { error: 'alpha endpoint unavailable' } },
    ]);
    expect(metrics).toMatchObject({
      timeoutCount: 3, stalledCount: 2, decisionCalls: 4, decisionsAccepted: 2, decisionsEscalated: 2, decisionFailures: 1,
    });
  });

  it('counts the calls that threw, which never reach a worker_call entry at all', () => {
    // A trial reported timeoutCount 0 while losing 54 calls to per-call timeouts, because the
    // counter only ever saw the successes.
    const metrics = aggregateModelUsage([
      { type: 'worker_call', data: { fallbackIndex: 0, networkRetries: 0, timedOut: false, costMetered: true } },
      { type: 'worker_call_unmetered', data: { timedOut: true, model: 'z-ai/glm-5.2' } },
      { type: 'worker_call_unmetered', data: { timedOut: true, model: 'z-ai/glm-5.2' } },
      { type: 'worker_call_unmetered', data: { timedOut: false, model: 'z-ai/glm-5.2' } },
    ]);

    expect(metrics.timeoutCount).toBe(2);
    expect(metrics.unmeteredCalls).toBe(3);
  });

  it('counts calls whose cost is this repository\'s arithmetic rather than the provider\'s', () => {
    const metrics = aggregateModelUsage([
      { type: 'worker_call', data: { fallbackIndex: 0, networkRetries: 0, timedOut: false, costMetered: true } },
      { type: 'worker_call', data: { fallbackIndex: 0, networkRetries: 0, timedOut: false, costMetered: false } },
      { type: 'worker_call', data: { fallbackIndex: 0, networkRetries: 0, timedOut: false, costMetered: false } },
    ]);

    expect(metrics.estimatedCostCalls).toBe(2);
  });
});

describe('buildApprovalResolutionPlan', () => {
  it('uses the configured per-run increment for both evaluator context and the new total budget', () => {
    const state: RunState = {
      runId: 'run-1',
      strategy: 'democratic',
      task: { goal: 'Implement the task', acceptanceCriteria: ['Tests pass'] },
      repoPath: '/repo',
      baseBranch: 'main',
      worktreePath: '/worktree',
      branch: 'swarm/run-1',
      status: 'paused_budget',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:01:00.000Z',
      budgetUsd: 8,
      costUsd: 8.1,
      tokensUsed: { prompt: 10, completion: 5 },
      workerCalls: 2,
      graph: null,
      pendingApprovals: [],
    };
    const budgetConfig: BudgetConfig = {
      defaults: {
        perRunUsd: 2,
        perTaskUsd: 0.3,
        maxWorkerCalls: 300,
        maxWallClockMinutes: 30,
        maxTaskAttempts: 3,
        perCallTimeoutMs: 60_000,
        warnAtFractionOfPerRun: 0.8,
      },
      hardCeilingUsd: 10,
    };
    const approval: PendingApproval = {
      id: 'approval-1',
      kind: 'budget_increase',
      description: 'More budget is required',
      createdAt: '2026-01-01T00:01:00.000Z',
    };
    const allowance = new BenchmarkAllowance(40, 6);

    const plan = buildApprovalResolutionPlan({
      approval,
      state,
      allowance,
      perRunUsdIncrement: budgetConfig.defaults.perRunUsd,
    });

    expect(plan.context).toEqual({ allowance, budgetIncreaseUsd: 2 });
    expect(plan.modifiedBudgetUsd).toBe(10);
  });

  it('supplies the persisted deadline when resolving a wall-clock extension', () => {
    const deadlineAt = '2026-01-01T00:30:00.000Z';
    const allowance = new BenchmarkAllowance(0, 1);
    const plan = buildApprovalResolutionPlan({
      approval: { id: 'clock-1', kind: 'wall_clock_extension', description: 'More time' } as PendingApproval,
      state: { budgetUsd: 8, deadlineAt } as RunState,
      allowance,
      perRunUsdIncrement: 2,
    });

    expect(plan.context).toEqual({ allowance, currentDeadlineAt: deadlineAt });
  });
});

describe('latestIndependentChecks', () => {
  const entry = (taskId: string, categories: unknown[], incompleteCategories?: string[]) => ({
    type: 'verification_result',
    data: { taskId, categories, incompleteCategories },
  }) as unknown as LedgerEntry;

  // decideFinalDiff fails closed without these, so nothing supplying them meant every task that
  // reached needs_human was auto-rejected and abandoned — three tasks across two doctrines in one
  // sweep, each with work the evaluator never looked at.
  it('returns the checks the engine ran for the task', () => {
    const checks = latestIndependentChecks(
      [entry('t6', [{ id: 'unit', ran: true, passed: true }])],
      't6',
    );

    expect(checks).toEqual([
      expect.objectContaining({ categoryId: 'unit', ran: true, passed: true }),
    ]);
  });

  it('takes the most recent run, not the first', () => {
    const checks = latestIndependentChecks(
      [
        entry('t6', [{ id: 'unit', ran: true, passed: false }]),
        entry('t6', [{ id: 'unit', ran: true, passed: true }]),
      ],
      't6',
    );

    expect(checks[0]?.passed).toBe(true);
  });

  it('ignores another task\'s results', () => {
    const checks = latestIndependentChecks(
      [entry('t5', [{ id: 'unit', ran: true, passed: true }])],
      't6',
    );

    expect(checks).toEqual([]);
  });

  it('returns nothing when the task never ran a check, so the evaluator still fails closed', () => {
    expect(latestIndependentChecks([], 't6')).toEqual([]);
  });

  it('carries a skipped reason and a baseline failure through', () => {
    const checks = latestIndependentChecks(
      [entry('t6', [{ id: 'lint', ran: false, passed: false, skippedReason: 'no linter', failedAtBaseline: true }])],
      't6',
    );

    expect(checks[0]).toMatchObject({ skippedReason: 'no linter', failedAtBaseline: true });
  });

  it('preserves the engine\'s pre-task incomplete attribution for human sign-off', () => {
    const checks = latestIndependentChecks(
      [entry('t6', [{ id: 'unit', ran: true, passed: false }], ['unit'])],
      't6',
    );

    expect(checks[0]).toMatchObject({ categoryId: 'unit', passed: false, failedAtBaseline: true });
  });
});

describe('buildApprovalResolutionPlan final_diff', () => {
  it('passes the independent checks through so the evaluator can decide on evidence', () => {
    const checks = [{ categoryId: 'unit', command: '', args: [], ran: true, passed: true }];
    const plan = buildApprovalResolutionPlan({
      approval: { id: 'a', kind: 'final_diff', taskId: 't6', description: 'sign off' } as PendingApproval,
      state: { budgetUsd: 8 },
      allowance: new BenchmarkAllowance(40, 6),
      perRunUsdIncrement: 2,
      independentChecks: checks,
    });

    expect(plan.context.independentChecks).toEqual(checks);
    expect(plan.modifiedBudgetUsd).toBeUndefined();
  });
});

describe('aggregateSovereignUsage', () => {
  it('counts each arm\'s answered consultations and their cost, and fallbacks separately', () => {
    const entries = [
      { type: 'sovereign_decision', data: { decidedBy: 'sovereign', costUsd: 0.25 } },
      { type: 'sovereign_decision', data: { decidedBy: 'sovereign', costUsd: 0.5 } },
      { type: 'sovereign_decision', data: { decidedBy: 'fallback-policy', costUsd: 0 } },
      { type: 'worker_call', data: { costUsd: 9 } },
    ];
    expect(aggregateSovereignUsage(entries)).toEqual({ calls: 2, fallbacks: 1, costUsd: 0.75 });
  });
});

describe('summarizeOracle', () => {
  const check = (id: number, passed: boolean, detail = 'ok') => ({ id, description: `check ${id}`, passed, detail });
  const crashed = (id: number) => check(id, false, 'calculation exited 1: Traceback (most recent call last)');

  it('splits a run that never starts from one that runs and gets things wrong', () => {
    // abdm2-off-r1 socialist: one traceback, ten checks never judged, five of them worded otherwise.
    const notRunning = [
      crashed(1), crashed(2), crashed(3),
      check(4, false, '99.8% input failed without a clear normalisation warning: Traceback ...'),
      check(5, false, 'failure did not clearly identify unsupported Cu'),
      crashed(6),
      check(7, false, 'out-of-range request failed, but did not explain the range problem'),
      crashed(8),
      check(9, false, 'calculation produced no PNG file'),
      check(10, true),
      check(11, false, 'program output/provenance command does not surface: source, model, dataset'),
      check(12, false, 'the submission\'s own test suite fails (exit 1)'),
    ];
    expect(summarizeOracle(notRunning)).toEqual({
      runsEndToEnd: false, passed: 1, evaluated: 2, blocked: 10, total: 12, label: 'runs: no (10 blocked) · functional 1/2',
    });
    const running = [...Array.from({ length: 10 }, (_, i) => check(i + 1, true)), check(11, false, 'values off'), check(12, false, 'tests fail')];
    expect(summarizeOracle(running)).toEqual({
      runsEndToEnd: true, passed: 10, evaluated: 12, blocked: 0, total: 12, label: 'runs: yes · functional 10/12',
    });
  });

  it('counts a run that crashes on some inputs as not running end to end', () => {
    const partial = [check(1, true), check(2, false, 'no numeric result CSV was written'), check(3, false, 'wrong fraction')];
    expect(summarizeOracle(partial)).toMatchObject({ runsEndToEnd: false, passed: 1, evaluated: 2, blocked: 1 });
    // Pure Fe runs, so a missing plot is the program's own failure, not a crash's.
    const noPlot = [check(1, true), crashed(3), check(9, false, 'calculation produced no PNG file')];
    expect(summarizeOracle(noPlot)).toMatchObject({ blocked: 1, evaluated: 2 });
  });

  it('reports nothing when the oracle produced no report', () => {
    expect(summarizeOracle(null)).toBeNull();
  });

  it('uses the same never-evaluated prefixes and program checks as the oracle report', () => {
    const reportPy = readFileSync(fileURLToPath(new URL('../../../benchmark/oracle/report.py', import.meta.url)), 'utf8');
    const tuple = reportPy.match(/NEVER_EVALUATED_PREFIXES = \(([^)]*)\)/)?.[1] ?? '';
    expect([...tuple.matchAll(/"([^"]+)"/g)].map((m) => m[1])).toEqual([...NEVER_EVALUATED_PREFIXES]);
    const ids = reportPy.match(/PROGRAM_CHECK_IDS = \(([^)]*)\)/)?.[1] ?? '';
    expect(ids.split(',').map((id) => Number(id.trim()))).toEqual([...PROGRAM_CHECK_IDS]);
  });
});
