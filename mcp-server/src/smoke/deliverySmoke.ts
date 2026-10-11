// End-to-end smoke test of the orchestrator boundary in section 5 of every doctrine in
// docs/philosophy/, against real OpenRouter models:
//
//   run -> awaiting_acceptance -> swarm_apply REFUSED -> swarm_remediate (one concrete defect)
//       -> the same swarm reworks it -> awaiting_acceptance -> swarm_accept -> swarm_apply allowed
//
// Run with: npm run smoke:delivery
// Set SWARM_SMOKE_DELIVERY_STRATEGY to democratic | socialist | capitalist (default: democratic).
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

import { OpenRouterClient } from '../engine/OpenRouterClient.js';
import { SwarmEngine } from '../engine/SwarmEngine.js';
import { DemocraticStrategy } from '../strategies/democratic/DemocraticStrategy.js';
import { SocialistStrategy } from '../strategies/socialist/SocialistStrategy.js';
import { CapitalistStrategy } from '../strategies/capitalist/CapitalistStrategy.js';
import type { StrategyId } from '../engine/types.js';
import type { RunState } from '../engine/RunStore.js';
import { loadBudgetConfig, loadModelsConfig, loadStrategiesConfig } from '../util/config.js';
import { swarmApply } from '../tools/swarmApply.js';
import { swarmGetDelivery } from '../tools/swarmGetDelivery.js';
import { swarmAccept } from '../tools/swarmAccept.js';
import { swarmRemediate } from '../tools/swarmRemediate.js';
import { buildNoopStrategies, log as createLog, reportChecks, setUpScratchRepo, type Check } from './harness.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(__dirname, '../../..'); // dist/smoke -> dist -> mcp-server -> plugin root
const configDir = path.join(pluginRoot, 'config');
const runsRootDir = path.join(pluginRoot, 'runs', 'smoke-delivery');
const scratchRepo = process.env.SWARM_SMOKE_DELIVERY_DIR ?? path.join(os.tmpdir(), 'swarm-smoke-delivery');

const RUN_BUDGET_USD = 0.5;
const SETTLE_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 500;

const log = createLog('delivery-smoke');

dotenv.config({ path: path.join(pluginRoot, '.env') });

function strategyId(): StrategyId {
  const requested = process.env.SWARM_SMOKE_DELIVERY_STRATEGY ?? 'democratic';
  if (requested !== 'democratic' && requested !== 'socialist' && requested !== 'capitalist') {
    throw new Error(`SWARM_SMOKE_DELIVERY_STRATEGY must be democratic, socialist or capitalist (got "${requested}")`);
  }
  return requested;
}

function buildEngine(id: StrategyId): SwarmEngine {
  const client = new OpenRouterClient(process.env.OPENROUTER_API_KEY ?? '');
  const strategies = buildNoopStrategies({
    democratic: id === 'democratic' ? new DemocraticStrategy() : undefined,
    socialist: id === 'socialist' ? new SocialistStrategy() : undefined,
    capitalist: id === 'capitalist' ? new CapitalistStrategy() : undefined,
  });

  return new SwarmEngine({
    client,
    modelsConfig: loadModelsConfig(configDir),
    configDir,
    budgetConfig: loadBudgetConfig(configDir),
    strategiesConfig: loadStrategiesConfig(configDir),
    runsRootDir,
    strategies,
    // The scratch repo has no npm project, so the configured categories would all report
    // "command could not be executed". `true` gives a real, always-passing check instead, which
    // keeps the run about the boundary rather than about a missing test runner.
    checksConfig: {
      categories: [{ id: 'unit', command: 'true', args: [], timeoutMs: 10_000, required: true }],
      reviewCommands: [],
      testPathGlobs: ['**/*.test.*', '**/*.spec.*', '**/test/**', '**/tests/**'],
      maxConcurrentExecutes: 2,
      manualEvidenceAccepted: true,
      sandbox: 'none',
      command: 'true',
      args: [],
      timeoutMs: 10_000,
    },
  });
}

/** Waits until the run stops moving on its own — the swarm has either produced a delivery packet
 * or stopped for a reason worth reporting. */
async function waitUntilSettled(engine: SwarmEngine, runId: string): Promise<RunState> {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const state = engine.getRunStore().load(runId);
    if (state && state.status !== 'running' && state.status !== 'remediation') return state;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(`Run ${runId} did not settle within ${SETTLE_TIMEOUT_MS}ms`);
}

