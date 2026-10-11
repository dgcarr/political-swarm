import { z } from 'zod';
import type { OpenRouterClient } from '../engine/OpenRouterClient.js';
import { saveModelsLocalOverride, type ModelEntry, type ModelsLocalOverride } from '../util/config.js';

export const swarmConfigureModelsInputShape = {
  primary: z.string().min(1).describe('OpenRouter model id to use as the primary model for every swarm role, e.g. "openai/gpt-4o-mini".'),
  fallback: z.string().min(1).describe('OpenRouter model id to fall back to if the primary fails.'),
};

export async function swarmConfigureModels(
  client: OpenRouterClient,
  configDir: string,
  input: { primary: string; fallback: string },
): Promise<ModelsLocalOverride> {
  const catalog = await client.listModels();
  const byId = new Map(catalog.map((m) => [m.id, m]));

  const modelEntries: Record<string, ModelEntry> = {};
  for (const id of [input.primary, input.fallback]) {
    const entry = byId.get(id);
    if (!entry) {
      throw new Error(`"${id}" was not found in OpenRouter's model catalog. Run swarm_list_models to see valid ids.`);
    }
    modelEntries[id] = {
      inputPricePerMTok: entry.inputPricePerMTok,
      outputPricePerMTok: entry.outputPricePerMTok,
      supportsJsonMode: entry.supportsJsonMode,
      supportsToolCalls: entry.supportsToolCalls,
      ...(entry.contextLength ? { contextLength: entry.contextLength } : {}),
    };
  }

  const override = {
    primary: input.primary,
    fallback: input.fallback,
    updatedAt: new Date().toISOString(),
    modelEntries,
  };
  saveModelsLocalOverride(configDir, override);

  return override;
}
