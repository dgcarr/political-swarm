// DemocraticStrategy smoke test: instantiates SwarmEngine directly (no MCP protocol layer) and
// drives three real scenarios against real OpenRouter models, closely modeled on
// mcp-server/src/smoke/engineSmoke.ts (direct-engine pattern) and mcp-server/src/smoke/mcpSmoke.ts
// (scratch-repo setup). Run with `npm run smoke:democratic`, which spends real money.
//
//   1. a routine low-risk motion, which should reach assent with nobody asked to rule;
//   2. a security-boundary motion, which must stop for a human whatever the vote said;
//   3. a multi-motion programme, which is what convenes the second chamber and gives the
//      constituencies something to divide on.
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

import { OpenRouterClient } from '../engine/OpenRouterClient.js';
import { SwarmEngine } from '../engine/SwarmEngine.js';
import { latestVerdict } from '../engine/TaskGraph.js';
import { DemocraticStrategy } from '../strategies/democratic/DemocraticStrategy.js';
import { loadBudgetConfig, loadModelsConfig, loadStrategiesConfig } from '../util/config.js';
import { buildNoopStrategies, log as createLog, reportChecks, setUpScratchRepo, waitForTerminal } from './harness.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(__dirname, '../../..'); // dist/smoke -> dist -> mcp-server -> plugin root
const configDir = path.join(pluginRoot, 'config');
const runsRootDir = path.join(pluginRoot, 'runs', 'smoke-democratic');

const scratchRepoRoutine = process.env.SWARM_SMOKE_DEM_ROUTINE_DIR ?? path.join(os.tmpdir(), 'swarm-smoke-democratic-routine');
const scratchRepoSecurity = process.env.SWARM_SMOKE_DEM_SECURITY_DIR ?? path.join(os.tmpdir(), 'swarm-smoke-democratic-security');
const scratchRepoChamber = process.env.SWARM_SMOKE_DEM_CHAMBER_DIR ?? path.join(os.tmpdir(), 'swarm-smoke-democratic-chamber');
// Matches socialistSmoke's corrected figure: the current roster's primary (space-bunny-alpha)
// measured 300s+ on large-output calls, and scenario 1 alone (a routine single-task run, no vote
// ceremony) already used ~108 of a 120s budget in a real run — scenario 2's security-boundary vote
// threshold does strictly more institutional calls on top of that and timed out outright.
const RUN_TIMEOUT_MS = 240_000;
const TERMINAL_POLL_INTERVAL_MS = 500;
const RUN_BUDGET_USD = 0.3;

const log = createLog('dem-smoke');

function buildEngine(): SwarmEngine {
  const client = new OpenRouterClient(process.env.OPENROUTER_API_KEY ?? '');
  const modelsConfig = loadModelsConfig(configDir);
  const budgetConfig = loadBudgetConfig(configDir);
  const strategiesConfig = loadStrategiesConfig(configDir);

  const strategies = buildNoopStrategies({ democratic: new DemocraticStrategy() });

  return new SwarmEngine({ client, modelsConfig, configDir, budgetConfig, strategiesConfig, runsRootDir, strategies });
}

async function runRoutineScenario(): Promise<boolean> {
  log('--- Scenario 1: routine, low-risk task (should reach "completed" with no human approval) ---');
  // A dependency-free `npm test` gives the run a check that actually works: without one the unit
  // category fails at baseline, no acceptance criterion can be evidenced, and the swarm rightly
  // refuses to deliver.
  setUpScratchRepo({
    repoPath: scratchRepoRoutine,
    readme: '# scratch repo for political-swarm democratic strategy smoke test\n',
    packageJson: {
      name: 'democratic-smoke-scratch',
      version: '1.0.0',
      private: true,
      scripts: { test: 'node test.js' },
    },
    testFile: "console.log('no tests yet');\n",
  });
  const engine = buildEngine();

  const run = await engine.startRun({
    task: {
      goal: 'add an isEven function with a unit test',
      acceptanceCriteria: [
        'A function isEven(n) exists that returns true for even integers and false for odd integers',
        'A unit test file exists that exercises isEven for at least one even and one odd number',
      ],
      repoPath: scratchRepoRoutine,
      baseBranch: 'main',
    },
    strategy: 'democratic',
    budgetUsd: RUN_BUDGET_USD,
  });
  log(`Started run ${run.runId}`);

  const finalState = await waitForTerminal(engine, run.runId, {
    timeoutMs: RUN_TIMEOUT_MS,
    pollIntervalMs: TERMINAL_POLL_INTERVAL_MS,
    result: 'state',
  });
  log(`Final status: ${finalState.status}, costUsd=${finalState.costUsd.toFixed(4)}, workerCalls=${finalState.workerCalls}`);
  if (finalState.graph) {
    for (const id of finalState.graph.order) {
      const n = finalState.graph.nodes[id];
      log(`  node ${id}: phase=${n.phase} verdict=${latestVerdict(n) ?? 'pending'} riskClass=${n.riskClass} targetGlobs=${n.targetGlobs.join(',')}`);
    }
  }
  const voteThresholdApprovals = finalState.pendingApprovals.filter((a) => a.kind === 'vote_threshold');

  const checks: [string, boolean][] = [
    // The swarm's own assent leaves the run at awaiting_acceptance, not completed: section 5
    // reserves completion for a delivery Claude has independently checked.
    ['run reached awaiting_acceptance status', finalState.status === 'awaiting_acceptance'],
    ['a delivery packet was assembled', finalState.delivery !== undefined],
    ['the constitutional gate granted assent', finalState.delivery?.doctrineAcceptance.accepted === true],
    ['the Integration Committee reported on the combined tree', finalState.delivery?.integrationEvidence.integratorId === 'integration-committee'],
    ['a verifier outside the authorship chain reported', finalState.delivery?.independentVerification.verifierId === 'commons-verifier'],
    ['every finding carries a disposition', (finalState.delivery?.findings ?? []).every((f) => f.dispositionRationale.trim().length > 0)],
    ['no vote_threshold approvals were opened for a routine/low-risk task', voteThresholdApprovals.length === 0],
    ['run cost stayed within budget', finalState.costUsd <= finalState.budgetUsd],
    ['ledger.jsonl was written', existsSync(path.join(runsRootDir, run.runId, 'ledger.jsonl'))],
  ];
  const ok = reportChecks('dem-smoke', checks);
  if (finalState.status !== 'awaiting_acceptance') {
    log(`lastError: ${finalState.lastError ?? '(none)'}`);
    log(`pendingApprovals: ${JSON.stringify(finalState.pendingApprovals, null, 2)}`);
  }
  return ok;
}