async function main(): Promise<void> {
  if (!process.env.OPENROUTER_API_KEY) {
    log('OPENROUTER_API_KEY is not set — this smoke test drives real models and cannot run without it.');
    process.exit(1);
  }

  const id = strategyId();
  log(`--- Orchestrator boundary, strategy: ${id} ---`);
  if (existsSync(runsRootDir)) rmSync(runsRootDir, { recursive: true, force: true });
  // A dependency-free `npm test` gives the run a check that actually works: without one the unit
  // category fails at baseline, no acceptance criterion can be evidenced, and the swarm rightly
  // refuses to deliver.
  setUpScratchRepo({
    repoPath: scratchRepo,
    readme: '# scratch repo for the political-swarm delivery-boundary smoke test\n',
    packageJson: {
      name: 'delivery-smoke-scratch',
      version: '1.0.0',
      private: true,
      scripts: { test: 'node test.js' },
    },
    testFile: "console.log('no tests yet');\n",
  });

  const engine = buildEngine(id);
  const checks: Check[] = [];

  const run = await engine.startRun({
    task: {
      goal: 'Add an isEven function with a unit test. Do not touch anything else in the repo.',
      acceptanceCriteria: [
        'A function isEven(n) exists that returns true for even integers and false for odd integers',
        'A unit test file exercises isEven for at least one even and one odd number',
      ],
      repoPath: scratchRepo,
      baseBranch: 'main',
    },
    strategy: id,
    budgetUsd: RUN_BUDGET_USD,
  });
  log(`run started: ${run.runId}`);

  // --- 1. The swarm finishes its own work and stops short of completion -----------------------
  const first = await waitUntilSettled(engine, run.runId);
  log(`first settle: ${first.status}${first.lastError ? ` (${first.lastError})` : ''}`);
  checks.push(['run reached awaiting_acceptance, not completed', first.status === 'awaiting_acceptance']);

  if (first.status !== 'awaiting_acceptance') {
    log('Cannot exercise the boundary without a delivery packet — stopping here.');
    process.exit(reportChecks('delivery-smoke', checks) ? 0 : 1);
  }

  const delivery = await swarmGetDelivery(engine, { runId: run.runId });
  const packet = delivery.delivery!;
  log(`delivery: ${packet.changedFiles.length} file(s), ${packet.findings.length} finding(s)`);
  checks.push(
    ['a delivery packet is available to Claude', delivery.delivery !== undefined],
    ['the packet traces every user acceptance criterion', packet.requirementMatrix.length >= packet.acceptanceCriteria.length],
    ['the packet records a baseline taken before any editing', packet.baseline.length > 0],
    ['the packet records checks on the integrated tree', packet.finalChecks.length > 0],
    ['integration was reported by a non-implementer', packet.integrationEvidence.integratorId.length > 0],
    [
      'verification was performed by a different agent than integration',
      packet.independentVerification.verifierId !== packet.integrationEvidence.integratorId,
    ],
    ['every finding carries a disposition rationale', packet.findings.every((f) => f.dispositionRationale.trim().length > 0)],
    ['the packet states a rollback path', packet.rollback.trim().length > 0],
    ['the doctrine recorded its own acceptance decision', packet.doctrineAcceptance.procedure.length > 0],
  );

  // --- 2. Apply is refused before Claude's independent check ----------------------------------
  let applyRefused = false;
  try {
    await swarmApply(engine, runsRootDir, { runId: run.runId });
  } catch (err) {
    applyRefused = String(err).includes('not "completed"');
  }
  checks.push(['swarm_apply refuses a run Claude has not accepted', applyRefused]);

  // --- 3. An empty rejection is refused --------------------------------------------------------
  let emptyRejectionRefused = false;
  try {
    await swarmRemediate(engine, { runId: run.runId, findings: [] as never });
  } catch (err) {
    emptyRejectionRefused = String(err).length > 0;
  }
  checks.push(['a rejection carrying no defect is refused', emptyRejectionRefused]);

  // --- 4. Claude rejects; the SAME swarm reworks it ---------------------------------------------
  const remediation = await swarmRemediate(engine, {
    runId: run.runId,
    findings: [
      {
        summary: 'The unit test does not cover a negative even number, so the criterion is only partly evidenced.',
        evidence: 'The delivered test file exercises no negative input.',
        severity: 'medium',
      },
    ],
  });
  log(`remediation cycle ${remediation.cycle}, reopened: ${remediation.reopenedTaskIds.join(', ') || '(all)'}`);
  checks.push(['rejection opened a remediation cycle', remediation.cycle === 1]);

  const second = await waitUntilSettled(engine, run.runId);
  log(`second settle: ${second.status}${second.lastError ? ` (${second.lastError})` : ''}`);
  checks.push(
    ['the same swarm produced a second delivery', second.status === 'awaiting_acceptance'],
    ['the run records the remediation cycle', (second.remediationCycles ?? 0) === 1],
    ['the second packet knows it followed a remediation', (second.delivery?.remediationCycles ?? 0) === 1],
  );

  if (second.status !== 'awaiting_acceptance') {
    process.exit(reportChecks('delivery-smoke', checks) ? 0 : 1);
  }

  // --- 5. Claude accepts; only now may the change reach the real repository ---------------------
  const accepted = await swarmAccept(engine, { runId: run.runId, note: 'smoke test: boundary exercised' });
  checks.push(['acceptance completes the run', accepted.status === 'completed']);

  const applied = await swarmApply(engine, runsRootDir, { runId: run.runId });
  checks.push(
    ['swarm_apply succeeds once acceptance is recorded', applied.applied],
    ['files reached the real repository', applied.appliedFiles.length > 0],
  );

  const final = engine.getRunStore().load(run.runId)!;
  log(`cost: $${final.costUsd.toFixed(4)} across ${final.workerCalls} worker call(s)`);

  process.exit(reportChecks('delivery-smoke', checks) ? 0 : 1);
}

main().catch((err) => {
  log(`FATAL: ${String(err)}`);
  process.exit(1);
});
