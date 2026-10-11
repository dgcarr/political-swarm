// M6 smoke test: confirms BudgetGuard actually pauses a run for approval when spend would
// exceed budgetUsd, that a swarm_decide-style budget increase resumes it, and that no
// increase can push total spend past the hard ceiling in config/budget.yaml. Uses
// CapitalistStrategy directly (it makes several real dispatcher calls per task, unlike
// NoopStrategy) against a real scratch repo. Run with: npm run smoke:budget
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

import { OpenRouterClient } from '../engine/OpenRouterClient.js';
import { SwarmEngine } from '../engine/SwarmEngine.js';
import { CapitalistStrategy } from '../strategies/capitalist/CapitalistStrategy.js';
import { loadBudgetConfig, loadModelsConfig, loadStrategiesConfig } from '../util/config.js';
import { buildNoopStrategies, log as createLog, reportChecks, setUpScratchRepo, waitForTerminal } from './harness.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(__dirname, '../../..');
const configDir = path.join(pluginRoot, 'config');
const runsRootDir = path.join(pluginRoot, 'runs', `budget-smoke-${Date.now()}`);
const scratchRepoRoot = path.join(os.tmpdir(), 'swarm-budget-smoke-repo');
const DEFAULT_RUN_TIMEOUT_MS = 60_000;
// Raised for the acceptance barriers the resumed run still has to get through: an integration
// report, an independent assessment and a finding-disposition sitting, each a model call.
const RESUMED_RUN_TIMEOUT_MS = 240_000;
const TERMINAL_POLL_INTERVAL_MS = 300;
const TINY_BUDGET_USD = 0.00005;
const BUDGET_SLACK_USD = 0.0005;
const APPROVED_BUDGET_USD = 0.5;
const EXCESSIVE_BUDGET_MULTIPLIER = 100;

const log = createLog('budget-smoke');

