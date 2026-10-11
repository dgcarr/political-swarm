import { beforeAll, describe, expect, it, vi } from 'vitest';
import { BudgetExceededError, BudgetGuard } from './BudgetGuard.js';
import type { Ledger } from './Ledger.js';
import type { ChatCompletionResult, OpenRouterClient } from './OpenRouterClient.js';
import type { RunState } from './RunStore.js';
import type { RepoWorktree } from './RepoWorktree.js';
import { emptyOwnershipMap, type OwnershipMap } from './packets.js';
import { contentDigest, jsonResponseSuffix, UNKNOWN_CONTEXT_TOKENS, WorkerDispatcher, type DispatchOptions } from './WorkerDispatcher.js';
import type { BudgetConfig, ModelsConfig } from '../util/config.js';

const PRIMARY_MODEL = 'test/primary';
const FALLBACK_MODEL = 'test/fallback';

const modelEntry = {
  inputPricePerMTok: 1,
  outputPricePerMTok: 2,
  supportsJsonMode: true,
  supportsToolCalls: false,
};

const modelsConfig: ModelsConfig = {
  roles: { planner: { primary: PRIMARY_MODEL, fallback: FALLBACK_MODEL } },
  models: {
    [PRIMARY_MODEL]: modelEntry,
    [FALLBACK_MODEL]: modelEntry,
  },
};

function completion(model: string, attempts = 1, provider?: string): ChatCompletionResult {
  return {
    text: '{"ok":true}',
    promptTokens: 10,
    completionTokens: 5,
    costUsd: 0.001,
    costMetered: true,
    model,
    attempts,
    timedOut: false,
    provider,
  };
}

function dispatchOptions(): DispatchOptions {
  return {
    role: 'planner',
    systemPrompt: 'Plan carefully.',
    userPrompt: 'Create a plan.',
    schemaDescription: '{ "ok": boolean }',
    validate: (value) => {
      if (typeof value !== 'object' || value === null || !('ok' in value)) throw new Error('invalid');
    },
  };
}

function createDispatcher(
  chatCompletion: ReturnType<typeof vi.fn>,
  repoInventory?: () => { paths: string[]; truncated: boolean },
  ownership?: () => OwnershipMap | undefined,
  institutionalLimit?: number,
  fileExists?: (relPath: string) => boolean,
  testPathGlobs?: string[],
) {
  const record = vi.fn();
  const recordTranscript = vi.fn();
  const client = { chatCompletion } as unknown as OpenRouterClient;
  const ledger = { record, recordTranscript } as unknown as Ledger;
  const budget = {
    checkBeforeCall: vi.fn(),
    perCallTimeoutMs: vi.fn(() => 1_000), stallTimeout: vi.fn(() => undefined),
    recordSpend: vi.fn(() => ({ warn: false })),
    maxInstitutionalCallsPerTask: vi.fn(() => institutionalLimit),
  } as unknown as BudgetGuard;
  const runState = {
    runId: 'test-run',
    costUsd: 0,
    tokensUsed: { prompt: 0, completion: 0 },
    workerCalls: 0,
  } as RunState;

  return {
    dispatcher: new WorkerDispatcher({ client, modelsConfig, ledger, budget, runState, repoInventory, ownership, fileExists, testPathGlobs }),
    record,
    runState,
  };
}

function userMessage(chatCompletion: ReturnType<typeof vi.fn>): string {
  return chatCompletion.mock.calls[0]![0].messages.find((m: { role: string }) => m.role === 'user').content;
}

describe('WorkerDispatcher "no change" for an absent owned file', () => {
  const ownership = (): OwnershipMap => ({
    ...emptyOwnershipMap(),
    entries: { calc: { taskId: 'calc', paths: ['pkg/damage.py'], interfaces: [], generated: [], tests: [] } },
  });
  const answer = (fileOps: unknown[]) => ({ ...completion(PRIMARY_MODEL), text: JSON.stringify({ fileOps, rationale: 'r' }) });

  it('sends the empty answer back naming the missing file, and accepts the written one', async () => {
    (modelsConfig.roles as Record<string, { primary: string; fallback: string }>).implementer = { primary: PRIMARY_MODEL, fallback: FALLBACK_MODEL };
    const chatCompletion = vi.fn()
      .mockResolvedValueOnce(answer([]))
      .mockResolvedValueOnce(answer([{ op: 'write', path: 'pkg/damage.py', content: 'def damage():\n    return 1\n' }]));
    const { dispatcher } = createDispatcher(chatCompletion, undefined, ownership, undefined, () => false);

    await dispatcher.dispatch({ ...dispatchOptions(), role: 'implementer', taskId: 'calc', validate: () => {} });

    expect(chatCompletion).toHaveBeenCalledTimes(2);
    expect(chatCompletion.mock.calls[1]![0].messages.at(-1).content).toContain('pkg/damage.py');
  });

  it('accepts "no change" when the owned file exists', async () => {
    const chatCompletion = vi.fn().mockResolvedValueOnce(answer([]));
    const { dispatcher } = createDispatcher(chatCompletion, undefined, ownership, undefined, () => true);

    await dispatcher.dispatch({ ...dispatchOptions(), role: 'implementer', taskId: 'calc', validate: () => {} });

    expect(chatCompletion).toHaveBeenCalledTimes(1);
  });
});

describe('WorkerDispatcher delivery verifier evidence', () => {
  const report = (verified: boolean, rationale: string) =>
    ({ ...completion(PRIMARY_MODEL), text: JSON.stringify({ verified, criteriaTraced: [], findings: [], rationale }) });
  const verify = (dispatcher: WorkerDispatcher) =>
    dispatcher.dispatch({ ...dispatchOptions(), role: 'verifier', validate: () => {} });

  beforeAll(() => {
    (modelsConfig.roles as Record<string, { primary: string; fallback: string }>).verifier = { primary: PRIMARY_MODEL, fallback: FALLBACK_MODEL };
  });

  it('tells the verifier the diff is applied and the checks already ran', async () => {
    const chatCompletion = vi.fn().mockResolvedValue(report(true, 'All criteria traced.'));
    const { dispatcher } = createDispatcher(chatCompletion);

    await verify(dispatcher);

    expect(userMessage(chatCompletion)).toContain('the diff is already applied');
    expect(userMessage(chatCompletion)).toContain('executed by the engine on exactly this tree');
  });

  // Both are verbatim from refusals that withheld delivery on 2026-10-04.
  it.each([
    'The repository contains a complete implementation, but I have not yet executed the required commands to confirm pytest passes.',
    'The provided diff is a proposed change rather than the current repository state; I must read the actual files on disk.',
  ])('sends back a refusal that rests on not gathering evidence itself: %s', async (rationale) => {
    const chatCompletion = vi.fn()
      .mockResolvedValueOnce(report(false, rationale))
      .mockResolvedValueOnce(report(true, 'All criteria traced to code and the passing checks.'));
    const { dispatcher } = createDispatcher(chatCompletion);

    const result = await verify(dispatcher);

    expect(chatCompletion).toHaveBeenCalledTimes(2);
    expect((result.value as { verified: boolean }).verified).toBe(true);
  });

  it('keeps a refusal that names a defect', async () => {
    const chatCompletion = vi.fn().mockResolvedValueOnce(report(false, 'The CLI does not run: cli.py imports plot_damage, which plotting.py does not define.'));
    const { dispatcher } = createDispatcher(chatCompletion);

    const result = await verify(dispatcher);

    expect(chatCompletion).toHaveBeenCalledTimes(1);
    expect((result.value as { verified: boolean }).verified).toBe(false);
  });
});

describe('WorkerDispatcher plan dependency cycles', () => {
  const plan = (docsDependsOn: string[]) => ({
    ...completion(PRIMARY_MODEL),
    text: JSON.stringify([
      { id: 'core', dependsOn: ['docs'], targetGlobs: ['pkg/core.py'], acceptanceCriteria: ['core works'] },
      { id: 'docs', dependsOn: docsDependsOn, targetGlobs: ['README.md'], acceptanceCriteria: ['docs written'] },
    ]),
  });

  it('sends a cyclic plan back with the cycle named, and accepts the corrected one', async () => {
    const chatCompletion = vi.fn().mockResolvedValueOnce(plan(['core'])).mockResolvedValueOnce(plan([]));
    const { dispatcher } = createDispatcher(chatCompletion);

    await dispatcher.dispatch({ ...dispatchOptions(), schemaDescription: '[{ id, dependsOn, targetGlobs }]', validate: () => {} });

    expect(chatCompletion).toHaveBeenCalledTimes(2);
    const retry = chatCompletion.mock.calls[1]![0].messages.at(-1).content;
    expect(retry).toContain('core → docs → core');
  });
});

describe('WorkerDispatcher repo inventory', () => {
  const inventory = () => ({ paths: ['data/Fe/Fe_dpa_nrt.csv', 'README.md'], truncated: false });

  it('tells code-authoring roles the listed files already exist', async () => {
    const chatCompletion = vi.fn().mockResolvedValue(completion(PRIMARY_MODEL));
    const { dispatcher } = createDispatcher(chatCompletion, inventory);

    await dispatcher.dispatch(dispatchOptions());

    const content = userMessage(chatCompletion);
    expect(content).toContain('data/Fe/Fe_dpa_nrt.csv');
    expect(content).toContain('ALREADY EXIST');
  });

  // The failure this exists to prevent: an implementer inventing data files that were sitting
  // unread in the same worktree, three attempts running.
  it('warns against regenerating supplied data', async () => {
    const chatCompletion = vi.fn().mockResolvedValue(completion(PRIMARY_MODEL));
    const { dispatcher } = createDispatcher(chatCompletion, inventory);

    await dispatcher.dispatch({ ...dispatchOptions(), role: 'planner' });

    expect(userMessage(chatCompletion)).toContain('must not be regenerated');
  });

  it('provides the same repository visibility to reviewing roles', async () => {
    const chatCompletion = vi.fn().mockResolvedValue(completion(PRIMARY_MODEL));
    const { dispatcher } = createDispatcher(chatCompletion, inventory);
    const config = modelsConfig.roles as Record<string, { primary: string; fallback: string }>;
    config.reviewer = { primary: PRIMARY_MODEL, fallback: FALLBACK_MODEL };

    await dispatcher.dispatch({ ...dispatchOptions(), role: 'reviewer' });

    expect(userMessage(chatCompletion)).toContain('data/Fe/Fe_dpa_nrt.csv');
  });

  it('says so when the listing was capped, so a partial repo is not read as the whole one', async () => {
    const chatCompletion = vi.fn().mockResolvedValue(completion(PRIMARY_MODEL));
    const { dispatcher } = createDispatcher(chatCompletion, () => ({ paths: ['a.py'], truncated: true }));

    await dispatcher.dispatch(dispatchOptions());

    expect(userMessage(chatCompletion)).toContain('listing truncated');
  });

  it('dispatches normally when no inventory is available', async () => {
    const chatCompletion = vi.fn().mockResolvedValue(completion(PRIMARY_MODEL));
    const { dispatcher } = createDispatcher(chatCompletion);

    await expect(dispatcher.dispatch(dispatchOptions())).resolves.toBeDefined();
  });

  // A repository that cannot be listed must not take the whole run down with it.
  it('survives an inventory that throws', async () => {
    const chatCompletion = vi.fn().mockResolvedValue(completion(PRIMARY_MODEL));
    const { dispatcher } = createDispatcher(chatCompletion, () => {
      throw new Error('worktree vanished');
    });

    await expect(dispatcher.dispatch(dispatchOptions())).resolves.toBeDefined();
  });
});

