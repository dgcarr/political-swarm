// Phase 2 gate: drives a real SwarmEngine run with the dashboard attached and asserts that the
// events arrive over SSE *while the run is happening*, not merely afterwards.
//
// Uses NoopStrategy, so this exercises the real engine, ledger, run store, event bus and HTTP
// stack at zero OpenRouter spend. Run with:  npm run smoke:dashboard-live
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

import { OpenRouterClient } from '../engine/OpenRouterClient.js';
import { SwarmEngine } from '../engine/SwarmEngine.js';
import { EventBus } from '../engine/EventBus.js';
import { DashboardServer, isTerminal } from '../dashboard/DashboardServer.js';
import type { RunState } from '../engine/RunStore.js';
import { loadBudgetConfig, loadModelsConfig, loadStrategiesConfig } from '../util/config.js';
import { buildNoopStrategies, log as createLog, reportChecks, SENTINEL_CHECKED_REPO, setUpScratchRepo } from './harness.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(__dirname, '../../..');
const configDir = path.join(pluginRoot, 'config');
const runsRootDir = path.join(pluginRoot, 'runs', 'smoke');
const scratchRepoRoot = process.env.SWARM_SMOKE_SCRATCH_DIR ?? path.join(os.tmpdir(), 'swarm-dashboard-smoke-repo');
const RUN_BUDGET_USD = 1;
const RUN_TIMEOUT_MS = 30_000;
const RUN_POLL_INTERVAL_MS = 100;
const FINAL_FRAME_DRAIN_MS = 200;
const CLIENT_DISCONNECT_DELAY_MS = 50;

const log = createLog('dashboard-smoke');

interface Frame {
  id?: string;
  event?: string;
  data?: string;
}

type DashboardPayload =
  | { kind: 'ledger'; entry: { type: string } }
  | { kind: 'state'; state: { status: string } };

interface RunsSummary {
  runs: { runId: string }[];
}

function openStream(base: string, onFrame: (frame: Frame) => void): Promise<http.ClientRequest> {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname, port, path: '/api/stream?runId=all', method: 'GET', headers: { Accept: 'text/event-stream' } },
      (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`stream status ${res.statusCode}`));
          return;
        }
        let buffer = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          buffer += chunk;
          let split;
          while ((split = buffer.indexOf('\n\n')) !== -1) {
            const raw = buffer.slice(0, split);
            buffer = buffer.slice(split + 2);
            const frame: Frame = {};
            for (const line of raw.split('\n')) {
              if (line.startsWith('id: ')) frame.id = line.slice(4);
              else if (line.startsWith('event: ')) frame.event = line.slice(7);
              else if (line.startsWith('data: ')) frame.data = line.slice(6);
            }
            onFrame(frame);
          }
        });
        resolve(req);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function main(): Promise<void> {
  dotenv.config({ path: path.join(pluginRoot, '.env') });
  setUpScratchRepo({
    repoPath: scratchRepoRoot,
    readme: '# scratch repo for the dashboard live smoke test\n',
    ...SENTINEL_CHECKED_REPO,
  });

  const bus = new EventBus();
  // NoopStrategy issues no model calls, so no real key is needed or wanted here — the client is
  // constructed only to satisfy EngineDeps. A placeholder also lets this run in a worktree or CI
  // checkout that has no .env.
  const client = new OpenRouterClient(process.env.OPENROUTER_API_KEY || 'noop-smoke-no-network-calls');
  const strategies = buildNoopStrategies();

  const engine = new SwarmEngine({
    client,
    modelsConfig: loadModelsConfig(configDir),
    configDir,
    budgetConfig: loadBudgetConfig(configDir),
    strategiesConfig: loadStrategiesConfig(configDir),
    runsRootDir,
    strategies,
    bus,
  });

  const dashboard = new DashboardServer({
    runStore: engine.getRunStore(),
    runsRootDir,
    bus,
    config: { enabled: true, port: 0, host: '127.0.0.1', autoOpen: false, rhetoric: 'template' },
  });

  const url = await dashboard.start();
  if (!url) throw new Error('dashboard failed to start');
  const base = url.replace(/\/$/, '');
  log(`Dashboard at ${base}`);

  // Subscribe *before* starting the run, exactly as a watching browser tab would.
  const ledgerFrames: { type: string; at: number }[] = [];
  const stateFrames: { status: string; at: number }[] = [];
  const req = await openStream(base, (frame) => {
    if (!frame.data) return;
    const payload = JSON.parse(frame.data) as DashboardPayload;
    if (payload.kind === 'ledger') ledgerFrames.push({ type: payload.entry.type, at: Date.now() });
    if (payload.kind === 'state') stateFrames.push({ status: payload.state.status, at: Date.now() });
  });

  const startedAt = Date.now();
  const run = await engine.startRun({
    task: {
      goal: 'Dashboard live smoke test',
      acceptanceCriteria: ['SWARM_SENTINEL.md exists in the worktree'],
      repoPath: scratchRepoRoot,
      baseBranch: 'main',
    },
    strategy: 'noop',
    budgetUsd: RUN_BUDGET_USD,
  });
  log(`Started run ${run.runId}`);

  const deadline = Date.now() + RUN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const state = engine.getRunStore().load(run.runId);
    if (state && isTerminal(state.status as RunState['status'])) break;
    // awaiting_acceptance is where a healthy run rests: the swarm has finished and Claude's
    // independent check has not happened, so it is a stopping point for this smoke too.
    if (state?.status === 'awaiting_acceptance') break;
    await new Promise((r) => setTimeout(r, RUN_POLL_INTERVAL_MS));
  }
  const finalState = engine.getRunStore().load(run.runId);
  // Let the last frames drain.
  await new Promise((r) => setTimeout(r, FINAL_FRAME_DRAIN_MS));

  const finishedAt = Date.now();
  const arrivedDuringRun = ledgerFrames.filter((f) => f.at <= finishedAt).length;
  const summary = (await (await fetch(`${base}/api/runs`)).json()) as RunsSummary;
  const listed = summary.runs.some((listedRun) => listedRun.runId === run.runId);

  const checks: [string, boolean][] = [
    ['run reached awaiting_acceptance status', finalState?.status === 'awaiting_acceptance'],
    ['ledger events arrived over SSE', ledgerFrames.length > 0],
    ['events arrived while the run was in flight', arrivedDuringRun > 0],
    ['a state snapshot arrived over SSE', stateFrames.length > 0],
    [
      'final state snapshot reported the run had stopped working',
      stateFrames.some((f) => f.status === 'awaiting_acceptance' || isTerminal(f.status as RunState['status'])),
    ],
    ['the run appears in /api/runs', listed],
  ];

  log(`Ledger frames: ${ledgerFrames.length} (${ledgerFrames.map((f) => f.type).join(', ')})`);
  log(`State frames: ${stateFrames.length} · run took ${finishedAt - startedAt}ms`);

  let ok = reportChecks('dashboard-smoke', checks);

  req.destroy();
  await new Promise((r) => setTimeout(r, CLIENT_DISCONNECT_DELAY_MS));
  const leaked = dashboard.clientCount;
  log(`${leaked === 0 ? 'PASS' : 'FAIL'} - client released on disconnect (open clients: ${leaked})`);
  if (leaked !== 0) ok = false;

  await dashboard.stop();

  if (!ok) {
    process.exitCode = 1;
    return;
  }
  log('All checks passed.');
}

main().catch((err) => {
  process.stderr.write(`[dashboard-smoke] FATAL: ${String(err?.stack ?? err)}\n`);
  process.exitCode = 1;
});
