import type { BudgetConfig } from '../util/config.js';
import type { RunState } from './RunStore.js';
import type { StallTimeout } from './OpenRouterClient.js';

export class BudgetExceededError extends Error {
  constructor(message: string, public readonly kind: 'per_run' | 'per_task' | 'hard_ceiling' | 'call_count') {
    super(message);
    this.name = 'BudgetExceededError';
  }
}

// Gates every WorkerDispatcher call against the run's budget. Spend never continues silently:
// crossing perRunUsd pauses the run for a `budget_increase` approval, and no approval —
// including a human-granted increase via swarm_decide — can push total spend past hardCeilingUsd.
export class BudgetGuard {
  constructor(private readonly config: BudgetConfig) {}

  /** Throws if starting another worker call would already be unsafe. Call before every dispatch. */
  checkBeforeCall(state: RunState, taskId?: string): void {
    if (state.workerCalls >= this.config.defaults.maxWorkerCalls) {
      throw new BudgetExceededError(
        `Run ${state.runId} hit maxWorkerCalls (${this.config.defaults.maxWorkerCalls}).`,
        'call_count',
      );
    }
    if (state.costUsd >= state.budgetUsd) {
      throw new BudgetExceededError(
        `Run ${state.runId} reached its per-run budget of $${state.budgetUsd.toFixed(2)}.`,
        'per_run',
      );
    }
    if (state.costUsd >= this.config.hardCeilingUsd) {
      throw new BudgetExceededError(
        `Run ${state.runId} reached the hard ceiling of $${this.config.hardCeilingUsd.toFixed(2)}. ` +
          `This cannot be raised via swarm_decide.`,
        'hard_ceiling',
      );
    }
    const reservation = taskId ? state.resourceReservations?.[taskId] : undefined;
    if (reservation && reservation.spentUsd >= reservation.limitUsd) {
      throw new BudgetExceededError(`Task ${taskId} exhausted its reserved $${reservation.limitUsd.toFixed(2)}.`, 'per_task');
    }
    const unspentOther = Object.entries(state.resourceReservations ?? {}).reduce((sum, [id, reserved]) =>
      sum + (id === taskId ? 0 : Math.max(0, reserved.limitUsd - reserved.spentUsd)), 0);
    if (state.costUsd + unspentOther >= state.budgetUsd && !reservation) {
      throw new BudgetExceededError('The unreserved run budget is committed to task envelopes.', 'per_run');
    }
  }

  /** Reserve a task envelope atomically against the same run state all dispatches meter. */
  reserveTask(state: RunState, taskId: string, requestedUsd: number): number {
    if (!taskId || !Number.isFinite(requestedUsd) || requestedUsd <= 0) return 0;
    const reservations = (state.resourceReservations ??= {});
    if (reservations[taskId]) return reservations[taskId].limitUsd;
    const committed = Object.values(reservations).reduce((sum, value) =>
      sum + Math.max(0, value.limitUsd - value.spentUsd), 0);
    const available = Math.max(0, Math.min(state.budgetUsd, this.config.hardCeilingUsd) - state.costUsd - committed);
    const granted = Math.round(Math.min(requestedUsd, available) * 10000) / 10000;
    if (granted > 0) reservations[taskId] = { limitUsd: granted, spentUsd: 0 };
    return granted;
  }

  /** Increase an exhausted envelope only from funds not committed to other tasks. */
  topUpTask(state: RunState, taskId: string, requestedUsd: number): number {
    const reservation = state.resourceReservations?.[taskId];
    if (!reservation || !Number.isFinite(requestedUsd) || requestedUsd <= 0) return 0;
    const committedOther = Object.entries(state.resourceReservations ?? {}).reduce((sum, [id, value]) =>
      sum + (id === taskId ? 0 : Math.max(0, value.limitUsd - value.spentUsd)), 0);
    const available = Math.max(0, Math.min(state.budgetUsd, this.config.hardCeilingUsd) -
      state.costUsd - committedOther - Math.max(0, reservation.limitUsd - reservation.spentUsd));
    const granted = Math.round(Math.min(requestedUsd, available) * 10000) / 10000;
    if (reservation.limitUsd + granted <= reservation.spentUsd) return 0;
    if (granted > 0) reservation.limitUsd += granted;
    return granted;
  }

  releaseTask(state: RunState, taskId: string): void {
    delete state.resourceReservations?.[taskId];
  }

  /** Records actual spend after a call completes and returns whether a warning threshold was crossed. */
  recordSpend(
    state: RunState,
    spend: { costUsd: number; promptTokens: number; completionTokens: number },
    taskId?: string,
  ): { warn: boolean } {
    state.costUsd += spend.costUsd;
    state.tokensUsed.prompt += spend.promptTokens;
    state.tokensUsed.completion += spend.completionTokens;
    state.workerCalls += 1;
    const reservation = taskId ? state.resourceReservations?.[taskId] : undefined;
    if (reservation) reservation.spentUsd += spend.costUsd;
    const warn = state.costUsd >= state.budgetUsd * this.config.defaults.warnAtFractionOfPerRun;
    return { warn };
  }

  isOverRunBudget(state: RunState): boolean {
    return state.costUsd >= state.budgetUsd;
  }

  clampBudgetIncrease(requestedUsd: number): number {
    return Math.min(requestedUsd, this.config.hardCeilingUsd);
  }

  perCallTimeoutMs(role?: string): number {
    const override = role ? this.config.defaults.perCallTimeoutMsByRole?.[role] : undefined;
    return override ?? this.config.defaults.perCallTimeoutMs;
  }

  /** Silence limits for a streamed call; undefined keeps calls unstreamed under the ceiling alone. */
  stallTimeout(): StallTimeout | undefined {
    return this.config.defaults.stallTimeout;
  }

  maxWallClockMinutes(): number {
    return this.config.defaults.maxWallClockMinutes;
  }

  maxTaskAttempts(): number {
    return this.config.defaults.maxTaskAttempts;
  }

  defaultTaskEnvelopeUsd(): number {
    return this.config.defaults.perTaskUsd;
  }

  maxInstitutionalCallsPerTask(): number | undefined {
    return this.config.defaults.maxInstitutionalCallsPerTask;
  }
}
