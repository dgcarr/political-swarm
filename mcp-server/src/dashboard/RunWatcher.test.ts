import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RunWatcher } from './RunWatcher.js';
import { EventBus, type SwarmEvent } from '../engine/EventBus.js';
import { Ledger } from '../engine/Ledger.js';
import { DashboardServer } from './DashboardServer.js';
import { RunStore, type RunState } from '../engine/RunStore.js';
import type { DashboardConfig } from './config.js';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await wait(20);
  }
  throw new Error('condition not met within timeout');
}

function makeState(runId: string): RunState {
  return {
    runId,
    strategy: 'capitalist',
    task: { goal: 'Out of process work', acceptanceCriteria: [] },
    repoPath: '/repo',
    baseBranch: 'main',
    worktreePath: '/wt',
    branch: 'b',
    status: 'running',
    createdAt: '2026-01-01T10:00:00.000Z',
    updatedAt: '2026-01-01T10:00:00.000Z',
    budgetUsd: 5,
    costUsd: 0,
    tokensUsed: { prompt: 0, completion: 0 },
    workerCalls: 0,
    graph: null,
    pendingApprovals: [],
  };
}

function line(type: string, data: Record<string, unknown> = {}): string {
  return JSON.stringify({ ts: new Date().toISOString(), runId: 'external-run', type, data }) + '\n';
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'swarm-watch-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('RunWatcher', () => {
  it('publishes ledger lines written by another process', async () => {
    const bus = new EventBus();
    const seen: SwarmEvent[] = [];
    bus.subscribe((e) => seen.push(e));

    const watcher = new RunWatcher(root, bus);
    watcher.start();

    // A run that appears after the watcher started, as the benchmark harness would create it.
    const runDir = path.join(root, 'external-run');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(path.join(runDir, 'state.json'), JSON.stringify(makeState('external-run')), 'utf8');
    appendFileSync(path.join(runDir, 'ledger.jsonl'), line('plan_created', { nodeCount: 2 }), 'utf8');

    await until(() => seen.some((e) => e.kind === 'ledger' && e.entry.type === 'plan_created'));
    const event = seen.find((e) => e.kind === 'ledger')!;
    expect(event.source).toBe('watch');
    expect(event.runId).toBe('external-run');
    expect(seen.some((e) => e.kind === 'state')).toBe(true);

    watcher.stop();
  });

  it('finds runs nested one level deep, as the plugin groups them', async () => {
    const bus = new EventBus();
    const seen: SwarmEvent[] = [];
    bus.subscribe((e) => seen.push(e));

    const runDir = path.join(root, 'benchmark', 'external-run');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(path.join(runDir, 'state.json'), JSON.stringify(makeState('external-run')), 'utf8');

    const watcher = new RunWatcher(root, bus);
    watcher.start();
    appendFileSync(path.join(runDir, 'ledger.jsonl'), line('worker_call', { role: 'planner' }), 'utf8');

    await until(() => seen.some((e) => e.kind === 'ledger' && e.entry.type === 'worker_call'));
    watcher.stop();
  });

  it('does not replay history that existed before it started', async () => {
    const runDir = path.join(root, 'old-run');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(path.join(runDir, 'state.json'), JSON.stringify(makeState('old-run')), 'utf8');
    writeFileSync(path.join(runDir, 'ledger.jsonl'), line('ancient') + line('history'), 'utf8');

    const bus = new EventBus();
    const seen: SwarmEvent[] = [];
    bus.subscribe((e) => seen.push(e));

    const watcher = new RunWatcher(root, bus);
    watcher.start();
    await wait(250);

    // The page loads history over /api/run/:id; re-emitting it here would only duplicate it.
    expect(seen.filter((e) => e.kind === 'ledger')).toHaveLength(0);

    appendFileSync(path.join(runDir, 'ledger.jsonl'), line('fresh'), 'utf8');
    await until(() => seen.some((e) => e.kind === 'ledger' && e.entry.type === 'fresh'));
    expect(seen.filter((e) => e.kind === 'ledger')).toHaveLength(1);

    watcher.stop();
  });

  it('waits for a torn line to be completed rather than dropping it', async () => {
    const bus = new EventBus();
    const seen: SwarmEvent[] = [];
    bus.subscribe((e) => seen.push(e));

    const runDir = path.join(root, 'partial-run');
    mkdirSync(runDir, { recursive: true });
    const file = path.join(runDir, 'ledger.jsonl');
    writeFileSync(file, '', 'utf8');

    const watcher = new RunWatcher(root, bus);
    watcher.start();

    const whole = line('split_entry', { n: 1 });
    appendFileSync(file, whole.slice(0, 20), 'utf8');
    await wait(250);
    expect(seen.filter((e) => e.kind === 'ledger')).toHaveLength(0);

    appendFileSync(file, whole.slice(20), 'utf8');
    await until(() => seen.some((e) => e.kind === 'ledger' && e.entry.type === 'split_entry'));

    watcher.stop();
  });

  it('does not corrupt a multi-byte character torn across two reads', async () => {
    const bus = new EventBus();
    const seen: SwarmEvent[] = [];
    bus.subscribe((e) => seen.push(e));

    const runDir = path.join(root, 'utf8-run');
    mkdirSync(runDir, { recursive: true });
    const file = path.join(runDir, 'ledger.jsonl');
    writeFileSync(file, '', 'utf8');

    const watcher = new RunWatcher(root, bus);
    watcher.start();

    // The goal text is the kind of thing a run actually carries, and every one of these is a
    // multi-byte character. The split lands inside one of them.
    const whole = Buffer.from(
      JSON.stringify({ ts: '2026-01-01T10:00:00.000Z', runId: 'utf8-run', type: 'goal', data: { text: 'né—Ω日本' } }) +
        '\n',
      'utf8',
    );
    const cut = whole.indexOf(Buffer.from('—', 'utf8')) + 1; // mid-codepoint, by construction
    appendFileSync(file, whole.subarray(0, cut));
    await wait(250);
    appendFileSync(file, whole.subarray(cut));

    const isGoal = (e: SwarmEvent): e is Extract<SwarmEvent, { kind: 'ledger' }> =>
      e.kind === 'ledger' && e.entry.type === 'goal';
    await until(() => seen.some(isGoal));
    // A byte-level split decoded eagerly would leave U+FFFD here instead of the original text.
    expect(seen.find(isGoal)?.entry.data.text).toBe('né—Ω日本');

    watcher.stop();
  });

  it('publishes a state rewrite that lands on the same mtime', async () => {
    const bus = new EventBus();
    const seen: SwarmEvent[] = [];
    bus.subscribe((e) => seen.push(e));

    const runDir = path.join(root, 'mtime-run');
    mkdirSync(runDir, { recursive: true });
    const file = path.join(runDir, 'state.json');

    const watcher = new RunWatcher(root, bus);
    watcher.start();

    // Both writes are pinned to one timestamp, which is what a filesystem whose timestamps are
    // coarser than the gap between two writes would give them anyway.
    const PINNED = 1_700_000_000;
    writeFileSync(file, JSON.stringify(makeState('mtime-run')), 'utf8');
    utimesSync(file, PINNED, PINNED);
    await until(() => seen.some((e) => e.kind === 'state'));
    expect(statSync(file).mtimeMs).toBe(PINNED * 1000);

    // An mtime gate drops this one permanently — every later sweep compares equal too — and with
    // it the terminal status, leaving the run showing as running for the life of the page.
    writeFileSync(file, JSON.stringify({ ...makeState('mtime-run'), status: 'completed' as const }), 'utf8');
    utimesSync(file, PINNED, PINNED);

    await until(() => seen.some((e) => e.kind === 'state' && e.state.status === 'completed'));
    watcher.stop();
  });

  it('retries a half-written state.json instead of marking it seen', async () => {
    const bus = new EventBus();
    const seen: SwarmEvent[] = [];
    bus.subscribe((e) => seen.push(e));

    const runDir = path.join(root, 'torn-state-run');
    mkdirSync(runDir, { recursive: true });
    const file = path.join(runDir, 'state.json');
    const complete = JSON.stringify(makeState('torn-state-run'));
    writeFileSync(file, complete.slice(0, complete.length - 10), 'utf8');

    const watcher = new RunWatcher(root, bus);
    watcher.start();
    await wait(250);
    expect(seen.filter((e) => e.kind === 'state')).toHaveLength(0);

    // The completing write is what the watcher must not have already written off.
    writeFileSync(file, complete, 'utf8');
    await until(() => seen.some((e) => e.kind === 'state'));

    watcher.stop();
  });

  it('stops cleanly and publishes nothing afterwards', async () => {
    const bus = new EventBus();
    const seen: SwarmEvent[] = [];
    bus.subscribe((e) => seen.push(e));

    const runDir = path.join(root, 'stop-run');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(path.join(runDir, 'ledger.jsonl'), '', 'utf8');

    const watcher = new RunWatcher(root, bus);
    watcher.start();
    watcher.stop();

    appendFileSync(path.join(runDir, 'ledger.jsonl'), line('after_stop'), 'utf8');
    await wait(300);
    expect(seen).toHaveLength(0);
  });
});

