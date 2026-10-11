// A zero-cost, end-to-end tour of the framework: no API key, no network, about ten seconds.
//
//   npm run example
//
// Part 1 runs the real engine through a whole run — isolated worktree, baseline and per-task
// checks, ledger, delivery packet, Claude's independent acceptance — with the no-op strategy, which
// writes one file instead of asking a model. Part 2 shows the governance machinery the doctrines
// run on: a run adopts its machine-readable constitution, a division is recorded under one of its
// declared rules, a forged result is refused before it reaches the ledger, and the verifier
// replays the record and catches an after-the-fact edit. A doctrine's own institutions (Speaker,
// councils, auctions) need models to deliberate; `npm run smoke:democratic` runs one for real.
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { constitutionFor } from '../constitution/articles.js';
import { Ledger } from '../engine/Ledger.js';
import { OpenRouterClient } from '../engine/OpenRouterClient.js';
import { RunStore, type RunState } from '../engine/RunStore.js';
import { SwarmEngine } from '../engine/SwarmEngine.js';
import { recordGovernanceDecision, type GovernanceDecision } from '../engine/governance.js';
import { verifyRun } from '../engine/verifyRun.js';
import { buildNoopStrategies, SENTINEL_CHECKED_REPO, setUpScratchRepo, waitForTerminal } from '../smoke/harness.js';
import { loadBudgetConfig, loadChecksConfig, loadModelsConfig, loadStrategiesConfig } from '../util/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(__dirname, '../../..'); // dist/examples -> dist -> mcp-server -> plugin root
const configDir = path.join(pluginRoot, 'config');
const runsRootDir = process.env.SWARM_EXAMPLE_RUNS_DIR ?? path.join(pluginRoot, 'runs', 'examples');
const scratchRepo = process.env.SWARM_EXAMPLE_REPO_DIR ?? path.join(os.tmpdir(), 'swarm-example-repo');

const say = (message = '') => process.stdout.write(`${message}\n`);
const failures: string[] = [];
function expect(label: string, passed: boolean): void {
  say(`  ${passed ? 'ok  ' : 'FAIL'}  ${label}`);
  if (!passed) failures.push(label);
}

async function partOneEngineRun(): Promise<void> {
  say('Part 1 — one run through the engine, start to acceptance');
  setUpScratchRepo({ repoPath: scratchRepo, readme: '# example target repository\n', ...SENTINEL_CHECKED_REPO });
  const strategiesConfig = loadStrategiesConfig(configDir);
  const engine = new SwarmEngine({
    client: new OpenRouterClient('example-no-network-calls'),
    modelsConfig: loadModelsConfig(configDir),
    configDir,
    budgetConfig: loadBudgetConfig(configDir),
    strategiesConfig,
    runsRootDir,
    strategies: buildNoopStrategies(),
  });
  const started = await engine.startRun({
    task: { goal: 'Add SWARM_SENTINEL.md', acceptanceCriteria: ['SWARM_SENTINEL.md exists'], repoPath: scratchRepo, baseBranch: 'main' },
    strategy: 'noop',
  });
  say(`  run ${started.runId}, worktree ${started.worktreePath}`);
  await waitForTerminal(engine, started.runId);
  const awaiting = engine.getRunStore().load(started.runId)!;
  expect(`the swarm submits a delivery packet (status ${awaiting.status})`, awaiting.status === 'awaiting_acceptance' && !!awaiting.delivery);
  expect('the change exists only in the isolated worktree', existsSync(path.join(awaiting.worktreePath, 'SWARM_SENTINEL.md')) &&
    !existsSync(path.join(scratchRepo, 'SWARM_SENTINEL.md')));
  const requiredIds = new Set(loadChecksConfig(configDir).categories.filter((c) => c.required).map((c) => c.id));
  const finalChecks = awaiting.delivery?.finalChecks ?? [];
  const required = finalChecks.filter((check) => requiredIds.has(check.categoryId));
  expect(`the required checks ran against it and passed (${required.map((c) => c.categoryId).join(', ')})`,
    required.length > 0 && required.every((check) => check.ran && check.passed));
  const optional = finalChecks.filter((check) => !requiredIds.has(check.categoryId) && !check.passed);
  if (optional.length) {
    say(`        optional checks that failed are disclosed as limitations, not hidden: ${optional.map((c) => c.categoryId).join(', ')}`);
  }
  const accepted = engine.acceptDelivery(started.runId, 'Checked by the example script.');
  expect('Claude\'s independent acceptance completes the run', accepted.status === 'completed');
  const report = verifyRun(runsRootDir, started.runId);
  expect(`the verifier replays its record: ${report.ledger.entries} hash-chained ledger entries`, report.ok);
  say(`  read it: ${path.join(runsRootDir, started.runId, 'ledger.jsonl')}`);
  say();
}

