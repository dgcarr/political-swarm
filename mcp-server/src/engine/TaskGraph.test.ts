import { describe, expect, it } from 'vitest';
import {
  addNode,
  allApproved,
  allDisposed,
  approvedNodeIds,
  emptyGraph,
  hasBlockedNodes,
  latestVerdict,
  progressSummary,
  readyNodes,
  recordAttempt,
  rejectedNodeIds,
  releaseOrphanedDependents,
} from './TaskGraph.js';
import type { TaskAttempt, TaskGraph, TaskNode } from './types.js';

const AT = '2026-08-23T00:00:00.000Z';

function attempt(outcome: TaskAttempt['outcome'], number = 1): TaskAttempt {
  return {
    attempt: number,
    outcome,
    rationale: `${outcome} by test`,
    evidenceRefs: [],
    at: AT,
    fingerprint: `attempt-${number}`,
    repeated: false,
  };
}

function node(id: string, overrides: Partial<TaskNode> = {}): TaskNode {
  return {
    id,
    title: id,
    description: '',
    acceptanceCriteria: [],
    dependsOn: [],
    targetGlobs: [],
    riskTags: [],
    riskClass: 'low',
    phase: 'queued',
    attempts: [],
    ...overrides,
  };
}

function graph(...nodes: TaskNode[]): TaskGraph {
  const result = emptyGraph();
  for (const task of nodes) addNode(result, task);
  return result;
}

describe('TaskGraph', () => {
  it('creates an empty graph and adds nodes in insertion order', () => {
    const result = emptyGraph();
    const task = node('one');

    addNode(result, task);

    expect(result).toEqual({ nodes: { one: task }, order: ['one'] });
  });

  it('records contiguous attempts and returns the latest verdict', () => {
    const task = node('one');

    const first = recordAttempt(task, {
      outcome: 'rejected',
      rationale: 'first review failed',
      evidenceRefs: ['test:1'],
      at: AT,
      fingerprint: 'first',
      repeated: false,
    });
    const second = recordAttempt(task, {
      outcome: 'approved',
      rationale: 'retry passed',
      evidenceRefs: ['test:2'],
      assigneeId: 'worker-1',
      testsPassed: true,
      at: AT,
      fingerprint: 'second',
      repeated: false,
    });

    expect(first.attempt).toBe(1);
    expect(second.attempt).toBe(2);
    expect(task.attempts).toEqual([first, second]);
    expect(latestVerdict(task)).toBe('approved');
    expect(latestVerdict(node('unattempted'))).toBeUndefined();
  });

  it('returns only queued nodes whose dependencies have latest approval verdicts', () => {
    const approvedDependency = node('dependency', {
      phase: 'settled',
      attempts: [attempt('rejected', 1), attempt('approved', 2)],
    });
    const ready = node('ready', { dependsOn: ['dependency'] });
    const missingDependency = node('missing', { dependsOn: ['unknown'] });
    const running = node('running', { phase: 'running' });

    expect(readyNodes(graph(approvedDependency, ready, missingDependency, running))).toEqual([ready]);
  });

  it('allows a node re-queued after a rejected attempt to become ready again', () => {
    const retried = node('retry', { phase: 'queued', attempts: [attempt('rejected')] });

    expect(readyNodes(graph(retried))).toEqual([retried]);
  });

  it('requires a non-empty graph whose latest verdicts are all approved', () => {
    const retried = node('retry', {
      phase: 'settled',
      attempts: [attempt('rejected', 1), attempt('approved', 2)],
    });

    expect(allApproved(graph(retried))).toBe(true);
    expect(allApproved(graph(retried, node('pending')))).toBe(false);
    expect(allApproved(emptyGraph())).toBe(false);
  });

  it('is disposed only when every node is settled or abandoned', () => {
    const settled = node('settled', { phase: 'settled', attempts: [attempt('approved')] });
    const abandoned = node('abandoned', { phase: 'abandoned', attempts: [attempt('rejected')] });

    expect(allDisposed(graph(settled, abandoned))).toBe(true);
    expect(allDisposed(graph(settled, node('queued')))).toBe(false);
  });

  it('reports abandoned ids separately from latest approved verdict ids', () => {
    const approved = node('approved', { phase: 'settled', attempts: [attempt('approved')] });
    const abandoned = node('abandoned', { phase: 'abandoned', attempts: [attempt('rejected')] });
    const requeued = node('requeued', { phase: 'queued', attempts: [attempt('rejected')] });

    const result = graph(approved, abandoned, requeued);
    expect(rejectedNodeIds(result)).toEqual(['abandoned']);
    expect(approvedNodeIds(result)).toEqual(['approved']);
  });

  it('detects blocked nodes', () => {
    expect(hasBlockedNodes(graph(node('blocked', { phase: 'blocked' })))).toBe(true);
    expect(hasBlockedNodes(graph(node('queued')))).toBe(false);
  });

  it('summarises approved, abandoned, and all other nodes', () => {
    const result = graph(
      node('approved', { phase: 'settled', attempts: [attempt('approved')] }),
      node('abandoned', { phase: 'abandoned', attempts: [attempt('rejected')] }),
      node('queued'),
      node('blocked', { phase: 'blocked', attempts: [attempt('needs_human')] }),
    );

    expect(progressSummary(result)).toEqual({ total: 4, approved: 1, rejected: 1, pending: 2 });
  });
});

