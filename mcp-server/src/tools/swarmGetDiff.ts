import { z } from 'zod';
import type { SwarmEngine } from '../engine/SwarmEngine.js';
import { RepoWorktree } from '../engine/RepoWorktree.js';
import path from 'node:path';
import { latestVerdict } from '../engine/TaskGraph.js';
import { runIdSchema } from '../util/ids.js';

export const swarmGetDiffInputShape = {
  runId: runIdSchema,
  taskId: z.string().optional(),
};

export interface SwarmGetDiffResult {
  diffText: string;
  filesChanged: string[];
  summary: string;
}

export async function swarmGetDiff(
  engine: SwarmEngine,
  runsRootDir: string,
  input: { runId: string; taskId?: string },
): Promise<SwarmGetDiffResult> {
  const state = engine.getRunStore().load(input.runId);
  if (!state) throw new Error(`Unknown run "${input.runId}"`);

  const runDir = path.join(runsRootDir, input.runId);
  const worktree = new RepoWorktree(state.repoPath, runDir, input.runId);
  const { diffText, filesChanged } = await worktree.diff();

  const node = input.taskId && state.graph ? state.graph.nodes[input.taskId] : undefined;
  const taskDisposition = node
    ? latestVerdict(node) ?? (node.phase === 'running' ? 'in_progress' : node.phase === 'blocked' ? 'blocked_on_human' : node.phase)
    : undefined;
  const summary = node
    ? `Task "${node.title}" (${taskDisposition}): ${filesChanged.length} file(s) changed.`
    : `Run "${input.runId}" (${state.status}): ${filesChanged.length} file(s) changed across all approved tasks so far.`;

  return { diffText, filesChanged, summary };
}