async function runSecurityBoundaryScenario(): Promise<boolean> {
  log('--- Scenario 2: touches auth/** (should reach "paused_human" via a vote_threshold approval) ---');
  setUpScratchRepo({
    repoPath: scratchRepoSecurity,
    readme: '# scratch repo for political-swarm democratic strategy smoke test\n',
    packageJson: {
      name: 'democratic-smoke-scratch',
      version: '1.0.0',
      private: true,
      scripts: { test: 'node test.js' },
    },
    testFile: "console.log('no tests yet');\n",
  });
  const engine = buildEngine();

  const run = await engine.startRun({
    task: {
      goal: 'add a login check in auth/login.js',
      acceptanceCriteria: [
        'auth/login.js exports a function that checks a username and password against expected values',
      ],
      repoPath: scratchRepoSecurity,
      baseBranch: 'main',
    },
    strategy: 'democratic',
    budgetUsd: RUN_BUDGET_USD,
  });
  log(`Started run ${run.runId}`);

  const finalState = await waitForTerminal(engine, run.runId, {
    timeoutMs: RUN_TIMEOUT_MS,
    pollIntervalMs: TERMINAL_POLL_INTERVAL_MS,
    result: 'state',
  });
  log(`Final status: ${finalState.status}, costUsd=${finalState.costUsd.toFixed(4)}, workerCalls=${finalState.workerCalls}`);
  if (finalState.graph) {
    for (const id of finalState.graph.order) {
      const n = finalState.graph.nodes[id];
      log(`  node ${id}: phase=${n.phase} verdict=${latestVerdict(n) ?? 'pending'} riskClass=${n.riskClass} targetGlobs=${n.targetGlobs.join(',')}`);
    }
  }
  const unresolvedVoteThresholdApprovals = finalState.pendingApprovals.filter(
    (a) => a.kind === 'vote_threshold' && !a.resolvedAt,
  );

  const checks: [string, boolean][] = [
    ['run reached paused_human status', finalState.status === 'paused_human'],
    ['at least one unresolved vote_threshold approval was opened', unresolvedVoteThresholdApprovals.length > 0],
    [
      'the security-touching node was classified high risk',
      finalState.graph ? Object.values(finalState.graph.nodes).some((n) => n.riskClass === 'high') : false,
    ],
    ['ledger.jsonl was written', existsSync(path.join(runsRootDir, run.runId, 'ledger.jsonl'))],
  ];
  const ok = reportChecks('dem-smoke', checks);
  log(`pendingApprovals: ${JSON.stringify(finalState.pendingApprovals, null, 2)}`);
  return ok;
}

/**
 * Scenario 3 exercises the institutions the first two never reach: a multi-motion, cross-module
 * programme, which is what convenes the second chamber and gives the constituencies something to
 * divide on. Written to be reachable rather than exhaustive — a real model decides what to draft,
 * so the checks assert that each institution had its chance and recorded what it did, not that it
 * reached a particular verdict.
 */
