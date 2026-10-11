import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { OpenRouterClient } from '../engine/OpenRouterClient.js';
import { swarmConfigureModels } from './swarmConfigureModels.js';

const catalogModel = (id: string, contextLength: number | null) => ({
  id, name: id, contextLength, inputPricePerMTok: 1, outputPricePerMTok: 2, supportsJsonMode: true, supportsToolCalls: true,
});

describe('swarmConfigureModels', () => {
  // Prompt budgets scale with the roster's smallest window, so a new roster must carry its windows.
  it('records each model\'s context window from the catalog, and omits one the catalog lacks', async () => {
    const configDir = mkdtempSync(path.join(os.tmpdir(), 'configure-models-test-'));
    try {
      const client = { listModels: async () => [catalogModel('a/big', 200_000), catalogModel('b/unknown', null)] } as unknown as OpenRouterClient;

      const override = await swarmConfigureModels(client, configDir, { primary: 'a/big', fallback: 'b/unknown' });

      expect(override.modelEntries['a/big']?.contextLength).toBe(200_000);
      expect(override.modelEntries['b/unknown']).not.toHaveProperty('contextLength');
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});
