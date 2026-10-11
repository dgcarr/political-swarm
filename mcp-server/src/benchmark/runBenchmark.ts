// Headless coding-swarm benchmark driver: launches the same task against some/all real strategies
// sequentially by default, using SwarmEngine directly — same direct-engine pattern as
// mcp-server/src/smoke/engineSmoke.ts, no MCP/chat session required. Not wired into
// .mcp.json/commands — this is a benchmarking tool, not part of the distributed plugin surface.
// Run with:
//   npm run benchmark -- --label <name> [--strategies democratic,socialist,capitalist,managerial,single_agent]
//                         [--budget-usd 8] [--trial-index 0] [--concurrent] [--stop-after plan|first-task]
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

import { OpenRouterClient } from '../engine/OpenRouterClient.js';
import { SwarmEngine } from '../engine/SwarmEngine.js';
import type { DecisionMode } from '../engine/WorkerDispatcher.js';
import { RepoWorktree } from '../engine/RepoWorktree.js';
import { Ledger, type LedgerEntry } from '../engine/Ledger.js';
import type { CheckRunRecord } from '../engine/packets.js';
import { loadBudgetConfig, loadModelsConfig, loadStrategiesConfig, normalizeChecksConfig } from '../util/config.js';
import type { PendingApproval, StrategyId } from '../engine/types.js';
import type { RunState } from '../engine/RunStore.js';
import { log as createLog } from '../smoke/harness.js';
import { EventBus } from '../engine/EventBus.js';
import { milestoneFor } from '../strategies/milestones.js';
import { captureEnvironmentInfo } from './environmentInfo.js';
import {
  BenchmarkAllowance,
  decideApproval,
  decideDelivery,
  evaluatorDecisionLedgerData,
  type ApprovalContext,
} from './evaluatorPolicy.js';
import { BENCHMARK_STRATEGIES, buildStrategies, RELEASE_GATE_STRATEGIES } from '../strategies/registry.js';
import { describeRotation, rotatedStrategyOrder } from './runOrder.js';
import { combinedApproval, decideAsSovereign, sovereignDecides, sovereignDecisionGroups } from './sovereign.js';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(__dirname, '../../..'); // dist/benchmark -> dist -> mcp-server -> plugin root
const configDir = path.join(pluginRoot, 'config');

const REAL_STRATEGIES: StrategyId[] = BENCHMARK_STRATEGIES;
// terminated_incomplete included: section 5's third ending (cancellation/resource exhaustion/a
// doctrine's own recorded terminal failure) is a genuine, final outcome to report, not an error.
const TERMINAL = new Set<RunState['status']>([
  'completed',
  'terminated_incomplete',
  'failed',
  'stopped',
  'paused_human',
  'paused_budget',
]);
// Raised from 90 on 2026-09-25: every arm across two full sweeps that failed to finish did so on
// wall-clock exhaustion, never on dollar budget (every arm stayed under $0.03 of an $8 ceiling).
// Democratic needed ~123 minutes just to reach 4 of 7 tasks against the current roster; 90 minutes
// plus its extensions was never enough to let a genuinely converging run actually finish.
const DEFAULT_MAX_WALL_CLOCK_MINUTES = 150;
const DEFAULT_BUDGET_USD = 8;
// Each arm gets its own bounded reserve. A single pool shared by the sweep let whichever arm ran
// first spend the extensions the later arms needed, and a refused extension ends a run.
const DEFAULT_ALLOWANCE_USD = 8;
const DEFAULT_ALLOWANCE_EXTENSIONS = 2;
const POLL_TIMEOUT_BUFFER_MINUTES = 15;
const MILLISECONDS_PER_MINUTE = 60_000;
const MILLISECONDS_PER_SECOND = 1_000;
// Applied to the implementer role only (see buildEngine) — it's the one role whose responses are
// legitimately large (a full engineering package's worth of files), so it keeps the long leash.
// Raised from 300s to 600s with stall detection (BENCHMARK_STALL_TIMEOUT): a silent implementer now
// fails over in a minute, so this ceiling only bounds one that keeps writing.
const DEFAULT_IMPLEMENTER_CALL_TIMEOUT_MS = 600_000;
// Every other role (planner/reviewer/opposition/...) sends smaller prompts than the implementer.
// Discovered the hard way: with a single flat 300s timeout shared by every role, a congested
// shared model (openai/gpt-oss-20b, used by nearly every non-implementer role) could sit silently
// unresolved for the full 5 minutes — twice, on a concurrent 3-strategy run — before falling over
// to its fallback, which then answered in under 2 seconds. A shorter timeout on the cheap roles
// turns that into a fast failover instead of a long stall.
//
// Raised from 60s after that 60s budget — calibrated against gpt-oss-20b, which answers almost
// immediately — killed an entire socialist run outright on a reasoning model. Both z-ai/glm-5.2
// and its deepseek fallback timed out on the *planner*, the run crashed with 0 worker calls, and
// the doctrine produced no result at all. The figure is model-tier dependent, not universal: a
// thinking model spends real time before its first token, and socialist's planner prompt is the
// largest of any doctrine. Keep it well below the implementer's leash so a genuine stall still
// fails over quickly.
//
// Lowered from 180s to 90s on 2026-10-02. In sweep-solar-mini4, inkling-small's reviewer calls came
// back in 1-13s (45 of 61) or in clusters at ~60s, ~120s and ~165s — provider queueing, not longer
// thinking — and its 180s timeouts each cost three minutes before gemini-3.1-flash-lite answered in
// 2-6s. 90s clears the ~60s bucket and fails the stalls over. The planner, which is what forced
// this figure up before, has its own PLANNER_CALL_TIMEOUT_MS.
//
// Raised to 300s on 2026-10-02, when BENCHMARK_STALL_TIMEOUT took over stall detection. Every figure
// above was a wall-clock guess at "stalled", re-tuned per roster; this is now only the ceiling for
// a model that keeps producing tokens.
export const FAST_ROLE_CALL_TIMEOUT_MS = 300_000;
/**
 * Fail over when a model goes silent, whatever the roster.
 *
 * 60s to the first token clears an ordinary queue wait and a reasoning model that streams its
 * thinking; 30s of silence mid-answer is a dead stream, not a slow one. solar-mini4 spent 100-189s
 * on real implementations and streams throughout, so it is never cut off; inkling-small's silent
 * queue waits fail over at 60s instead of at a role ceiling.
 */
export const BENCHMARK_STALL_TIMEOUT = { firstTokenMs: 60_000, betweenTokensMs: 30_000 } as const;
/**
 * The planner is not a fast role, however small its prompt.
 *
 * The tiering above predicts response time from prompt size, which holds for every role except this
 * one: the planner reads a 14KB brief and returns a whole dependency-ordered task graph, so its cost
 * is generation, not input. That mis-filing is why the planner — and only the planner — has forced
 * this budget up twice, first from 60s and then from 180s, each time after it took an entire arm
 * down with it.
 *
 * Measured 2026-09-25 by replaying TASK.md as a real planning request against the live roster:
 * stealth/space-bunny-alpha answered in 339.9s and z-ai/glm-5.3-flash in 179.2s, both with valid
 * graphs. The 180s budget therefore failed the primary outright and cleared the fallback by 800ms,
 * which is how one sweep lost two arms in a row to a role that was working correctly. This is the
 * slowest observation plus headroom, not a round number.
 */
export const PLANNER_CALL_TIMEOUT_MS = 600_000;
const TICKER_INTERVAL_MS = 5_000;
const APPROVAL_SETTLE_DELAY_MS = 1_000;
const RUN_POLL_INTERVAL_MS = 2_000;
const COVERAGE_TIMEOUT_MS = 180_000;
const ORACLE_TIMEOUT_MS = 120_000;
/**
 * How many checks `OracleChecks.run_all` returns. The engine treats any other count as a corrupt
 * evaluation record and refuses the delivery, so a stale value here does not merely misreport a
 * score — it makes acceptance unreachable and every run times out instead. `oracleCheckCount.test.ts`
 * reads the real number out of checks.py so the two cannot drift again.
 */
export const ORACLE_CHECK_COUNT = 12;
// Larger than config/checks.yaml's default 60s unit-test timeout: this task's pytest run covers
// a full engineering package's worth of tests, not a small unit suite.
const PYTEST_CHECK_TIMEOUT_MS = 120_000;
const COVERAGE_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const VENV_SETUP_TIMEOUT_MS = 120_000;
const ERROR_DETAIL_MAX_LENGTH = 300;
const PARSE_ERROR_MAX_LENGTH = 200;
const PERCENT_SCALE = 100;

const log = createLog('benchmark');

const PYTEST_NO_TESTS_IS_A_PASS = 'import sys, pytest; code = pytest.main(); sys.exit(0 if code == 5 else code)';

