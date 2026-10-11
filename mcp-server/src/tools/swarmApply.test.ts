import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SwarmEngine } from '../engine/SwarmEngine.js';
import { Ledger } from '../engine/Ledger.js';
import { RepoWorktree } from '../engine/RepoWorktree.js';
import { RunStore, type RunState, type RunStatus } from '../engine/RunStore.js';
import type { PendingApproval, TaskAttempt, TaskGraph, TaskNode } from '../engine/types.js';
import { swarmApply } from './swarmApply.js';

const RUN_ID = 'test-run';

let tmpRoot: string;
let repoPath: string;
let runsRootDir: string;
let runStore: RunStore;
let engine: SwarmEngine;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'swarm-apply-test-'));
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

  runStore = new RunStore(runsRootDir);
  engine = { getRunStore: () => runStore } as unknown as SwarmEngine;
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('swarmApply', () => {
  it('preserves the completed-run apply behavior and default commit message when the flag is present', async () => {
    const graph = graphFor([
      nodeFor('approved-task', 'settled', attemptFor('approved')),
    ]);
    const worktree = await saveRun('completed', graph);
    worktree.applyFileOps([{ op: 'write', path: 'approved-task.txt', content: 'approved work\n' }]);

    const result = await applyReviewedFixture(engine, runsRootDir, {
      runId: RUN_ID,
      allowPartialFromIncomplete: true,
    });

    expect(result.applied).toBe(true);
    expect(result.appliedFiles).toEqual(['approved-task.txt']);
    expect(readFileSync(path.join(repoPath, 'approved-task.txt'), 'utf8')).toBe('approved work\n');
    expect(git(repoPath, ['log', '-1', '--pretty=%s'])).toBe('political-swarm(noop): test goal');
  });

  it.each([undefined, false])(
    'refuses an incomplete run when the opt-in flag is %s',
    async (allowPartialFromIncomplete) => {
      await saveRun('terminated_incomplete', graphFor([nodeFor('approved-task', 'settled', attemptFor('approved'))]), {
        lastError: 'graph exhausted',
      });

      await expect(
        applyReviewedFixture(engine, runsRootDir, { runId: RUN_ID, allowPartialFromIncomplete }),
      ).rejects.toThrow(
        `Refusing to apply run "${RUN_ID}": status is "terminated_incomplete", not "completed". The run ended incomplete and has no accepted delivery. Reason: graph exhausted`,
      );
    },
  );

  it('applies only approved work from an incomplete run when explicitly opted in', async () => {
    const graph = graphFor([
      nodeFor('approved-task', 'settled', attemptFor('approved')),
      nodeFor('rejected-task', 'abandoned', attemptFor('rejected')),
      nodeFor('never-attempted-task', 'queued'),
    ]);
    const worktree = await saveRun('terminated_incomplete', graph, { lastError: 'dependency could not settle' });
    worktree.applyFileOps([{ op: 'write', path: 'approved-task.txt', content: 'approved work\n' }]);
    const rejectedWork = [{ op: 'write' as const, path: 'rejected-task.txt', content: 'rejected work\n' }];
    const rejectedSnapshot = worktree.snapshotFileOps(rejectedWork);
    worktree.applyFileOps(rejectedWork);
    worktree.revertFileOps(rejectedSnapshot);

    const result = await applyReviewedFixture(engine, runsRootDir, {
      runId: RUN_ID,
      allowPartialFromIncomplete: true,
    });

    expect(result.applied).toBe(true);
    expect(result.appliedFiles).toEqual(['approved-task.txt']);
    expect(result.remainingDiff).toBe('2 task(s) not yet approved/applied.');
    expect(readFileSync(path.join(repoPath, 'approved-task.txt'), 'utf8')).toBe('approved work\n');
    expect(existsSync(path.join(repoPath, 'rejected-task.txt'))).toBe(false);
    expect(existsSync(path.join(repoPath, 'never-attempted-task.txt'))).toBe(false);
    expect(git(repoPath, ['log', '-1', '--pretty=%s'])).toContain('partial salvage from an incomplete run');

    const appliedEntry = new Ledger(path.join(runsRootDir, RUN_ID), RUN_ID, 'noop')
      .readAll()
      .find((entry) => entry.type === 'applied_to_real_repo');
    expect(appliedEntry?.data).toMatchObject({
      taskIds: ['approved-task'],
      filesChanged: ['approved-task.txt'],
      fromStatus: 'terminated_incomplete',
    });
  });

  it('refuses an incomplete run with no approved tasks even when explicitly opted in', async () => {
    await saveRun(
      'terminated_incomplete',
      graphFor([
        nodeFor('rejected-task', 'abandoned', attemptFor('rejected')),
        nodeFor('never-attempted-task', 'queued'),
      ]),
    );

    await expect(
      applyReviewedFixture(engine, runsRootDir, { runId: RUN_ID, allowPartialFromIncomplete: true }),
    ).rejects.toThrow('No approved tasks to apply yet.');
  });

  it('keeps unresolved approvals blocking an explicitly opted-in salvage', async () => {
    const pendingApproval: PendingApproval = {
      id: 'approval-1',
      kind: 'final_diff',
      description: 'Review the final diff',
      createdAt: new Date().toISOString(),
    };
    await saveRun('terminated_incomplete', graphFor([nodeFor('approved-task', 'settled', attemptFor('approved'))]), {
      pendingApprovals: [pendingApproval],
    });

    await expect(
      applyReviewedFixture(engine, runsRootDir, { runId: RUN_ID, allowPartialFromIncomplete: true }),
    ).rejects.toThrow(`Run "${RUN_ID}" has 1 unresolved approval(s). Resolve them with swarm_decide before applying.`);
  });

  describe('taskIds subset', () => {
    const twoTasks = (): TaskGraph => graphFor([
      nodeFor('a', 'settled', attemptFor('approved')),
      nodeFor('b', 'settled', attemptFor('approved')),
    ]);
    const writeBoth = (worktree: RepoWorktree): void => {
      worktree.applyFileOps([
        { op: 'write', path: 'a.txt', content: 'from a\n' },
        { op: 'write', path: 'b.txt', content: 'from b\n' },
      ]);
    };

    it("applies only the files the chosen tasks own and reports what it left", async () => {
      writeBoth(await saveRun('completed', twoTasks()));

      const result = await applyReviewedFixture(engine, runsRootDir, { runId: RUN_ID, taskIds: ['a'] });

      expect(result.appliedFiles).toEqual(['a.txt']);
      expect(result.excludedFiles).toEqual([{ path: 'b.txt', owners: ['b'] }]);
      expect(result.remainingDiff).toContain('Approved but not applied: b');
      expect(readFileSync(path.join(repoPath, 'a.txt'), 'utf8')).toBe('from a\n');
      expect(existsSync(path.join(repoPath, 'b.txt'))).toBe(false);
      expect(git(repoPath, ['log', '-1', '--pretty=%s'])).toBe('political-swarm(noop): test goal [tasks: a]');
      expect(git(repoPath, ['status', '--porcelain'])).toBe('');
    });

    it('applies the rest later as a second subset', async () => {
      writeBoth(await saveRun('completed', twoTasks()));

      await applyReviewedFixture(engine, runsRootDir, { runId: RUN_ID, taskIds: ['a'] });
      await applyReviewedFixture(engine, runsRootDir, { runId: RUN_ID, taskIds: ['b'] });

      expect(readFileSync(path.join(repoPath, 'b.txt'), 'utf8')).toBe('from b\n');
      expect(git(repoPath, ['log', '--pretty=%s', '-2']).split('\n')).toHaveLength(2);
      await expect(applyReviewedFixture(engine, runsRootDir, { runId: RUN_ID, taskIds: ['b'] }))
        .rejects.toThrow('already has these tasks');
    });

    it('refuses a task without the approved task it depends on', async () => {
      const graph = twoTasks();
      graph.nodes.b.dependsOn = ['a'];
      writeBoth(await saveRun('completed', graph));

      await expect(applyReviewedFixture(engine, runsRootDir, { runId: RUN_ID, taskIds: ['b'] }))
        .rejects.toThrow('without the task(s) they depend on: a');
      expect(existsSync(path.join(repoPath, 'b.txt'))).toBe(false);
    });

    it('keeps commits made on the base branch after the run began', async () => {
      writeBoth(await saveRun('completed', twoTasks()));
      writeFileSync(path.join(repoPath, 'later.txt'), 'user work\n', 'utf8');
      git(repoPath, ['add', 'later.txt']);
      git(repoPath, ['commit', '-q', '-m', 'user commit']);

      await applyReviewedFixture(engine, runsRootDir, { runId: RUN_ID, taskIds: ['a'] });

      expect(readFileSync(path.join(repoPath, 'later.txt'), 'utf8')).toBe('user work\n');
      expect(readFileSync(path.join(repoPath, 'a.txt'), 'utf8')).toBe('from a\n');
    });

    it('refuses, changing nothing, when the real repo has uncommitted edits to a chosen file', async () => {
      writeBoth(await saveRun('completed', twoTasks()));
      writeFileSync(path.join(repoPath, 'a.txt'), 'user draft\n', 'utf8');
      const head = git(repoPath, ['rev-parse', 'HEAD']);

      await expect(applyReviewedFixture(engine, runsRootDir, { runId: RUN_ID, taskIds: ['a'] }))
        .rejects.toThrow('uncommitted changes to files these tasks change');
      expect(readFileSync(path.join(repoPath, 'a.txt'), 'utf8')).toBe('user draft\n');
      expect(git(repoPath, ['rev-parse', 'HEAD'])).toBe(head);
    });

    it('refuses, changing nothing, when the base branch changed the same file since the run began', async () => {
      writeBoth(await saveRun('completed', twoTasks()));
      writeFileSync(path.join(repoPath, 'a.txt'), 'someone else\n', 'utf8');
      git(repoPath, ['add', 'a.txt']);
      git(repoPath, ['commit', '-q', '-m', 'conflicting commit']);
      const head = git(repoPath, ['rev-parse', 'HEAD']);

      await expect(applyReviewedFixture(engine, runsRootDir, { runId: RUN_ID, taskIds: ['a'] }))
        .rejects.toThrow('no longer apply cleanly');
      expect(git(repoPath, ['rev-parse', 'HEAD'])).toBe(head);
      expect(git(repoPath, ['status', '--porcelain'])).toBe('');
    });
  });

  describe('sensitive paths', () => {
    const workflow = '.github/workflows/ci.yml';

    it('refuses, changing nothing, to apply a workflow without confirmation, and names it', async () => {
      const worktree = await saveRun('completed', graphFor([nodeFor('approved-task', 'settled', attemptFor('approved'))]));
      worktree.applyFileOps([
        { op: 'write', path: workflow, content: 'on: push\n' },
        { op: 'write', path: 'plain.txt', content: 'plain\n' },
      ]);
      const head = git(repoPath, ['rev-parse', 'HEAD']);

      await expect(applyReviewedFixture(engine, runsRootDir, { runId: RUN_ID })).rejects.toThrow(
        `can run code outside the checks once applied: ${workflow}. Review those changes in the diff, then re-run swarm_apply with confirmSensitivePaths: true.`,
      );
      expect(git(repoPath, ['rev-parse', 'HEAD'])).toBe(head);
      expect(existsSync(path.join(repoPath, workflow))).toBe(false);
    });

    it('applies it once confirmed', async () => {
      const worktree = await saveRun('completed', graphFor([nodeFor('approved-task', 'settled', attemptFor('approved'))]));
      worktree.applyFileOps([{ op: 'write', path: workflow, content: 'on: push\n' }]);

      const result = await applyReviewedFixture(engine, runsRootDir, { runId: RUN_ID, confirmSensitivePaths: true });

      expect(result.appliedFiles).toEqual([workflow]);
      expect(readFileSync(path.join(repoPath, workflow), 'utf8')).toBe('on: push\n');
    });

    it('checks only the chosen subset, so an unchosen task\'s manifest does not block it', async () => {
      const worktree = await saveRun('completed', graphFor([
        nodeFor('a', 'settled', attemptFor('approved')),
        nodeFor('b', 'settled', attemptFor('approved')),
      ]));
      worktree.applyFileOps([
        { op: 'write', path: 'a.txt', content: 'from a\n' },
        { op: 'write', path: 'b.txt', content: 'from b\n' },
        { op: 'write', path: 'package.json', content: '{}\n' },
      ]);

      const result = await applyReviewedFixture(engine, runsRootDir, { runId: RUN_ID, taskIds: ['a'] });
      expect(result.appliedFiles).toEqual(['a.txt']);
    });
  });

  it.each([
    [
      'awaiting_acceptance',
      true,
      'Read the delivery packet with swarm_get_delivery, check it yourself, then accept it with swarm_accept (or return defects with swarm_remediate).',
    ],
    ['paused_human', true, 'Only a run whose delivery packet Claude has independently accepted can be applied.'],
  ] as const)(
    'refuses status %s even when the opt-in flag is %s',
    async (status, allowPartialFromIncomplete, expectedHint) => {
      await saveRun(status, graphFor([nodeFor('approved-task', 'settled', attemptFor('approved'))]));

      await expect(
        applyReviewedFixture(engine, runsRootDir, { runId: RUN_ID, allowPartialFromIncomplete }),
      ).rejects.toThrow(
        `Refusing to apply run "${RUN_ID}": status is "${status}", not "completed". ${expectedHint}`,
      );
    },
  );
});

