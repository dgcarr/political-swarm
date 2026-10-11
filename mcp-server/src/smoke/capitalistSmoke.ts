// Standalone smoke test for CapitalistStrategy: exercises SwarmEngine + RepoWorktree + Ledger +
// BudgetGuard end to end against a scratch repo, driving the real task-exchange (planner ->
// bidder x N -> implementer -> reviewer -> regulator -> decide) against REAL OpenRouter models.
// This makes real, metered API calls (kept small via a tight budgetUsd) — a valid
// OPENROUTER_API_KEY must be present in political-swarm/.env. Modeled closely on
// src/smoke/engineSmoke.ts (NoopStrategy-only) and src/smoke/mcpSmoke.ts (MCP transport); this
// one instantiates SwarmEngine directly, without going through the MCP protocol layer.
//
// Run with (after `npm run build`):
//   node dist/smoke/capitalistSmoke.js
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

import { OpenRouterClient } from '../engine/OpenRouterClient.js';
import { SwarmEngine } from '../engine/SwarmEngine.js';
import { latestVerdict } from '../engine/TaskGraph.js';
import { CapitalistStrategy } from '../strategies/capitalist/CapitalistStrategy.js';
import { loadBudgetConfig, loadModelsConfig, loadStrategiesConfig } from '../util/config.js';
import type { CapitalAccount } from '../strategies/capitalist/types.js';
import {
  buildNoopStrategies,
  endedWithARecordedReason as recordedReason,
  log as createLog,
  reportChecks,
  setUpScratchRepo,
  waitForTerminal,
} from './harness.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(__dirname, '../../..'); // dist/smoke -> dist -> mcp-server -> plugin root
const configDir = path.join(pluginRoot, 'config');
const runsRootDir = path.join(pluginRoot, 'runs', 'capitalist-smoke');

const scratchRepoRoot = process.env.SWARM_SMOKE_SCRATCH_DIR ?? path.join(os.tmpdir(), 'swarm-capitalist-smoke-repo');
const RUN_TIMEOUT_MS = 120_000;
// Scenario 2 does strictly more than scenario 1 — due diligence goes out before the plan, the goal
// carries several acceptance criteria so the planner decomposes it, and a firm may engage a
// subcontractor. On top of that every model failure costs two corrective retries against each of two
// models. 120s is not a budget it can be expected to meet, and a timeout aborts the whole script
// rather than failing one check.
const MARKET_TIMEOUT_MS = 420_000;
const TERMINAL_POLL_INTERVAL_MS = 500;
const RUN_BUDGET_USD = 0.3;
const INITIAL_CAPITAL = 100;

const log = createLog('capitalist-smoke');

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

function getDiffStat(worktreePath: string): { filesChanged: string[]; diffText: string } {
  execFileSync('git', ['add', '-A'], { cwd: worktreePath, stdio: 'pipe' });
  const diffText = execFileSync('git', ['diff', '--cached'], { cwd: worktreePath }).toString('utf8');
  const nameStatus = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: worktreePath }).toString('utf8');
  const filesChanged = nameStatus.split('\n').filter(Boolean);
  return { diffText, filesChanged };
}

