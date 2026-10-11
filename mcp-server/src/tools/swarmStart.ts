import { z } from 'zod';
import type { SwarmEngine } from '../engine/SwarmEngine.js';
import { STARTABLE_STRATEGIES } from '../strategies/registry.js';
import { branchNameSchema, MAX_ITEM_CHARS, MAX_LIST_ITEMS, MAX_TASK_CHARS } from '../util/ids.js';

export const swarmStartInputShape = {
  task: z.string().min(1).max(MAX_TASK_CHARS).describe('The goal to implement, in plain language.'),
  strategy: z.enum(STARTABLE_STRATEGIES).describe('Which governance strategy coordinates the swarm.'),
  repoPath: z.string().optional().describe('Absolute path to the target repo. Defaults to the current Claude Code project.'),
  baseBranch: branchNameSchema.optional().describe('Branch to fork the isolated worktree from. Defaults to "main".'),
  acceptanceCriteria: z.array(z.string().max(MAX_ITEM_CHARS)).max(MAX_LIST_ITEMS).optional().describe('Concrete, testable criteria for the task.'),
  budgetUsd: z.number().positive().optional().describe('Per-run spend cap in USD. Defaults to config/budget.yaml.'),
  constraints: z.array(z.string().max(MAX_ITEM_CHARS)).max(MAX_LIST_ITEMS).optional(),
};

export interface SwarmStartResult {
  runId: string;
  worktreePath: string;
  branch: string;
  status: import('../engine/RunStore.js').RunStatus;
  strategy: import('../engine/types.js').StrategyId;
  budgetUsd: number;
}

export async function swarmStart(
  engine: SwarmEngine,
  defaultRepoPath: string | undefined,
  input: {
    task: string;
    strategy: import('../engine/types.js').StrategyId;
    repoPath?: string;
    baseBranch?: string;
    acceptanceCriteria?: string[];
    budgetUsd?: number;
    constraints?: string[];
  },
): Promise<SwarmStartResult> {
  const repoPath = input.repoPath ?? defaultRepoPath;
  if (!repoPath) {
    throw new Error(
      'No repoPath given and SWARM_DEFAULT_REPO_PATH is not set. Pass repoPath explicitly (absolute path to a git repo).',
    );
  }

  const state = await engine.startRun({
    task: {
      goal: input.task,
      acceptanceCriteria: input.acceptanceCriteria ?? [],
      repoPath,
      baseBranch: input.baseBranch ?? 'main',
      constraints: input.constraints,
    },
    strategy: input.strategy,
    budgetUsd: input.budgetUsd,
  });

  return {
    runId: state.runId,
    worktreePath: state.worktreePath,
    branch: state.branch,
    status: state.status,
    strategy: state.strategy,
    budgetUsd: state.budgetUsd,
  };
}