export function benchmarkVerificationChecks(pythonPath: string): {
  checksConfig: ReturnType<typeof normalizeChecksConfig>;
  finalOnlyChecks: Array<{
    id: string;
    command: string;
    args: string[];
    required: boolean;
    timeoutMs: number;
  }>;
} {
  return {
    checksConfig: normalizeChecksConfig({
      categories: [
        {
          id: 'python-syntax',
          command: pythonPath,
          args: ['-m', 'compileall', '-q', '.'],
          required: true,
          timeoutMs: PYTEST_CHECK_TIMEOUT_MS,
        },
        // The starting repo has no tests, and pytest exits 5 ("no tests collected") on it. Counted
        // as a failing baseline, that made every later pytest failure "pre-existing", so a task
        // that broke the package's own import was never charged with it (2026-10-03 sweep).
        {
          id: 'unit',
          command: pythonPath,
          args: ['-c', PYTEST_NO_TESTS_IS_A_PASS],
          required: true,
          timeoutMs: PYTEST_CHECK_TIMEOUT_MS,
        },
        // The empty package imports at baseline, so the first task to break `import alloydamage`
        // (an __init__ re-exporting a name nothing defines) fails its own check, not the final one.
        {
          id: 'package-import',
          command: pythonPath,
          args: ['-c', 'import alloydamage'],
          required: true,
          timeoutMs: PYTEST_CHECK_TIMEOUT_MS,
        },
      ],
      // What a critic may run before its verdict, so a reviewer can try an edge case the swarm's own
      // tests never exercise (the 2026-10-08 capitalist-luna arm passed review and failed the
      // oracle on a below-range request no reviewer had run). Both run in a scratch copy.
      reviewCommands: [
        {
          id: 'alloydamage',
          description:
            'python -m alloydamage <args>: run the package CLI, e.g. ["calculate", "examples/304L.yaml", "--points", "5"]',
          command: pythonPath,
          args: ['-m', 'alloydamage'],
          timeoutMs: PYTEST_CHECK_TIMEOUT_MS,
        },
        // A critic's most direct probe is calling the code it is judging. The 2026-10-08
        // capitalist-reviewcmd arm's nuclear-data reviewer tried exactly this through the CLI
        // command, twice. The snippet is model-written code, the same trust as the swarm's tests.
        {
          id: 'python',
          description:
            'python -c <code>: run a Python snippet against the package, e.g. ["from alloydamage import composition; print(composition.__all__)"]',
          command: pythonPath,
          args: ['-c'],
          timeoutMs: PYTEST_CHECK_TIMEOUT_MS,
          maxArgChars: 4_000,
        },
        {
          id: 'pytest',
          description: 'python -m pytest -q <args>: run chosen tests, e.g. ["tests/test_damage.py", "-k", "interpolat"]',
          command: pythonPath,
          args: ['-m', 'pytest', '-q', '-p', 'no:cacheprovider'],
          timeoutMs: PYTEST_CHECK_TIMEOUT_MS,
        },
      ],
      // The evaluator refuses manual evidence headless (evaluatorPolicy.ts), so the test mandate
      // is told so up front. Before this, 8 of 10 arms in the 2026-10-04 run mapped a criterion to
      // manual inspection at run start and could never be accepted, whatever they built.
      manualEvidenceAccepted: false,
    }),
    finalOnlyChecks: [
      {
        id: 'benchmark-import',
        command: pythonPath,
        args: ['-c', 'import alloydamage; import alloydamage.cli'],
        required: true,
        timeoutMs: PYTEST_CHECK_TIMEOUT_MS,
      },
      {
        id: 'benchmark-cli',
        command: pythonPath,
        args: ['-m', 'alloydamage', 'calculate', 'examples/304L.yaml'],
        required: true,
        timeoutMs: PYTEST_CHECK_TIMEOUT_MS,
      },
    ],
  };
}

export interface Args {
  label: string;
  strategies: StrategyId[];
  budgetUsd: number;
  repoPath: string;
  maxWallClockMinutes: number;
  pollTimeoutMs: number;
  /** Timeout for the implementer role only — every other role uses FAST_ROLE_CALL_TIMEOUT_MS. */
  implementerCallTimeoutMs: number;
  /** Which bounded decisions consult a decision model first. Recorded in the manifest, because
   * sweeps run under different modes are not comparable. */
  decisionModels: DecisionMode;
  /** Bug-hunting: stop each arm once it reaches this stage instead of running it to the end. */
  stopAfter?: StopAfter;
  concurrent: boolean;
  trialIndex: number;
  allowanceUsd: number;
  allowanceExtensions: number;
  resumeDir?: string;
}

export function parseArgs(argv: readonly string[] = process.argv.slice(2)): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const label = get('--label');
  const resumeDir = get('--resume');
  if (!label && !resumeDir) throw new Error('Usage: --label <name> or --resume <results-dir> is required');

  const strategiesArg = get('--strategies');
  const strategies = strategiesArg
    ? (strategiesArg.split(',').map((s) => s.trim()) as StrategyId[])
    : REAL_STRATEGIES;
  for (const s of strategies) {
    if (!REAL_STRATEGIES.includes(s)) throw new Error(`Unknown strategy "${s}", expected one of ${REAL_STRATEGIES.join(',')}`);
  }

  const maxWallClockMinutes = Number(get('--max-wall-clock-min') ?? DEFAULT_MAX_WALL_CLOCK_MINUTES);
  const decisionModels = (get('--decision-models') ?? 'pure') as DecisionMode;
  if (!['off', 'pure'].includes(decisionModels)) {
    throw new Error(`Unknown --decision-models "${decisionModels}", expected off or pure (explain was removed 2026-10-04)`);
  }

  const stopAfter = get('--stop-after') as StopAfter | undefined;
  if (stopAfter !== undefined && !STOP_AFTER_STAGES.includes(stopAfter)) {
    throw new Error(`Unknown --stop-after "${stopAfter}", expected ${STOP_AFTER_STAGES.join(' or ')}`);
  }

  return {
    label: label ?? 'resumed',
    strategies,
    budgetUsd: Number(get('--budget-usd') ?? DEFAULT_BUDGET_USD),
    repoPath: path.resolve(get('--repo') ?? path.join(pluginRoot, 'benchmark', 'starting-repo')),
    maxWallClockMinutes,
    // Default must exceed maxWallClockMinutes, otherwise the harness's own poll timeout fires
    // (and reports a false harness_error) before the engine's wall-clock guard ever gets a
    // chance to pause a run that's still legitimately within its budget.
    pollTimeoutMs: Number(
      get('--poll-timeout-ms') ?? (maxWallClockMinutes + POLL_TIMEOUT_BUFFER_MINUTES) * MILLISECONDS_PER_MINUTE,
    ),
    implementerCallTimeoutMs: Number(get('--call-timeout-ms') ?? DEFAULT_IMPLEMENTER_CALL_TIMEOUT_MS),
    decisionModels,
    ...(stopAfter ? { stopAfter } : {}),
    concurrent: argv.includes('--concurrent'),
    trialIndex: Number(get('--trial-index') ?? 0),
    allowanceUsd: Number(get('--allowance-usd') ?? DEFAULT_ALLOWANCE_USD),
    allowanceExtensions: Number(get('--allowance-extensions') ?? DEFAULT_ALLOWANCE_EXTENSIONS),
    ...(resumeDir ? { resumeDir: path.resolve(resumeDir) } : {}),
  };
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2), 'utf8');
  renameSync(temporary, filePath);
}

/** benchmark/starting-repo is plain tracked files in the main political-swarm repo (no nested
 * .git — that would only show up as an opaque submodule gitlink to the outer repo). swarm_start
 * needs a real git repo to fork worktrees from, so each invocation copies the source into a
 * disposable scratch repo under runs/ (gitignored) and git-inits it fresh — same idea as
 * setUpScratchRepo in mcp-server/src/smoke/engineSmoke.ts, just seeded from starting-repo's
 * content instead of a bare README. */
function prepareScratchRepo(sourceDir: string, scratchDir: string): string {
  if (!existsSync(sourceDir)) throw new Error(`Starting repo source not found at ${sourceDir}`);
  if (existsSync(scratchDir)) rmSync(scratchDir, { recursive: true, force: true });
  mkdirSync(scratchDir, { recursive: true });
  cpSync(sourceDir, scratchDir, { recursive: true, filter: (p) => !p.includes(`${path.sep}.pytest_cache`) });

  const git = (args: string[]) => execFileSync('git', args, { cwd: scratchDir, stdio: 'pipe' });
  git(['init', '-q']);
  git(['config', 'user.email', 'swarm-benchmark@example.com']);
  git(['config', 'user.name', 'Swarm Benchmark']);
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'Benchmark starting point']);
  git(['branch', '-M', 'main']);
  return scratchDir;
}

/** The system python is externally managed (PEP 668, Debian/Ubuntu) and has no pytest-cov, and
 * installing it system-wide would need sudo and change every project's python — a venv scoped to
 * benchmark/ needs neither and is trivially reproducible. Provisioned once and reused across
 * runs; rebuilt automatically when requirements.txt changes (tracked via a hash file alongside
 * the venv), so an edited requirements.txt can't silently leave a stale, under-installed venv
 * behind — every benchmark task's verification gate depends on it having every listed package. */