async function runChamberScenario(): Promise<boolean> {
  log('--- Scenario 3: a multi-motion programme (Speaker, division, second chamber, stage 9) ---');
  setUpScratchRepo({
    repoPath: scratchRepoChamber,
    readme: '# scratch repo for political-swarm democratic strategy smoke test\n',
    packageJson: {
      name: 'democratic-smoke-scratch',
      version: '1.0.0',
      private: true,
      scripts: { test: 'node test.js' },
    },
    testFile: "console.log('no tests yet');\n",
  });
  const engine = buildEngine();

  const run = await engine.startRun({
    task: {
      goal:
        'add a parity module with isEven and isOdd, a separate formatting helper that uses them, ' +
        'and documentation for both in docs/parity.md',
      acceptanceCriteria: [
        'isEven(n) returns true for even integers and false for odd integers',
        'isOdd(n) returns the opposite of isEven for the same input',
        'docs/parity.md documents both functions',
      ],
      repoPath: scratchRepoChamber,
      baseBranch: 'main',
    },
    strategy: 'democratic',
    budgetUsd: RUN_BUDGET_USD,
  });
  log(`Started run ${run.runId}`);

  const finalState = await waitForTerminal(engine, run.runId, {
    timeoutMs: RUN_TIMEOUT_MS,
    pollIntervalMs: TERMINAL_POLL_INTERVAL_MS,
    result: 'state',
  });
  log(`Final status: ${finalState.status}, costUsd=${finalState.costUsd.toFixed(4)}, workerCalls=${finalState.workerCalls}`);

  const ledgerPath = path.join(runsRootDir, run.runId, 'ledger.jsonl');
  const entries = existsSync(ledgerPath)
    ? readFileSync(ledgerPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { type: string; data: Record<string, unknown> })
    : [];
  const seen = (type: string) => entries.filter((e) => e.type === type);
  const divisions = seen('division_recorded');

  for (const type of [...new Set(entries.map((e) => e.type))].sort()) {
    log(`  ledger: ${type} x${seen(type).length}`);
  }

  const checks: [string, boolean][] = [
    ['the offices were constituted before any motion was drafted', (() => {
      const offices = entries.findIndex((e) => e.type === 'offices_constituted');
      const drafted = entries.findIndex((e) => e.type === 'motions_drafted');
      return offices >= 0 && drafted >= 0 && offices < drafted;
    })()],
    ['the Speaker ruled on every drafted motion', seen('speaker_ruling').length > 0],
    ['the Chair and the Prime Coordinator are different agents', (() => {
      const constituted = seen('offices_constituted')[0]?.data ?? {};
      return Boolean(constituted.speaker) && constituted.speaker !== constituted.primeCoordinator;
    })()],
    ['the House divided on every motion that reached a vote', divisions.length === seen('vote_computed').length],
    [
      'constituencies that could not inspect a motion abstained rather than voting',
      divisions.some((e) => Number(e.data.abstentions) > 0),
    ],
    ['the executive reported to the House at stage 9', seen('accountability_report').length === 1],
    [
      'the guardian preserved the charter with the delivery',
      seen('reserve_power_exercised').some((e) => e.data.power === 'preserve-charter'),
    ],
    // The delivery has to exist before anything can be asserted about it. Without this the two
    // checks below read `delivery?.findings ?? []` and pass on an empty array — so a run that died
    // at a barrier and produced no delivery at all reported a clean sweep. A smoke test that goes
    // green on nothing is worse than no smoke test.
    ['a delivery packet was assembled', finalState.delivery !== undefined],
    [
      'every finding carries a disposition',
      finalState.delivery !== undefined &&
        finalState.delivery.findings.every((f) => f.dispositionRationale.trim().length > 0),
    ],
    [
      'any dissent on a carried motion reached the delivery as a minority report',
      finalState.delivery !== undefined &&
        finalState.delivery.findings.filter((f) => f.minority).length === finalState.delivery.minorityReports.length,
    ],
    ['run cost stayed within budget', finalState.costUsd <= finalState.budgetUsd],
  ];

  const ok = reportChecks('dem-smoke', checks);
  log(`Final status: ${finalState.status}${finalState.lastError ? ` — ${finalState.lastError}` : ''}`);
  if (finalState.delivery) {
    log(`minorityReports: ${finalState.delivery.minorityReports.length}`);
    log(`limitations: ${JSON.stringify(finalState.delivery.limitations, null, 2)}`);
  }
  if (!ok) log(`lastError: ${finalState.lastError ?? '(none)'}`);
  return ok;
}

async function main(): Promise<void> {
  dotenv.config({ path: path.join(pluginRoot, '.env') });
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY is not set — check political-swarm/.env');
  }

  log(`Plugin root: ${pluginRoot}`);
  if (existsSync(runsRootDir)) rmSync(runsRootDir, { recursive: true, force: true });

  const routineOk = await runRoutineScenario();
  const securityOk = await runSecurityBoundaryScenario();
  const chamberOk = await runChamberScenario();

  const ok = routineOk && securityOk && chamberOk;
  log(`\nScenario 1 (routine): ${routineOk ? 'PASS' : 'FAIL'}`);
  log(`Scenario 2 (security boundary): ${securityOk ? 'PASS' : 'FAIL'}`);
  log(`Scenario 3 (chambers and accountability): ${chamberOk ? 'PASS' : 'FAIL'}`);

  if (!ok) {
    process.exitCode = 1;
    return;
  }
  log('All checks passed.');
}

main().catch((err) => {
  process.stderr.write(`[dem-smoke] FATAL: ${String(err?.stack ?? err)}\n`);
  process.exitCode = 1;
});
