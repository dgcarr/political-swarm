import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { BudgetGuard } from './BudgetGuard.js';
import type { RunState } from './RunStore.js';
import { loadBudgetConfig, type BudgetConfig } from '../util/config.js';
import { BENCHMARK_STALL_TIMEOUT, FAST_ROLE_CALL_TIMEOUT_MS, PLANNER_CALL_TIMEOUT_MS } from '../benchmark/runBenchmark.js';

function config(over: Partial<BudgetConfig['defaults']> = {}): BudgetConfig {
  return {
    defaults: {
      perRunUsd: 2,
      perTaskUsd: 0.3,
      maxWorkerCalls: 300,
      maxWallClockMinutes: 30,
      maxTaskAttempts: 3,
      perCallTimeoutMs: 60_000,
      warnAtFractionOfPerRun: 0.8,
      ...over,
    },
    hardCeilingUsd: 10,
  };
}

describe('shared task reservations', () => {
  function state(): RunState {
    return { runId: 'r', budgetUsd: 1, costUsd: 0, workerCalls: 0,
      tokensUsed: { prompt: 0, completion: 0 } } as RunState;
  }

  it('cannot reserve the same unspent dollars for simultaneous tasks', () => {
    const guard = new BudgetGuard(config());
    const run = state();
    expect(guard.reserveTask(run, 'hard', 0.7)).toBe(0.7);
    expect(guard.reserveTask(run, 'easy', 0.7)).toBe(0.3);
    expect(guard.reserveTask(run, 'third', 0.1)).toBe(0);
  });

  it('meters a task against its envelope and releases unused capacity', () => {
    const guard = new BudgetGuard(config());
    const run = state();
    guard.reserveTask(run, 'task', 0.2);
    guard.recordSpend(run, { costUsd: 0.2, promptTokens: 1, completionTokens: 1 }, 'task');
    expect(() => guard.checkBeforeCall(run, 'task')).toThrow('exhausted');
    guard.releaseTask(run, 'task');
    expect(guard.reserveTask(run, 'other', 0.8)).toBe(0.8);
  });

  it('tops up an exhausted task only from uncommitted funds', () => {
    const guard = new BudgetGuard(config());
    const run = state();
    guard.reserveTask(run, 'hard', 0.4);
    guard.reserveTask(run, 'easy', 0.4);
    guard.recordSpend(run, { costUsd: 0.4, promptTokens: 0, completionTokens: 0 }, 'hard');
    expect(guard.topUpTask(run, 'hard', 0.5)).toBe(0.2);
    expect(run.resourceReservations?.hard.limitUsd).toBeCloseTo(0.6);
    expect(guard.topUpTask(run, 'hard', 0.1)).toBe(0);
    expect(run.resourceReservations?.easy.limitUsd).toBe(0.4);
  });

  it('does not issue a top-up too small to clear an in-flight overrun', () => {
    const guard = new BudgetGuard(config());
    const run = state();
    guard.reserveTask(run, 'task', 0.2);
    guard.recordSpend(run, { costUsd: 0.5, promptTokens: 0, completionTokens: 0 }, 'task');
    guard.reserveTask(run, 'other', 0.3);
    expect(guard.topUpTask(run, 'task', 0.2)).toBe(0);
    expect(run.resourceReservations?.task.limitUsd).toBe(0.2);
  });
});

describe('perCallTimeoutMs', () => {
  it('returns the flat default when no role override is configured', () => {
    const guard = new BudgetGuard(config());
    expect(guard.perCallTimeoutMs()).toBe(60_000);
    expect(guard.perCallTimeoutMs('implementer')).toBe(60_000);
  });

  it('returns a role-specific override when one is configured', () => {
    const guard = new BudgetGuard(config({ perCallTimeoutMsByRole: { implementer: 300_000 } }));
    expect(guard.perCallTimeoutMs('implementer')).toBe(300_000);
  });

  it('falls back to the default for a role with no override', () => {
    const guard = new BudgetGuard(config({ perCallTimeoutMsByRole: { implementer: 300_000 } }));
    expect(guard.perCallTimeoutMs('reviewer')).toBe(60_000);
    expect(guard.perCallTimeoutMs()).toBe(60_000);
  });
});

describe('checked-in config/budget.yaml', () => {
  const repoConfigDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../config');

  it('streams interactive calls with the same stall failover the benchmark uses', () => {
    const guard = new BudgetGuard(loadBudgetConfig(repoConfigDir));
    expect(guard.stallTimeout()).toEqual({ ...BENCHMARK_STALL_TIMEOUT });
    expect(guard.perCallTimeoutMs()).toBe(FAST_ROLE_CALL_TIMEOUT_MS);
    expect(guard.perCallTimeoutMs('implementer')).toBe(600_000);
    expect(guard.perCallTimeoutMs('planner')).toBe(PLANNER_CALL_TIMEOUT_MS);
  });
});

describe('maxTaskAttempts', () => {
  it('returns the configured per-task attempt ceiling', () => {
    expect(new BudgetGuard(config({ maxTaskAttempts: 5 })).maxTaskAttempts()).toBe(5);
  });

  it('defaults legacy budget files to three attempts', () => {
    const configDir = mkdtempSync(path.join(os.tmpdir(), 'swarm-budget-config-'));
    try {
      writeFileSync(path.join(configDir, 'budget.yaml'), [
        'defaults:',
        '  perRunUsd: 2',
        '  perTaskUsd: 0.3',
        '  maxWorkerCalls: 300',
        '  maxWallClockMinutes: 30',
        '  perCallTimeoutMs: 60000',
        '  warnAtFractionOfPerRun: 0.8',
        'hardCeilingUsd: 10',
      ].join('\n'));

      expect(loadBudgetConfig(configDir).defaults.maxTaskAttempts).toBe(3);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});