describe('grouped run layouts', () => {
  it('finds runs both flat and grouped one level deep', async () => {
    const { listAllRuns, resolveRunDir } = await import('./DashboardServer.js');

    mkdirSync(path.join(root, 'flat-run'), { recursive: true });
    writeFileSync(path.join(root, 'flat-run', 'state.json'), JSON.stringify(makeState('flat-run')), 'utf8');

    mkdirSync(path.join(root, 'benchmark', 'grouped-run'), { recursive: true });
    writeFileSync(
      path.join(root, 'benchmark', 'grouped-run', 'state.json'),
      JSON.stringify({ ...makeState('grouped-run'), createdAt: '2026-02-01T00:00:00.000Z' }),
      'utf8',
    );

    const ids = listAllRuns(root).map((s) => s.runId);
    expect(ids).toContain('flat-run');
    // RunStore only understands the flat layout; the benchmark harness writes the grouped one.
    expect(ids).toContain('grouped-run');
    // Newest first.
    expect(ids[0]).toBe('grouped-run');

    expect(resolveRunDir(root, 'grouped-run')).toBe(path.join(root, 'benchmark', 'grouped-run'));
    expect(resolveRunDir(root, 'flat-run')).toBe(path.join(root, 'flat-run'));
    expect(resolveRunDir(root, 'no-such-run')).toBeNull();
  });

  it('serves a grouped run over the API, not just a flat one', async () => {
    const bus = new EventBus();
    const server = new DashboardServer({
      runStore: new RunStore(root, bus),
      runsRootDir: root,
      bus,
      config: { enabled: true, port: 0, host: '127.0.0.1', autoOpen: false, rhetoric: 'template', watch: false },
    });
    const url = (await server.start()) as string;

    const dir = path.join(root, 'benchmark', 'api-run');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'state.json'), JSON.stringify(makeState('api-run')), 'utf8');
    writeFileSync(
      path.join(dir, 'ledger.jsonl'),
      JSON.stringify({ ts: '2026-01-01T10:00:00.000Z', runId: 'api-run', type: 'plan_created', data: { nodeCount: 2 } }) + '\n',
      'utf8',
    );

    const detail = await (await fetch(`${url}api/run/api-run`)).json();
    expect(detail.state.runId).toBe('api-run');
    expect(detail.ledger).toHaveLength(1);
    expect(detail.ticker[0].text).toContain('2 contracts');

    await server.stop();
  });
});