describe('WorkerDispatcher call timeout', () => {
  it('uses a shorter timeout for optional institutional work', async () => {
    const chatCompletion = vi.fn().mockResolvedValue(completion(PRIMARY_MODEL));
    const { dispatcher } = createDispatcher(chatCompletion);

    await dispatcher.dispatch({ ...dispatchOptions(), phase: 'institutional', timeoutMs: 250 });

    expect(chatCompletion.mock.calls[0]![0].timeoutMs).toBe(250);
  });

  it('does not let a dispatch extend the configured ceiling', async () => {
    const chatCompletion = vi.fn().mockResolvedValue(completion(PRIMARY_MODEL));
    const { dispatcher } = createDispatcher(chatCompletion);

    await dispatcher.dispatch({ ...dispatchOptions(), timeoutMs: 2_000 });

    expect(chatCompletion.mock.calls[0]![0].timeoutMs).toBe(1_000);
  });
});

describe('WorkerDispatcher institutional accounting', () => {
  it('blocks a second decision at the institutional ceiling before another model call', async () => {
    const chatCompletion = vi.fn().mockResolvedValue(completion(PRIMARY_MODEL));
    const { dispatcher, record, runState } = createDispatcher(chatCompletion, undefined, undefined, 1);
    const config = modelsConfig.roles as Record<string, { primary: string; fallback: string }>;
    config.reviewer = { primary: PRIMARY_MODEL, fallback: FALLBACK_MODEL };
    const ballot = { ...dispatchOptions(), role: 'reviewer', phase: 'institutional' as const,
      taskId: 'council-task' };

    await dispatcher.dispatch(ballot);
    await expect(dispatcher.dispatch(ballot)).rejects.toThrow('institutional-call ceiling of 1');

    expect(runState.institutionalCallsByTask?.['council-task']).toBe(1);
    expect(chatCompletion).toHaveBeenCalledTimes(1);
    expect(record.mock.calls.filter(([type]) => type === 'institutional_dispatch')).toHaveLength(1);
  });

  it('reports metered usage immediately and does not retry a response if persistence fails', async () => {
    const chatCompletion = vi.fn().mockResolvedValue(completion(PRIMARY_MODEL));
    const onProgress = vi.fn(() => { throw new Error('disk unavailable'); });
    const dispatcher = new WorkerDispatcher({
      client: { chatCompletion } as unknown as OpenRouterClient,
      modelsConfig,
      ledger: { record: vi.fn(), recordTranscript: vi.fn() } as unknown as Ledger,
      budget: {
        checkBeforeCall: vi.fn(), perCallTimeoutMs: vi.fn(() => 1_000), stallTimeout: vi.fn(() => undefined),
        recordSpend: vi.fn(() => ({ warn: false })),
      } as unknown as BudgetGuard,
      runState: { runId: 'test-run', costUsd: 0, tokensUsed: { prompt: 0, completion: 0 }, workerCalls: 0 } as RunState,
      onProgress,
    });

    await expect(dispatcher.dispatch(dispatchOptions())).rejects.toThrow('Could not persist metered worker usage');
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(chatCompletion).toHaveBeenCalledTimes(1);
  });

  it('does not charge the final delivery review to a task ceiling, and charges again afterwards', async () => {
    const chatCompletion = vi.fn().mockResolvedValue(completion(PRIMARY_MODEL));
    const { dispatcher, record, runState } = createDispatcher(chatCompletion, undefined, undefined, 1);
    const config = modelsConfig.roles as Record<string, { primary: string; fallback: string }>;
    config.reviewer = { primary: PRIMARY_MODEL, fallback: FALLBACK_MODEL };
    const ballot = { ...dispatchOptions(), role: 'reviewer', phase: 'institutional' as const,
      taskId: 'council-task' };

    await dispatcher.dispatch(ballot);
    await dispatcher.outsideTaskCeilings(async () => {
      await dispatcher.dispatch(ballot);
      await dispatcher.dispatch(ballot);
    });

    expect(chatCompletion).toHaveBeenCalledTimes(3);
    expect(runState.institutionalCallsByTask?.['council-task']).toBe(1);
    expect(record.mock.calls.filter(([type, data]) =>
      type === 'institutional_dispatch' && (data as { deliveryReview?: boolean }).deliveryReview)).toHaveLength(2);
    await expect(dispatcher.dispatch(ballot)).rejects.toThrow('institutional-call ceiling of 1');
  });

  it('counts an institutional ballot dispatched through a reviewer role', async () => {
    const chatCompletion = vi.fn().mockResolvedValue(completion(PRIMARY_MODEL));
    const { dispatcher, record, runState } = createDispatcher(chatCompletion);
    const config = modelsConfig.roles as Record<string, { primary: string; fallback: string }>;
    config.reviewer = { primary: PRIMARY_MODEL, fallback: FALLBACK_MODEL };

    await dispatcher.dispatch({
      ...dispatchOptions(),
      role: 'reviewer',
      phase: 'institutional',
      taskId: 'council-task',
    });

    expect(record).toHaveBeenCalledWith('worker_call', expect.objectContaining({ phase: 'institutional' }));
    expect(runState.institutionalCallsByTask?.['council-task']).toBe(1);
  });

  it('pins each call to its task and to digests of exactly what was sent and returned', async () => {
    const chatCompletion = vi.fn().mockResolvedValue(completion(PRIMARY_MODEL));
    const { dispatcher, record } = createDispatcher(chatCompletion);

    await dispatcher.dispatch({ ...dispatchOptions(), taskId: 'task-7' });

    const [, entry] = record.mock.calls.find(([type]) => type === 'worker_call')!;
    const sent = chatCompletion.mock.calls[0][0].messages;
    expect(entry).toMatchObject({ taskId: 'task-7', promptDigest: contentDigest(sent) });
    expect(entry.responseDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('can omit repository tools when an institutional reviewer has the evidence in the prompt', async () => {
    const chatCompletion = vi.fn().mockResolvedValue(completion(PRIMARY_MODEL));
    const toolModel = { ...modelEntry, supportsToolCalls: true };
    const dispatcher = new WorkerDispatcher({
      client: { chatCompletion } as unknown as OpenRouterClient,
      modelsConfig: {
        roles: { reviewer: { primary: PRIMARY_MODEL, fallback: FALLBACK_MODEL } },
        models: { [PRIMARY_MODEL]: toolModel, [FALLBACK_MODEL]: toolModel },
      },
      ledger: { record: vi.fn(), recordTranscript: vi.fn() } as unknown as Ledger,
      budget: {
        checkBeforeCall: vi.fn(), perCallTimeoutMs: vi.fn(() => 1_000), stallTimeout: vi.fn(() => undefined),
        recordSpend: vi.fn(() => ({ warn: false })),
      } as unknown as BudgetGuard,
      runState: { runId: 'test-run', costUsd: 0, tokensUsed: { prompt: 0, completion: 0 }, workerCalls: 0 } as RunState,
      worktree: {} as RepoWorktree,
    });

    await dispatcher.dispatch({ ...dispatchOptions(), role: 'reviewer', phase: 'institutional', repositoryTools: false });

    expect(chatCompletion.mock.calls[0]![0]).not.toHaveProperty('tools');
  });

  it('ends institutional repository exploration after four requested reads', async () => {
    const toolCalls = Array.from({ length: 5 }, (_, index) => ({
      id: `call-${index}`, type: 'function' as const,
      function: { name: 'list_repository_files', arguments: '{}' },
    }));
    const chatCompletion = vi.fn()
      .mockResolvedValueOnce({ ...completion(PRIMARY_MODEL), text: '', toolCalls })
      .mockResolvedValueOnce(completion(PRIMARY_MODEL));
    const toolModel = { ...modelEntry, supportsToolCalls: true };
    const runState = { runId: 'test-run', costUsd: 0, tokensUsed: { prompt: 0, completion: 0 },
      workerCalls: 0 } as RunState;
    const dispatcher = new WorkerDispatcher({
      client: { chatCompletion } as unknown as OpenRouterClient,
      modelsConfig: {
        roles: { reviewer: { primary: PRIMARY_MODEL, fallback: FALLBACK_MODEL } },
        models: { [PRIMARY_MODEL]: toolModel, [FALLBACK_MODEL]: toolModel },
      },
      ledger: { record: vi.fn(), recordTranscript: vi.fn() } as unknown as Ledger,
      budget: {
        checkBeforeCall: vi.fn(), perCallTimeoutMs: vi.fn(() => 1_000), stallTimeout: vi.fn(() => undefined),
        recordSpend: vi.fn(() => ({ warn: false })),
      } as unknown as BudgetGuard,
      runState,
      worktree: {} as RepoWorktree,
    });

    await expect(dispatcher.dispatch({ ...dispatchOptions(), role: 'reviewer', phase: 'institutional',
      taskId: 'council-task' }))
      .resolves.toMatchObject({ model: PRIMARY_MODEL });
    expect(chatCompletion).toHaveBeenCalledTimes(2);
    expect(chatCompletion.mock.calls[1]![0]).not.toHaveProperty('tools');
    expect(runState.institutionalCallsByTask?.['council-task']).toBe(1);
  });
});

describe('WorkerDispatcher required plan ownership', () => {
  const requiredPrompt =
    'Plan the work.\nEngine-enforced required ownership paths (JSON): ' +
    '["package/__init__.py","package/__main__.py","README.md"]\nAlso assign tests.';

  it('corrects a plan that omits an engine-required path', async () => {
    const incomplete = JSON.stringify({
      nodes: [{ id: 'cli', targetGlobs: ['package/__main__.py', 'README.md'] }],
    });
    const complete = JSON.stringify({
      nodes: [{ id: 'cli', targetGlobs: ['package/__init__.py', 'package/__main__.py', 'README.md'] }],
    });
    const chatCompletion = vi
      .fn()
      .mockResolvedValueOnce({ ...completion(PRIMARY_MODEL), text: incomplete })
      .mockResolvedValueOnce({ ...completion(PRIMARY_MODEL), text: complete });
    const { dispatcher } = createDispatcher(chatCompletion);

    const result = await dispatcher.dispatch({
      ...dispatchOptions(),
      userPrompt: requiredPrompt,
      schemaDescription: '{ "nodes": [{ "targetGlobs": string[] }] }',
      validate: () => {},
    });

    expect(chatCompletion).toHaveBeenCalledTimes(2);
    expect(chatCompletion.mock.calls[1]![0].messages.at(-1).content).toContain('package/__init__.py');
    expect(result.value).toEqual(JSON.parse(complete));
  });

  it('sends back a plan that changes code but gives no task a test', async () => {
    const untested = JSON.stringify({ nodes: [{ id: 'core', targetGlobs: ['pkg/core.py'] }, { id: 'docs', targetGlobs: ['README.md'] }] });
    const tested = JSON.stringify({ nodes: [{ id: 'core', targetGlobs: ['pkg/core.py', 'tests/test_core.py'] }] });
    const chatCompletion = vi.fn()
      .mockResolvedValueOnce({ ...completion(PRIMARY_MODEL), text: untested })
      .mockResolvedValueOnce({ ...completion(PRIMARY_MODEL), text: tested });
    const { dispatcher } = createDispatcher(chatCompletion, undefined, undefined, undefined, undefined, ['**/tests/**']);

    const result = await dispatcher.dispatch({
      ...dispatchOptions(), schemaDescription: '{ "nodes": [{ "targetGlobs": string[] }] }', validate: () => {},
    });

    expect(chatCompletion).toHaveBeenCalledTimes(2);
    expect(chatCompletion.mock.calls[1]![0].messages.at(-1).content).toContain('No task owns a test file');
    expect(result.value).toEqual(JSON.parse(tested));
  });

  it('reports every plan problem in one correction', async () => {
    const twoProblems = JSON.stringify({ nodes: [{ id: 'cli', targetGlobs: ['package/__main__.py', 'README.md'] }] });
    const fixed = JSON.stringify({
      nodes: [{ id: 'cli', targetGlobs: ['package/__init__.py', 'package/__main__.py', 'README.md', 'tests/test_cli.py'] }],
    });
    const chatCompletion = vi.fn()
      .mockResolvedValueOnce({ ...completion(PRIMARY_MODEL), text: twoProblems })
      .mockResolvedValueOnce({ ...completion(PRIMARY_MODEL), text: fixed });
    const { dispatcher } = createDispatcher(chatCompletion, undefined, undefined, undefined, undefined, ['**/tests/**']);

    await dispatcher.dispatch({
      ...dispatchOptions(), userPrompt: requiredPrompt,
      schemaDescription: '{ "nodes": [{ "targetGlobs": string[] }] }', validate: () => {},
    });

    const correction = chatCompletion.mock.calls[1]![0].messages.at(-1).content as string;
    expect(correction).toContain('Fix all 2 of these problems');
    expect(correction).toContain('package/__init__.py');
    expect(correction).toContain('No task owns a test file');
  });

  it('does not apply benchmark ownership rules without the explicit engine marker', async () => {
    const plan = JSON.stringify({ nodes: [{ id: 'cli', targetGlobs: ['package/__main__.py'] }] });
    const chatCompletion = vi.fn().mockResolvedValue({ ...completion(PRIMARY_MODEL), text: plan });
    const { dispatcher } = createDispatcher(chatCompletion);

    await dispatcher.dispatch({ ...dispatchOptions(), validate: () => {} });

    expect(chatCompletion).toHaveBeenCalledTimes(1);
  });

  it('does not apply task ownership rules to planner-labelled reconnaissance', async () => {
    const reconnaissance = JSON.stringify({ scopes: ['package'], risks: [], dependencies: [] });
    const chatCompletion = vi.fn().mockResolvedValue({ ...completion(PRIMARY_MODEL), text: reconnaissance });
    const { dispatcher } = createDispatcher(chatCompletion);

    await dispatcher.dispatch({
      ...dispatchOptions(),
      userPrompt: requiredPrompt,
      schemaDescription: '{ "scopes": string[], "risks": string[], "dependencies": string[] }',
      validate: () => {},
    });

    expect(chatCompletion).toHaveBeenCalledTimes(1);
  });

  it('corrects final integrated criteria copied onto every benchmark task', async () => {
    const repeated = JSON.stringify({
      nodes: [
        { id: 'package', targetGlobs: ['package/__init__.py'], acceptanceCriteria: ['pytest passes'] },
        {
          id: 'cli',
          targetGlobs: ['package/__main__.py', 'README.md'],
          acceptanceCriteria: ['pytest passes'],
        },
      ],
    });
    const taskLocal = JSON.stringify({
      nodes: [
        { id: 'package', targetGlobs: ['package/__init__.py'], acceptanceCriteria: ['package imports'] },
        {
          id: 'cli',
          targetGlobs: ['package/__main__.py', 'README.md'],
          acceptanceCriteria: ['module entry point delegates to CLI'],
        },
      ],
    });
    const chatCompletion = vi
      .fn()
      .mockResolvedValueOnce({ ...completion(PRIMARY_MODEL), text: repeated })
      .mockResolvedValueOnce({ ...completion(PRIMARY_MODEL), text: taskLocal });
    const { dispatcher } = createDispatcher(chatCompletion);

    const result = await dispatcher.dispatch({
      ...dispatchOptions(),
      userPrompt: requiredPrompt,
      schemaDescription: '{ "nodes": [{ "targetGlobs": string[], "acceptanceCriteria": string[] }] }',
      validate: () => {},
    });

    expect(chatCompletion).toHaveBeenCalledTimes(2);
    expect(chatCompletion.mock.calls[1]![0].messages.at(-1).content).toContain('pytest passes');
    expect(result.value).toEqual(JSON.parse(taskLocal));
  });
});

// Two doctrines independently shipped a file whose entire body was the three bytes `...` —
// capitalist as cli.py, democratic as nuclear_data.py, the latter approved by its own committee
// because an empty module breaks no test until something imports it.
describe('WorkerDispatcher placeholder guard', () => {
  function withRole(role: string) {
    (modelsConfig.roles as Record<string, { primary: string; fallback: string }>)[role] = {
      primary: PRIMARY_MODEL,
      fallback: FALLBACK_MODEL,
    };
  }

  it('tells implementers not to deliver a stub that looks finished', async () => {
    withRole('implementer');
    const chatCompletion = vi.fn().mockResolvedValue(completion(PRIMARY_MODEL));
    const { dispatcher } = createDispatcher(chatCompletion);

    await dispatcher.dispatch({ ...dispatchOptions(), role: 'implementer' });

    const content = userMessage(chatCompletion);
    expect(content).toContain('complete and runnable as delivered');
    expect(content).toContain('NotImplementedError');
  });

  it('says why it matters: the next task cannot repair what it imports', async () => {
    withRole('implementer');
    const chatCompletion = vi.fn().mockResolvedValue(completion(PRIMARY_MODEL));
    const { dispatcher } = createDispatcher(chatCompletion);

    await dispatcher.dispatch({ ...dispatchOptions(), role: 'implementer' });

    expect(userMessage(chatCompletion)).toContain('another task will import what you write');
  });

  it('leaves roles that write no files alone', async () => {
    const chatCompletion = vi.fn().mockResolvedValue(completion(PRIMARY_MODEL));
    const { dispatcher } = createDispatcher(chatCompletion);

    await dispatcher.dispatch(dispatchOptions());

    expect(userMessage(chatCompletion)).not.toContain('complete and runnable as delivered');
  });
});

describe('WorkerDispatcher model observability', () => {
  it('reuses an exact institutional ballot on replay without spending another call', async () => {
    const config = modelsConfig.roles as Record<string, { primary: string; fallback: string }>;
    config.reviewer = { primary: PRIMARY_MODEL, fallback: FALLBACK_MODEL };
    const chatCompletion = vi.fn().mockResolvedValue(completion(PRIMARY_MODEL));
    const { dispatcher, record } = createDispatcher(chatCompletion);
    const ballot = { ...dispatchOptions(), role: 'reviewer', phase: 'institutional' as const,
      institutionalReplayKey: 'plan-v1:member-a' };

    await dispatcher.dispatch(ballot);
    await dispatcher.dispatch(ballot);
    await dispatcher.dispatch({ ...ballot, userPrompt: 'A revised plan.' });

    expect(chatCompletion).toHaveBeenCalledTimes(2);
    expect(record).toHaveBeenCalledWith('institutional_plan_cache_hit',
      expect.objectContaining({ role: 'reviewer' }));
  });

  it('uses low reasoning for engineering calls with repository tools and preserves explicit overrides', async () => {
    const chatCompletion = vi.fn().mockResolvedValue(completion(PRIMARY_MODEL));
    const toolModel = { ...modelEntry, supportsToolCalls: true };
    const dispatcher = new WorkerDispatcher({
      client: { chatCompletion } as unknown as OpenRouterClient,
      modelsConfig: {
        roles: {
          implementer: { primary: PRIMARY_MODEL, fallback: FALLBACK_MODEL },
          planner: { primary: PRIMARY_MODEL, fallback: FALLBACK_MODEL },
        },
        models: { [PRIMARY_MODEL]: toolModel, [FALLBACK_MODEL]: toolModel },
      },
      ledger: { record: vi.fn(), recordTranscript: vi.fn() } as unknown as Ledger,
      budget: {
        checkBeforeCall: vi.fn(), perCallTimeoutMs: vi.fn(() => 1_000), stallTimeout: vi.fn(() => undefined),
        recordSpend: vi.fn(() => ({ warn: false })),
      } as unknown as BudgetGuard,
      runState: { runId: 'test-run', costUsd: 0, tokensUsed: { prompt: 0, completion: 0 }, workerCalls: 0 } as RunState,
      worktree: {} as RepoWorktree,
    });

    await dispatcher.dispatch({ ...dispatchOptions(), role: 'implementer' });
    await dispatcher.dispatch({ ...dispatchOptions(), role: 'implementer', reasoningEffort: 'high' });
    await dispatcher.dispatch({ ...dispatchOptions(), role: 'implementer', repositoryTools: false });
    await dispatcher.dispatch(dispatchOptions());

    expect(chatCompletion.mock.calls[0]![0]).toEqual(expect.objectContaining({ reasoningEffort: 'low' }));
    expect(chatCompletion.mock.calls[1]![0]).toEqual(expect.objectContaining({ reasoningEffort: 'high' }));
    expect(chatCompletion.mock.calls[2]![0]).toEqual(expect.objectContaining({ reasoningEffort: undefined }));
    expect(chatCompletion.mock.calls[3]![0]).toEqual(expect.objectContaining({ reasoningEffort: 'low' }));
  });

  it('forwards a role-specific reasoning tier when requested', async () => {
    const chatCompletion = vi.fn().mockResolvedValue(completion(PRIMARY_MODEL));
    const { dispatcher } = createDispatcher(chatCompletion);

    await dispatcher.dispatch({ ...dispatchOptions(), reasoningEffort: 'low' });

    expect(chatCompletion).toHaveBeenCalledWith(expect.objectContaining({ reasoningEffort: 'low' }));
  });

  it('records the primary model with fallback index zero', async () => {
    const chatCompletion = vi.fn().mockResolvedValue(completion(PRIMARY_MODEL, 1, 'Primary Provider'));
    const { dispatcher, record } = createDispatcher(chatCompletion);

    await dispatcher.dispatch(dispatchOptions());

    expect(record).toHaveBeenCalledWith(
      'worker_call',
      expect.objectContaining({
        model: PRIMARY_MODEL,
        fallbackIndex: 0,
        networkRetries: 0,
        timedOut: false,
        provider: 'Primary Provider',
      }),
    );
  });

  it('records the successful fallback as the worker call, and the primary as unmetered', async () => {
    const chatCompletion = vi
      .fn()
      .mockRejectedValueOnce(new Error('primary failed'))
      .mockResolvedValueOnce(completion(FALLBACK_MODEL));
    const { dispatcher, record, runState } = createDispatcher(chatCompletion);

    await dispatcher.dispatch(dispatchOptions());

    // Only one call produced usage to price, but the one that threw still consumed whatever the
    // provider generated before it failed, and must not vanish from the record.
    const workerCalls = record.mock.calls.filter(([type]) => type === 'worker_call');
    expect(workerCalls).toHaveLength(1);
    expect(record).toHaveBeenCalledWith(
      'worker_call',
      expect.objectContaining({ model: FALLBACK_MODEL, fallbackIndex: 1 }),
    );
    expect(record).toHaveBeenCalledWith(
      'worker_call_unmetered',
      expect.objectContaining({ model: PRIMARY_MODEL, timedOut: false }),
    );
    expect(runState.workerCalls).toBe(1);
  });

  it('asks the primary to finish without tools when repository reads exceed the limit', async () => {
    const toolModel = { ...modelEntry, supportsToolCalls: true };
    const toolModelsConfig: ModelsConfig = {
      roles: { planner: { primary: PRIMARY_MODEL, fallback: FALLBACK_MODEL } },
      models: { [PRIMARY_MODEL]: toolModel, [FALLBACK_MODEL]: toolModel },
    };
    const excessiveToolCalls = Array.from({ length: 5 }, (_, index) => ({
      id: `call-${index}`,
      type: 'function' as const,
      function: { name: 'list_repository_files', arguments: '{}' },
    }));
    const chatCompletion = vi
      .fn()
      .mockResolvedValueOnce({ ...completion(PRIMARY_MODEL), text: '', toolCalls: excessiveToolCalls })
      .mockResolvedValueOnce(completion(PRIMARY_MODEL));
    const dispatcher = new WorkerDispatcher({
      client: { chatCompletion } as unknown as OpenRouterClient,
      modelsConfig: toolModelsConfig,
      ledger: { record: vi.fn(), recordTranscript: vi.fn() } as unknown as Ledger,
      budget: {
        checkBeforeCall: vi.fn(),
        perCallTimeoutMs: vi.fn(() => 1_000), stallTimeout: vi.fn(() => undefined),
        recordSpend: vi.fn(() => ({ warn: false })),
      } as unknown as BudgetGuard,
      runState: {
        runId: 'test-run', costUsd: 0, tokensUsed: { prompt: 0, completion: 0 }, workerCalls: 0,
      } as RunState,
      worktree: {} as RepoWorktree,
      fallbackRepositoryContext: () => 'README.md\n# Repository context',
    });

    await expect(dispatcher.dispatch(dispatchOptions())).resolves.toMatchObject({ model: PRIMARY_MODEL });

    expect(chatCompletion).toHaveBeenCalledTimes(2);
    expect(chatCompletion.mock.calls[0]![0]).toHaveProperty('tools');
    expect(chatCompletion.mock.calls[1]![0]).not.toHaveProperty('tools');
    // JSON mode is held back while tools are offered: under response_format solar-mini4 wrote its
    // tool calls as JSON text (0 real calls in 6) and never read the repository. The tool-free
    // final round gets it back.
    expect(chatCompletion.mock.calls[0]![0]).toEqual(expect.objectContaining({ jsonMode: false }));
    expect(chatCompletion.mock.calls[1]![0]).toEqual(expect.objectContaining({ jsonMode: true }));
    const primaryUserMessage = chatCompletion.mock.calls[0]![0].messages
      .find((message: { role: string }) => message.role === 'user').content;
    const finalUserMessage = chatCompletion.mock.calls[1]![0].messages
      .find((message: { role: string }) => message.role === 'user').content;
    expect(primaryUserMessage).toContain('Repository fallback bundle');
    expect(finalUserMessage).toContain('Repository fallback bundle');
    expect(chatCompletion.mock.calls[1]![0].messages.at(-1).content).toContain('return the requested JSON now');
  });

  // From democratic-muqz15a5-8f7dc3: the Prime Coordinator ballot went out inside ~15k characters
  // of repository context and every elector abstained.
  it('sends an office ballot without any repository context', async () => {
    const chatCompletion = vi.fn().mockResolvedValue(completion(PRIMARY_MODEL));
    const dispatcher = new WorkerDispatcher({
      client: { chatCompletion } as unknown as OpenRouterClient,
      modelsConfig: { roles: { reviewer: { primary: PRIMARY_MODEL, fallback: FALLBACK_MODEL } }, models: { [PRIMARY_MODEL]: { ...modelEntry, supportsToolCalls: true }, [FALLBACK_MODEL]: modelEntry } },
      ledger: { record: vi.fn(), recordTranscript: vi.fn() } as unknown as Ledger,
      budget: {
        checkBeforeCall: vi.fn(),
        perCallTimeoutMs: vi.fn(() => 1_000), stallTimeout: vi.fn(() => undefined),
        recordSpend: vi.fn(() => ({ warn: false })),
      } as unknown as BudgetGuard,
      runState: { runId: 'test-run', costUsd: 0, tokensUsed: { prompt: 0, completion: 0 }, workerCalls: 0 } as RunState,
      worktree: {} as RepoWorktree,
      repoInventory: () => ({ paths: ['TASK.md', 'data/Fe/Fe_dpa_nrt.csv'], truncated: false }),
      fallbackRepositoryContext: () => 'TASK.md\n# The whole brief',
    });

    await dispatcher.dispatch({ ...dispatchOptions(), role: 'reviewer', repositoryContext: false });

    const request = chatCompletion.mock.calls[0]![0];
    const userMessage = request.messages.find((message: { role: string }) => message.role === 'user').content;
    expect(userMessage).not.toContain('Repository fallback bundle');
    expect(userMessage).not.toContain('Fe_dpa_nrt.csv');
    expect(request).not.toHaveProperty('tools');
  });

  it('tells planners to leave runtime-generated artifacts to final checks', async () => {
    const chatCompletion = vi.fn().mockResolvedValue(completion(PRIMARY_MODEL));
    const { dispatcher } = createDispatcher(chatCompletion);

    await dispatcher.dispatch(dispatchOptions());

    const userMessage = chatCompletion.mock.calls[0]![0].messages
      .find((message: { role: string }) => message.role === 'user').content;
    expect(userMessage).toContain('Do not create a standalone task');
    expect(userMessage).toContain('results/*.png');
    expect(userMessage).toContain('check artifacts, not authored FileOps');
    expect(userMessage).toContain('Give every file exactly one owning task');
    expect(userMessage).toContain('package/__main__.py');
  });

  /**
   * A real 2026-09-12 capitalist run planned six tasks whose combined targetGlobs covered every
   * source module but no test file at all (no tests/, no test_*.py). Every task's own review
   * passed — nothing in any single task's acceptance criteria required a test — so the gap
   * surfaced only at the final whole-suite pytest check ("collected 0 items"), with no task left
   * to blame or retry. Doctrine-neutral (this dispatch chokepoint is shared by every strategy's
   * planner), so the fix is here rather than in one strategy's prompts.
   */
  it('tells planners at least one task must own a discoverable test file', async () => {
    const chatCompletion = vi.fn().mockResolvedValue(completion(PRIMARY_MODEL));
    const { dispatcher } = createDispatcher(chatCompletion);

    await dispatcher.dispatch(dispatchOptions());

    const userMessage = chatCompletion.mock.calls[0]![0].messages
      .find((message: { role: string }) => message.role === 'user').content;
    expect(userMessage).toMatch(/at least one task's target paths must own a test file/i);
    expect(userMessage).toMatch(/collected 0 items|collected zero|no test collected/i);
  });

  /**
   * Two 2026-09-12 capitalist validation runs (v14, v15) each planned a task whose acceptance
   * criteria demanded the shared multi-element energy grid be built over the "union" of each
   * element's native data range — self-contradictory with the also-planned "no extrapolation"
   * requirement whenever elements' ranges differ, since covering the union forces extrapolating
   * whichever element doesn't reach that far. No implementation could satisfy both, so every
   * rework attempt was spent on a contradiction the plan itself created, not a real defect.
   */
  it('tells planners to check acceptance criteria for contradictions before finalizing', async () => {
    const chatCompletion = vi.fn().mockResolvedValue(completion(PRIMARY_MODEL));
    const { dispatcher } = createDispatcher(chatCompletion);

    await dispatcher.dispatch(dispatchOptions());

    const userMessage = chatCompletion.mock.calls[0]![0].messages
      .find((message: { role: string }) => message.role === 'user').content;
    expect(userMessage).toMatch(/hidden contradiction/i);
    expect(userMessage).toMatch(/state the outcome/i);
  });

  it('records network retries as the client attempt count minus one', async () => {
    const chatCompletion = vi.fn().mockResolvedValue(completion(PRIMARY_MODEL, 3));
    const { dispatcher, record } = createDispatcher(chatCompletion);

    await dispatcher.dispatch(dispatchOptions());

    expect(record).toHaveBeenCalledWith(
      'worker_call',
      expect.objectContaining({ networkRetries: 2 }),
    );
  });
});

describe('WorkerDispatcher worker-call ceiling', () => {
  it('counts an unmetered timeout before considering a fallback', async () => {
    const budget = new BudgetGuard({
      defaults: {
        perRunUsd: 10, perTaskUsd: 1, maxWorkerCalls: 1,
        maxWallClockMinutes: 30, maxTaskAttempts: 3,
        perCallTimeoutMs: 1_000, warnAtFractionOfPerRun: 0.8,
      },
      hardCeilingUsd: 20,
    });
    const runState = { runId: 'test-run', budgetUsd: 10, costUsd: 0,
      tokensUsed: { prompt: 0, completion: 0 }, workerCalls: 0 } as RunState;
    const chatCompletion = vi.fn().mockRejectedValue(new Error('provider timed out'));
    const dispatcher = new WorkerDispatcher({
      client: { chatCompletion } as unknown as OpenRouterClient,
      modelsConfig,
      ledger: { record: vi.fn(), recordTranscript: vi.fn() } as unknown as Ledger,
      budget, runState,
    });

    await expect(dispatcher.dispatch(dispatchOptions())).rejects.toMatchObject({ kind: 'call_count' });
    expect(chatCompletion).toHaveBeenCalledTimes(1);
    expect(runState.workerCalls).toBe(1);
  });

  it('does not start another corrective attempt after reaching the call ceiling', async () => {
    const maxWorkerCalls = 3;
    const budgetConfig: BudgetConfig = {
      defaults: {
        perRunUsd: 10,
        perTaskUsd: 1,
        maxWorkerCalls,
        maxWallClockMinutes: 30,
        maxTaskAttempts: 3,
        perCallTimeoutMs: 1_000,
        warnAtFractionOfPerRun: 0.8,
      },
      hardCeilingUsd: 20,
    };
    const runState = {
      runId: 'test-run',
      budgetUsd: budgetConfig.defaults.perRunUsd,
      costUsd: 0,
      tokensUsed: { prompt: 0, completion: 0 },
      workerCalls: maxWorkerCalls - 1,
    } as RunState;
    const budget = new BudgetGuard(budgetConfig);
    const checkBeforeCall = vi.spyOn(budget, 'checkBeforeCall');
    const chatCompletion = vi.fn().mockResolvedValue({
      ...completion(PRIMARY_MODEL),
      text: 'not valid JSON',
    });
    const dispatcher = new WorkerDispatcher({
      client: { chatCompletion } as unknown as OpenRouterClient,
      modelsConfig,
      ledger: { record: vi.fn(), recordTranscript: vi.fn() } as unknown as Ledger,
      budget,
      runState,
    });

    const error = await dispatcher.dispatch(dispatchOptions()).catch((err: unknown) => err);

    expect(chatCompletion).toHaveBeenCalledTimes(1);
    expect(checkBeforeCall).toHaveBeenCalledTimes(2);
    expect(runState.workerCalls).toBe(maxWorkerCalls);
    expect(error).toBeInstanceOf(BudgetExceededError);
    expect(error).toEqual(expect.objectContaining({ kind: 'call_count' }));
  });
});

// The instruction alone did not hold: it shipped, and the next run delivered five stub files.
// This is the mechanical half — the artifact is inspected rather than the worker believed.
describe('WorkerDispatcher placeholder rejection', () => {
  function implementerOptions(): DispatchOptions {
    (modelsConfig.roles as Record<string, { primary: string; fallback: string }>).implementer = {
      primary: PRIMARY_MODEL,
      fallback: FALLBACK_MODEL,
    };
    return { ...dispatchOptions(), role: 'implementer', validate: () => {} };
  }

  function completionWith(text: string): ChatCompletionResult {
    return { ...completion(PRIMARY_MODEL), text };
  }

  const STUB = JSON.stringify({ fileOps: [{ op: 'write', path: 'alloydamage/cli.py', content: '...' }] });
  const REAL = JSON.stringify({
    fileOps: [{ op: 'write', path: 'alloydamage/cli.py', content: 'def main():\n    return 0\n' }],
  });

  it('sends a stub back for a corrective retry instead of accepting it', async () => {
    const chatCompletion = vi
      .fn()
      .mockResolvedValueOnce(completionWith(STUB))
      .mockResolvedValueOnce(completionWith(REAL));
    const { dispatcher } = createDispatcher(chatCompletion);

    const result = await dispatcher.dispatch(implementerOptions());

    expect(chatCompletion).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result.value)).toContain('def main()');
  });

  it('names the offending file so the retry knows what to write', async () => {
    const chatCompletion = vi.fn().mockResolvedValue(completionWith(STUB));
    const { dispatcher } = createDispatcher(chatCompletion);

    await expect(dispatcher.dispatch(implementerOptions())).rejects.toThrow(/alloydamage\/cli\.py/);
  });

  it('keeps full file contents in the last corrective request', async () => {
    const chatCompletion = vi.fn().mockResolvedValue(completionWith(STUB));
    const { dispatcher } = createDispatcher(chatCompletion);

    await expect(dispatcher.dispatch(implementerOptions())).rejects.toThrow();

    const correction = chatCompletion.mock.calls[2][0].messages.at(-1).content as string;
    expect(correction).toContain('Preserve complete, runnable file contents');
    expect(correction).not.toContain('Keep every string value to a few words');
  });

  it('lets real work through on the first attempt', async () => {
    const chatCompletion = vi.fn().mockResolvedValue(completionWith(REAL));
    const { dispatcher } = createDispatcher(chatCompletion);

    await dispatcher.dispatch(implementerOptions());

    expect(chatCompletion).toHaveBeenCalledTimes(1);
  });

  // Reviewers and planners quote code; only the role that delivers files is checked.
  it('does not police roles that deliver no files', async () => {
    const chatCompletion = vi.fn().mockResolvedValue(completionWith(STUB));
    const { dispatcher } = createDispatcher(chatCompletion);

    await dispatcher.dispatch({ ...dispatchOptions(), validate: () => {} });

    expect(chatCompletion).toHaveBeenCalledTimes(1);
  });
});

// Democratic's implementer wire format keys each op by `filePath`, not `path` — the translation
// into the engine's own FileOp shape only happens after dispatch() returns (democratic/prompts.ts's
// toEngineFileOps). The ownership check below runs against the model's raw, untranslated JSON, so
// before the fix every op.path here was undefined and matchesAnyGlob threw a bare TypeError instead
// of the model getting a correctable validation error — killing the whole task attempt.
describe('WorkerDispatcher ownership check on raw wire JSON', () => {
  function implementerOptions(taskId: string): DispatchOptions {
    (modelsConfig.roles as Record<string, { primary: string; fallback: string }>).implementer = {
      primary: PRIMARY_MODEL,
      fallback: FALLBACK_MODEL,
    };
    return { ...dispatchOptions(), role: 'implementer', taskId, validate: () => {} };
  }

  function completionWith(text: string): ChatCompletionResult {
    return { ...completion(PRIMARY_MODEL), text };
  }

  const ownershipMap: OwnershipMap = {
    ...emptyOwnershipMap(),
    entries: { a: { taskId: 'a', paths: ['src/a.ts'], interfaces: [], generated: [], tests: [] } },
  };

  it('does not crash on filePath-keyed fileOps, and still catches a path outside ownership', async () => {
    const OUTSIDE_OWNERSHIP = JSON.stringify({ fileOps: [{ op: 'write', filePath: 'src/sneaky.ts', content: 'x' }] });
    const chatCompletion = vi.fn().mockResolvedValue(completionWith(OUTSIDE_OWNERSHIP));
    const { dispatcher } = createDispatcher(chatCompletion, undefined, () => ownershipMap);

    await expect(dispatcher.dispatch(implementerOptions('a'))).rejects.toThrow(/src\/sneaky\.ts/);
  });

  // Told only what they owned, implementers kept writing a test or entry point for their own code
  // into another task's file and lost the task after two corrections.
  it('names the task that owns a stray path, in the prompt and in the correction', async () => {
    const withTests: OwnershipMap = {
      ...ownershipMap,
      entries: { ...ownershipMap.entries, tests: { taskId: 'tests', paths: ['tests/'], interfaces: [], generated: [], tests: [] } },
    };
    const STRAY = JSON.stringify({ fileOps: [{ op: 'write', path: 'tests/test_a.py', content: 'x' }] });
    const chatCompletion = vi.fn().mockResolvedValue(completionWith(STRAY));
    const { dispatcher } = createDispatcher(chatCompletion, undefined, () => withTests);

    await expect(dispatcher.dispatch(implementerOptions('a'))).rejects.toThrow(/tests\/test_a\.py \(owned by tests\)/);
    const prompt = chatCompletion.mock.calls[0]![0].messages[1].content as string;
    expect(prompt).toContain('leave it out and say so in your rationale');
  });

  it('accepts filePath-keyed fileOps for an owned path', async () => {
    const OWNED = JSON.stringify({ fileOps: [{ op: 'write', filePath: 'src/a.ts', content: 'x' }] });
    const chatCompletion = vi.fn().mockResolvedValue(completionWith(OWNED));
    const { dispatcher } = createDispatcher(chatCompletion, undefined, () => ownershipMap);

    await expect(dispatcher.dispatch(implementerOptions('a'))).resolves.toBeDefined();
    expect(chatCompletion).toHaveBeenCalledTimes(1);
  });
});

// ab5-pure-r1: a democratic Opposition, reading TASK.md, rejected "plotting" for lacking cli.py
// and composition.py, both owned by other motions.
describe('WorkerDispatcher review scope', () => {
  const ownership: OwnershipMap = {
    ...emptyOwnershipMap(),
    entries: {
      plotting: { taskId: 'plotting', paths: ['pkg/plotting.py'], interfaces: [], generated: [], tests: [] },
      cli: { taskId: 'cli', paths: ['pkg/cli.py', 'pkg/__main__.py'], interfaces: [], generated: [], tests: [] },
    },
  };
  beforeAll(() => {
    for (const role of ['opposition', 'reviewer', 'implementer']) {
      (modelsConfig.roles as Record<string, { primary: string; fallback: string }>)[role] = { primary: PRIMARY_MODEL, fallback: FALLBACK_MODEL };
    }
  });
  const promptFor = async (opts: Partial<DispatchOptions>) => {
    const chatCompletion = vi.fn().mockResolvedValue(completion(PRIMARY_MODEL));
    const { dispatcher } = createDispatcher(chatCompletion, undefined, () => ownership);
    await dispatcher.dispatch({ ...dispatchOptions(), ...opts });
    return userMessage(chatCompletion);
  };

  it('tells a reviewer what the task owns and what other tasks own', async () => {
    const prompt = await promptFor({ role: 'opposition', scopeTaskId: 'plotting' });
    expect(prompt).toContain('task plotting owns exactly pkg/plotting.py');
    expect(prompt).toContain('cli: pkg/cli.py, pkg/__main__.py');
    expect(prompt).toContain('is not a defect of this one');
  });

  it('scopes a reviewer by its taskId, but never an implementer or an unscoped call', async () => {
    expect(await promptFor({ role: 'reviewer', taskId: 'plotting' })).toContain('Scope of this review');
    expect(await promptFor({ role: 'implementer', taskId: 'plotting' })).not.toContain('Scope of this review');
    expect(await promptFor({ role: 'reviewer' })).not.toContain('Scope of this review');
  });
});

// Socialist lost a task to six consecutive test_waiver requests, each refused with "benchmark mode
// never approves weakening or removal of required tests". The refusal reached it; what it lacked
// was being told up front that the waiver was never coming.
describe('WorkerDispatcher test-integrity guidance', () => {
  it('tells implementers a failing test means the code is wrong', async () => {
    (modelsConfig.roles as Record<string, { primary: string; fallback: string }>).implementer = {
      primary: PRIMARY_MODEL,
      fallback: FALLBACK_MODEL,
    };
    const chatCompletion = vi.fn().mockResolvedValue(completion(PRIMARY_MODEL));
    const { dispatcher } = createDispatcher(chatCompletion);

    await dispatcher.dispatch({ ...dispatchOptions(), role: 'implementer' });

    const content = userMessage(chatCompletion);
    expect(content).toMatch(/never delete, skip, weaken or narrow an existing test/i);
    expect(content).toMatch(/requests to waive a required test are refused/i);
  });

  it('says nothing about tests to roles that deliver no files', async () => {
    const chatCompletion = vi.fn().mockResolvedValue(completion(PRIMARY_MODEL));
    const { dispatcher } = createDispatcher(chatCompletion);

    await dispatcher.dispatch(dispatchOptions());

    expect(userMessage(chatCompletion)).not.toMatch(/never delete, skip, weaken/i);
  });
});

describe('WorkerDispatcher sign-off refusal guidance', () => {
  it('includes only the refusal for the task being dispatched', async () => {
    (modelsConfig.roles as Record<string, { primary: string; fallback: string }>).implementer = {
      primary: PRIMARY_MODEL,
      fallback: FALLBACK_MODEL,
    };
    const chatCompletion = vi.fn().mockResolvedValue(completion(PRIMARY_MODEL));
    const { dispatcher, runState } = createDispatcher(chatCompletion);
    runState.graph = {
      order: ['task-a', 'task-b'],
      nodes: {
        'task-a': {
          id: 'task-a',
          title: 'Task A',
          description: 'Implement A',
          acceptanceCriteria: [],
          dependsOn: [],
          targetGlobs: ['src/a.ts'],
          riskTags: [],
          riskClass: 'low',
          phase: 'queued',
          attempts: [],
          signOffRefusals: ['A-specific refusal'],
        },
        'task-b': {
          id: 'task-b',
          title: 'Task B',
          description: 'Implement B',
          acceptanceCriteria: [],
          dependsOn: [],
          targetGlobs: ['src/b.ts'],
          riskTags: [],
          riskClass: 'low',
          phase: 'queued',
          attempts: [],
          signOffRefusals: ['B-specific refusal'],
        },
      },
    };

    await dispatcher.dispatch({ ...dispatchOptions(), role: 'implementer', taskId: 'task-a' });

    const content = userMessage(chatCompletion);
    expect(content).toContain('A-specific refusal');
    expect(content).not.toContain('B-specific refusal');
  });

  it('carries refusals while the engine has the task marked running', async () => {
    (modelsConfig.roles as Record<string, { primary: string; fallback: string }>).implementer = {
      primary: PRIMARY_MODEL,
      fallback: FALLBACK_MODEL,
    };
    const chatCompletion = vi.fn().mockResolvedValue(completion(PRIMARY_MODEL));
    const { dispatcher, runState } = createDispatcher(chatCompletion);
    runState.graph = {
      order: ['task-a'],
      nodes: {
        'task-a': {
          id: 'task-a',
          title: 'Task A',
          description: 'Implement A',
          acceptanceCriteria: [],
          dependsOn: [],
          targetGlobs: ['src/a.ts'],
          riskTags: [],
          riskClass: 'low',
          // SwarmEngine sets this before strategy.execute() dispatches the implementer.
          phase: 'running',
          attempts: [],
          signOffRefusals: ['A-specific refusal'],
        },
      },
    };

    await dispatcher.dispatch({ ...dispatchOptions(), role: 'implementer', taskId: 'task-a' });

    expect(userMessage(chatCompletion)).toContain('A-specific refusal');
  });

  it('omits refusal guidance when no task id is supplied', async () => {
    const chatCompletion = vi.fn().mockResolvedValue(completion(PRIMARY_MODEL));
    const { dispatcher, runState } = createDispatcher(chatCompletion);
    runState.graph = {
      order: ['task-a'],
      nodes: {
        'task-a': {
          id: 'task-a',
          title: 'Task A',
          description: 'Implement A',
          acceptanceCriteria: [],
          dependsOn: [],
          targetGlobs: ['src/a.ts'],
          riskTags: [],
          riskClass: 'low',
          phase: 'queued',
          attempts: [],
          signOffRefusals: ['A-specific refusal'],
        },
      },
    };

    await dispatcher.dispatch({ ...dispatchOptions(), role: 'implementer' });

    expect(userMessage(chatCompletion)).not.toContain('A-specific refusal');
  });

  it('carries recent execution failures into the next implementer attempt', async () => {
    (modelsConfig.roles as Record<string, { primary: string; fallback: string }>).implementer = {
      primary: PRIMARY_MODEL,
      fallback: FALLBACK_MODEL,
    };
    const chatCompletion = vi.fn().mockResolvedValue(completion(PRIMARY_MODEL));
    const { dispatcher, runState } = createDispatcher(chatCompletion);
    runState.graph = {
      order: ['task-a'],
      nodes: {
        'task-a': {
          id: 'task-a',
          title: 'Task A',
          description: 'Implement A',
          acceptanceCriteria: [],
          dependsOn: [],
          targetGlobs: ['src/a.ts'],
          riskTags: [],
          riskClass: 'low',
          phase: 'queued',
          attempts: [{
            attempt: 1,
            outcome: 'needs_human',
            rationale: 'Execution failed: Edit find-text not found in src/a.ts: old text',
            evidenceRefs: [],
            at: new Date().toISOString(),
            fingerprint: 'failure',
            repeated: false,
          }],
        },
      },
    };

    await dispatcher.dispatch({ ...dispatchOptions(), role: 'implementer', taskId: 'task-a' });

    expect(userMessage(chatCompletion)).toContain('Edit find-text not found in src/a.ts');
  });
});

describe('WorkerDispatcher work reviews and the owned-files rule', () => {
  const ownership = (): OwnershipMap => ({
    ...emptyOwnershipMap(),
    entries: {
      cli: { taskId: 'cli', paths: ['alloydamage/cli.py'], interfaces: [], generated: [], tests: [] },
      tests: { taskId: 'tests', paths: [], interfaces: [], generated: [], tests: ['tests/test_damage.py'] },
    },
  });
  const COLLECTION_ERROR = "tests/test_damage.py:27: in <module>\nE   NameError: name 'Path' is not defined";
  const verdict = (value: Record<string, unknown>) => ({ ...completion(PRIMARY_MODEL), text: JSON.stringify(value) });
  const reviewOptions = (): DispatchOptions => ({
    role: 'opposition',
    scopeTaskId: 'cli',
    systemPrompt: 'Oppose.',
    userPrompt: 'Review the cli motion.',
    schemaDescription: '{ "verdict": "approve" | "reject" | "flag", "rationale": string, "evidenceRefs": string[] }',
    validate: () => {},
  });
  function reviewing(chatCompletion: ReturnType<typeof vi.fn>) {
    (modelsConfig.roles as Record<string, { primary: string; fallback: string }>).opposition = { primary: PRIMARY_MODEL, fallback: FALLBACK_MODEL };
    const created = createDispatcher(chatCompletion, undefined, ownership);
    created.runState.underReview = { cli: COLLECTION_ERROR };
    return created;
  }

  it('tells a work review where the checks fail and asks for defectPaths', async () => {
    const chatCompletion = vi.fn().mockResolvedValue(verdict({ verdict: 'approve', rationale: 'ok', evidenceRefs: [] }));
    const { dispatcher } = reviewing(chatCompletion);

    await dispatcher.dispatch(reviewOptions());

    const content = userMessage(chatCompletion);
    expect(content).toContain('tests/test_damage.py: owned by task tests');
    expect(content).toContain('Do not reject this task for it');
    expect(content).toContain('"defectPaths"');
  });

  it('leaves institutional ballots in the same window alone', async () => {
    const chatCompletion = vi.fn().mockResolvedValue(verdict({ verdict: 'reject', rationale: 'no', defectPaths: ['tests/test_damage.py'] }));
    const { dispatcher } = reviewing(chatCompletion);

    const result = await dispatcher.dispatch({ ...reviewOptions(), role: 'reviewer', phase: 'institutional' });

    expect(userMessage(chatCompletion)).not.toContain('"defectPaths"');
    expect((result.value as { verdict: string }).verdict).toBe('reject');
  });

  it('sends back a reject that places the defect only in another task\'s files', async () => {
    const chatCompletion = vi.fn()
      .mockResolvedValueOnce(verdict({ verdict: 'reject', rationale: 'collection fails', evidenceRefs: [], defectPaths: ['tests/test_damage.py'] }))
      .mockResolvedValueOnce(verdict({ verdict: 'reject', rationale: 'cli crashes', evidenceRefs: [], defectPaths: ['alloydamage/cli.py'] }));
    const { dispatcher } = reviewing(chatCompletion);

    const result = await dispatcher.dispatch(reviewOptions());

    expect(chatCompletion).toHaveBeenCalledTimes(2);
    const correction = chatCompletion.mock.calls[1]![0].messages.at(-1).content as string;
    expect(correction).toContain('tests/test_damage.py (owned by tests)');
    expect(result.value).toMatchObject({ verdict: 'reject', evidenceRefs: ['alloydamage/cli.py'] });
  });

  it('keeps a persistent foreign-only reject as a flag on the last attempt', async () => {
    const chatCompletion = vi.fn().mockResolvedValue(
      verdict({ verdict: 'reject', rationale: 'collection fails', evidenceRefs: [], defectPaths: ['tests/test_damage.py'] }));
    const { dispatcher, record } = reviewing(chatCompletion);

    const result = await dispatcher.dispatch(reviewOptions());

    expect(result.value).toMatchObject({ verdict: 'flag' });
    expect((result.value as { rationale: string }).rationale).toContain('owned by another task');
    expect(record).toHaveBeenCalledWith('review_reject_downgraded', expect.objectContaining({ taskId: 'cli', foreignPaths: ['tests/test_damage.py'] }));
  });

  it('lets a reject naming one of the task\'s own files stand', async () => {
    const chatCompletion = vi.fn().mockResolvedValue(verdict({
      verdict: 'reject', rationale: 'both', evidenceRefs: [], defectPaths: ['tests/test_damage.py', 'alloydamage/cli.py'],
    }));
    const { dispatcher } = reviewing(chatCompletion);

    const result = await dispatcher.dispatch(reviewOptions());

    expect(chatCompletion).toHaveBeenCalledTimes(1);
    expect(result.value).toMatchObject({ verdict: 'reject' });
  });
});

describe('WorkerDispatcher per-call usage', () => {
  // Capitalist meters each contract by the run-wide token counter's delta; two calls in flight at
  // once each counted the other's tokens. The result must carry the call's own.
  it('reports the tokens of every corrective round of this call', async () => {
    const chatCompletion = vi
      .fn()
      .mockResolvedValueOnce({ ...completion(PRIMARY_MODEL), text: 'not json' })
      .mockResolvedValueOnce(completion(PRIMARY_MODEL));
    const { dispatcher } = createDispatcher(chatCompletion);

    const result = await dispatcher.dispatch({ ...dispatchOptions(), validate: () => {} });

    expect(chatCompletion).toHaveBeenCalledTimes(2);
    expect(result.promptTokens).toBe(20);
    expect(result.completionTokens).toBe(10);
  });
});

describe('WorkerDispatcher repair brief', () => {
  function graphWith(overrides: Record<string, unknown>) {
    return {
      order: ['task-a'],
      nodes: {
        'task-a': {
          id: 'task-a',
          title: 'Task A',
          description: 'Implement A',
          acceptanceCriteria: [],
          dependsOn: [],
          targetGlobs: ['src/a.ts'],
          riskTags: [],
          riskClass: 'low' as const,
          phase: 'queued' as const,
          attempts: [],
          ...overrides,
        },
      },
    };
  }
  const brief = {
    attempt: 1,
    maxAttempts: 8,
    checks: [{ categoryId: 'unit', status: 'new' as const, output: 'E   ValueError: units' }],
    advisoryFailures: [],
    findings: [],
    reviewRequiredChanges: [],
    priorAttempt: 'edit src/a.ts:\n--- find\nold\n+++ replace\nnew',
    history: [],
    repeatCount: 1,
  };

  it('shows the implementer the engine brief, including the reverted attempt', async () => {
    (modelsConfig.roles as Record<string, { primary: string; fallback: string }>).implementer = {
      primary: PRIMARY_MODEL,
      fallback: FALLBACK_MODEL,
    };
    const chatCompletion = vi.fn().mockResolvedValue(completion(PRIMARY_MODEL));
    const { dispatcher, runState } = createDispatcher(chatCompletion);
    runState.graph = graphWith({ repairBrief: brief });

    await dispatcher.dispatch({ ...dispatchOptions(), role: 'implementer', taskId: 'task-a' });

    const content = userMessage(chatCompletion);
    expect(content).toContain('REPAIR BRIEF');
    expect(content).toContain('E   ValueError: units');
    expect(content).toContain('edit src/a.ts');
  });

  it('does not show the brief to other roles', async () => {
    const chatCompletion = vi.fn().mockResolvedValue(completion(PRIMARY_MODEL));
    const { dispatcher, runState } = createDispatcher(chatCompletion);
    runState.graph = graphWith({ repairBrief: brief });

    await dispatcher.dispatch({ ...dispatchOptions(), role: 'reviewer', taskId: 'task-a' });

    expect(userMessage(chatCompletion)).not.toContain('REPAIR BRIEF');
  });

  it('drops a refusal\'s pasted check output when the brief already carries it', async () => {
    (modelsConfig.roles as Record<string, { primary: string; fallback: string }>).implementer = {
      primary: PRIMARY_MODEL,
      fallback: FALLBACK_MODEL,
    };
    const chatCompletion = vi.fn().mockResolvedValue(completion(PRIMARY_MODEL));
    const { dispatcher, runState } = createDispatcher(chatCompletion);
    runState.graph = graphWith({
      repairBrief: brief,
      signOffRefusals: ['Needs sign-off.\nIndependent check output:\nDUPLICATE OUTPUT\nEvaluator decision: wrong units'],
    });

    await dispatcher.dispatch({ ...dispatchOptions(), role: 'implementer', taskId: 'task-a' });

    const content = userMessage(chatCompletion);
    expect(content).toContain('Evaluator decision: wrong units');
    expect(content).not.toContain('DUPLICATE OUTPUT');
  });

  // A provider timeout says nothing about the work; "repeating the same delivery will fail again"
  // after one sent the next attempt looking for a defect that was never there.
  it('leaves transient execution failures out', async () => {
    (modelsConfig.roles as Record<string, { primary: string; fallback: string }>).implementer = {
      primary: PRIMARY_MODEL,
      fallback: FALLBACK_MODEL,
    };
    const chatCompletion = vi.fn().mockResolvedValue(completion(PRIMARY_MODEL));
    const { dispatcher, runState } = createDispatcher(chatCompletion);
    runState.graph = graphWith({
      attempts: [{
        attempt: 1,
        outcome: 'needs_human',
        rationale: 'Execution failed: provider timed out',
        evidenceRefs: [],
        at: new Date().toISOString(),
        fingerprint: 'error',
        repeated: false,
        transient: true,
      }],
    });

    await dispatcher.dispatch({ ...dispatchOptions(), role: 'implementer', taskId: 'task-a' });

    expect(userMessage(chatCompletion)).not.toContain('provider timed out');
  });
});

describe('jsonResponseSuffix', () => {
  // Sent to every role, the file-escaping example made solar-mini4 abstain on 18 of 24 Prime
  // Coordinator ballots; without it, on none.
  it('keeps the file-escaping example for the implementer only', () => {
    expect(jsonResponseSuffix('{"x": 1}', 'implementer')).toContain('def f():');
    for (const role of ['reviewer', 'generalist', 'planner', 'opposition', undefined]) {
      const suffix = jsonResponseSuffix('{"x": 1}', role);
      expect(suffix).not.toContain('def f():');
      expect(suffix).toContain('never place a literal newline');
    }
  });
});

describe('WorkerDispatcher planner criteria ordering', () => {
  const plan = (cliDependsOnScaffold: boolean) => JSON.stringify({ tasks: [
    { id: 'scaffold', targetGlobs: ['pkg/__main__.py'], dependsOn: [], acceptanceCriteria: ['pkg/__main__.py dispatches to cli.py'] },
    { id: 'cli', targetGlobs: ['pkg/cli.py'], dependsOn: cliDependsOnScaffold ? ['scaffold'] : [], acceptanceCriteria: ['Parses args'] },
  ] });
  const plannerOptions = (): DispatchOptions => ({
    ...dispatchOptions(), schemaDescription: '{ "tasks": [{ "id", "targetGlobs", "dependsOn", "acceptanceCriteria" }] }',
    validate: () => {},
  });

  it('asks the planner to fix a criterion that needs a later task\'s file', async () => {
    const chatCompletion = vi.fn()
      .mockResolvedValueOnce({ ...completion(PRIMARY_MODEL), text: plan(true) })
      .mockResolvedValueOnce({ ...completion(PRIMARY_MODEL), text: plan(true).replace('dispatches to cli.py', 'exists') });
    const { dispatcher } = createDispatcher(chatCompletion);

    await dispatcher.dispatch(plannerOptions());

    expect(chatCompletion).toHaveBeenCalledTimes(2);
    const correction = chatCompletion.mock.calls[1]![0].messages.at(-1).content as string;
    expect(correction).toContain('needs pkg/cli.py (written by "cli")');
  });

  it('keeps the last plan rather than failing a planner that cannot untangle it', async () => {
    const chatCompletion = vi.fn().mockResolvedValue({ ...completion(PRIMARY_MODEL), text: plan(true) });
    const { dispatcher, record } = createDispatcher(chatCompletion);

    await expect(dispatcher.dispatch(plannerOptions())).resolves.toBeDefined();
    expect(record).toHaveBeenCalledWith('plan_criteria_ahead_of_owner', expect.objectContaining({
      criteria: [{ taskId: 'scaffold', ownerTaskId: 'cli', path: 'pkg/cli.py' }],
    }));
  });
});

describe('WorkerDispatcher planner reading-only tasks', () => {
  const plannerOptions = (): DispatchOptions => ({
    ...dispatchOptions(), schemaDescription: '{ "tasks": [{ "id", "title", "targetGlobs" }] }',
    validate: () => {},
  });
  const plan = (withReader: boolean) => JSON.stringify({ tasks: [
    ...(withReader ? [{ id: 'read-data', title: 'Read and validate the supplied data', targetGlobs: ['data/Fe.csv'], dependsOn: [] }] : []),
    { id: 'loader', title: 'Read the CSVs in a loader module', targetGlobs: ['pkg/loader.py'], dependsOn: [] },
  ] });

  it('asks the planner to drop a task that only reads files already present', async () => {
    const chatCompletion = vi.fn()
      .mockResolvedValueOnce({ ...completion(PRIMARY_MODEL), text: plan(true) })
      .mockResolvedValueOnce({ ...completion(PRIMARY_MODEL), text: plan(false) });
    const { dispatcher } = createDispatcher(chatCompletion, undefined, undefined, undefined, (p) => p === 'data/Fe.csv');

    await dispatcher.dispatch(plannerOptions());

    expect(chatCompletion).toHaveBeenCalledTimes(2);
    const correction = chatCompletion.mock.calls[1]![0].messages.at(-1).content as string;
    expect(correction).toContain('"read-data" (data/Fe.csv)');
    expect(correction).not.toContain('"loader"');
  });
});

describe('WorkerDispatcher.smallestContextTokens', () => {
  const chat = { inputPricePerMTok: 1, outputPricePerMTok: 1, supportsJsonMode: true, supportsToolCalls: true };
  const dispatcherFor = (models: Record<string, object>, roles: Record<string, { primary: string; fallback: string }>) =>
    new WorkerDispatcher({
      client: {} as OpenRouterClient,
      modelsConfig: { roles, models } as never,
      ledger: { record: vi.fn() } as unknown as Ledger,
      budget: {} as BudgetGuard,
      runState: {} as RunState,
    });

  it('sizes to the smallest window any role may be served by, fallbacks included', () => {
    const dispatcher = dispatcherFor(
      { big: { ...chat, contextLength: 524_288 }, small: { ...chat, contextLength: 16_384 },
        decide: { ...chat, api: 'decisions', contextLength: 1_000 } },
      { implementer: { primary: 'big', fallback: 'small' }, decider: { primary: 'decide', fallback: 'decide' } },
    );
    expect(dispatcher.smallestContextTokens()).toBe(16_384);
  });

  it('treats an unrecorded window as small, so a new roster errs toward a shorter prompt', () => {
    const dispatcher = dispatcherFor(
      { big: { ...chat, contextLength: 524_288 }, unknown: { ...chat, contextLength: null } },
      { implementer: { primary: 'big', fallback: 'unknown' } },
    );
    expect(dispatcher.smallestContextTokens()).toBe(UNKNOWN_CONTEXT_TOKENS);
  });
});

describe('WorkerDispatcher.decide', () => {
  const DECIDE = 'test/decide';
  const DECIDE_FALLBACK = 'test/decide-fallback';
  const decisionEntry = { inputPricePerMTok: 0.1, outputPricePerMTok: 0, supportsJsonMode: false, supportsToolCalls: false, api: 'decisions' as const };
  const ballot = { type: 'choice' as const, instructions: 'Vote.', criteria: { aye: 'For.', no: 'Against.', abstain: 'Neither.' } };

  function decisionResult(probabilities: Record<string, number>, model = DECIDE) {
    const choice = Object.entries(probabilities).sort(([, a], [, b]) => b - a)[0]![0];
    return {
      answers: { vote: { type: 'choice' as const, choice, confidence: 0.5, probabilities } },
      promptTokens: 500, costUsd: 0.00005, costMetered: true, model, attempts: 1, timedOut: false,
    };
  }

  function decider(decide: ReturnType<typeof vi.fn>, decisionMode: 'off' | 'pure' = 'pure') {
    const record = vi.fn();
    const recordSpend = vi.fn(() => ({ warn: false }));
    const runState = { runId: 'r', costUsd: 0, tokensUsed: { prompt: 0, completion: 0 }, workerCalls: 0 } as RunState;
    const dispatcher = new WorkerDispatcher({
      client: { decide, chatCompletion: vi.fn() } as unknown as OpenRouterClient,
      modelsConfig: {
        roles: { decider: { primary: DECIDE, fallback: DECIDE_FALLBACK }, reviewer: { primary: DECIDE, fallback: PRIMARY_MODEL } },
        models: { [DECIDE]: decisionEntry, [DECIDE_FALLBACK]: decisionEntry, [PRIMARY_MODEL]: modelEntry },
      },
      ledger: { record, recordTranscript: vi.fn() } as unknown as Ledger,
      budget: { checkBeforeCall: vi.fn(), perCallTimeoutMs: vi.fn(() => 60_000), stallTimeout: vi.fn(() => undefined), recordSpend } as unknown as BudgetGuard,
      runState,
      decisionMode,
    });
    return { dispatcher, record, recordSpend, runState };
  }

  it('accepts a confident answer, meters it and records the distribution', async () => {
    const decide = vi.fn().mockResolvedValue(decisionResult({ aye: 0.9, no: 0.07, abstain: 0.03 }));
    const { dispatcher, record, recordSpend } = decider(decide);

    const outcome = await dispatcher.decide({ personaId: 'rep', taskId: 't1', state: { motion: 'm' }, questions: { vote: ballot }, confidenceFloor: 0.6 });

    expect(outcome).toMatchObject({ accepted: true, reason: 'accepted', model: DECIDE, answers: { vote: { choice: 'aye' } } });
    expect(recordSpend).toHaveBeenCalledWith(expect.anything(), { costUsd: 0.00005, promptTokens: 500, completionTokens: 0 }, 't1');
    expect(record).toHaveBeenCalledWith('decision_call', expect.objectContaining({
      personaId: 'rep', model: DECIDE, outcome: 'accepted', answers: { vote: 'p(aye)=0.90 p(no)=0.07 p(abstain)=0.03' },
    }));
  });

  it('answers a one-option choice itself, since the API refuses it', async () => {
    const lead = { type: 'choice' as const, instructions: 'Lead?', criteria: { backend: 'Backend.' } };
    const decide = vi.fn().mockResolvedValue(decisionResult({ aye: 0.9, no: 0.07, abstain: 0.03 }));
    const { dispatcher } = decider(decide);

    const both = await dispatcher.decide({ state: 's', questions: { vote: ballot, lead }, confidenceFloor: 0.6 });
    expect(decide).toHaveBeenCalledWith(expect.objectContaining({ questions: { vote: ballot } }));
    expect(both).toMatchObject({ accepted: true, answers: { vote: { choice: 'aye' }, lead: { choice: 'backend', confidence: 1 } } });

    decide.mockClear();
    await expect(dispatcher.decide({ state: 's', questions: { lead }, confidenceFloor: 0.6 }))
      .resolves.toMatchObject({ accepted: true, answers: { lead: { choice: 'backend' } }, costUsd: 0 });
    expect(decide).not.toHaveBeenCalled();
  });

  it('hands an unconfident answer back for the chat call', async () => {
    const decide = vi.fn().mockResolvedValue(decisionResult({ aye: 0.5, no: 0.45, abstain: 0.05 }));
    const { dispatcher } = decider(decide);
    await expect(dispatcher.decide({ state: 's', questions: { vote: ballot }, confidenceFloor: 0.6 }))
      .resolves.toMatchObject({ accepted: false, reason: 'low-confidence' });
  });

  it('hands back an answer the call site will not take unexplained', async () => {
    const decide = vi.fn().mockResolvedValue(decisionResult({ aye: 0.02, no: 0.95, abstain: 0.03 }));
    const { dispatcher } = decider(decide);
    const outcome = await dispatcher.decide({
      state: 's', questions: { vote: ballot }, confidenceFloor: 0.6,
      accept: (answers) => (answers.vote as { choice: string }).choice === 'aye',
    });
    expect(outcome).toMatchObject({ accepted: false, reason: 'not-accepted', answers: { vote: { choice: 'no' } } });
  });

  it('tries the fallback decision model, then reports failure instead of throwing', async () => {
    const decide = vi.fn().mockRejectedValue(new Error('alpha endpoint unavailable'));
    const { dispatcher, record, runState } = decider(decide);

    await expect(dispatcher.decide({ state: 's', questions: { vote: ballot }, confidenceFloor: 0.6 }))
      .resolves.toMatchObject({ accepted: false, reason: 'failed' });
    expect(decide.mock.calls.map(([opts]) => opts.model)).toEqual([DECIDE, DECIDE_FALLBACK]);
    expect(record.mock.calls.filter(([type]) => type === 'decision_call_failed')).toHaveLength(2);
    expect(runState.workerCalls).toBe(2);
  });

  it('never sends a chat request to a decision model', async () => {
    const chatCompletion = vi.fn().mockResolvedValue(completion(PRIMARY_MODEL));
    const { dispatcher } = decider(vi.fn());
    (dispatcher as unknown as { client: { chatCompletion: unknown } }).client.chatCompletion = chatCompletion;
    await dispatcher.dispatch({ ...dispatchOptions(), role: 'reviewer' });
    expect(chatCompletion.mock.calls.map(([opts]) => opts.model)).toEqual([PRIMARY_MODEL]);
  });

  it('asks decision models first under pure only', () => {
    expect(decider(vi.fn(), 'off').dispatcher.decidesFirst()).toBe(false);
    expect(decider(vi.fn(), 'pure').dispatcher.decidesFirst()).toBe(true);
  });
});

describe('WorkerDispatcher review commands', () => {
  const reviewCommands = [{ id: 'cli', description: 'run the CLI', command: 'python', args: ['-m', 'pkg'], timeoutMs: 1_000 }];

  function reviewDispatcher(chatCompletion: ReturnType<typeof vi.fn>, role: string) {
    const toolModel = { ...modelEntry, supportsToolCalls: true };
    const record = vi.fn();
    const runInScratchCopy = vi.fn(async () => ({ ran: true, passed: false, output: 'error: energy below range' }));
    const dispatcher = new WorkerDispatcher({
      client: { chatCompletion } as unknown as OpenRouterClient,
      modelsConfig: {
        roles: { [role]: { primary: PRIMARY_MODEL, fallback: FALLBACK_MODEL } },
        models: { [PRIMARY_MODEL]: toolModel, [FALLBACK_MODEL]: toolModel },
      },
      ledger: { record, recordTranscript: vi.fn() } as unknown as Ledger,
      budget: {
        checkBeforeCall: vi.fn(), perCallTimeoutMs: vi.fn(() => 1_000), stallTimeout: vi.fn(() => undefined),
        recordSpend: vi.fn(() => ({ warn: false })),
      } as unknown as BudgetGuard,
      runState: { runId: 'test-run', costUsd: 0, tokensUsed: { prompt: 0, completion: 0 }, workerCalls: 0 } as RunState,
      worktree: { runInScratchCopy } as unknown as RepoWorktree,
      reviewCommands,
    });
    return { dispatcher, record, runInScratchCopy };
  }

  const toolNames = (request: { tools?: Array<{ function: { name: string } }> }) =>
    (request.tools ?? []).map((tool) => tool.function.name);

  it('offers run_review_command to a reviewer and returns the output to it', async () => {
    const call = { id: 'c1', type: 'function' as const,
      function: { name: 'run_review_command', arguments: '{"commandId":"cli","args":["calculate","a.yaml"]}' } };
    const chatCompletion = vi.fn()
      .mockResolvedValueOnce({ ...completion(PRIMARY_MODEL), text: '', toolCalls: [call] })
      .mockResolvedValueOnce(completion(PRIMARY_MODEL));
    const { dispatcher, record, runInScratchCopy } = reviewDispatcher(chatCompletion, 'reviewer');

    await dispatcher.dispatch({ ...dispatchOptions(), role: 'reviewer', taskId: 't1' });

    expect(toolNames(chatCompletion.mock.calls[0]![0])).toContain('run_review_command');
    expect(runInScratchCopy).toHaveBeenCalledWith('python', ['-m', 'pkg', 'calculate', 'a.yaml'], 1_000, { sandbox: 'none' });
    const toolMessage = chatCompletion.mock.calls[1]![0].messages.at(-1);
    expect(toolMessage).toMatchObject({ role: 'tool', name: 'run_review_command' });
    expect(toolMessage.content).toContain('energy below range');
    expect(record).toHaveBeenCalledWith('review_command_run', expect.objectContaining({
      role: 'reviewer', taskId: 't1', commandId: 'cli', args: ['calculate', 'a.yaml'], ran: true, exitedZero: false,
    }));
  });

  it('does not offer it to the implementer, and refuses it if called anyway', async () => {
    const call = { id: 'c1', type: 'function' as const,
      function: { name: 'run_review_command', arguments: '{"commandId":"cli"}' } };
    const chatCompletion = vi.fn()
      .mockResolvedValueOnce({ ...completion(PRIMARY_MODEL), text: '', toolCalls: [call] })
      .mockResolvedValueOnce(completion(PRIMARY_MODEL));
    const { dispatcher, runInScratchCopy } = reviewDispatcher(chatCompletion, 'implementer');

    await dispatcher.dispatch({ ...dispatchOptions(), role: 'implementer', taskId: 't1' }).catch(() => undefined);

    expect(toolNames(chatCompletion.mock.calls[0]![0])).not.toContain('run_review_command');
    expect(toolNames(chatCompletion.mock.calls[0]![0])).toContain('read_repository_file');
    expect(runInScratchCopy).not.toHaveBeenCalled();
  });

  it('caps commands at five per verdict', async () => {
    const calls = Array.from({ length: 6 }, (_, i) => ({ id: `c${i}`, type: 'function' as const,
      function: { name: 'run_review_command', arguments: '{"commandId":"cli"}' } }));
    const chatCompletion = vi.fn()
      .mockResolvedValueOnce({ ...completion(PRIMARY_MODEL), text: '', toolCalls: calls })
      .mockResolvedValueOnce(completion(PRIMARY_MODEL));
    const { dispatcher, record, runInScratchCopy } = reviewDispatcher(chatCompletion, 'reviewer');

    await dispatcher.dispatch({ ...dispatchOptions(), role: 'reviewer', taskId: 't1' });

    expect(runInScratchCopy).toHaveBeenCalledTimes(5);
    expect(record).toHaveBeenCalledWith('review_command_refused', expect.objectContaining({ reason: expect.stringMatching(/At most 5/) }));
  });

  it('does not count a refused call against the cap', async () => {
    const refused = { id: 'r', type: 'function' as const,
      function: { name: 'run_review_command', arguments: '{"commandId":"cli","args":["/etc/passwd"]}' } };
    const calls = [refused, ...Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, type: 'function' as const,
      function: { name: 'run_review_command', arguments: '{"commandId":"cli"}' } }))];
    const chatCompletion = vi.fn()
      .mockResolvedValueOnce({ ...completion(PRIMARY_MODEL), text: '', toolCalls: calls })
      .mockResolvedValueOnce(completion(PRIMARY_MODEL));
    const { dispatcher, runInScratchCopy } = reviewDispatcher(chatCompletion, 'reviewer');

    await dispatcher.dispatch({ ...dispatchOptions(), role: 'reviewer', taskId: 't1' });

    expect(runInScratchCopy).toHaveBeenCalledTimes(5);
  });
});
