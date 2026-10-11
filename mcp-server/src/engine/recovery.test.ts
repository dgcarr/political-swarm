import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RunStore, type RunState } from './RunStore.js';
import { recoverInterruptedTasks } from './SwarmEngine.js';
import type { TaskGraph, TaskNode } from './types.js';

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('RunStore with an unreadable run', () => {
  it('lists the readable runs and names the unreadable one when loaded directly', () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'runstore-corrupt-'));
    const store = new RunStore(dir);
    store.save({ runId: 'good', createdAt: '2026-10-06T00:00:00.000Z', strategy: 'noop', graph: null, pendingApprovals: [] } as unknown as RunState);
    mkdirSync(path.join(dir, 'torn'));
    writeFileSync(path.join(dir, 'torn', 'state.json'), '{"runId": "torn", "sta');

    expect(store.listAll().map((s) => s.runId)).toEqual(['good']);
    expect(() => store.load('torn')).toThrow(/Run state for "torn" is unreadable/);
  });
});

describe('recoverInterruptedTasks', () => {
  const node = (id: string, phase: TaskNode['phase'], extra: Partial<TaskNode> = {}): TaskNode =>
    ({ id, title: id, phase, attempts: [], ...extra }) as unknown as TaskNode;

  it('puts back an unjudged change, requeues the cut-off task and records both', () => {
    const snapshot = [{ path: 'src/a.py', existed: true, content: 'before' }];
    const graph: TaskGraph = {
      nodes: {
        cut: node('cut', 'running', { inFlightFileSnapshots: snapshot }),
        waiting: node('waiting', 'queued'),
        done: node('done', 'settled'),
      },
      order: ['cut', 'waiting', 'done'],
    } as unknown as TaskGraph;
    const reverted: unknown[] = [];
    const recorded: Array<[string, Record<string, unknown>]> = [];

    recoverInterruptedTasks(graph, {
      worktree: { revertFileOps: (s) => reverted.push(s) },
      ledger: { record: (type, data) => recorded.push([type, data]) },
    });

    expect(reverted).toEqual([snapshot]);
    expect(graph.nodes.cut.phase).toBe('queued');
    expect(graph.nodes.cut.inFlightFileSnapshots).toBeUndefined();
    expect(graph.nodes.waiting.phase).toBe('queued');
    expect(graph.nodes.done.phase).toBe('settled');
    expect(recorded).toEqual([
      ['task_recovered_after_interrupt', { taskId: 'cut', previousPhase: 'running', phase: 'queued', revertedPaths: ['src/a.py'] }],
    ]);
  });

  it('leaves an untouched graph and ledger alone', () => {
    const graph = { nodes: { a: node('a', 'queued') }, order: ['a'] } as unknown as TaskGraph;
    const recorded: unknown[] = [];
    recoverInterruptedTasks(graph, { worktree: { revertFileOps: () => undefined }, ledger: { record: (...args) => recorded.push(args) } });
    expect(recorded).toEqual([]);
  });
});