describe('duplicate suppression', () => {
  const config: DashboardConfig = {
    enabled: true,
    port: 0,
    host: '127.0.0.1',
    autoOpen: false,
    rhetoric: 'template',
    watch: true,
  };

  it('reports an in-process run once, not twice', async () => {
    // A run written by this process is published by the engine *and* seen by the watcher. The
    // server must prefer the engine's copy, or every line appears twice on the page.
    const bus = new EventBus();
    const store = new RunStore(root, bus);
    const server = new DashboardServer({ runStore: store, runsRootDir: root, bus, config });
    const url = (await server.start()) as string;

    const runId = 'owned-run';
    const runDir = path.join(root, runId);
    mkdirSync(runDir, { recursive: true });
    store.save({ ...makeState(runId), runId });

    const frames: string[] = [];
    const res = await fetch(`${url}api/stream?runId=${runId}`);
    const reader = res.body!.getReader();
    const pump = (async () => {
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        const text = decoder.decode(value);
        for (const l of text.split('\n')) if (l.startsWith('data: ')) frames.push(l.slice(6));
      }
    })();

    await wait(100);
    const ledger = new Ledger(runDir, runId, 'capitalist', bus);
    ledger.record('only_once', { n: 1 });

    // Long enough for a watcher sweep to have also noticed the append.
    await wait(900);

    const ledgerFrames = frames.map((f) => JSON.parse(f)).filter((p) => p.kind === 'ledger');
    expect(ledgerFrames.filter((p) => p.entry.type === 'only_once')).toHaveLength(1);

    await reader.cancel().catch(() => {});
    await server.stop();
    await pump.catch(() => {});
  });
});