/**
 * One abandoned task used to take its whole subtree with it: its dependents stayed queued forever
 * because readyNodes required every dependency's latest verdict to be `approved`. That ended every
 * benchmark run in the session — democratic settled four of eight tasks and delivered nothing,
 * with the other four never attempted once and $7 of its $8 unspent.
 */
describe('releaseOrphanedDependents', () => {
  function node(id: string, deps: string[], phase: TaskNode['phase'], verdict?: TaskAttempt['outcome']): TaskNode {
    return {
      id,
      title: id,
      description: '',
      acceptanceCriteria: [],
      dependsOn: deps,
      targetGlobs: [`${id}.py`],
      riskTags: [],
      riskClass: 'low',
      phase,
      attempts: verdict
        ? [{ attempt: 1, outcome: verdict, rationale: '', evidenceRefs: [], at: '2026-01-01T00:00:00.000Z', fingerprint: '', repeated: false }]
        : [],
    };
  }

  function graphOf(...nodes: TaskNode[]): TaskGraph {
    return { order: nodes.map((n) => n.id), nodes: Object.fromEntries(nodes.map((n) => [n.id, n])) };
  }

  it('frees a task whose only blocker was abandoned, and records what it lost', () => {
    const graph = graphOf(node('a', [], 'abandoned', 'rejected'), node('b', ['a'], 'queued'));

    expect(readyNodes(graph)).toHaveLength(0);
    expect(releaseOrphanedDependents(graph)).toEqual([{ taskId: 'b', missing: ['a'] }]);
    expect(readyNodes(graph).map((n) => n.id)).toEqual(['b']);
    expect(graph.nodes.b.abandonedDependencies).toEqual(['a']);
  });

  it('leaves a task still waiting on live work alone', () => {
    const graph = graphOf(
      node('a', [], 'abandoned', 'rejected'),
      node('b', [], 'queued'),
      node('c', ['a', 'b'], 'queued'),
    );

    expect(releaseOrphanedDependents(graph)).toEqual([]);
    expect(graph.nodes.c.abandonedDependencies).toBeUndefined();
  });

  it('does not touch tasks whose dependencies were approved', () => {
    const graph = graphOf(node('a', [], 'settled', 'approved'), node('b', ['a'], 'queued'));

    expect(releaseOrphanedDependents(graph)).toEqual([]);
    expect(readyNodes(graph).map((n) => n.id)).toEqual(['b']);
  });

  it('releases a whole stranded chain across successive passes', () => {
    const graph = graphOf(
      node('a', [], 'abandoned', 'rejected'),
      node('b', ['a'], 'queued'),
      node('c', ['b'], 'queued'),
    );

    expect(releaseOrphanedDependents(graph).map((r) => r.taskId)).toEqual(['b']);
    // c stays blocked while b is live work — it is freed only if b is itself abandoned.
    graph.nodes.b.phase = 'abandoned';
    graph.nodes.b.attempts.push({ attempt: 1, outcome: 'rejected', rationale: '', evidenceRefs: [], at: '2026-01-01T00:00:00.000Z', fingerprint: '', repeated: false });
    expect(releaseOrphanedDependents(graph).map((r) => r.taskId)).toEqual(['c']);
  });

  it('returns nothing when there is genuinely no work left to free', () => {
    expect(releaseOrphanedDependents(graphOf(node('a', [], 'settled', 'approved')))).toEqual([]);
  });
});