async function ensureBenchmarkPython(): Promise<string> {
  const venvDir = path.join(pluginRoot, 'benchmark', '.venv');
  const venvPython = path.join(venvDir, 'bin', 'python');
  const requirementsPath = path.join(pluginRoot, 'benchmark', 'requirements.txt');
  const requirementsHash = createHash('sha256').update(readFileSync(requirementsPath)).digest('hex');
  const hashMarkerPath = path.join(venvDir, '.requirements-hash');

  if (existsSync(venvPython) && existsSync(hashMarkerPath) && readFileSync(hashMarkerPath, 'utf8') === requirementsHash) {
    return venvPython;
  }

  if (existsSync(venvDir)) rmSync(venvDir, { recursive: true, force: true });
  log(`Provisioning benchmark venv at ${venvDir} from ${requirementsPath}...`);
  await execFileAsync('python3', ['-m', 'venv', venvDir], { timeout: VENV_SETUP_TIMEOUT_MS });
  await execFileAsync(venvPython, ['-m', 'pip', 'install', '--quiet', '-r', requirementsPath], {
    timeout: VENV_SETUP_TIMEOUT_MS,
  });
  writeFileSync(hashMarkerPath, requirementsHash, 'utf8');
  return venvPython;
}

/**
 * The worktree diff while an approval is pending, or undefined when it cannot be read. Staged
 * first, as RepoWorktree.diff() does, so files the swarm created appear alongside edits.
 */
async function worktreeDiff(worktreePath: string): Promise<string | undefined> {
  try {
    await execFileAsync('git', ['add', '-A'], { cwd: worktreePath });
    const { stdout } = await execFileAsync('git', ['diff', '--cached'], {
      cwd: worktreePath,
      maxBuffer: 32 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return undefined;
  }
}

function buildEngine(
  runsRootDir: string,
  budgetMaxWallClockMinutes: number,
  implementerCallTimeoutMs: number,
  pythonPath: string,
  decisionModels: DecisionMode = 'pure',
  bus?: EventBus,
): SwarmEngine {
  const client = new OpenRouterClient(process.env.OPENROUTER_API_KEY ?? '');
  const modelsConfig = loadModelsConfig(configDir);
  const budgetConfig = loadBudgetConfig(configDir);
  // Overrides are in-memory only — never touch the checked-in config/budget.yaml, so the
  // plugin's normal interactive defaults are unaffected by this benchmark run. The 30-minute
  // wall clock is tuned for small interactive tasks, not a full engineering package. Benchmark
  // calls stream and fail over once the model goes silent; the per-role limits below only bound
  // a model that keeps producing tokens.
  budgetConfig.defaults.maxWallClockMinutes = budgetMaxWallClockMinutes;
  budgetConfig.defaults.perCallTimeoutMs = FAST_ROLE_CALL_TIMEOUT_MS;
  budgetConfig.defaults.perCallTimeoutMsByRole = {
    implementer: implementerCallTimeoutMs,
    planner: PLANNER_CALL_TIMEOUT_MS,
  };
  budgetConfig.defaults.stallTimeout = { ...BENCHMARK_STALL_TIMEOUT };
  const strategiesConfig = loadStrategiesConfig(configDir);
  // Override, never mutate config/checks.yaml on disk. Syntax validation belongs in the per-task
  // barrier so malformed Python is rejected while its owning task can still repair it; package
  // import and the literal required CLI remain final-only checks of the assembled product.
  const { checksConfig, finalOnlyChecks } = benchmarkVerificationChecks(pythonPath);

  const strategies = buildStrategies();

  return new SwarmEngine({
    client,
    modelsConfig,
    configDir,
    budgetConfig,
    strategiesConfig,
    checksConfig,
    runsRootDir,
    strategies,
    finalOnlyChecks,
    isolateKnowledgePerRun: true,
    decisionModels,
    bus,
    externalEvaluator: async (worktreePath) => {
      const oracle = await measureOracle(worktreePath, pythonPath);
      return oracle.results ?? [{
        id: 'oracle-unavailable',
        description: 'Independent benchmark oracle execution',
        passed: false,
        detail: oracle.detail,
      }];
    },
    requiredExternalEvaluationCount: ORACLE_CHECK_COUNT,
  });
}

function nodeCounts(state: RunState): { done: number; total: number } {
  if (!state.graph) return { done: 0, total: 0 };
  const nodes = Object.values(state.graph.nodes);
  const done = nodes.filter((node) => node.phase === 'settled' || node.phase === 'abandoned').length;
  return { done, total: nodes.length };
}

export const STOP_AFTER_STAGES = ['plan', 'first-task'] as const;
export type StopAfter = (typeof STOP_AFTER_STAGES)[number];

/** `plan`: the plan exists, so formation and ratification are behind the arm. `first-task`: one
 * task has settled or been abandoned, so implement, review and decide have each run once. */
export function reachedStage(state: RunState, stage: StopAfter): boolean {
  const { done, total } = nodeCounts(state);
  return stage === 'plan' ? total > 0 : done >= 1;
}

/** One-line ticker so a long headless run isn't silent for 90 minutes — printed on its own
 * interval (5s) rather than piggybacking the 2s poll, so log volume stays readable even during
 * concurrent stress runs. */
function tickerLine(strategy: StrategyId, state: RunState, elapsedMs: number): string {
  const { done, total } = nodeCounts(state);
  const elapsedS = Math.round(elapsedMs / MILLISECONDS_PER_SECOND);
  return `[${strategy}] ${elapsedS}s status=${state.status} tasks=${done}/${total || '?'} costUsd=${state.costUsd.toFixed(4)}/${state.budgetUsd.toFixed(2)} calls=${state.workerCalls}`;
}

interface AutoResolveOptions {
  engine: SwarmEngine;
  stopAfter?: StopAfter;
  strategy: StrategyId;
  runId: string;
  pollTimeoutMs: number;
  allowance: BenchmarkAllowance;
  perRunUsdIncrement: number;
}

interface ApprovalResolutionPlan {
  context: ApprovalContext;
  modifiedBudgetUsd?: number;
}

interface BuildApprovalResolutionPlanOptions {
  approval: PendingApproval;
  state: Pick<RunState, 'budgetUsd' | 'deadlineAt'>;
  allowance: BenchmarkAllowance;
  perRunUsdIncrement: number;
  independentChecks?: readonly CheckRunRecord[];
}

/**
 * Reconstructs the check results the engine executed for a task, newest first.
 *
 * decideFinalDiff fails closed without them, and nothing was supplying them, so every task that
 * reached needs_human was auto-rejected and abandoned on the spot however good its work was —
 * three tasks across two doctrines died this way in one sweep. These records are independent in
 * the sense the policy needs: the engine runs the checks itself and writes what they returned, so
 * no model reports its own grade.
 */
export function latestIndependentChecks(entries: readonly LedgerEntry[], taskId: string): CheckRunRecord[] {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]!;
    if (entry.type !== 'verification_result') continue;
    const data = entry.data as { taskId?: string; categories?: unknown; incompleteCategories?: unknown };
    if (data.taskId !== taskId || !Array.isArray(data.categories)) continue;
    const incompleteCategories = new Set(
      Array.isArray(data.incompleteCategories)
        ? data.incompleteCategories.filter((category): category is string => typeof category === 'string')
        : [],
    );
    return (data.categories as Array<Record<string, unknown>>).map((category) => ({
      categoryId: String(category.id ?? ''),
      command: '',
      args: [],
      ran: category.ran === true,
      passed: category.passed === true,
      ...(typeof category.skippedReason === 'string' ? { skippedReason: category.skippedReason } : {}),
      ...(category.failedAtBaseline === true || incompleteCategories.has(String(category.id ?? ''))
        ? { failedAtBaseline: true }
        : {}),
    }));
  }
  return [];
}

export function buildApprovalResolutionPlan({
  approval,
  state,
  allowance,
  perRunUsdIncrement,
  independentChecks,
}: BuildApprovalResolutionPlanOptions): ApprovalResolutionPlan {
  if (approval.kind === 'final_diff') return { context: { allowance, independentChecks } };
  if (approval.kind === 'wall_clock_extension') {
    return { context: { allowance, currentDeadlineAt: state.deadlineAt } };
  }
  if (approval.kind !== 'budget_increase') return { context: { allowance } };
  return {
    context: { allowance, budgetIncreaseUsd: perRunUsdIncrement },
    modifiedBudgetUsd: state.budgetUsd + perRunUsdIncrement,
  };
}

