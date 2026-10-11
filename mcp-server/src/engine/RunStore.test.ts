import { describe, expect, it } from 'vitest';
import { migrateLegacyTaskNodes, type RunState } from './RunStore.js';
import type { TaskNode } from './types.js';

const UPDATED_AT = '2026-08-23T01:02:03.000Z';

function stateWithNodes(nodes: Record<string, unknown>): RunState {
  return {
    runId: 'run-1',
    strategy: 'democratic',
    task: { goal: 'test migration', acceptanceCriteria: [] },
    repoPath: '/repo',
    baseBranch: 'main',
    worktreePath: '/worktree',
    branch: 'swarm/run-1',
    status: 'terminated_incomplete',
    createdAt: UPDATED_AT,
    updatedAt: UPDATED_AT,
    budgetUsd: 1,
    costUsd: 0,
    tokensUsed: { prompt: 0, completion: 0 },
    workerCalls: 0,
    graph: { nodes, order: Object.keys(nodes) },
    pendingApprovals: [],
  } as unknown as RunState;
}

function legacyNode(status: string): Record<string, unknown> {
  return {
    id: status,
    title: status,
    description: '',
    acceptanceCriteria: [],
    dependsOn: [],
    targetGlobs: [],
    riskTags: [],
    riskClass: 'low',
    status,
  };
}

describe('migrateLegacyTaskNodes', () => {
  it('maps every legacy status to phase and synthetic attempt history', () => {
    const state = stateWithNodes({
      pending: legacyNode('pending'),
      ready: legacyNode('ready'),
      in_progress: legacyNode('in_progress'),
      blocked: legacyNode('blocked_on_human'),
      approved: legacyNode('approved'),
      rejected: legacyNode('rejected'),
    });

    const migrated = migrateLegacyTaskNodes(state);

    expect(migrated.graph?.nodes.pending).toMatchObject({ phase: 'queued', attempts: [] });
    expect(migrated.graph?.nodes.ready).toMatchObject({ phase: 'queued', attempts: [] });
    expect(migrated.graph?.nodes.in_progress).toMatchObject({ phase: 'queued', attempts: [] });
    expect(migrated.graph?.nodes.blocked).toMatchObject({ phase: 'blocked', attempts: [] });
    expect(migrated.graph?.nodes.approved).toMatchObject({
      phase: 'settled',
      attempts: [{ attempt: 1, outcome: 'approved', rationale: 'migrated from legacy status', at: UPDATED_AT }],
    });
    expect(migrated.graph?.nodes.rejected).toMatchObject({
      phase: 'abandoned',
      attempts: [{ attempt: 1, outcome: 'rejected', rationale: 'migrated from legacy status', at: UPDATED_AT }],
    });
    for (const task of Object.values(migrated.graph!.nodes)) expect(task).not.toHaveProperty('status');
  });

  it('passes a node that already has a phase through untouched', () => {
    const current: TaskNode = {
      id: 'current',
      title: 'current',
      description: '',
      acceptanceCriteria: [],
      dependsOn: [],
      targetGlobs: [],
      riskTags: [],
      riskClass: 'low',
      phase: 'queued',
      attempts: [],
    };
    const state = stateWithNodes({ current });

    migrateLegacyTaskNodes(state);

    expect(state.graph?.nodes.current).toBe(current);
    expect(state.graph?.nodes.current).toEqual(current);
  });
});
