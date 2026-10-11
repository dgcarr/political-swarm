// Standalone smoke test for SocialistStrategy: exercises SwarmEngine + SocialistStrategy end to
// end against two scratch repos, using REAL OpenRouter calls (an OPENROUTER_API_KEY must be
// configured in political-swarm/.env). Modeled closely on engineSmoke.ts (NoopStrategy, no real
// API calls) and mcpSmoke.ts (polling pattern) but instantiates SwarmEngine directly rather than
// going through the MCP protocol layer, and drives SocialistStrategy specifically.
//
// Scenario 1 ("single guild"): a small, single-domain task. Asserts the run completes and that
// the ledger shows NO 'coordinator' persona worker_call — single-guild nodes must federally
// finalize their own assignment without an arbitration call.
//
// Scenario 2 ("cross guild"): a task that explicitly spans the frontend and backend domains.
// Asserts the run completes and that the ledger DOES show a 'coordinator' persona worker_call —
// cross-guild nodes must trigger exactly one coordinator arbitration.
//
// Scenario 3 ("federation"): a multi-discipline goal, asserting that the institutions section 6
// names actually fire on a real run rather than only in unit tests — councils go out and publish
// before the plan exists, councils form around the units of production, need is measured,
// subsidiarity is recorded, and the run files a commons report the delivery packet can still read.
// Deliberately does not assert acceptance: the councils may refuse under their own rules, and a
// refusal is a valid outcome. What is asserted is that the machinery ran.
//
// Run with (after `npm run build`):
//   node dist/smoke/socialistSmoke.js
import { existsSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

import { OpenRouterClient } from '../engine/OpenRouterClient.js';
import { SwarmEngine } from '../engine/SwarmEngine.js';
import { SocialistStrategy } from '../strategies/socialist/SocialistStrategy.js';
import { loadBudgetConfig, loadModelsConfig, loadStrategiesConfig } from '../util/config.js';
import type { TaskSpec } from '../engine/types.js';
import { buildNoopStrategies, log as createLog, reportChecks, setUpScratchRepo, waitForTerminal } from './harness.js';
import type { RunState } from '../engine/RunStore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(__dirname, '../../..'); // dist/smoke -> dist -> mcp-server -> plugin root
const configDir = path.join(pluginRoot, 'config');
// Deliberately OUTSIDE the repo's runs/ dir: other strategies' agents are building/smoke-testing
// concurrently in this same checkout, and a shared runs/ root risks a sibling process's cleanup
// step deleting this run's ledger mid-flight (observed as a spurious ENOENT on ledger.jsonl).
const runsRootDir = path.join(os.tmpdir(), 'swarm-socialist-smoke-runs');
// Raised for the acceptance barriers: after the task loop each run still has an integration
// report, an independent peer verification and a ledger-disposition sitting to get through.
const RUN_TIMEOUT_MS = 240_000;
// Scenario 3 does strictly more than the other two — reconnaissance goes out before the plan, and
// the goal carries four acceptance criteria, so the planner decomposes it into several nodes. On top
// of that, every model failure costs two corrective retries against each of two models, and the
// pinned models are unreliable enough that this happens most runs. 240s is not a budget it can be
// expected to meet, and a timeout aborts the whole script rather than failing one check.
const FEDERATION_TIMEOUT_MS = 420_000;
const TERMINAL_POLL_INTERVAL_MS = 500;
const RUN_BUDGET_USD = 0.3;

const log = createLog('socialist-smoke');

interface LedgerEntry {
  ts: string;
  runId: string;
  type: string;
  data: Record<string, unknown>;
}

function readLedger(runId: string): LedgerEntry[] {
  const p = path.join(runsRootDir, runId, 'ledger.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as LedgerEntry);
}

function hasCoordinatorCall(ledger: LedgerEntry[]): boolean {
  return ledger.some((e) => e.type === 'worker_call' && e.data.personaId === 'coordinator');
}

async function runScenario(
  engine: SwarmEngine,
  label: string,
  task: TaskSpec,
  budgetUsd: number,
  timeoutMs = RUN_TIMEOUT_MS,
): Promise<{ status: string; ledger: LedgerEntry[]; coordinatorCalled: boolean; runId: string; delivery: RunState['delivery'] }> {
  const run = await engine.startRun({ task, strategy: 'socialist', budgetUsd });
  log(`[${label}] started run ${run.runId}, worktree at ${run.worktreePath}`);

  await waitForTerminal(engine, run.runId, {
    timeoutMs,
    pollIntervalMs: TERMINAL_POLL_INTERVAL_MS,
  });
  const finalState = engine.getRunStore().load(run.runId)!;
  log(`[${label}] final status: ${finalState.status} (cost=$${finalState.costUsd.toFixed(4)}, workerCalls=${finalState.workerCalls})`);
  if (finalState.lastError) log(`[${label}] lastError: ${finalState.lastError}`);

  const ledger = readLedger(run.runId);
  const coordinatorCalled = hasCoordinatorCall(ledger);
  const personaCalls = ledger
    .filter((e) => e.type === 'worker_call')
    .map((e) => `${e.data.role}:${e.data.personaId ?? '(none)'}`);
  log(`[${label}] worker calls: ${personaCalls.join(', ') || '(none)'}`);

  return { status: finalState.status, ledger, coordinatorCalled, runId: run.runId, delivery: finalState.delivery };
}

async function main(): Promise<void> {
  dotenv.config({ path: path.join(pluginRoot, '.env') });

  log(`Plugin root: ${pluginRoot}`);
  if (existsSync(runsRootDir)) rmSync(runsRootDir, { recursive: true, force: true });

  const client = new OpenRouterClient(process.env.OPENROUTER_API_KEY ?? '');
  const modelsConfig = loadModelsConfig(configDir);
  const budgetConfig = loadBudgetConfig(configDir);
  const strategiesConfig = loadStrategiesConfig(configDir);

  const strategies = buildNoopStrategies({ socialist: new SocialistStrategy() });

  const engine = new SwarmEngine({ client, modelsConfig, configDir, budgetConfig, strategiesConfig, runsRootDir, strategies });

  // ---- Scenario 1: single-guild task ----
  const repo1 = path.join(os.tmpdir(), 'swarm-socialist-smoke-repo-single');
  // A dependency-free `npm test` gives the run a check that actually works: without one the unit
  // category fails at baseline, no acceptance criterion can be evidenced, and the swarm rightly
  // refuses to deliver.
  setUpScratchRepo({
    repoPath: repo1,
    readme: '# scratch repo for political-swarm socialist smoke test\n',
    packageJson: {
      name: 'socialist-smoke-scratch',
      version: '1.0.0',
      private: true,
      scripts: { test: 'node test.js' },
    },
    testFile: "console.log('no tests yet');\n",
  });
  const scenario1 = await runScenario(
    engine,
    'single-guild',
    {
      goal: 'Add an isEven function with a unit test. Do not touch anything else in the repo.',
      acceptanceCriteria: [
        'A function named isEven exists that returns true for even integers and false for odd integers',
        'A unit test file exercises isEven for at least one even and one odd input',
      ],
      repoPath: repo1,
      baseBranch: 'main',
    },
    RUN_BUDGET_USD,
  );

  // ---- Scenario 2: cross-guild task ----
  const repo2 = path.join(os.tmpdir(), 'swarm-socialist-smoke-repo-cross');
  setUpScratchRepo({
    repoPath: repo2,
    readme: '# scratch repo for political-swarm socialist smoke test\n',
    packageJson: {
      name: 'socialist-smoke-scratch',
      version: '1.0.0',
      private: true,
      scripts: { test: 'node test.js' },
    },
    testFile: "console.log('no tests yet');\n",
  });
  const scenario2 = await runScenario(
    engine,
    'cross-guild',
    {
      goal:
        'Implement, as a single cohesive task, both a frontend contact form UI component AND a separate backend API endpoint ' +
        'that receives the form submissions, plus tests for both the frontend component and the backend endpoint.',
      acceptanceCriteria: [
        'A frontend UI component/file implements a contact form',
        'A backend API endpoint/file receives and handles contact form submissions',
        'Tests exist covering both the frontend component and the backend endpoint',
      ],
      repoPath: repo2,
      baseBranch: 'main',
    },
    RUN_BUDGET_USD,
  );

  // ---- Scenario 3: the federation, exercised ----
  // A goal that touches several disciplines, so reconnaissance goes out, councils form around more
  // than one unit of production, and there is something for a coordinating council to coordinate.
  const repo3 = path.join(os.tmpdir(), 'swarm-socialist-smoke-repo-federation');
  setUpScratchRepo({
    repoPath: repo3,
    readme: '# scratch repo for political-swarm socialist smoke test\n',
    packageJson: {
      name: 'socialist-smoke-scratch',
      version: '1.0.0',
      private: true,
      scripts: { test: 'node test.js' },
    },
    testFile: "console.log('no tests yet');\n",
  });
  const scenario3 = await runScenario(
    engine,
    'federation',
    {
      goal:
        'Add a documented input-validation helper used by a backend API route, with unit tests for the ' +
        'helper and a short section in the README describing it.',
      acceptanceCriteria: [
        'A validation helper rejects malformed input and accepts well-formed input',
        'A backend route uses the helper',
        'Unit tests cover both the accepting and the rejecting case',
        'The README documents the helper',
      ],
      repoPath: repo3,
      baseBranch: 'main',
    },
    RUN_BUDGET_USD,
    FEDERATION_TIMEOUT_MS,
  );

  const federationLedger = scenario3.ledger;
  const has = (type: string): boolean => federationLedger.some((e) => e.type === type);
  const scenario3Delivered = scenario3.delivery !== undefined;

  const checks: [string, boolean][] = [
    ['scenario 1 (single-guild) run reached awaiting_acceptance status', scenario1.status === 'awaiting_acceptance'],
    ['scenario 1 assembled a delivery packet', scenario1.delivery !== undefined],
    ['scenario 1 was verified by an independent peer', scenario1.delivery?.independentVerification.verifierId === 'peer-verifier'],
    ['scenario 1 (single-guild) ledger has NO coordinator worker_call', !scenario1.coordinatorCalled],
    // Deliberately not "reached awaiting_acceptance": the councils may reject the work under their
    // own rules, and a rejected task must end the run incomplete rather than be reported as done.
    // (Before the acceptance barriers existed this assertion read `status === 'completed'`, which
    // a fully rejected graph satisfied — the exact conflation section 5 forbids.)
    // The councils may approve, reject, or escalate to a human under their own rules — all three
    // are valid. What is never valid is reporting completion the swarm did not reach and Claude
    // did not check, so that is what this asserts.
    ['scenario 2 (cross-guild) never claims completion it has not earned', scenario2.status !== 'completed'],
    [
      'scenario 2 either delivered through the integration council, or ended incomplete with a reason',
      scenario2.status === 'awaiting_acceptance'
        ? scenario2.delivery?.integrationEvidence.integratorId === 'integration-council'
        : scenario2.delivery === undefined,
    ],
    ['scenario 2 (cross-guild) ledger DOES have a coordinator worker_call', scenario2.coordinatorCalled],

    // ---- Scenario 3: the institutions section 6 names have to actually fire ----
    ['scenario 3 (federation) never claims completion it has not earned', scenario3.status !== 'completed'],
    // Every check below reads the ledger, which exists whether or not a delivery was assembled —
    // but the packet assertions do not, so that one is asked separately rather than being allowed
    // to pass vacuously over an absent packet.
    ['scenario 3 sent councils out to inspect before the plan was written', has('reconnaissance_published')],
    [
      'scenario 3 reconnaissance really preceded the plan, rather than merely being recorded',
      federationLedger.findIndex((e) => e.type === 'reconnaissance_published') <
        federationLedger.findIndex((e) => e.type === 'plan_source'),
    ],
    ['scenario 3 formed worker councils and seated a coordinating council', has('councils_constituted')],
    ['scenario 3 measured what each unit of work needed', has('needs_assessed')],
    ['scenario 3 recorded where each allocation was decided', has('subsidiarity_applied')],
    [
      'scenario 3 let at least one council settle its own work without escalating',
      federationLedger.some((e) => e.type === 'subsidiarity_applied' && e.data.escalated === false),
    ],
    // The barrier stages only happen if the run reaches them, and it may legitimately not: the
    // councils escalate a repeatedly-rejected node to a human, which pauses the run with no packet.
    // Asserting a packet outright would be asserting an outcome the doctrine never promised — the
    // same conflation scenario 2's check above already avoids. So the assertion is conditional on
    // the ending, and the branch for a run that did NOT deliver still has teeth: it requires the
    // absence of a packet, so a delivered-but-broken run cannot slip through the else.
    [
      'scenario 3 either delivered with a commons report the packet carries, or ended with a reason and no packet',
      scenario3.status === 'awaiting_acceptance'
        ? scenario3Delivered &&
          has('commons_report') &&
          has('constitutional_gate') &&
          (scenario3.delivery!.limitations.length > 0 || scenario3.delivery!.residualRisks.length > 0)
        : !scenario3Delivered,
    ],
    [
      'scenario 3 recorded why it stopped, whichever way it ended',
      scenario3.status === 'awaiting_acceptance'
        ? has('council_acceptance')
        : has('approval_opened') || federationLedger.some((e) => e.type === 'task_error'),
    ],
  ];

  const ok = reportChecks('socialist-smoke', checks);

  if (!ok) {
    process.exitCode = 1;
    return;
  }
  log('All checks passed.');
}

main().catch((err) => {
  process.stderr.write(`[socialist-smoke] FATAL: ${String(err?.stack ?? err)}\n`);
  process.exitCode = 1;
});