async function autoResolveUntilTerminal({
  engine,
  stopAfter,
  strategy,
  runId,
  pollTimeoutMs,
  allowance,
  perRunUsdIncrement,
}: AutoResolveOptions): Promise<RunState> {
  const start = Date.now();
  let pollDeadlineAt = start + pollTimeoutMs;
  let lastTick = 0;
  const evaluatorLedger = new Ledger(path.join(pluginRoot, 'runs', 'benchmark', runId), runId, strategy);
  for (;;) {
    const state = engine.getRunStore().load(runId);
    if (!state) throw new Error(`Run ${runId} disappeared from RunStore`);

    if (state.status === 'awaiting_acceptance') {
      if (!state.delivery) throw new Error(`Run ${runId} is awaiting acceptance without a delivery packet`);
      const decision = decideDelivery(state.delivery);
      evaluatorLedger.record('external_evaluator_decision', evaluatorDecisionLedgerData(decision));
      log(`  [${runId}] evaluator decision for delivery: ${decision.decision}`);
      if (decision.accept) {
        engine.acceptDelivery(runId);
      } else if (decision.reasons.length > 0) {
        await engine.submitRemediation(
          runId,
          decision.reasons.map((reason) => ({
            summary: reason,
            evidence: 'Neutral benchmark evaluator policy',
            severity: 'high' as const,
          })),
        );
      } else {
        throw new Error(`Evaluator rejected delivery for run ${runId} without remediation findings`);
      }
      continue;
    }

    const now = Date.now();
    if (now - lastTick >= TICKER_INTERVAL_MS) {
      log(tickerLine(strategy, state, now - start));
      lastTick = now;
    }

    if (stopAfter && !TERMINAL.has(state.status) && reachedStage(state, stopAfter)) {
      log(`[${strategy}] reached stage "${stopAfter}", stopping the arm (--stop-after)`);
      return engine.stopRun(runId, `Benchmark --stop-after ${stopAfter}: stage reached`);
    }

    if (TERMINAL.has(state.status)) {
      const unresolved = state.pendingApprovals.filter((a) => !a.resolvedAt);
      if (unresolved.length === 0) return state;

      for (const group of sovereignDecisionGroups(unresolved)) {
        const approval = combinedApproval(group);
        const resolutionPlan = buildApprovalResolutionPlan({
          approval,
          state,
          allowance,
          perRunUsdIncrement,
          ...(approval.taskId
            ? { independentChecks: latestIndependentChecks(evaluatorLedger.readAll(), approval.taskId) }
            : {}),
        });
        const fixed = decideApproval(approval, resolutionPlan.context);
        // Escalations the doctrine reserves above its government go to the sovereign, the user's
        // own Claude model; budget and wall-clock extensions stay on the arm's fixed allowance.
        let decision = fixed;
        let engineNote = fixed.note;
        if (sovereignDecides(approval.kind)) {
          const outcome = await decideAsSovereign(
            {
              approval,
              goal: state.task.goal,
              acceptanceCriteria: state.task.acceptanceCriteria,
              independentChecks: resolutionPlan.context.independentChecks,
              diffText: await worktreeDiff(state.worktreePath),
            },
            fixed,
          );
          decision = outcome.decision;
          engineNote = outcome.engineNote;
          evaluatorLedger.record('sovereign_decision', {
            approvalId: approval.id,
            kind: approval.kind,
            groupedApprovalIds: group.map((a) => a.id),
            decidedBy: outcome.decidedBy,
            decision: decision.decision,
            model: outcome.model ?? '',
            costUsd: outcome.costUsd ?? 0,
            error: outcome.error ?? '',
          });
        }
        for (const member of group) {
          evaluatorLedger.record('external_evaluator_decision', evaluatorDecisionLedgerData({ ...decision, approvalId: member.id }));
          log(`  [${runId}] evaluator ${decision.decision} for pending "${member.kind}": ${member.description}`);
          engine.resolveApproval(
            runId,
            member.id,
            decision.decision,
            engineNote,
            decision.decision === 'approve' && member.kind === 'budget_increase'
              ? resolutionPlan.modifiedBudgetUsd
              : undefined,
          );
        }
        if (decision.decision === 'approve' && approval.kind === 'wall_clock_extension') {
          // The engine deadline and harness deadline must advance together. Otherwise an approved
          // 15-minute engine extension is immediately undercut by the harness's original fixed
          // poll ceiling, which records a false harness_error and abandons a recoverable run.
          pollDeadlineAt += 15 * MILLISECONDS_PER_MINUTE;
        }
      }
      // give the resumed loop a moment to either finish or re-pause before re-checking
      await new Promise((r) => setTimeout(r, APPROVAL_SETTLE_DELAY_MS));
      const after = engine.getRunStore().load(runId)!;
      if (after.status === state.status && after.pendingApprovals.every((a) => a.resolvedAt)) {
        // resolution didn't change status (e.g. still over hard ceiling) — genuinely stuck, stop.
        return after;
      }
    }

    if (Date.now() > pollDeadlineAt) {
      throw new Error(`Run ${runId} did not reach a stable terminal status within ${pollTimeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, RUN_POLL_INTERVAL_MS));
  }
}

const BENCHMARK_DIFF_EXCLUDES = ['**/__pycache__/**', '**/.pytest_cache/**', '**/*.pyc'];

function copyDirExcludingGit(src: string, dest: string, excludeGenerated = false): void {
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, { recursive: true, filter: (p) => {
    if (p.includes(`${path.sep}.git${path.sep}`) || p.endsWith(`${path.sep}.git`)) return false;
    if (!excludeGenerated) return true;
    const name = path.basename(p);
    return name !== '__pycache__' && name !== '.pytest_cache' && !name.endsWith('.pyc');
  } });
}

function copyCheckArtifacts(runDir: string, outDir: string): void {
  const src = path.join(runDir, 'check-artifacts');
  if (existsSync(src)) copyDirExcludingGit(src, path.join(outDir, 'check-artifacts'));
}

interface CoverageResult {
  /** Percent of statements covered, or null when it could not be measured. */
  percent: number | null;
  /** How it was measured, or why it could not be — never leave a null unexplained. */
  detail: string;
}

export interface ModelUsageMetrics {
  fallbackCount: number;
  retryCount: number;
  timeoutCount: number;
  /** Calls that threw, so their spend is real but absent from costUsd. */
  unmeteredCalls: number;
  /** Calls priced from models.yaml because the provider reported no cost. */
  estimatedCostCalls: number;
  providersUsed: string[];
  /** Calls abandoned because the model went silent, a subset of timeoutCount. */
  stalledCount: number;
  /** Decision-model calls (WorkerDispatcher.decide), whose answer stood on its own or not. */
  decisionCalls: number;
  decisionsAccepted: number;
  /** Decisions that were not decisive and went on to the chat call. */
  decisionsEscalated: number;
  decisionFailures: number;
}

export interface PhaseUsageMetrics {
  engineering: { calls: number; unmeteredCalls: number; durationMs: number; costUsd: number };
  institutional: { calls: number; unmeteredCalls: number; durationMs: number; costUsd: number };
}

/** Causal mechanism activations, kept separate from output quality and institutional call cost. */
export interface MechanismUsageMetrics {
  decisions: number;
  mandatesGranted: number;
  mandatesRevoked: number;
  planRatifications: number;
  councilMemberBallots: number;
  minorityAmendmentsConsidered: number;
  minorityAmendmentsReworked: number;
  resourceTopUps: number;
  publicGoodGrants: number;
  ventureExperiments: number;
  ventureFindings: number;
  creditRepayments: number;
  warrantyClaims: number;
  deadlineBreaches: number;
}

export function aggregateMechanismUsage(entries: readonly Pick<LedgerEntry, 'type' | 'data'>[]): MechanismUsageMetrics {
  const count = (type: string): number => entries.filter((entry) => entry.type === type).length;
  const seenCouncilBallots = new Set<string>();
  let councilMemberBallots = 0;
  for (const entry of entries.filter((item) => item.type === 'council_member_ballots')) {
    const { taskId, planDigest, council, ballots } = entry.data;
    const key = typeof taskId === 'string' && typeof planDigest === 'string' && typeof council === 'string'
      ? `${taskId}:${planDigest}:${council}` : undefined;
    if (key && seenCouncilBallots.has(key)) continue;
    if (key) seenCouncilBallots.add(key);
    councilMemberBallots += Array.isArray(ballots) ? ballots.length : 0;
  }
  return {
    decisions: count('governance_decision'),
    mandatesGranted: count('governance_mandate_granted'),
    mandatesRevoked: count('governance_mandate_revoked'),
    planRatifications: entries.filter((entry) => entry.type === 'governance_decision' &&
      (entry.data.rule === 'delegated-council-ratification-v1' ||
        entry.data.rule === 'member-council-ratification-v1') && entry.data.result === 'approve').length,
    councilMemberBallots,
    minorityAmendmentsConsidered: count('minority_amendment_considered'),
    minorityAmendmentsReworked: entries.filter((entry) => entry.type === 'minority_amendment_considered' &&
      entry.data.adoptedForRework === true).length,
    resourceTopUps: count('resource_envelope_topped_up'),
    publicGoodGrants: count('public_good_granted') - count('public_good_grant_reversed'),
    ventureExperiments: count('venture_experiment_commissioned') - count('venture_experiment_reversed'),
    ventureFindings: count('venture_findings_published'),
    creditRepayments: count('credit_repaid'),
    warrantyClaims: count('claim_paid'),
    deadlineBreaches: count('contract_deadline_breached'),
  };
}

export function aggregatePhaseUsage(ledgerEntries: readonly Pick<LedgerEntry, 'type' | 'data'>[]): PhaseUsageMetrics {
  const usage: PhaseUsageMetrics = {
    engineering: { calls: 0, unmeteredCalls: 0, durationMs: 0, costUsd: 0 },
    institutional: { calls: 0, unmeteredCalls: 0, durationMs: 0, costUsd: 0 },
  };
  for (const entry of ledgerEntries) {
    if (entry.type !== 'worker_call' && entry.type !== 'worker_call_unmetered') continue;
    const phase = entry.data.phase === 'institutional' ? 'institutional' : 'engineering';
    usage[phase].calls += 1;
    if (entry.type === 'worker_call_unmetered') usage[phase].unmeteredCalls += 1;
    usage[phase].durationMs += typeof entry.data.durationMs === 'number' ? entry.data.durationMs : 0;
    usage[phase].costUsd += typeof entry.data.costUsd === 'number' ? entry.data.costUsd : 0;
  }
  return usage;
}

export interface SovereignUsageMetrics {
  /** Consultations the sovereign answered for this arm. */
  calls: number;
  /** Decisions left to the fixed policy because the sovereign could not answer. */
  fallbacks: number;
  /** Reported cost of the answered consultations. Not in `costUsd`: it is harness spend, not the swarm's. */
  costUsd: number;
}

/** Per-arm sovereign usage, so arms that escalate more are not compared as if their help were free. */
export function aggregateSovereignUsage(ledgerEntries: readonly Pick<LedgerEntry, 'type' | 'data'>[]): SovereignUsageMetrics {
  const usage: SovereignUsageMetrics = { calls: 0, fallbacks: 0, costUsd: 0 };
  for (const entry of ledgerEntries) {
    if (entry.type !== 'sovereign_decision') continue;
    if (entry.data.decidedBy !== 'sovereign') {
      usage.fallbacks += 1;
      continue;
    }
    usage.calls += 1;
    usage.costUsd += typeof entry.data.costUsd === 'number' ? entry.data.costUsd : 0;
  }
  return usage;
}

export function aggregateModelUsage(
  ledgerEntries: readonly Pick<LedgerEntry, 'type' | 'data'>[],
): ModelUsageMetrics {
  const workerCalls = ledgerEntries.filter((entry) => entry.type === 'worker_call');
  // A call that threw never produced a `worker_call` entry, so counting timeouts among the
  // successes reported zero while a trial was losing 54 calls to them.
  const unmetered = ledgerEntries.filter((entry) => entry.type === 'worker_call_unmetered');
  const providers = new Set<string>();
  let fallbackCount = 0;
  let retryCount = 0;
  let timeoutCount = unmetered.filter((entry) => entry.data.timedOut === true).length;
  let estimatedCostCalls = 0;

  for (const entry of workerCalls) {
    if (typeof entry.data.fallbackIndex === 'number' && entry.data.fallbackIndex > 0) fallbackCount += 1;
    if (typeof entry.data.networkRetries === 'number' && Number.isFinite(entry.data.networkRetries)) {
      retryCount += entry.data.networkRetries;
    }
    if (entry.data.timedOut === true) timeoutCount += 1;
    if (entry.data.costMetered === false) estimatedCostCalls += 1;
    if (typeof entry.data.provider === 'string') providers.add(entry.data.provider);
  }

  const decisions = ledgerEntries.filter((entry) => entry.type === 'decision_call');
  return {
    fallbackCount,
    retryCount,
    timeoutCount,
    unmeteredCalls: unmetered.length,
    estimatedCostCalls,
    providersUsed: [...providers],
    stalledCount: [...workerCalls, ...unmetered].filter((entry) => entry.data.stalled === true).length,
    decisionCalls: decisions.length,
    decisionsAccepted: decisions.filter((entry) => entry.data.outcome === 'accepted').length,
    decisionsEscalated: decisions.filter((entry) => entry.data.outcome !== 'accepted').length,
    decisionFailures: ledgerEntries.filter((entry) => entry.type === 'decision_call_failed').length,
  };
}

interface OracleCheckResult {
  id: number;
  description: string;
  passed: boolean;
  detail: string;
}

/** Mirrors NEVER_EVALUATED_PREFIXES in benchmark/oracle/report.py; a test keeps the two equal. */
export const NEVER_EVALUATED_PREFIXES = ['calculation exited', 'no numeric result CSV'] as const;
/** Mirrors PROGRAM_CHECK_IDS in report.py: all blocked, whatever their wording, once check 1 cannot run. */
export const PROGRAM_CHECK_IDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 11] as const;

export interface OracleSummary {
  /** No check was blocked by the program failing to produce a result. */
  runsEndToEnd: boolean;
  passed: number;
  /** Checks judged on their own merits: the total less the blocked ones. */
  evaluated: number;
  blocked: number;
  total: number;
  label: string;
}

/**
 * Two numbers instead of one total. Ten of the twelve checks invoke the CLI, so one traceback on
 * its path fails them all and a program with sound physics reads 1/12. Whether it runs end to end
 * and how it scores on the checks that could judge it are reported apart.
 */
export function summarizeOracle(results: readonly OracleCheckResult[] | null): OracleSummary | null {
  if (!results) return null;
  const neverEvaluated = new Set(
    results.filter((r) => !r.passed && NEVER_EVALUATED_PREFIXES.some((prefix) => r.detail.startsWith(prefix))).map((r) => r.id),
  );
  const crashesOutright = neverEvaluated.has(1);
  const blocked = results.filter(
    (r) => !r.passed && (neverEvaluated.has(r.id) || (crashesOutright && (PROGRAM_CHECK_IDS as readonly number[]).includes(r.id))),
  ).length;
  const passed = results.filter((r) => r.passed).length;
  const evaluated = results.length - blocked;
  const runsEndToEnd = blocked === 0;
  return {
    runsEndToEnd,
    passed,
    evaluated,
    blocked,
    total: results.length,
    label: `runs: ${runsEndToEnd ? 'yes' : `no (${blocked} blocked)`} · functional ${passed}/${evaluated}`,
  };
}

interface OracleMeasurement {
  results: OracleCheckResult[] | null;
  detail: string;
}

function parseOracleResults(stdout: string): OracleCheckResult[] {
  const summaryStart = stdout.indexOf('\nOracle summary:');
  const jsonText = (summaryStart >= 0 ? stdout.slice(0, summaryStart) : stdout).trim();
  const parsed = JSON.parse(jsonText) as unknown;
  if (!Array.isArray(parsed)) throw new Error('oracle report was not a JSON array');
  return parsed as OracleCheckResult[];
}

/** Scores the snapshot against the benchmark-owned oracle.
 *
 * Runs under `pythonPath` — the provisioned benchmark venv — for the same reason the check and
 * coverage passes do. The system python is externally managed and has neither numpy nor
 * matplotlib, so invoking it here made the oracle import-fail inside every submission that plots,
 * and report 0/11 for work that runs correctly under the interpreter the swarm was given. That is
 * an environment artifact reported as an engineering verdict, on the one measurement the rubric
 * treats as the authority a swarm cannot game. */
async function measureOracle(worktreeDir: string, pythonPath: string): Promise<OracleMeasurement> {
  if (!existsSync(worktreeDir)) return { results: null, detail: 'no worktree snapshot to score' };

  let stdout = '';
  let executionError: unknown;
  try {
    const result = await execFileAsync(
      pythonPath,
      ['benchmark/oracle/run_oracle.py', worktreeDir],
      { cwd: pluginRoot, timeout: ORACLE_TIMEOUT_MS, maxBuffer: COVERAGE_MAX_BUFFER_BYTES },
    );
    stdout = result.stdout;
  } catch (err) {
    const failure = err as { stdout?: string; stderr?: string };
    stdout = failure.stdout ?? '';
    executionError = err;
    if (!stdout.trim()) {
      const detail = String(failure.stderr || err).trim().slice(0, ERROR_DETAIL_MAX_LENGTH);
      return { results: null, detail: `oracle did not produce a report: ${detail}` };
    }
  }

  try {
    const results = parseOracleResults(stdout);
    const passed = results.filter((result) => result.passed).length;
    return {
      results,
      detail: `independent oracle completed: ${passed}/${results.length} checks passed${executionError ? ' (non-zero exit)' : ''}`,
    };
  } catch (err) {
    return { results: null, detail: `could not parse oracle report: ${String(err).slice(0, PARSE_ERROR_MAX_LENGTH)}` };
  }
}

/**
 * Scoring pass: re-runs the check under coverage against the run's output worktree snapshot.
 * Deliberately tolerant — a failing test suite still yields a useful coverage number, and a
 * missing pytest-cov plugin must degrade to `null` with a reason rather than fail the benchmark.
 */
async function measureCoverage(worktreeDir: string, reportPath: string, pythonPath: string): Promise<CoverageResult> {
  if (!existsSync(worktreeDir)) return { percent: null, detail: 'no worktree snapshot to measure' };

  let runError: string | null = null;
  try {
    // Must be async, not execFileSync: concurrent stress runs share the event loop, and a
    // synchronous child process would freeze other strategies' polling and inflate wall-clock time.
    await execFileAsync(
      pythonPath,
      // Report written outside the snapshot so measuring never pollutes the artifact we captured.
      ['-m', 'pytest', '--cov=.', '--cov-report', `json:${reportPath}`, '-q', '-p', 'no:cacheprovider'],
      { cwd: worktreeDir, timeout: COVERAGE_TIMEOUT_MS, maxBuffer: COVERAGE_MAX_BUFFER_BYTES },
    );
  } catch (err) {
    // pytest exits non-zero merely because tests failed, and still writes the coverage report;
    // only treat this as fatal if no report landed.
    const e = err as { stdout?: string; stderr?: string };
    runError = String(e.stderr || e.stdout || err).trim().slice(0, ERROR_DETAIL_MAX_LENGTH);
  }

  if (!existsSync(reportPath)) {
    // coverage.py writes no report at all when nothing was importable/executed — the normal case
    // for a run whose only task was rejected and whose sources were therefore reverted away.
    if (runError && /no.data.was.collected|no-data-collected/i.test(runError)) {
      return { percent: null, detail: 'no coverage data collected — no Python sources ran under the check' };
    }
    return {
      percent: null,
      detail: `no coverage report produced (is pytest-cov installed?)${runError ? `: ${runError}` : ''}`,
    };
  }

  try {
    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as { totals?: { percent_covered?: number } };
    const pct = report.totals?.percent_covered;
    if (typeof pct !== 'number') return { percent: null, detail: 'coverage report had no totals.percent_covered' };
    return {
      percent: Math.round(pct * PERCENT_SCALE) / PERCENT_SCALE,
      detail: 'python -m pytest --cov=. against the output worktree',
    };
  } catch (err) {
    return { percent: null, detail: `could not parse coverage report: ${String(err).slice(0, PARSE_ERROR_MAX_LENGTH)}` };
  }
}

interface Metrics {
  runId: string;
  strategy: StrategyId;
  status: string;
  costUsd: number;
  budgetUsd: number;
  tokensUsed: { prompt: number; completion: number };
  workerCalls: number;
  wallClockMs: number;
  filesChanged: number;
  autoApprovals: { kind: string; description: string }[];
  taskErrors: number;
  testRuns: { ran: boolean; passed: boolean }[];
  fallbackCount: number;
  retryCount: number;
  timeoutCount: number;
  /** Calls that threw, so their spend is real but absent from costUsd. */
  unmeteredCalls: number;
  /** Calls priced from models.yaml because the provider reported no cost. */
  estimatedCostCalls: number;
  providersUsed: string[];
  phaseUsage: PhaseUsageMetrics;
  mechanismUsage: MechanismUsageMetrics;
  sovereign: SovereignUsageMetrics;
  coverage: CoverageResult;
  oracleResults: OracleCheckResult[] | null;
  /** Absent on harness errors and on results written before 2026-10-06. */
  oracle?: OracleSummary | null;
  oracleDetail: string;
  note: string;
}

interface RunStrategyOptions {
  engine: SwarmEngine;
  strategy: StrategyId;
  repoPath: string;
  budgetUsd: number;
  pollTimeoutMs: number;
  resultsDir: string;
  pythonPath: string;
  allowance: BenchmarkAllowance;
  perRunUsdIncrement: number;
  /** Every arm of a trial draws its lots from this seed, so doctrines are compared on the same draws. */
  lotSeed: string;
  stopAfter?: StopAfter;
  onStarted?: (runId: string) => void;
}

const BENCHMARK_REQUIRED_OWNERSHIP_PATHS = [
  'alloydamage/__init__.py',
  'alloydamage/__main__.py',
  'alloydamage/composition.py',
  'alloydamage/nuclear_data.py',
  'alloydamage/damage.py',
  'alloydamage/plotting.py',
  'alloydamage/cli.py',
  'examples/304L.yaml',
  'README.md',
] as const;

export const BENCHMARK_ACCEPTANCE_CRITERIA = [
  'python -m pytest passes',
  'python -m alloydamage calculate examples/304L.yaml produces the calculated alloy cross-section and plot',
  'CSV energy header states explicit MeV units',
  'per-element and alloy-total displacement cross-section headers state barn or dpa-barn units',
  'numeric alloy-total values appear under that explicit alloy-total displacement cross-section header',
  'an out-of-range energy request fails and says the requested energy is outside the supported range',
  'provenance output identifies the nuclear-data source, damage model, and dataset',
  'interpolation is implemented in one place, not duplicated across modules',
  'runtime-generated CSV and PNG outputs are not authored repository files',
];

export function benchmarkTaskGoal(taskMarkdown: string): string {
  return (
    `${taskMarkdown.trim()}\n\n---\n\n` +
    `Benchmark harness ownership constraint (applies equally to every strategy): preserve these ` +
    `required output paths verbatim and ensure each is owned by an actionable source, CLI, example, ` +
    `or documentation task.\nEngine-enforced required ownership paths (JSON): ` +
    `${JSON.stringify(BENCHMARK_REQUIRED_OWNERSHIP_PATHS)}\nAlso assign pytest files ` +
    `under tests/ to test-owning work. Do not rename, abbreviate, or misspell these paths. Runtime-generated ` +
    `CSV and PNG outputs are check artifacts, not authored FileOps.\n\n` +
    `Benchmark harness decomposition constraint (applies equally to every strategy): when a task's own ` +
    `plan, acceptance criteria, or tests go beyond what the brief above and the acceptance criteria ` +
    `given with this run actually require, they must not be stricter than those require. Assert a ` +
    `computed floating-point result within a stated numerical tolerance appropriate to the calculation, ` +
    `never bitwise/exact equality against a value derived from irrational or repeated floating-point ` +
    `arithmetic (for example, a logarithmically spaced grid point), unless the brief explicitly requires ` +
    `exact reproduction. This does not relax anything the brief or the acceptance criteria actually ` +
    `state — it only forbids a task inventing a harder bar than they set.`
  );
}

async function runStrategy({
  engine,
  strategy,
  repoPath,
  budgetUsd,
  pollTimeoutMs,
  resultsDir,
  pythonPath,
  allowance,
  perRunUsdIncrement,
  lotSeed,
  stopAfter,
  onStarted,
}: RunStrategyOptions): Promise<Metrics> {
  const taskMd = readFileSync(path.join(repoPath, 'TASK.md'), 'utf8');

  const run = await engine.startRun({
    task: {
      goal: benchmarkTaskGoal(taskMd),
      acceptanceCriteria: [...BENCHMARK_ACCEPTANCE_CRITERIA],
      repoPath,
      baseBranch: 'main',
    },
    strategy,
    budgetUsd,
    lotSeed,
  });
  onStarted?.(run.runId);
  log(`[${strategy}] started run ${run.runId}, worktree=${run.worktreePath}`);

  // The harness giving up — almost always its poll deadline — is a statement about the harness's
  // patience, not about the run. State, ledger and worktree are all on disk by then, so scoring
  // proceeds from the run as it stands and the metrics are labelled harness_error. Discarding them
  // for zeroes loses real measurements: a 135-minute run that timed out had done 185 worker calls
  // and written 537 lines, and reported none of it.
  let harnessError: unknown;
  let finalState: RunState;
  try {
    finalState = await autoResolveUntilTerminal({
      engine,
      ...(stopAfter ? { stopAfter } : {}),
      strategy,
      runId: run.runId,
      pollTimeoutMs,
      allowance,
      perRunUsdIncrement,
    });
  } catch (err) {
    // Stop this one run first: its loop outlives the harness's patience and would keep writing to
    // the worktree we are about to snapshot. stopRun throws only if the run is gone from the
    // store, and then there is genuinely nothing to score.
    finalState = engine.stopRun(run.runId, `Benchmark harness gave up: ${String(err)}`);
    harnessError = err;
    log(`[${strategy}] harness gave up, scoring the run as it stands: ${String(err)}`);
  }
  log(`[${strategy}] final status=${finalState.status} costUsd=${finalState.costUsd.toFixed(4)} workerCalls=${finalState.workerCalls}`);

  const runDir = path.join(pluginRoot, 'runs', 'benchmark', run.runId);
  const outDir = path.join(resultsDir, strategy);
  mkdirSync(outDir, { recursive: true });

  // diff + worktree snapshot (best-effort: worktree may be gone if the run failed before creation)
  let filesChanged = 0;
  try {
    const worktree = new RepoWorktree(repoPath, runDir, run.runId);
    const { diffText, filesChanged: fc } = await worktree.diff(BENCHMARK_DIFF_EXCLUDES);
    filesChanged = fc.length;
    writeFileSync(path.join(outDir, 'diff.patch'), diffText, 'utf8');
  } catch (err) {
    writeFileSync(path.join(outDir, 'diff.patch'), `(failed to compute diff: ${String(err)})\n`, 'utf8');
  }
  if (existsSync(finalState.worktreePath)) {
    copyDirExcludingGit(finalState.worktreePath, path.join(outDir, 'worktree'), true);
  }
  copyCheckArtifacts(runDir, outDir);

  writeFileSync(path.join(outDir, 'state.json'), JSON.stringify(finalState, null, 2), 'utf8');
  const ledgerPath = path.join(runDir, 'ledger.jsonl');
  const ledgerEntries: { type: string; data: Record<string, unknown> }[] = existsSync(ledgerPath)
    ? readFileSync(ledgerPath, 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l))
    : [];
  if (existsSync(ledgerPath)) cpSync(ledgerPath, path.join(outDir, 'ledger.jsonl'));

  const wallClockMs = new Date(finalState.updatedAt).getTime() - new Date(finalState.createdAt).getTime();
  const testRuns: { ran: boolean; passed: boolean }[] = ledgerEntries
    .filter((e) => e.type === 'verification_result')
    .map((e) => ({ ran: e.data.ran as boolean, passed: e.data.passed as boolean }));
  const modelUsage = aggregateModelUsage(ledgerEntries);
  const phaseUsage = aggregatePhaseUsage(ledgerEntries);
  const worktreeSnapshot = path.join(outDir, 'worktree');
  const coverage = await measureCoverage(worktreeSnapshot, path.join(outDir, 'coverage.json'), pythonPath);
  const reportingOracle = await measureOracle(worktreeSnapshot, pythonPath);
  const acceptanceOracle = finalState.delivery?.externalEvaluations as OracleCheckResult[] | undefined;

  const metrics: Metrics = {
    runId: run.runId,
    strategy,
    status: harnessError ? 'harness_error' : finalState.status,
    costUsd: finalState.costUsd,
    budgetUsd: finalState.budgetUsd,
    tokensUsed: finalState.tokensUsed,
    workerCalls: finalState.workerCalls,
    wallClockMs,
    filesChanged,
    autoApprovals: finalState.pendingApprovals
      .filter((a) => a.resolvedAt)
      .map((a) => ({ kind: a.kind, description: a.description })),
    taskErrors: ledgerEntries.filter((e) => e.type === 'task_error').length,
    testRuns,
    ...modelUsage,
    phaseUsage,
    mechanismUsage: aggregateMechanismUsage(ledgerEntries),
    sovereign: aggregateSovereignUsage(ledgerEntries),
    coverage,
    oracleResults: acceptanceOracle ?? reportingOracle.results,
    oracle: summarizeOracle(acceptanceOracle ?? reportingOracle.results),
    oracleDetail: acceptanceOracle
      ? `acceptance oracle preserved in delivery: ${acceptanceOracle.filter((result) => result.passed).length}/${acceptanceOracle.length} checks passed`
      : reportingOracle.detail,
    note: harnessError
      ? `Harness-level failure; the run was stopped and scored where it stood: ${String(harnessError)}`
      : 'testRuns and model usage come from ledger entries; coverage and oracle results come from independent scoring passes.',
  };
  writeFileSync(path.join(outDir, 'metrics.json'), JSON.stringify(metrics, null, 2), 'utf8');
  return metrics;
}

export function strategiesForTrial<T>(strategies: readonly T[], trialIndex: number): T[] {
  return rotatedStrategyOrder(strategies, trialIndex);
}

interface ExecuteStrategyRunsOptions<TStrategy, TResult> {
  orderedStrategies: readonly TStrategy[];
  concurrent: boolean;
  run: (strategy: TStrategy) => Promise<TResult>;
}

export async function executeStrategyRuns<TStrategy, TResult>({
  orderedStrategies,
  concurrent,
  run,
}: ExecuteStrategyRunsOptions<TStrategy, TResult>): Promise<TResult[]> {
  if (concurrent) return Promise.all(orderedStrategies.map((strategy) => run(strategy)));

  const results: TResult[] = [];
  for (const strategy of orderedStrategies) results.push(await run(strategy));
  return results;
}

function harnessErrorMetrics(strategy: StrategyId, budgetUsd: number, err: unknown): Metrics {
  return {
    runId: '(none)',
    strategy,
    status: 'harness_error',
    costUsd: 0,
    budgetUsd,
    tokensUsed: { prompt: 0, completion: 0 },
    workerCalls: 0,
    wallClockMs: 0,
    filesChanged: 0,
    autoApprovals: [],
    taskErrors: 0,
    testRuns: [],
    fallbackCount: 0,
    retryCount: 0,
    timeoutCount: 0,
    unmeteredCalls: 0,
    estimatedCostCalls: 0,
    providersUsed: [],
    phaseUsage: aggregatePhaseUsage([]),
    mechanismUsage: aggregateMechanismUsage([]),
    sovereign: { calls: 0, fallbacks: 0, costUsd: 0 },
    coverage: { percent: null, detail: 'run did not complete, nothing to measure' },
    oracleResults: null,
    oracleDetail: 'run did not complete, no worktree to score',
    note: `Harness-level failure before/during run: ${String(err)}`,
  };
}

export function benchmarkReleaseGate(results: readonly Metrics[]): { passed: boolean; failures: string[] } {
  const failures = RELEASE_GATE_STRATEGIES.flatMap((strategy) => {
    const result = results.find((candidate) => candidate.strategy === strategy);
    if (!result) return [`${strategy}: missing result`];
    if (result.status !== 'completed') return [`${strategy}: status ${result.status}`];
    const oracle = result.oracleResults ?? [];
    if (oracle.length !== ORACLE_CHECK_COUNT || oracle.some((check) => !check.passed)) {
      return [`${strategy}: oracle ${oracle.filter((check) => check.passed).length}/${oracle.length}`];
    }
    return [];
  });
  return { passed: failures.length === 0, failures };
}

interface BenchmarkManifest {
  version: 2;
  label: string;
  args: Args;
  repoPath: string;
  updatedAt: string;
  sourceFingerprint?: string;
  configFingerprint?: string;
  dependencyLockFingerprint?: string;
  inputRevision?: string;
  resumedSourceFingerprints?: string[];
  mixedBuild?: boolean;
  strategies: Partial<Record<StrategyId, { runId?: string; status: string; metrics?: Metrics }>>;
}

export function fingerprintTree(root: string, include: (relativePath: string) => boolean): string {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) {
        const relative = path.relative(root, absolute).split(path.sep).join('/');
        if (include(relative)) files.push(relative);
      }
    }
  };
  visit(root);
  const digest = createHash('sha256');
  for (const file of files.sort()) {
    digest.update(file).update('\0').update(readFileSync(path.join(root, file))).update('\0');
  }
  return digest.digest('hex');
}

