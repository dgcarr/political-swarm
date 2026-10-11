// Verifies config/models.yaml against OpenRouter's live catalog.
//
// This exists because of a specific failure. `qwen/qwen-2.5-coder-32b-instruct` was declared with
// `supportsJsonMode: true`, and OpenRouter's catalog says that model does not accept
// `response_format` at all. WorkerDispatcher believed the config, sent the parameter anyway, and
// every run paid for it — provider 500s, unquoted JSON keys, fenced code where an object was
// required, two corrective retries per role per run. The roster's pricing was wrong by 3.7x on
// input and 5.6x on output as well, so budget accounting was quietly wrong too. Nothing caught any
// of it, because loadModelsConfig parses the YAML and trusts it.
//
// Unlike the other smoke scripts this one spends nothing: the catalog endpoint is public and no
// completion is requested. It is worth running whenever the roster is touched, and cheap enough to
// run on any day at all.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

import { OpenRouterClient } from '../engine/OpenRouterClient.js';
import { isDecisionModel, loadModelsConfig } from '../util/config.js';
import { log as createLog, reportChecks } from './harness.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(__dirname, '../../..');
const configDir = path.join(pluginRoot, 'config');

const log = createLog('models-smoke');

/** Catalog prices move. This is drift worth knowing about, not a rounding difference. */
const PRICE_TOLERANCE = 0.2;

function within(declared: number, actual: number, tolerance: number): boolean {
  if (actual === 0) return declared === 0;
  return Math.abs(declared - actual) / actual <= tolerance;
}

async function main(): Promise<void> {
  dotenv.config({ path: path.join(pluginRoot, '.env') });

  const config = loadModelsConfig(configDir);
  const client = new OpenRouterClient(process.env.OPENROUTER_API_KEY ?? '');
  const catalog = await client.listModels();
  const byId = new Map(catalog.map((m) => [m.id, m]));
  log(`OpenRouter catalog: ${catalog.length} models`);

  const checks: [string, boolean][] = [];

  // A catalog that came back empty would make every check below pass vacuously.
  checks.push(['the catalog was fetched and is not empty', catalog.length > 0]);

  // Decision models are served by the alpha Decisions API and are absent from the chat catalog, so
  // each is checked by answering one tiny question instead (a few hundred input tokens, ~$0.00005).
  for (const [id, declared] of Object.entries(config.models)) {
    if (!isDecisionModel(declared)) continue;
    let answered = false;
    try {
      const result = await client.decide({
        model: id, modelEntry: declared, timeoutMs: 30_000, state: 'The sky is blue.',
        questions: { q: { type: 'noul', instructions: 'Is the sky described as blue?', criteria: { true: 'Yes.', false: 'No.' } } },
      });
      answered = typeof (result.answers.q as { noul?: number }).noul === 'number';
    } catch (err) {
      log(`"${id}" decision probe failed: ${String(err).slice(0, 200)}`);
    }
    checks.push([`decision model "${id}" answers on the Decisions API`, answered]);
  }

  for (const [id, declared] of Object.entries(config.models)) {
    if (isDecisionModel(declared)) continue;
    const live = byId.get(id);
    checks.push([`"${id}" exists in the catalog`, live !== undefined]);
    if (!live) continue;

    const jsonModeAgrees = declared.supportsJsonMode === live.supportsJsonMode;
    const toolCallsAgrees = declared.supportsToolCalls === live.supportsToolCalls;

    checks.push([
      `"${id}" supportsJsonMode matches the catalog (declared ${declared.supportsJsonMode}, catalog ${live.supportsJsonMode})`,
      jsonModeAgrees,
    ]);
    checks.push([
      `"${id}" supportsToolCalls matches the catalog (declared ${declared.supportsToolCalls}, catalog ${live.supportsToolCalls})`,
      toolCallsAgrees,
    ]);
    checks.push([
      `"${id}" input price is within ${PRICE_TOLERANCE * 100}% of the catalog ` +
        `(declared ${declared.inputPricePerMTok}, catalog ${live.inputPricePerMTok.toFixed(4)})`,
      within(declared.inputPricePerMTok, live.inputPricePerMTok, PRICE_TOLERANCE),
    ]);
    checks.push([
      `"${id}" output price is within ${PRICE_TOLERANCE * 100}% of the catalog ` +
        `(declared ${declared.outputPricePerMTok}, catalog ${live.outputPricePerMTok.toFixed(4)})`,
      within(declared.outputPricePerMTok, live.outputPricePerMTok, PRICE_TOLERANCE),
    ]);
  }

  // Every role must be servable, and its fallback must be able to rescue its primary. A role whose
  // two models share a provider outage is a fallback in name only, but that is not something the
  // catalog can tell us — what it can tell us is that both ids resolve.
  for (const [role, entry] of Object.entries(config.roles)) {
    for (const [slot, modelId] of [['primary', entry.primary], ['fallback', entry.fallback]] as const) {
      if (isDecisionModel(config.models[modelId])) continue;
      checks.push([`role "${role}" ${slot} "${modelId}" resolves to a catalog model`, byId.has(modelId)]);
    }
  }

  // The dispatcher's only JSON guarantee is response_format. A role whose primary and fallback both
  // lack it is a role that will rely entirely on the prompt and the corrective-retry loop.
  for (const [role, entry] of Object.entries(config.roles)) {
    if (isDecisionModel(config.models[entry.primary])) continue;
    const primary = byId.get(entry.primary);
    const fallback = byId.get(entry.fallback);
    checks.push([
      `role "${role}" has at least one model that accepts response_format`,
      Boolean(primary?.supportsJsonMode || fallback?.supportsJsonMode),
    ]);
  }

  const ok = reportChecks('models-smoke', checks);
  if (!ok) {
    log('config/models.yaml disagrees with OpenRouter. Run swarm_list_models, or /swarm-setup, to pick a live roster.');
    process.exitCode = 1;
    return;
  }
  log('All checks passed.');
}

main().catch((err) => {
  process.stderr.write(`[models-smoke] FATAL: ${String(err?.stack ?? err)}\n`);
  process.exitCode = 1;
});
