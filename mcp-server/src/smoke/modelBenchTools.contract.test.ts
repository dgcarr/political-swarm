// Contract for the model bench's tool-use suite: the request shape production sends (tools, tool_choice
// auto, no JSON mode), a tool call written as text graded as a failure, and the scoring gate.
import { describe, expect, it, vi } from 'vitest';
import type { CatalogModel, OpenRouterClient } from '../engine/OpenRouterClient.js';
import { REPOSITORY_TOOL_DEFINITIONS } from '../engine/repositoryTools.js';
import { benchTools, scoreModel, scoreTools, type CaseRecord, type ModelRecord } from './modelBench.js';
import { BENCH_CASES, MIN_TOOL_CALL_RATE, SUITE_VERSION, TOOL_CASES, TOOL_SUITE_VERSION } from './modelBenchCases.js';

const PASS: CaseRecord = { ok: true, firstAttemptPass: true, attempts: 1, latencyMs: 1000, costUsd: 0.001 };
const TEXT_CALL: CaseRecord = { ...PASS, ok: false, firstAttemptPass: false, failureKind: 'wrong', detail: 'tool call written as text' };

function record(): ModelRecord {
  const cases = Object.fromEntries(BENCH_CASES.map((c) => [c.id, PASS]));
  return {
    id: 'x/model', suiteVersion: SUITE_VERSION, free: false, inputPricePerMTok: 1, outputPricePerMTok: 1,
    createdAt: null, maxTokens: 4000, worstCaseUsd: 0.1, cases,
    costUsd: Object.values(cases).reduce((s, c) => s + c.costUsd, 0), testedAt: new Date(0).toISOString(),
  };
}
const withTools = (called: number) => ({
  ...record(),
  tools: {
    suiteVersion: TOOL_SUITE_VERSION,
    cases: Object.fromEntries(TOOL_CASES.map((c, i) => [c.id, i < called ? PASS : TEXT_CALL])),
    costUsd: 0.001,
    testedAt: new Date(0).toISOString(),
  },
});
const model = { id: 'x/model', supportsJsonMode: true, supportsToolCalls: true, inputPricePerMTok: 1, outputPricePerMTok: 1 } as unknown as CatalogModel;
const completion = (over: Record<string, unknown>) => ({
  text: '', promptTokens: 100, completionTokens: 20, costUsd: 0.0001, costMetered: true, attempts: 1, timedOut: false, ...over,
});

describe('tool-use suite contract', () => {
  it('has at least three cases that each name a repository file to read', () => {
    expect(TOOL_CASES.length).toBeGreaterThanOrEqual(3);
    expect(new Set(TOOL_CASES.map((c) => c.id)).size).toBe(TOOL_CASES.length);
    for (const c of TOOL_CASES) {
      expect(['implementer', 'reviewer']).toContain(c.role);
      expect(c.userPrompt).toContain(c.expectedPath);
    }
    expect(MIN_TOOL_CALL_RATE).toBeGreaterThan(0);
    expect(MIN_TOOL_CALL_RATE).toBeLessThanOrEqual(1);
  });

  it('sends the production request shape: tools, tool_choice auto, no JSON mode', async () => {
    const chatCompletion = vi.fn(async () => completion({
      toolCalls: [{ id: 'c1', type: 'function', function: { name: 'read_repository_file', arguments: '{"path":"a.py"}' } }],
    }));
    const result = await benchTools({ chatCompletion } as unknown as OpenRouterClient, model, { maxTokens: 2000, worstCaseUsd: 0.01 }, 0.1);
    expect(chatCompletion).toHaveBeenCalledTimes(TOOL_CASES.length);
    for (const [opts] of chatCompletion.mock.calls as unknown as [Record<string, unknown>][]) {
      expect(opts.tools).toEqual(REPOSITORY_TOOL_DEFINITIONS);
      expect(opts.toolChoice).toBe('auto');
      expect(opts.jsonMode).toBe(false);
    }
    expect(result.suiteVersion).toBe(TOOL_SUITE_VERSION);
    expect(Object.values(result.cases).every((c) => c.ok)).toBe(true);
  });

  // solar-mini4 under response_format: {"call":{"name":"read_repository_file",...}} as plain text.
  it('fails a case whose tool call arrives as text or names an unknown tool', async () => {
    const chatCompletion = vi.fn()
      .mockResolvedValueOnce(completion({ text: '{"call": {"name": "read_repository_file", "path": "a.py"}}' }))
      .mockResolvedValueOnce(completion({ toolCalls: [{ id: 'c2', type: 'function', function: { name: 'delete_everything', arguments: '{}' } }] }))
      .mockResolvedValue(completion({ toolCalls: [{ id: 'c3', type: 'function', function: { name: 'list_repository_files', arguments: '{}' } }] }));
    const result = await benchTools({ chatCompletion } as unknown as OpenRouterClient, model, { maxTokens: 2000, worstCaseUsd: 0.01 }, 0.1);
    const cases = TOOL_CASES.map((c) => result.cases[c.id]!);
    expect(cases[0]).toMatchObject({ ok: false, failureKind: 'wrong' });
    expect(cases[1]).toMatchObject({ ok: false, failureKind: 'wrong' });
    expect(cases.slice(2).every((c) => c.ok)).toBe(true);
  });

  it('scores the rate of real tool calls and leaves untested models alone', () => {
    expect(scoreTools(undefined)).toMatchObject({ status: 'not-run', noToolUse: false });
    const all = scoreTools(withTools(TOOL_CASES.length).tools);
    expect(all).toMatchObject({ status: 'tested', callRate: 1, noToolUse: false, label: `${TOOL_CASES.length}/${TOOL_CASES.length} called` });
    const none = scoreTools(withTools(0).tools);
    expect(none).toMatchObject({ status: 'tested', callRate: 0, noToolUse: true, label: `0/${TOOL_CASES.length} called` });
    expect(scoreModel(record()).tier).toBe('A');
  });

  it('drops a model that does not call tools one tier and out of the tool-using roles', () => {
    const score = scoreModel(withTools(0));
    expect(score.tools.noToolUse).toBe(true);
    expect(score.tier).toBe('B');
    for (const role of ['implementer', 'reviewer', 'verifier', 'opposition', 'regulator']) expect(score.roles).not.toContain(role);
    expect(score.roles).toContain('planner');
    expect(score.failures).toContain(`tools:0/${TOOL_CASES.length} called`);
    expect(scoreModel(withTools(TOOL_CASES.length)).tier).toBe('A');
  });
});