function benchmarkBuildFingerprints() {
  return {
    sourceFingerprint: fingerprintTree(path.join(pluginRoot, 'mcp-server', 'src'), (file) => file.endsWith('.ts')),
    configFingerprint: fingerprintTree(configDir, (file) => /\.(?:yaml|yml|json)$/.test(file)),
    dependencyLockFingerprint: createHash('sha256')
      .update(readFileSync(path.join(pluginRoot, 'mcp-server', 'package-lock.json'))).digest('hex'),
  };
}

export function buildProvenanceChanged(
  manifest: BenchmarkManifest,
  current: ReturnType<typeof benchmarkBuildFingerprints>,
): boolean {
  return manifest.sourceFingerprint !== current.sourceFingerprint ||
    manifest.configFingerprint !== current.configFingerprint ||
    manifest.dependencyLockFingerprint !== current.dependencyLockFingerprint;
}

async function resumeStrategyRun(options: RunStrategyOptions, runId: string): Promise<Metrics> {
  let state = options.engine.getRunStore().load(runId);
  if (!state) throw new Error(`Cannot resume missing run ${runId}`);
  if (state.status === 'interrupted') await options.engine.resumeRun(runId);
  state = await autoResolveUntilTerminal({
    engine: options.engine,
    ...(options.stopAfter ? { stopAfter: options.stopAfter } : {}),
    strategy: options.strategy,
    runId,
    pollTimeoutMs: options.pollTimeoutMs,
    allowance: options.allowance,
    perRunUsdIncrement: options.perRunUsdIncrement,
  });
  const outDir = path.join(options.resultsDir, options.strategy);
  mkdirSync(outDir, { recursive: true });
  writeJsonAtomic(path.join(outDir, 'state.json'), state);
  if (existsSync(state.worktreePath) && !existsSync(path.join(outDir, 'worktree'))) {
    copyDirExcludingGit(state.worktreePath, path.join(outDir, 'worktree'), true);
  }
  const runDir = path.join(pluginRoot, 'runs', 'benchmark', runId);
  copyCheckArtifacts(runDir, outDir);
  let filesChanged = state.delivery?.changedFiles.length ?? 0;
  if (existsSync(state.worktreePath)) {
    try {
      const worktree = new RepoWorktree(state.repoPath, runDir, runId);
      const diff = await worktree.diff(BENCHMARK_DIFF_EXCLUDES);
      filesChanged = diff.filesChanged.length;
      writeFileSync(path.join(outDir, 'diff.patch'), diff.diffText, 'utf8');
    } catch (error) {
      writeFileSync(path.join(outDir, 'diff.patch'), `(failed to compute diff: ${String(error)})\n`, 'utf8');
    }
  }
  const ledger = new Ledger(runDir, runId, options.strategy).readAll();
  const modelUsage = aggregateModelUsage(ledger);
  const phaseUsage = aggregatePhaseUsage(ledger);
  const snapshot = existsSync(path.join(outDir, 'worktree')) ? path.join(outDir, 'worktree') : state.worktreePath;
  const reportingOracle = await measureOracle(snapshot, options.pythonPath);
  const acceptanceOracle = state.delivery?.externalEvaluations as OracleCheckResult[] | undefined;
  const metrics: Metrics = {
    runId,
    strategy: options.strategy,
    status: state.status,
    costUsd: state.costUsd,
    budgetUsd: state.budgetUsd,
    tokensUsed: state.tokensUsed,
    workerCalls: state.workerCalls,
    wallClockMs: new Date(state.updatedAt).getTime() - new Date(state.startedAt ?? state.createdAt).getTime(),
    filesChanged,
    autoApprovals: state.pendingApprovals.filter((approval) => approval.resolvedAt).map((approval) => ({
      kind: approval.kind,
      description: approval.description,
    })),
    taskErrors: ledger.filter((entry) => entry.type === 'task_error').length,
    testRuns: ledger.filter((entry) => entry.type === 'verification_result').map((entry) => ({
      ran: entry.data.ran === true,
      passed: entry.data.passed === true,
    })),
    ...modelUsage,
    phaseUsage,
    mechanismUsage: aggregateMechanismUsage(ledger),
    sovereign: aggregateSovereignUsage(ledger),
    coverage: await measureCoverage(snapshot, path.join(outDir, 'coverage.json'), options.pythonPath),
    oracleResults: acceptanceOracle ?? reportingOracle.results,
    oracle: summarizeOracle(acceptanceOracle ?? reportingOracle.results),
    oracleDetail: acceptanceOracle
      ? `acceptance oracle preserved in delivery: ${acceptanceOracle.filter((result) => result.passed).length}/${acceptanceOracle.length} checks passed`
      : reportingOracle.detail,
    note: 'Recovered run; acceptance evidence comes from persisted state and reporting metrics were rebuilt.',
  };
  writeJsonAtomic(path.join(outDir, 'metrics.json'), metrics);
  return metrics;
}