function attemptFor(outcome: TaskAttempt['outcome']): TaskAttempt {
  return {
    attempt: 1,
    outcome,
    rationale: `${outcome} in test`,
    evidenceRefs: [],
    at: new Date().toISOString(),
    fingerprint: outcome,
    repeated: false,
  };
}

function nodeFor(id: string, phase: TaskNode['phase'], attempt?: TaskAttempt): TaskNode {
  return {
    id,
    title: id,
    description: `Implement ${id}`,
    acceptanceCriteria: ['works'],
    dependsOn: [],
    targetGlobs: [`${id}.txt`],
    riskTags: [],
    riskClass: 'low',
    phase,
    attempts: attempt ? [attempt] : [],
  };
}

function graphFor(nodes: TaskNode[]): TaskGraph {
  return {
    order: nodes.map((node) => node.id),
    nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
  };
}

async function saveRun(
  status: RunStatus,
  graph: TaskGraph,
  overrides: Partial<Pick<RunState, 'lastError' | 'pendingApprovals'>> = {},
): Promise<RepoWorktree> {
  const runDir = path.join(runsRootDir, RUN_ID);
  const worktree = new RepoWorktree(repoPath, runDir, RUN_ID);
  await worktree.create('main');
  const now = new Date().toISOString();
  const state: RunState = {
    runId: RUN_ID,
    strategy: 'noop',
    task: { goal: 'test goal', acceptanceCriteria: ['works'] },
    repoPath,
    baseBranch: 'main',
    worktreePath: worktree.worktreePath,
    branch: worktree.branch,
    status,
    createdAt: now,
    updatedAt: now,
    budgetUsd: 10,
    costUsd: 0,
    tokensUsed: { prompt: 0, completion: 0 },
    workerCalls: 0,
    graph,
    pendingApprovals: overrides.pendingApprovals ?? [],
    strategyState: {},
    lastError: overrides.lastError,
  };
  runStore.save(state);
  return worktree;
}

/** Existing apply fixtures model a completed review, without running an entire doctrine. */
async function applyReviewedFixture(...args: Parameters<typeof swarmApply>) {
  const state = runStore.load(args[2].runId)!;
  if (state.status === 'completed' && !state.acceptedTreeId) {
    const worktree = new RepoWorktree(repoPath, path.join(runsRootDir, state.runId), state.runId);
    state.acceptedTreeId = await worktree.snapshotTree();
    state.delivery = { treeId: state.acceptedTreeId } as NonNullable<RunState['delivery']>;
    runStore.save(state);
  }
  return swarmApply(...args);
}
