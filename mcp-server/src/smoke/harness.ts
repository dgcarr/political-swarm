import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { NoopStrategy } from '../strategies/noop/NoopStrategy.js';
import type { SwarmEngine } from '../engine/SwarmEngine.js';
import type { RunState } from '../engine/RunStore.js';
import type { SwarmStrategy } from '../engine/SwarmStrategy.js';
import type { StrategyId } from '../engine/types.js';

export const DEFAULT_TERMINAL_TIMEOUT_MS = 30_000;
export const DEFAULT_TERMINAL_POLL_INTERVAL_MS = 300;

// Statuses from which the run loop will not move on its own. `awaiting_acceptance` belongs here
// because the swarm has stopped and is waiting on Claude's independent check — the run continues
// only when a caller accepts the delivery or returns defects, which is exactly what a smoke test
// then goes on to do.
const TERMINAL_STATUSES = new Set<RunState['status']>([
  'completed',
  'awaiting_acceptance',
  'terminated_incomplete',
  'failed',
  'stopped',
  'paused_human',
  'paused_budget',
]);

export type Check = readonly [label: string, passed: boolean];

export interface ScratchRepoOptions {
  repoPath: string;
  readme: string;
  packageJson?: Record<string, unknown>;
  testFile?: string;
}

/**
 * A repository whose `npm test` passes only once NoopStrategy has written its sentinel, so the
 * required `unit` check fails at baseline, passes on the integrated tree, and gives the
 * "SWARM_SENTINEL.md exists" criterion real evidence at the acceptance barrier.
 */
export const SENTINEL_CHECKED_REPO: Pick<ScratchRepoOptions, 'packageJson' | 'testFile'> = {
  packageJson: { name: 'swarm-smoke-scratch', private: true, scripts: { test: 'node test.js' } },
  testFile:
    "const { existsSync } = require('node:fs');\n" +
    "if (!existsSync('SWARM_SENTINEL.md')) {\n" +
    "  console.error('SWARM_SENTINEL.md is missing');\n" +
    '  process.exit(1);\n' +
    '}\n',
};

export interface WaitForTerminalOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  result?: 'state' | 'status' | 'void';
}

export function log(tag: string): (message: string) => void {
  return (message: string): void => {
    process.stdout.write(`[${tag}] ${message}\n`);
  };
}

export function setUpScratchRepo(options: ScratchRepoOptions): void {
  const { repoPath, readme, packageJson, testFile } = options;
  if (existsSync(repoPath)) rmSync(repoPath, { recursive: true, force: true });
  mkdirSync(repoPath, { recursive: true });
  const run = (args: string[]) => execFileSync('git', args, { cwd: repoPath, stdio: 'pipe' });
  run(['init', '-q']);
  run(['config', 'user.email', 'swarm-smoke@example.com']);
  run(['config', 'user.name', 'Swarm Smoke Test']);
  writeFileSync(path.join(repoPath, 'README.md'), readme);
  if (packageJson) {
    writeFileSync(path.join(repoPath, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`);
  }
  if (testFile !== undefined) writeFileSync(path.join(repoPath, 'test.js'), testFile);
  run(['add', '-A']);
  run(['commit', '-q', '-m', 'initial commit']);
  run(['branch', '-M', 'main']);
}

export async function waitForTerminal(
  engine: SwarmEngine,
  runId: string,
  options: WaitForTerminalOptions & { result: 'state' },
): Promise<RunState>;
export async function waitForTerminal(
  engine: SwarmEngine,
  runId: string,
  options: WaitForTerminalOptions & { result: 'status' },
): Promise<RunState['status']>;
export async function waitForTerminal(
  engine: SwarmEngine,
  runId: string,
  options?: WaitForTerminalOptions,
): Promise<void>;
export async function waitForTerminal(
  engine: SwarmEngine,
  runId: string,
  options: WaitForTerminalOptions = {},
): Promise<RunState | RunState['status'] | void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TERMINAL_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_TERMINAL_POLL_INTERVAL_MS;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = engine.getRunStore().load(runId);
    if (state && TERMINAL_STATUSES.has(state.status)) {
      if (options.result === 'state') return state;
      if (options.result === 'status') return state.status;
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  throw new Error(`Run ${runId} did not reach a terminal status within ${timeoutMs}ms`);
}

export function buildNoopStrategies(
  active: Partial<Record<StrategyId, SwarmStrategy>> = {},
): Record<StrategyId, SwarmStrategy> {
  const noop = active.noop ?? new NoopStrategy();
  return {
    noop,
    democratic: active.democratic ?? noop,
    socialist: active.socialist ?? noop,
    capitalist: active.capitalist ?? noop,
    managerial: active.managerial ?? noop,
    single_agent: active.single_agent ?? noop,
  };
}

export function reportChecks(tag: string, checks: readonly Check[]): boolean {
  const writeLog = log(tag);
  let passedAll = true;
  for (const [label, passed] of checks) {
    writeLog(`${passed ? 'PASS' : 'FAIL'} - ${label}`);
    if (!passed) passedAll = false;
  }
  return passedAll;
}

/**
 * Whether a run that produced no delivery nonetheless said why it stopped.
 *
 * Every doctrine has endings short of delivery that are the model working rather than failing: a
 * pause for human approval, an acceptance rule refusing the work, a genuine failure. A smoke test
 * that demands delivery is asserting an outcome no doctrine promises — and one that tries to infer
 * "did it stop properly" from which ledger events happened to fire will miss whichever ending it
 * did not think of. Both mistakes have been made here, the second while fixing the first.
 *
 * So the question is asked of the run's own terminal state, which is the thing that actually knows.
 * It does not care which institution stopped the market, only that the market said why — and
 * `terminated_incomplete` must carry its reason rather than merely appear, because silence is the
 * one ending that is never acceptable.
 */
export function endedWithARecordedReason(status: RunState['status'], lastError?: string): boolean {
  if (status === 'paused_human' || status === 'failed') return true;
  if (status === 'terminated_incomplete') return !!lastError && lastError.trim().length > 0;
  return false;
}