function partTwoGovernance(): void {
  say('Part 2 — a constitution, a division, a forgery, an audit');
  const strategiesConfig = loadStrategiesConfig(configDir);
  const constitution = constitutionFor('democratic', strategiesConfig)!;
  say(`  the democratic constitution: ${constitution.articles.length} articles, ${Object.keys(constitution.decisionRules).length} decision rules, digest ${constitution.digest.slice(0, 12)}`);

  const runId = `democratic-example-${Date.now().toString(36)}`;
  const runDir = path.join(runsRootDir, runId);
  const store = new RunStore(runsRootDir);
  const ledger = new Ledger(runDir, runId, 'democratic');
  const now = new Date().toISOString();
  const state = {
    runId, strategy: 'democratic', status: 'awaiting_acceptance', createdAt: now, updatedAt: now, costUsd: 0,
    graph: null, pendingApprovals: [], governanceDecisions: [], governanceMandates: [],
    constitution: { digest: constitution.digest, config: constitution.config },
  } as unknown as RunState;
  ledger.record('constitution_adopted', { strategy: 'democratic', digest: constitution.digest, document: constitution });

  const rule = 'two-thirds-of-all-seated-members';
  const seats = ['lord-1', 'lord-2', 'lord-3', 'lord-4', 'lord-5', 'lord-6'];
  const division = (id: string, ayes: number, result: string): GovernanceDecision => ({
    id, body: 'house-of-review', subject: 'motion-1', artifactDigest: 'example', rule,
    eligible: seats,
    positions: seats.map((actor, index) => ({ actor, choice: index < ayes ? 'aye' : 'no' })),
    evidenceRefs: [], result, nextAction: result === 'carried' ? 'proceed' : 'return to the Commons',
  });
  say(`  rule ${rule}: ${constitution.decisionRules[rule]?.description ?? '(not declared)'}`);

  recordGovernanceDecision(state, ledger, division('review-1', 4, 'carried'));
  expect('4 ayes of 6 seats carry the motion and are recorded', state.governanceDecisions!.length === 1);

  let refusal = '';
  try {
    recordGovernanceDecision(state, ledger, division('review-2', 3, 'carried'));
  } catch (error) {
    refusal = error instanceof Error ? error.message : String(error);
  }
  expect('3 ayes of 6 recorded as "carried" are refused before reaching the ledger', refusal.length > 0 && state.governanceDecisions!.length === 1);
  say(`        ${refusal}`);
  store.save(state);

  const clean = verifyRun(runsRootDir, runId);
  expect(`the verifier re-counts every decision under the adopted constitution (${clean.governance.decisions} decision)`, clean.ok);

  // Edit a copy of the record after the fact, the way a tampered audit trail would look.
  const tamperedId = `${runId}-tampered`;
  cpSync(runDir, path.join(runsRootDir, tamperedId), { recursive: true });
  const tamperedLedger = path.join(runsRootDir, tamperedId, 'ledger.jsonl');
  writeFileSync(tamperedLedger, readFileSync(tamperedLedger, 'utf8').replace('"choice":"no"', '"choice":"aye"'));
  const tamperedState = { ...state, runId: tamperedId };
  store.save(tamperedState);
  const caught = verifyRun(runsRootDir, tamperedId);
  expect('an edited ballot in a copy of the ledger fails verification', !caught.ok);
  for (const problem of caught.problems) say(`        ${problem}`);
  rmSync(path.join(runsRootDir, tamperedId), { recursive: true, force: true });
  say();
}

async function main(): Promise<void> {
  await partOneEngineRun();
  partTwoGovernance();
  if (failures.length) {
    say(`${failures.length} step(s) failed.`);
    process.exitCode = 1;
  } else {
    say('Every step behaved as documented. Next: a real doctrine with models — see README "Try a doctrine".');
  }
}

main().catch((error) => {
  process.stderr.write(`[example] ${String(error?.stack ?? error)}\n`);
  process.exitCode = 1;
});