async function main(): Promise<void> {
  dotenv.config({ path: path.join(pluginRoot, '.env') });
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY is not set — check political-swarm/.env');
  }

  let args = parseArgs();
  // Convenience wrapper around Ledger's own SWARM_FULL_TRANSCRIPTS env check (see Ledger.ts) —
  // no separate code path, just sets the same toggle before any Ledger gets constructed.
  if (process.argv.includes('--full-transcripts')) process.env.SWARM_FULL_TRANSCRIPTS = '1';
  log(`Plugin root: ${pluginRoot}`);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const resultsDir = args.resumeDir ?? path.join(pluginRoot, 'benchmark', 'results', `${timestamp}__${args.label}`);
  mkdirSync(resultsDir, { recursive: true });
  const manifestPath = path.join(resultsDir, 'manifest.json');
  let manifest: BenchmarkManifest;
  let repoPath: string;
  const buildFingerprints = benchmarkBuildFingerprints();
  if (args.resumeDir) {
    if (!existsSync(manifestPath)) throw new Error(`No benchmark manifest found in ${resultsDir}`);
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as BenchmarkManifest;
    args = { ...manifest.args, resumeDir: resultsDir };
    repoPath = manifest.repoPath;
    if (buildProvenanceChanged(manifest, buildFingerprints)) {
      manifest.mixedBuild = true;
      manifest.resumedSourceFingerprints = [...new Set([
        ...(manifest.resumedSourceFingerprints ?? []), buildFingerprints.sourceFingerprint,
      ])];
      log('Resumed with different or unavailable original build fingerprints; this trial is mixed-build.');
    }
  } else {
    const scratchRepoDir = path.join(pluginRoot, 'runs', 'benchmark-scratch', `${timestamp}__${args.label}`, 'repo');
    repoPath = prepareScratchRepo(args.repoPath, scratchRepoDir);
    manifest = {
      version: 2,
      label: args.label,
      args,
      repoPath,
      updatedAt: new Date().toISOString(),
      ...buildFingerprints,
      inputRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, encoding: 'utf8' }).trim(),
      strategies: Object.fromEntries(args.strategies.map((strategy) => [strategy, { status: 'pending' }])),
    };
    writeJsonAtomic(manifestPath, manifest);
  }
  log(`Repo source: ${args.repoPath}`);
  log(`Label: ${args.label}, strategies: ${args.strategies.join(',')}, budgetUsd/run: ${args.budgetUsd}`);
  log(`Scratch repo: ${repoPath}`);

  const pythonPath = await ensureBenchmarkPython();
  const environmentInfo = await captureEnvironmentInfo(pythonPath);
  writeFileSync(path.join(resultsDir, 'environment.json'), JSON.stringify(environmentInfo, null, 2), 'utf8');

  const runsRootDir = path.join(pluginRoot, 'runs', 'benchmark');
  // A manifest written before decision models existed ran without them.
  // Each governing event a run records (an election, a division, an award) is printed as it
  // happens, so the log shows how every doctrine is governing between ticker lines.
  // The same headline twice in one second is one event recorded at two levels (single-agent
  // and the engine both record plan_created), so it prints once.
  const bus = new EventBus();
  const lastHeadline = new Map<string, string>();
  bus.subscribe((event) => {
    if (event.kind !== 'ledger') return;
    const headline = milestoneFor(event.entry);
    if (!headline) return;
    const line = `${event.entry.ts.slice(11, 19)} > ${headline}`;
    if (lastHeadline.get(event.runId) === line) return;
    lastHeadline.set(event.runId, line);
    log(`[${event.entry.strategy}] ${line}`);
  });
  const engine = buildEngine(runsRootDir, args.maxWallClockMinutes, args.implementerCallTimeoutMs, pythonPath, args.decisionModels ?? 'pure', bus);
  log(`Decision models: ${args.decisionModels ?? 'pure'}`);
  if (args.stopAfter) log(`Stop after: ${args.stopAfter} (bug-hunting; scores are not comparable)`);
  const perRunUsdIncrement = loadBudgetConfig(configDir).defaults.perRunUsd;
  const orderedStrategies = strategiesForTrial(args.strategies, args.trialIndex);
  log(`Strategy rotation: ${describeRotation(args.strategies, args.trialIndex)}`);
  log(`Execution mode: ${args.concurrent ? 'concurrent stress test' : 'sequential'}`);

  const completedResults: Metrics[] = Object.values(manifest.strategies)
    .flatMap((entry) => entry?.metrics ? [entry.metrics] : []);
  const persistProgress = (): void => {
    manifest.updatedAt = new Date().toISOString();
    writeJsonAtomic(manifestPath, manifest);
    writeJsonAtomic(path.join(resultsDir, 'summary.json'), {
      label: args.label,
      args,
      results: completedResults,
      releaseGate: benchmarkReleaseGate(completedResults),
    });
  };
  const stop = async (signal: string): Promise<void> => {
    await engine.interruptOwnedRuns(`Benchmark received ${signal}`);
    persistProgress();
    process.exit(130);
  };
  process.once('SIGINT', () => void stop('SIGINT'));
  process.once('SIGTERM', () => void stop('SIGTERM'));

  const results = await executeStrategyRuns({
    orderedStrategies,
    concurrent: args.concurrent,
    run: async (strategy) => {
      const existing = manifest.strategies[strategy];
      if (existing?.metrics) return existing.metrics;
      let startedRunId = existing?.runId;
      const options: RunStrategyOptions = {
        engine,
        strategy,
        repoPath,
        budgetUsd: args.budgetUsd,
        pollTimeoutMs: args.pollTimeoutMs,
        resultsDir,
        pythonPath,
        allowance: new BenchmarkAllowance(args.allowanceUsd, args.allowanceExtensions),
        perRunUsdIncrement,
        lotSeed: `benchmark-trial-${args.trialIndex}`,
        ...(args.stopAfter ? { stopAfter: args.stopAfter } : {}),
        onStarted: (runId) => {
          startedRunId = runId;
          manifest.strategies[strategy] = { runId, status: 'running' };
          persistProgress();
        },
      };
      const metric = await (existing?.runId
        ? resumeStrategyRun(options, existing.runId)
        : runStrategy(options)).catch((err) => {
        log(`[${strategy}] FAILED: ${String(err?.stack ?? err)}`);
        return { ...harnessErrorMetrics(strategy, args.budgetUsd, err), runId: startedRunId ?? '(none)' };
      });
      manifest.strategies[strategy] = { runId: metric.runId, status: metric.status, metrics: metric };
      const index = completedResults.findIndex((result) => result.strategy === strategy);
      if (index >= 0) completedResults[index] = metric;
      else completedResults.push(metric);
      persistProgress();
      return metric;
    },
  });

  writeJsonAtomic(path.join(resultsDir, 'summary.json'), {
    label: args.label,
    args,
    results,
    releaseGate: benchmarkReleaseGate(results),
  });
  log(`\nResults written to ${resultsDir}`);
  for (const r of results) {
    log(`  ${r.strategy}: status=${r.status} costUsd=${r.costUsd.toFixed(4)} workerCalls=${r.workerCalls} filesChanged=${r.filesChanged} sovereignCalls=${r.sovereign?.calls ?? 0} oracle=[${r.oracle?.label ?? 'none'}]`);
  }
}

const entryPath = process.argv[1];
if (entryPath && path.resolve(entryPath) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`[benchmark] FATAL: ${String(err?.stack ?? err)}\n`);
    process.exitCode = 1;
  });
}
