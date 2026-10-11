import { z } from 'zod';
import path from 'node:path';
import type { SwarmEngine } from '../engine/SwarmEngine.js';
import { RepoWorktree } from '../engine/RepoWorktree.js';
import { Ledger } from '../engine/Ledger.js';
import { approvedNodeIds, latestVerdict } from '../engine/TaskGraph.js';
import { filesForTasks, ownershipFromGraph } from '../engine/ownership.js';
import { sensitivePaths } from '../engine/delivery.js';
import { MAX_TASK_CHARS, runIdSchema } from '../util/ids.js';

export const swarmApplyInputShape = {
  runId: runIdSchema,
  taskIds: z.array(z.string()).optional().describe(
    'Apply only these approved tasks: the files they own, as one commit on the base branch. Each must be approved, and every task one depends on must be included. Omit to apply the whole run.',
  ),
  commitMessage: z.string().max(MAX_TASK_CHARS).optional(),
  allowPartialFromIncomplete: z.boolean().optional(),
  confirmSensitivePaths: z.boolean().optional().describe(
    'Required when the files to apply include CI workflows, git hooks or config, package manifests or build scripts. Set only after reviewing those files in the diff.',
  ),
};

export interface SwarmApplyResult {
  applied: boolean;
  appliedFiles: string[];
  commitSha: string;
  remainingDiff: string | undefined;
  /** With `taskIds`: changed files left in the run because no chosen task owns them. */
  excludedFiles?: Array<{ path: string; owners: string[] }>;
}

