import type { SwarmEngine } from '../engine/SwarmEngine.js';

export const swarmListRunsInputShape = {};

export interface SwarmListRunsResult {
  runs: Array<{
    runId: string;
    task: string;
    strategy: import('../engine/types.js').StrategyId;
    status: import('../engine/RunStore.js').RunStatus;
    startedAt: string;
  }>;
}

export async function swarmListRuns(engine: SwarmEngine): Promise<SwarmListRunsResult> {
  const runs = engine
    .getRunStore()
    .listAll()
    .map((s) => ({
      runId: s.runId,
      task: s.task.goal,
      strategy: s.strategy,
      status: s.status,
      startedAt: s.createdAt,
    }));
  return { runs };
}
