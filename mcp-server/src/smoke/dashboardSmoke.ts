// Replays a recorded run through the full dashboard stack at speed, so the page can be built,
// demoed and regression-checked at zero OpenRouter spend.
//
//   npm run smoke:dashboard              replay, assert, exit
//   SWARM_SMOKE_HOLD=1 npm run smoke:dashboard   replay, then keep serving so you can browse it
//
// This is the intended development loop for the page: no API key, no network, no cost.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { EventBus } from '../engine/EventBus.js';
import { Ledger, type LedgerEntry } from '../engine/Ledger.js';
import { RunStore, type RunState } from '../engine/RunStore.js';
import { DashboardServer, isTerminal } from '../dashboard/DashboardServer.js';
import { loadDashboardConfig } from '../dashboard/config.js';
import { openInBrowser } from '../dashboard/openBrowser.js';
import { log as createLog, reportChecks } from './harness.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(__dirname, '../../..');

/** Wall-clock compression. The recorded gaps between entries are divided by this. */
const SPEEDUP = 10;
const MAX_GAP_MS = 400;
const STREAM_DRAIN_DELAY_MS = 300;
const MINIMUM_NARRATED_RATIO = 0.5;
const MAX_BROKEN_LINES_TO_LOG = 5;

const log = createLog('dashboard-replay');

interface Source {
  label: string;
  state: RunState;
  ledger: LedgerEntry[];
}

/**
 * Finds recorded runs to replay: benchmark results first, then any run directory.
 *
 * SWARM_REPLAY_FROM overrides the search root, which matters when developing in a git worktree —
 * benchmark/results and runs/ are untracked, so they exist only in the main checkout.
 */
