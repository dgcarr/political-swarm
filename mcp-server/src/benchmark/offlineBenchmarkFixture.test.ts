import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SwarmEngine } from '../engine/SwarmEngine.js';
import type { OpenRouterClient } from '../engine/OpenRouterClient.js';
import type { StrategyId } from '../engine/types.js';
import { buildNoopStrategies, setUpScratchRepo, waitForTerminal } from '../smoke/harness.js';
import { normalizeChecksConfig } from '../util/config.js';

let root = '';
afterEach(() => root && rmSync(root, { recursive: true, force: true }));

describe('offline five-strategy benchmark fixture', () => {
  it('completes all strategies with deterministic 11/11 external evidence and no network calls', async () => {
    root = mkdtempSync(path.join(os.tmpdir(), 'offline-benchmark-'));
    const repoPath = path.join(root, 'repo');
    setUpScratchRepo({ repoPath, readme: '# fixture\n' });
    const strategies = buildNoopStrategies();
    const engine = new SwarmEngine({
      client: {} as OpenRouterClient,
      modelsConfig: { roles: {}, models: {} },
      configDir: root,
      budgetConfig: {
        defaults: {
          perRunUsd: 1,
          perTaskUsd: 1,
          maxWorkerCalls: 20,
          maxWallClockMinutes: 1,
          maxTaskAttempts: 2,
          perCallTimeoutMs: 1_000,
          warnAtFractionOfPerRun: 0.8,
        },
        hardCeilingUsd: 2,
      },
      strategiesConfig: {},
      checksConfig: normalizeChecksConfig({
        categories: [{ id: 'unit', command: process.execPath, args: ['-e', 'process.exit(0)'], required: true, timeoutMs: 1_000 }],
      }),
      runsRootDir: path.join(root, 'runs'),
      strategies,
      externalEvaluator: async () => Array.from({ length: 11 }, (_, index) => ({
        id: index + 1,
        description: `offline oracle ${index + 1}`,
        passed: true,
        detail: 'deterministic fixture',
      })),
      requiredExternalEvaluationCount: 11,
    });

    const strategyIds: StrategyId[] = ['democratic', 'socialist', 'capitalist', 'managerial', 'single_agent'];
    for (const strategy of strategyIds) {
      const started = await engine.startRun({
        strategy,
        task: { goal: 'offline fixture', acceptanceCriteria: [], repoPath, baseBranch: 'main' },
      });
      const awaiting = await waitForTerminal(engine, started.runId, { result: 'state', timeoutMs: 10_000 });
      expect(awaiting.status).toBe('awaiting_acceptance');
      expect(awaiting.delivery?.externalEvaluations).toHaveLength(11);
      expect(engine.acceptDelivery(started.runId).status).toBe('completed');
    }
    // Five end-to-end runs in sequence, each allowed 10s above; vitest's 5s default covered barely one.
  }, 60_000);
});