async function main(): Promise<void> {
  dotenv.config({ path: path.join(pluginRoot, '.env') });
  setUpScratchRepo({
    repoPath: scratchRepoRoot,
    readme: '# scratch repo\n',
    packageJson: { name: 'budget-smoke-scratch', version: '1.0.0', private: true, scripts: { test: 'node test.js' } },
    testFile: "console.log('no tests yet');\n",
  });

  const client = new OpenRouterClient(process.env.OPENROUTER_API_KEY ?? '');
  const modelsConfig = loadModelsConfig(configDir);
  const budgetConfig = loadBudgetConfig(configDir);
  const strategiesConfig = loadStrategiesConfig(configDir);
  const strategies = buildNoopStrategies({ capitalist: new CapitalistStrategy() });
  const engine = new SwarmEngine({ client, modelsConfig, configDir, budgetConfig, strategiesConfig, runsRootDir, strategies });

  log(`Hard ceiling from config/budget.yaml: $${budgetConfig.hardCeilingUsd}`);

  // Tiny budget: the planner call alone (a few hundred tokens on cheap models) should exceed it,
  // so BudgetGuard should trip on the very next dispatch call and pause the run.
  const tinyBudgetUsd = TINY_BUDGET_USD;
  const run = await engine.startRun({
    task: {
      goal: 'Add an isEven function with a unit test',
      acceptanceCriteria: ['isEven(n) works for even and odd numbers'],
      repoPath: scratchRepoRoot,
      baseBranch: 'main',
    },
    strategy: 'capitalist',
    budgetUsd: tinyBudgetUsd,
  });
  log(`Started run ${run.runId} with budgetUsd=$${tinyBudgetUsd}`);

  const status1 = await waitForTerminal(engine, run.runId, {
    timeoutMs: DEFAULT_RUN_TIMEOUT_MS,
    pollIntervalMs: TERMINAL_POLL_INTERVAL_MS,
    result: 'status',
  });
  const state1 = engine.getRunStore().load(run.runId)!;
  log(`After tiny budget: status=${status1}, costUsd=$${state1.costUsd.toFixed(6)}, pendingApprovals=${state1.pendingApprovals.length}`);

  const budgetApproval = state1.pendingApprovals.find((a) => a.kind === 'budget_increase' && !a.resolvedAt);

  let resumedOk = false;
  let finalState = state1;
  if (budgetApproval) {
    // Approve a modest increase (well under the hard ceiling) and confirm the run resumes and completes.
    engine.resolveApproval(run.runId, budgetApproval.id, 'approve', 'raising budget for smoke test', APPROVED_BUDGET_USD);
    const status2 = await waitForTerminal(engine, run.runId, {
      timeoutMs: RESUMED_RUN_TIMEOUT_MS,
      pollIntervalMs: TERMINAL_POLL_INTERVAL_MS,
      result: 'status',
    });
    finalState = engine.getRunStore().load(run.runId)!;
    log(`After budget increase to $0.50: status=${status2}, costUsd=$${finalState.costUsd.toFixed(6)}, budgetUsd=$${finalState.budgetUsd}`);
    // What this smoke is actually about: raising the budget released the run to keep spending and
    // reach an end state on its own. Which end state it reaches depends on the doctrine's own
    // judgment and on model behaviour at the barriers, neither of which is this test's subject —
    // so anything except "still stuck on budget" counts, and 'completed' is excluded because that
    // would require Claude's independent check, which this smoke never performs.
    resumedOk = status2 !== 'paused_budget' && status2 !== 'completed';
  }

  // Hard ceiling: request an increase far above hardCeilingUsd and confirm it gets clamped, not honored verbatim.
  const run2 = await engine.startRun({
    task: {
      goal: 'trivial task for hard ceiling test',
      acceptanceCriteria: [],
      repoPath: scratchRepoRoot,
      baseBranch: 'main',
    },
    strategy: 'capitalist',
    budgetUsd: TINY_BUDGET_USD,
  });
  await waitForTerminal(engine, run2.runId, {
    timeoutMs: DEFAULT_RUN_TIMEOUT_MS,
    pollIntervalMs: TERMINAL_POLL_INTERVAL_MS,
  });
  const state2 = engine.getRunStore().load(run2.runId)!;
  const approval2 = state2.pendingApprovals.find((a) => a.kind === 'budget_increase' && !a.resolvedAt);
  let clampedCorrectly = false;
  if (approval2) {
    const requestedInsaneIncrease = budgetConfig.hardCeilingUsd * EXCESSIVE_BUDGET_MULTIPLIER;
    const resolved = engine.resolveApproval(run2.runId, approval2.id, 'approve', 'try to exceed hard ceiling', requestedInsaneIncrease);
    clampedCorrectly = resolved.budgetUsd === budgetConfig.hardCeilingUsd;
    log(`Requested budget increase to $${requestedInsaneIncrease}, clamped to $${resolved.budgetUsd} (hard ceiling $${budgetConfig.hardCeilingUsd})`);
  }
  engine.stopRun(run2.runId, 'hard ceiling test complete, stopping to avoid further spend');

  const checks: [string, boolean][] = [
    ['tiny budget caused the run to pause rather than silently overspend', status1 === 'paused_budget'],
    ['a budget_increase approval was opened with a clear description', !!budgetApproval && !!budgetApproval.description],
    ['spend did not exceed the tiny budget before pausing', state1.costUsd <= tinyBudgetUsd + BUDGET_SLACK_USD], // small slack for the one in-flight call that tripped it
    ['approving a budget increase released the run to keep working', resumedOk],
    ['a second tiny-budget run also opened a budget_increase approval', !!approval2],
    ['requesting far more than hardCeilingUsd was clamped to hardCeilingUsd, not honored verbatim', clampedCorrectly],
  ];

  const ok = reportChecks('budget-smoke', checks);

  if (!ok) {
    process.exitCode = 1;
    return;
  }
  log('All checks passed.');
}

main().catch((err) => {
  process.stderr.write(`[budget-smoke] FATAL: ${String(err?.stack ?? err)}\n`);
  process.exitCode = 1;
});
