// Standalone M1 smoke test: exercises SwarmEngine + RepoWorktree + Ledger + BudgetGuard end to
// end against a scratch repo, using NoopStrategy so no real OpenRouter calls happen. Run with:
//   npm run smoke:engine
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

import { OpenRouterClient } from '../engine/OpenRouterClient.js';
import { SwarmEngine } from '../engine/SwarmEngine.js';
import { loadBudgetConfig, loadModelsConfig, loadStrategiesConfig } from '../util/config.js';
import { buildNoopStrategies, log as createLog, reportChecks, SENTINEL_CHECKED_REPO, setUpScratchRepo, waitForTerminal } from './harness.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(__dirname, '../../..'); // dist/smoke -> dist -> mcp-server -> plugin root
const configDir = path.join(pluginRoot, 'config');
const runsRootDir = path.join(pluginRoot, 'runs', 'smoke');

const scratchRepoRoot = process.env.SWARM_SMOKE_SCRATCH_DIR ?? path.join(os.tmpdir(), 'swarm-smoke-repo');

const log = createLog('smoke');

async function main(): Promise<void> {
  dotenv.config({ path: path.join(pluginRoot, '.env') });

  log(`Plugin root: ${pluginRoot}`);
  log(`Setting up scratch repo at: ${scratchRepoRoot}`);
  setUpScratchRepo({
    repoPath: scratchRepoRoot,
    readme: '# scratch repo for political-swarm engine smoke test\n',
    ...SENTINEL_CHECKED_REPO,
  });

  // NoopStrategy makes no model calls; the placeholder lets this run in a CI checkout with no .env.
  const client = new OpenRouterClient(process.env.OPENROUTER_API_KEY || 'noop-smoke-no-network-calls');
  const modelsConfig = loadModelsConfig(configDir);
  const budgetConfig = loadBudgetConfig(configDir);
  const strategiesConfig = loadStrategiesConfig(configDir);

  const strategies = buildNoopStrategies();

  const engine = new SwarmEngine({ client, modelsConfig, configDir, budgetConfig, strategiesConfig, runsRootDir, strategies });

  const run = await engine.startRun({
    task: {
      goal: 'Engine smoke test',
      acceptanceCriteria: ['SWARM_SENTINEL.md exists in the worktree'],
      repoPath: scratchRepoRoot,
      baseBranch: 'main',
    },
    strategy: 'noop',
    budgetUsd: budgetConfig.defaults.perRunUsd,
  });
  log(`Started run ${run.runId}, worktree at ${run.worktreePath}`);

  await waitForTerminal(engine, run.runId);
  const finalState = engine.getRunStore().load(run.runId)!;
  log(`Final status: ${finalState.status}`);

  const sentinelPath = path.join(finalState.worktreePath, 'SWARM_SENTINEL.md');
  const realRepoSentinel = path.join(scratchRepoRoot, 'SWARM_SENTINEL.md');

  const checks: [string, boolean][] = [
    ['run reached awaiting_acceptance status', finalState.status === 'awaiting_acceptance'],
    ['a delivery packet was assembled', finalState.delivery !== undefined],
    ['sentinel file exists in isolated worktree', existsSync(sentinelPath)],
    ['real repo is untouched (no sentinel there)', !existsSync(realRepoSentinel)],
    ['ledger.jsonl was written', existsSync(path.join(runsRootDir, run.runId, 'ledger.jsonl'))],
    ['run cost stayed within budget', finalState.costUsd <= finalState.budgetUsd],
  ];

  const ok = reportChecks('smoke', checks);

  if (existsSync(sentinelPath)) {
    log(`Sentinel contents:\n${readFileSync(sentinelPath, 'utf8')}`);
  }

  if (!ok) {
    process.exitCode = 1;
    return;
  }
  log('All checks passed.');
}

main().catch((err) => {
  process.stderr.write(`[smoke] FATAL: ${String(err?.stack ?? err)}\n`);
  process.exitCode = 1;
});