async function main(): Promise<void> {
  dotenv.config({ path: path.join(pluginRoot, '.env') });

  log(`Plugin root: ${pluginRoot}`);
  log(`Setting up scratch repo at: ${scratchRepoRoot}`);
  // A dependency-free baseline test gives cheap implementers a real `npm test` without install.
  setUpScratchRepo({
    repoPath: scratchRepoRoot,
    readme: '# scratch repo for political-swarm capitalist smoke test\n',
    packageJson: {
      name: 'capitalist-smoke-scratch',
      version: '1.0.0',
      private: true,
      scripts: { test: 'node test.js' },
    },
    testFile: "console.log('no tests yet');\n",
  });
  if (existsSync(runsRootDir)) rmSync(runsRootDir, { recursive: true, force: true });

  const client = new OpenRouterClient(process.env.OPENROUTER_API_KEY ?? '');
  const modelsConfig = loadModelsConfig(configDir);
  const budgetConfig = loadBudgetConfig(configDir);
  const strategiesConfig = loadStrategiesConfig(configDir);

  const strategies = buildNoopStrategies({ capitalist: new CapitalistStrategy() });

  const engine = new SwarmEngine({ client, modelsConfig, configDir, budgetConfig, strategiesConfig, runsRootDir, strategies });

  const run = await engine.startRun({
    task: {
      goal: 'add an isEven function with a unit test',
      acceptanceCriteria: [
        'index.js exports a function isEven(n) that returns true for even integers and false for odd integers',
        'test.js contains a unit test for isEven covering at least one even and one odd number, and exits with a non-zero code if any assertion fails',
      ],
      repoPath: scratchRepoRoot,
      baseBranch: 'main',
    },
    strategy: 'capitalist',
    budgetUsd: RUN_BUDGET_USD,
  });
  log(`Started run ${run.runId}, worktree at ${run.worktreePath}`);

  await waitForTerminal(engine, run.runId, {
    timeoutMs: RUN_TIMEOUT_MS,
    pollIntervalMs: TERMINAL_POLL_INTERVAL_MS,
  });
  const finalState = engine.getRunStore().load(run.runId)!;
  log(`Final status: ${finalState.status}`);
  log(`Cost: $${finalState.costUsd.toFixed(4)} of $${finalState.budgetUsd.toFixed(2)} budget, ${finalState.workerCalls} worker calls`);

  if (finalState.graph) {
    for (const id of finalState.graph.order) {
      const n = finalState.graph.nodes[id];
      log(`  node ${id}: phase=${n.phase} verdict=${latestVerdict(n) ?? 'pending'} riskClass=${n.riskClass} targetGlobs=[${n.targetGlobs.join(', ')}]`);
    }
  }

  const { filesChanged, diffText } = getDiffStat(finalState.worktreePath);
  log(`Diff touches ${filesChanged.length} file(s): ${filesChanged.join(', ')}`);

  const strategyState = (finalState.strategyState ?? {}) as { capitalAccounts?: Record<string, CapitalAccount> };
  const accounts = strategyState.capitalAccounts ?? {};
  const accountEntries = Object.entries(accounts);
  for (const [personaId, acct] of accountEntries) {
    log(
      `  account ${personaId}: capital=${acct.capital.toFixed(2)} reputation=${acct.reputationScore.toFixed(
        2,
      )} defects=${acct.defects} cleanTasksInARow=${acct.cleanTasksInARow} heldEscrow=${acct.heldEscrow.toFixed(
        2,
      )} bankrupt=${acct.bankrupt}`,
    );
  }
  const hasCapitalDelta = accountEntries.some(
    ([, a]) => a.capital !== INITIAL_CAPITAL || a.heldEscrow > 0 || a.cleanTasksInARow > 0 || a.defects > 0,
  );

  const checks: [string, boolean][] = [
    ['run reached a sensible resting status (awaiting_acceptance, or paused_human if genuinely high-risk)', finalState.status === 'awaiting_acceptance' || finalState.status === 'paused_human'],
    ['run reached awaiting_acceptance (this trivial task should not be classified high-risk)', finalState.status === 'awaiting_acceptance'],
    ['escrow released under the regulatory safety floor', finalState.delivery?.doctrineAcceptance.accepted === true],
    ['an independent contractual assessor reported', finalState.delivery?.independentVerification.verifierId === 'contractual-assessor'],
    ['a diff was produced in the isolated worktree', filesChanged.length > 0 && diffText.length > 0],
    ['ledger.jsonl was written', existsSync(path.join(runsRootDir, run.runId, 'ledger.jsonl'))],
    ['at least one capital account was created', accountEntries.length > 0],
    ['capital accounts show a real delta (payout, escrow, or defect recorded)', hasCapitalDelta],
    ['run cost stayed within budget', finalState.costUsd <= finalState.budgetUsd],
  ];

  // ---- Scenario 2: the market, exercised ----
  // A goal touching several disciplines, so due diligence has something to find, the planner
  // produces more than one listing, and there is something for a firm to subcontract. What is
  // asserted is that the institutions section 6 names actually fire on a real run rather than only
  // in unit tests — deliberately NOT that the delivery was accepted, since the regulator may refuse
  // under the safety floor and a refusal is a valid outcome of a market that works.
  const marketRepo = path.join(os.tmpdir(), 'swarm-capitalist-smoke-repo-market');
  setUpScratchRepo({
    repoPath: marketRepo,
    readme: '# scratch repo for political-swarm capitalist smoke test\n',
    packageJson: {
      name: 'capitalist-smoke-scratch',
      version: '1.0.0',
      private: true,
      scripts: { test: 'node test.js' },
    },
    testFile: "console.log('no tests yet');\n",
  });

  const marketRun = await engine.startRun({
    task: {
      goal:
        'Add a documented input-validation helper used by a backend API route, with unit tests for the helper ' +
        'and a short section in the README describing it.',
      acceptanceCriteria: [
        'A validation helper rejects malformed input and accepts well-formed input',
        'A backend route uses the helper',
        'Unit tests cover both the accepting and the rejecting case',
        'The README documents the helper',
      ],
      repoPath: marketRepo,
      baseBranch: 'main',
    },
    strategy: 'capitalist',
    budgetUsd: RUN_BUDGET_USD,
  });
  log(`[market] started run ${marketRun.runId}`);
  await waitForTerminal(engine, marketRun.runId, {
    timeoutMs: MARKET_TIMEOUT_MS,
    pollIntervalMs: TERMINAL_POLL_INTERVAL_MS,
  });
  const marketState = engine.getRunStore().load(marketRun.runId)!;
  log(`[market] final status: ${marketState.status} (cost=$${marketState.costUsd.toFixed(4)})`);
  if (marketState.lastError) log(`[market] lastError: ${marketState.lastError}`);

  const marketLedger = readLedger(marketRun.runId);
  const has = (type: string): boolean => marketLedger.some((e) => e.type === type);
  const marketDelivered = marketState.delivery !== undefined;
  const settledAContract = has('contract_settled');
  // Asked of the run's own terminal state rather than reconstructed from which events happened to
  // fire. The first attempt guessed at a set of ledger events and missed the commonest ending of
  // all — the swarm rejecting its task under its own rules, which records `task_decided` and
  // `terminated_incomplete` and none of the events that predicate looked for. The rule now lives in
  // the shared harness, where it is unit-tested against every ending rather than against whichever
  // one a nondeterministic run happens to reach.
  const endedWithARecordedReason = recordedReason(marketState.status, marketState.lastError);

  checks.push(
    // Every check below reads the ledger, which exists whether or not a delivery was assembled. The
    // packet assertions do not, so they are asked separately rather than passing vacuously.
    ['scenario 2 never claims completion it has not earned', marketState.status !== 'completed'],
    ['scenario 2 surveyed the ground before anything was listed', has('diligence_completed')],
    [
      'scenario 2 due diligence really preceded the plan, rather than merely being recorded',
      marketLedger.findIndex((e) => e.type === 'diligence_completed') <
        marketLedger.findIndex((e) => e.type === 'plan_source'),
    ],
    ['scenario 2 published listings carrying their contract shape', has('listing_published')],
    [
      'scenario 2 chose a contract shape rather than defaulting every listing to one',
      marketLedger.some((e) => e.type === 'listing_published' && typeof e.data.contractType === 'string'),
    ],
    ['scenario 2 awarded on arithmetic a losing bidder could read', marketLedger.some((e) => e.type === 'listing_awarded' && !!e.data.terms)],
    // Settlement is conditional on the run reaching it, and it legitimately may not. A high-risk
    // listing opens a human spend approval and pauses under article 12, which is the doctrine
    // working rather than failing — observed on a real run, where these three checks failed on a
    // market that had behaved correctly. So each asserts an implication: IF a contract settled,
    // its consumption is priced, its profit recorded and its levy taken. The branch for a run that
    // settled nothing still has teeth — it must say why it stopped instead of passing on silence.
    [
      'scenario 2 priced what it consumed, wherever a contract actually settled',
      settledAContract ? has('resources_priced') : endedWithARecordedReason,
    ],
    [
      'scenario 2 settled on profit and loss rather than the contract price alone, where it settled',
      settledAContract
        ? marketLedger.some((e) => e.type === 'contract_settled' && e.data.profit !== undefined)
        : endedWithARecordedReason,
    ],
    [
      'scenario 2 collected the levy that funds the commons, where a contract settled',
      settledAContract ? has('levy_collected') : endedWithARecordedReason,
    ],
    // The report is filed at the end of disposeFindings(), which only runs once the task loop is
    // through — so it is asserted against reaching the barriers, not against the run existing.
    [
      'scenario 2 filed a market report wherever it reached the acceptance barriers',
      marketDelivered ? has('market_report') : endedWithARecordedReason,
    ],
    [
      'scenario 2 either delivered with the market report carried into the packet, or ended with a reason and no packet',
      marketState.status === 'awaiting_acceptance'
        ? marketDelivered &&
          has('constitutional_gate') &&
          (marketState.delivery!.limitations.length > 0 || marketState.delivery!.residualRisks.length > 0)
        : !marketDelivered,
    ],
    ['scenario 2 stayed within budget', marketState.costUsd <= marketState.budgetUsd],
  );

  const ok = reportChecks('capitalist-smoke', checks);

  if (!ok) {
    process.exitCode = 1;
    return;
  }
  log('All checks passed.');
}

main().catch((err) => {
  process.stderr.write(`[capitalist-smoke] FATAL: ${String(err?.stack ?? err)}\n`);
  process.exitCode = 1;
});
