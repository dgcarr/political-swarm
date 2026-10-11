import { describe, expect, it, vi } from 'vitest';
import { LlmRhetorician } from './LlmRhetorician.js';
import { aggregate, statementFor, type RunRecord } from './DoctrinalStatement.js';
import type { OpenRouterClient } from '../engine/OpenRouterClient.js';
import type { ModelsConfig } from '../util/config.js';
import type { RunState } from '../engine/RunStore.js';

const modelsConfig = {
  roles: { rhetorician: { primary: 'test/model', fallback: 'test/other' } },
  models: { 'test/model': { id: 'test/model', supportsJsonMode: false } },
} as unknown as ModelsConfig;

function clientReturning(text: string): OpenRouterClient {
  return {
    chatCompletion: vi.fn().mockResolvedValue({
      text,
      promptTokens: 10,
      completionTokens: 20,
      costUsd: 0.001,
      model: 'test/model',
    }),
  } as unknown as OpenRouterClient;
}

function makeRecord(): RunRecord {
  const state: RunState = {
    runId: 'r',
    strategy: 'democratic',
    task: { goal: 'Repair the drainage', acceptanceCriteria: [] },
    repoPath: '/repo',
    baseBranch: 'main',
    worktreePath: '/wt',
    branch: 'b',
    status: 'completed',
    createdAt: '2026-01-01T10:00:00.000Z',
    updatedAt: '2026-01-01T10:07:00.000Z',
    budgetUsd: 5,
    costUsd: 1.2345,
    tokensUsed: { prompt: 0, completion: 0 },
    workerCalls: 9,
    graph: { nodes: { t1: { id: 't1', title: 'One' } }, order: ['t1'] },
    pendingApprovals: [],
  } as unknown as RunState;

  return aggregate(state, [
    { ts: '2026-01-01T10:00:00.000Z', runId: 'r', strategy: 'democratic', type: 'task_decided', data: { taskId: 't1', outcome: 'approved' } },
  ]);
}

describe('LlmRhetorician', () => {
  const record = makeRecord();
  const draft = statementFor(record);

  it('accepts prose that cites only figures from the record', async () => {
    const text = [
      'Mr Speaker, the business before this House is concluded.',
      '',
      '1 motion stood on the Order Paper, and 1 was carried.',
      '',
      'The work is on the record for any member to examine.',
    ].join('\n');

    const result = await new LlmRhetorician(clientReturning(text), modelsConfig).revoice(draft, record);
    expect(result).not.toBeNull();
    expect(result!.paragraphs).toHaveLength(3);
    expect(result!.title).toBe(draft.title);
    // The ticker line stays deterministic — it is the sentence most likely to be quoted.
    expect(result!.closing).toBe(draft.closing);
  });

  it('rejects prose that invents a figure, keeping the deterministic statement', async () => {
    const text = [
      'Mr Speaker, the House has delivered.',
      '',
      'Public confidence in this programme stands at 87 per cent.',
    ].join('\n');

    const rhetorician = new LlmRhetorician(clientReturning(text), modelsConfig);
    await expect(rhetorician.revoice(draft, record)).resolves.toBeNull();
  });

  it('rejects a fabricated cost even when it looks plausible', async () => {
    const text = 'Mr Speaker.\n\nThe programme cost $3.5000 against its budget.';
    const rhetorician = new LlmRhetorician(clientReturning(text), modelsConfig);
    await expect(rhetorician.revoice(draft, record)).resolves.toBeNull();
  });

  it('keeps the deterministic statement when the model call fails', async () => {
    const client = {
      chatCompletion: vi.fn().mockRejectedValue(new Error('upstream 502')),
    } as unknown as OpenRouterClient;
    await expect(new LlmRhetorician(client, modelsConfig).revoice(draft, record)).resolves.toBeNull();
  });

  it('keeps the deterministic statement when the model returns nothing usable', async () => {
    for (const empty of ['', '   ', '\n\n']) {
      const rhetorician = new LlmRhetorician(clientReturning(empty), modelsConfig);
      await expect(rhetorician.revoice(draft, record)).resolves.toBeNull();
    }
  });

  it('strips markdown the model added despite being told not to', async () => {
    const text = '## Statement\n\n**Mr Speaker**, the business is concluded.\n\n- The record stands.';
    const result = await new LlmRhetorician(clientReturning(text), modelsConfig).revoice(draft, record);
    expect(result).not.toBeNull();
    for (const p of result!.paragraphs) {
      expect(p).not.toMatch(/^[#>\-*]/);
      expect(p).not.toContain('**');
    }
  });

  it('keeps the deterministic statement when no model is configured for the role', async () => {
    const bare = { roles: {}, models: {} } as unknown as ModelsConfig;
    await expect(new LlmRhetorician(clientReturning('x'), bare).revoice(draft, record)).resolves.toBeNull();
  });

  it('never calls the model more than the caller asks', async () => {
    const client = clientReturning('Mr Speaker.\n\nThe record stands.');
    await new LlmRhetorician(client, modelsConfig).revoice(draft, record);
    expect(client.chatCompletion).toHaveBeenCalledTimes(1);
  });
});