function findSources(): Source[] {
  const searchRoot = process.env.SWARM_REPLAY_FROM ?? pluginRoot;
  const candidates: string[] = [];

  const resultsRoot = path.join(searchRoot, 'benchmark', 'results');
  if (existsSync(resultsRoot)) {
    for (const stamp of readdirSync(resultsRoot)) {
      const dir = path.join(resultsRoot, stamp);
      if (!statSync(dir).isDirectory()) continue;
      for (const strategy of readdirSync(dir)) {
        const inner = path.join(dir, strategy);
        if (statSync(inner).isDirectory()) candidates.push(inner);
      }
    }
  }

  const runsRoot = process.env.SWARM_RUNS_DIR ?? path.join(searchRoot, 'runs');
  if (existsSync(runsRoot)) {
    for (const group of readdirSync(runsRoot)) {
      const dir = path.join(runsRoot, group);
      if (!statSync(dir).isDirectory()) continue;
      for (const run of readdirSync(dir)) {
        const inner = path.join(dir, run);
        if (statSync(inner).isDirectory()) candidates.push(inner);
      }
    }
  }

  const sources: Source[] = [];
  const seenStrategies = new Set<string>();

  for (const dir of candidates) {
    const statePath = path.join(dir, 'state.json');
    const ledgerPath = path.join(dir, 'ledger.jsonl');
    if (!existsSync(statePath) || !existsSync(ledgerPath)) continue;

    let state: RunState;
    try {
      state = JSON.parse(readFileSync(statePath, 'utf8')) as RunState;
    } catch {
      continue;
    }

    const ledger: LedgerEntry[] = [];
    for (const line of readFileSync(ledgerPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        ledger.push(JSON.parse(line) as LedgerEntry);
      } catch {
        /* torn line */
      }
    }
    if (ledger.length < 3) continue;

    // One run per strategy is enough to exercise all three registers.
    if (seenStrategies.has(state.strategy)) continue;
    seenStrategies.add(state.strategy);
    sources.push({ label: `${state.strategy} (${ledger.length} entries)`, state, ledger });
  }
  return sources;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Frame {
  event?: string;
  data?: string;
}

type DashboardPayload =
  | {
      kind: 'ledger';
      entry: { type: string };
      line?: { text: string };
    }
  | {
      kind: 'state';
      statement?: { closing: string };
    };

function openStream(base: string, onFrame: (f: Frame) => void): Promise<http.ClientRequest> {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname, port, path: '/api/stream?runId=all', method: 'GET', headers: { Accept: 'text/event-stream' } },
      (res) => {
        if (res.statusCode !== 200) return reject(new Error(`stream status ${res.statusCode}`));
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          buf += chunk;
          let i;
          while ((i = buf.indexOf('\n\n')) !== -1) {
            const raw = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const frame: Frame = {};
            for (const line of raw.split('\n')) {
              if (line.startsWith('event: ')) frame.event = line.slice(7);
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

interface ReplayOptions {
  source: Source;
  runsRootDir: string;
  bus: EventBus;
  store: RunStore;
}

async function replay({ source, runsRootDir, bus, store }: ReplayOptions): Promise<void> {
  const runId = `replay-${source.state.strategy}-${Date.now().toString(36)}`;
  const runDir = path.join(runsRootDir, runId);
  mkdirSync(runDir, { recursive: true });

  // Start from the recorded run but rewind it: running, no graph, nothing spent. The replay then
  // re-creates the run's history rather than revealing its ending immediately.
  const live: RunState = {
    ...source.state,
    runId,
    status: 'running',
    graph: null,
    costUsd: 0,
    workerCalls: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  store.save(live);

  const ledger = new Ledger(runDir, runId, live.strategy, bus);
  let previousTs = new Date(source.ledger[0].ts).getTime();
  let spent = 0;
  let calls = 0;

  for (const entry of source.ledger) {
    const ts = new Date(entry.ts).getTime();
    const gap = Number.isFinite(ts) ? Math.max(0, ts - previousTs) : 0;
    previousTs = ts;
    await wait(Math.min(MAX_GAP_MS, gap / SPEEDUP));

    ledger.record(entry.type, entry.data);

    if (entry.type === 'worker_call') {
      calls += 1;
      spent += typeof entry.data.costUsd === 'number' ? entry.data.costUsd : 0;
    }
    // The graph appears when the plan does, exactly as in a real run.
    if (entry.type === 'plan_created' && source.state.graph) live.graph = source.state.graph;

    live.costUsd = spent;
    live.workerCalls = calls;
    live.updatedAt = new Date().toISOString();
    store.save(live);
  }

  live.status = source.state.status;
  live.updatedAt = new Date().toISOString();
  store.save(live);
}

async function main(): Promise<void> {
  const sources = findSources();
  if (sources.length === 0) {
    log('No recorded runs found under benchmark/results or runs/. Nothing to replay.');
    log('Run a swarm (or `npm run smoke:engine`) once, then try again.');
    process.exitCode = 1;
    return;
  }
  log(`Replaying ${sources.length} recorded run(s) at ${SPEEDUP}x: ${sources.map((s) => s.label).join(', ')}`);

  const runsRootDir = path.join(os.tmpdir(), `swarm-dashboard-replay-${Date.now().toString(36)}`);
  mkdirSync(runsRootDir, { recursive: true });

  const bus = new EventBus();
  const store = new RunStore(runsRootDir, bus);
  const hold = process.env.SWARM_SMOKE_HOLD === '1';
  const base = loadDashboardConfig();

  const dashboard = new DashboardServer({
    runStore: store,
    runsRootDir,
    bus,
    // When holding for a browser, use the real configured port so the usual URL works.
    config: { ...base, enabled: true, port: hold ? base.port : 0 },
  });

  const url = await dashboard.start();
  if (!url) throw new Error('dashboard failed to start');
  log(`Dashboard at ${url}`);
  if (hold) {
    if (base.autoOpen) openInBrowser(url);
    log('Holding open — open that URL in a browser. Ctrl-C to stop.');
  }

  const ledgerFrames: { type: string; hasLine: boolean; text: string }[] = [];
  const statements: string[] = [];
  const req = await openStream(url, (frame) => {
    if (!frame.data) return;
    const payload = JSON.parse(frame.data) as DashboardPayload;
    if (payload.kind === 'ledger') {
      ledgerFrames.push({
        type: payload.entry.type,
        hasLine: Boolean(payload.line && payload.line.text),
        text: payload.line ? payload.line.text : '',
      });
    }
    if (payload.kind === 'state' && payload.statement) statements.push(payload.statement.closing);
  });

  for (const source of sources) await replay({ source, runsRootDir, bus, store });
  await wait(STREAM_DRAIN_DELAY_MS);

  const totalEntries = sources.reduce((n, s) => n + s.ledger.length, 0);
  const narrated = ledgerFrames.filter((f) => f.hasLine);
  const broken = narrated.filter((f) => /undefined|NaN|\[object Object\]/.test(f.text));

  const checks: [string, boolean][] = [
    ['every recorded entry was streamed', ledgerFrames.length === totalEntries],
    ['most entries produced a doctrine line', narrated.length > totalEntries * MINIMUM_NARRATED_RATIO],
    ['no ticker line contains undefined or NaN', broken.length === 0],
    // Only runs that actually ended get a closing statement. A run resting at awaiting_acceptance
    // has stopped working but has not finished — Claude's independent check is still to come — so
    // the page correctly says nothing final about it yet.
    [
      'a closing statement was delivered for each run that ended',
      statements.length === sources.filter((s) => isTerminal(s.state.status)).length,
    ],
  ];

  log(`Streamed ${ledgerFrames.length} of ${totalEntries} entries · ${narrated.length} narrated`);
  for (const closing of statements) log(`Closing: ${closing}`);
  for (const f of broken.slice(0, MAX_BROKEN_LINES_TO_LOG)) log(`BROKEN LINE (${f.type}): ${f.text}`);

  const ok = reportChecks('dashboard-replay', checks);

  if (hold) {
    // Leave the server up; the temp runs directory is cleaned by the OS.
    await new Promise(() => {});
  }

  req.destroy();
  await dashboard.stop();
  rmSync(runsRootDir, { recursive: true, force: true });

  if (!ok) {
    process.exitCode = 1;
    return;
  }
  log('All checks passed.');
}

main().catch((err) => {
  process.stderr.write(`[dashboard-replay] FATAL: ${String(err?.stack ?? err)}\n`);
  process.exitCode = 1;
});