// The ONLY tool that writes to the user's real repository. The calling command
// (commands/swarm-apply.md) has disable-model-invocation: true and requires an explicit
// in-chat confirmation before this is ever called — see README's documented limitation on
// why that enforcement is procedural, not protocol-guaranteed.
export async function swarmApply(
  engine: SwarmEngine,
  runsRootDir: string,
  input: {
    runId: string;
    taskIds?: string[];
    commitMessage?: string;
    allowPartialFromIncomplete?: boolean;
    confirmSensitivePaths?: boolean;
  },
): Promise<SwarmApplyResult> {
  const state = engine.getRunStore().load(input.runId);
  if (!state) throw new Error(`Unknown run "${input.runId}"`);

  // Section 5 makes Claude's independent acceptance the ordinary precondition for leaving the
  // isolated worktree. The sole exception is the explicit incomplete-run salvage below, which the
  // human-only calling command presents separately and limits to the swarm-approved work already
  // retained in the worktree.
  const isPartialSalvage =
    state.status === 'terminated_incomplete' && input.allowPartialFromIncomplete === true;
  if (state.status !== 'completed' && !isPartialSalvage) {
    const hint =
      state.status === 'awaiting_acceptance'
        ? 'Read the delivery packet with swarm_get_delivery, check it yourself, then accept it with swarm_accept (or return defects with swarm_remediate).'
        : state.status === 'terminated_incomplete'
          ? `The run ended incomplete and has no accepted delivery.${state.lastError ? ` Reason: ${state.lastError}` : ''}`
          : 'Only a run whose delivery packet Claude has independently accepted can be applied.';
    throw new Error(`Refusing to apply run "${input.runId}": status is "${state.status}", not "completed". ${hint}`);
  }

  const unresolvedBlocking = state.pendingApprovals.filter((a) => !a.resolvedAt);
  if (unresolvedBlocking.length > 0) {
    throw new Error(
      `Run "${input.runId}" has ${unresolvedBlocking.length} unresolved approval(s). Resolve them with swarm_decide before applying.`,
    );
  }

  const graph = state.graph;
  const targetTaskIds = input.taskIds ?? (graph ? approvedNodeIds(graph) : []);
  const notApproved = targetTaskIds.filter((id) => !graph?.nodes[id] || latestVerdict(graph.nodes[id]) !== 'approved');
  if (notApproved.length > 0) {
    throw new Error(`Cannot apply unapproved task(s): ${notApproved.join(', ')}`);
  }
  if (targetTaskIds.length === 0) {
    throw new Error('No approved tasks to apply yet.');
  }

  // A subset must carry what it builds on: applying a task without an approved task it depends on
  // would put code in the real repo that imports or calls files that are not there.
  if (input.taskIds && graph) {
    const chosen = new Set(input.taskIds);
    const missing = new Set<string>();
    const visit = (id: string): void => {
      for (const dep of graph.nodes[id]?.dependsOn ?? []) {
        if (chosen.has(dep) || missing.has(dep)) continue;
        missing.add(dep);
        visit(dep);
      }
    };
    input.taskIds.forEach(visit);
    if (missing.size > 0) {
      throw new Error(
        `Cannot apply ${input.taskIds.join(', ')} without the task(s) they depend on: ${[...missing].join(', ')}. ` +
          'Add them to taskIds, or omit taskIds to apply the whole run.',
      );
    }
  }

  const runDir = path.join(runsRootDir, input.runId);
  if (!isPartialSalvage && (!state.acceptedTreeId || state.acceptedTreeId !== state.delivery?.treeId)) {
    throw new Error('This run has no immutable accepted delivery. Start a new run and review its delivery before applying.');
  }
  const worktree = new RepoWorktree(state.repoPath, runDir, input.runId);
  const { filesChanged: allChanged } = await worktree.diff();
  const defaultCommitMessage = isPartialSalvage
    ? `political-swarm(${state.strategy}): ${state.task.goal} (partial salvage from an incomplete run)`
    : `political-swarm(${state.strategy}): ${state.task.goal}`;
  // The worktree keeps one commit of everything either way; only the real repo sees a subset.
  const revision = await worktree.commit(input.commitMessage ?? defaultCommitMessage, isPartialSalvage ? undefined : state.acceptedTreeId);

  // Applying these runs nothing, but the next push, install, commit or editor open does: model-written
  // code would execute outside any check. Refuse until a human has looked at them specifically.
  let sensitive: string[] = [];
  const refuseUnconfirmedSensitive = (files: readonly string[]): void => {
    sensitive = sensitivePaths(files);
    if (sensitive.length > 0 && input.confirmSensitivePaths !== true) {
      throw new Error(
        `Refusing to apply run "${input.runId}": it changes file(s) that can run code outside the checks once applied: ` +
          `${sensitive.join(', ')}. Review those changes in the diff, then re-run swarm_apply with confirmSensitivePaths: true.`,
      );
    }
  };

  let filesChanged = allChanged;
  let excludedFiles: SwarmApplyResult['excludedFiles'];
  let commitSha: string;
  if (input.taskIds) {
    const ownership = state.ownership ?? (graph ? ownershipFromGraph(graph, []) : { entries: {}, declaredOverlaps: [], publishedAt: '' });
    // From the run's base, not the worktree's index: an earlier subset apply already committed it.
    const split = filesForTasks(await worktree.changedSinceBase(state.baseBranch, revision), input.taskIds, ownership);
    if (split.selected.length === 0) {
      throw new Error(`The selected task(s) ${input.taskIds.join(', ')} own none of the run's changed files; nothing to apply.`);
    }
    filesChanged = split.selected;
    excludedFiles = [...split.othersOwn, ...split.unowned.map((p) => ({ path: p, owners: [] }))];
    refuseUnconfirmedSensitive(split.selected);
    const subsetMessage = input.commitMessage ?? `${defaultCommitMessage} [tasks: ${input.taskIds.join(', ')}]`;
    ({ commitSha } = await worktree.applyPathsToRealRepo(state.baseBranch, split.selected, { message: subsetMessage, revision }));
  } else {
    // The merge brings the branch's whole change since base, including files an earlier subset left behind.
    refuseUnconfirmedSensitive(await worktree.changedSinceBase(state.baseBranch, revision));
    ({ commitSha } = await worktree.applyToRealRepo(state.baseBranch, revision));
  }

  const ledger = new Ledger(runDir, input.runId, state.strategy);
  ledger.record('applied_to_real_repo', {
    taskIds: targetTaskIds,
    filesChanged,
    commitSha,
    fromStatus: state.status,
    ...(excludedFiles ? { subset: true, excludedFiles } : {}),
    ...(sensitive.length > 0 ? { sensitivePathsConfirmed: sensitive } : {}),
  });

  const remaining = graph
    ? graph.order.filter((id) => !targetTaskIds.includes(id) && latestVerdict(graph.nodes[id]) !== 'approved')
    : [];
  const approvedLeft = input.taskIds && graph
    ? graph.order.filter((id) => !targetTaskIds.includes(id) && latestVerdict(graph.nodes[id]) === 'approved')
    : [];
  const remainingDiff = remaining.length + approvedLeft.length > 0
    ? [
        remaining.length > 0 ? `${remaining.length} task(s) not yet approved/applied.` : '',
        approvedLeft.length > 0 ? `Approved but not applied: ${approvedLeft.join(', ')}.` : '',
      ].filter(Boolean).join(' ')
    : undefined;

  return { applied: true, appliedFiles: filesChanged, commitSha, remainingDiff, ...(excludedFiles ? { excludedFiles } : {}) };
}
