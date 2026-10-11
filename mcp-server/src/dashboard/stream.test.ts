import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DashboardServer } from './DashboardServer.js';
import { EventBus } from '../engine/EventBus.js';
import { Ledger } from '../engine/Ledger.js';
import { RunStore, type RunState } from '../engine/RunStore.js';
import type { DashboardConfig } from './config.js';

const CONFIG: DashboardConfig = {
  enabled: true,
  port: 0,
  host: '127.0.0.1',
  autoOpen: false,
  rhetoric: 'template',
};

const RUN_ID = 'democratic-stream-01';

/**
 * Minimal SSE client. EventSource is a browser API, so the framing is parsed here directly —
 * which also means these tests assert the wire format a browser will actually receive.
 */
class StreamClient {
  readonly frames: { id?: string; event?: string; data?: string }[] = [];
  private req: http.ClientRequest | null = null;
  private buffer = '';

  constructor(private readonly base: string) {}

  connect(query = '', headers: Record<string, string> = {}): Promise<void> {
    const { hostname, port } = new URL(this.base);
    return new Promise((resolve, reject) => {
      this.req = http.request(
        { hostname, port, path: `/api/stream${query}`, method: 'GET', headers: { Accept: 'text/event-stream', ...headers } },
        (res) => {
          if (res.statusCode !== 200) {
            reject(new Error(`stream status ${res.statusCode}`));
            return;
          }
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            this.buffer += chunk;
            let split;
            while ((split = this.buffer.indexOf('\n\n')) !== -1) {
              const raw = this.buffer.slice(0, split);
              this.buffer = this.buffer.slice(split + 2);
              this.frames.push(parseFrame(raw));
            }
          });
          resolve();
        },
      );
      this.req.on('error', reject);
      this.req.end();
    });
  }

  close(): void {
    this.req?.destroy();
    this.req = null;
  }

  events(kind: string) {
    return this.frames.filter((f) => f.event === kind);
  }
}

function parseFrame(raw: string): { id?: string; event?: string; data?: string } {
  const frame: { id?: string; event?: string; data?: string } = {};
  for (const line of raw.split('\n')) {
    if (line.startsWith('id: ')) frame.id = line.slice(4);
    else if (line.startsWith('event: ')) frame.event = line.slice(7);
    else if (line.startsWith('data: ')) frame.data = line.slice(6);
  }
  return frame;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll rather than sleep blindly, so the tests stay fast and are not timing-flaky. */
async function until(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await wait(10);
  }
  throw new Error('condition not met within timeout');
}

let runsRootDir: string;
let bus: EventBus;
let server: DashboardServer;
let runStore: RunStore;
let base: string;

function makeState(): RunState {
  return {
    runId: RUN_ID,
    strategy: 'democratic',
    task: { goal: 'Drain the fens', acceptanceCriteria: [] },
    repoPath: '/repo',
    baseBranch: 'main',
    worktreePath: '/repo/.wt',
    branch: 'swarm/x',
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

beforeAll(async () => {
  runsRootDir = mkdtempSync(path.join(tmpdir(), 'swarm-sse-'));
  mkdirSync(path.join(runsRootDir, RUN_ID), { recursive: true });
  writeFileSync(path.join(runsRootDir, RUN_ID, 'state.json'), JSON.stringify(makeState()), 'utf8');

  bus = new EventBus();
  runStore = new RunStore(runsRootDir, bus);
  server = new DashboardServer({ runStore, runsRootDir, bus, config: CONFIG });
  base = ((await server.start()) as string).replace(/\/$/, '');
});

afterAll(async () => {
  await server.stop();
  rmSync(runsRootDir, { recursive: true, force: true });
});

describe('GET /api/stream', () => {
  it('pushes ledger entries as they are recorded', async () => {
    const client = new StreamClient(base);
    await client.connect(`?runId=${RUN_ID}`);
    await until(() => server.clientCount === 1);

    const ledger = new Ledger(path.join(runsRootDir, RUN_ID), RUN_ID, 'democratic', bus);
    ledger.record('plan_created', { nodeCount: 3 });

    await until(() => client.events('ledger').length === 1);
    const frame = client.events('ledger')[0];
    expect(Number(frame.id)).toBeGreaterThan(0);
    expect(JSON.parse(frame.data as string)).toMatchObject({
      kind: 'ledger',
      runId: RUN_ID,
      entry: { type: 'plan_created', data: { nodeCount: 3 } },
    });

    client.close();
    await until(() => server.clientCount === 0);
  });

  it('pushes state snapshots on save', async () => {
    const client = new StreamClient(base);
    await client.connect(`?runId=${RUN_ID}`);
    await until(() => server.clientCount === 1);

    const state = makeState();
    state.costUsd = 1.5;
    runStore.save(state);

    await until(() => client.events('state').length === 1);
    const payload = JSON.parse(client.events('state')[0].data as string);
    expect(payload.state.costUsd).toBe(1.5);

    client.close();
    await until(() => server.clientCount === 0);
  });

  it('does not leak another run\'s events to a run-scoped client', async () => {
    const client = new StreamClient(base);
    await client.connect(`?runId=${RUN_ID}`);
    await until(() => server.clientCount === 1);

    const otherDir = path.join(runsRootDir, 'capitalist-other-99');
    new Ledger(otherDir, 'capitalist-other-99', 'capitalist', bus).record('bids_received', { bids: [] });
    new Ledger(path.join(runsRootDir, RUN_ID), RUN_ID, 'democratic', bus).record('task_decided', { taskId: 't1' });

    await until(() => client.events('ledger').length >= 1);
    await wait(50); // give the foreign event every chance to arrive if filtering were broken
    const types = client.events('ledger').map((f) => JSON.parse(f.data as string).entry.type);
    expect(types).toEqual(['task_decided']);

    client.close();
    await until(() => server.clientCount === 0);
  });

  it('sends every run to a client subscribed to all', async () => {
    const client = new StreamClient(base);
    await client.connect('?runId=all');
    await until(() => server.clientCount === 1);

    new Ledger(path.join(runsRootDir, RUN_ID), RUN_ID, 'democratic', bus).record('a', {});
    new Ledger(path.join(runsRootDir, 'capitalist-other-99'), 'capitalist-other-99', 'capitalist', bus).record('b', {});

    await until(() => client.events('ledger').length === 2);
    client.close();
    await until(() => server.clientCount === 0);
  });

  it('replays missed events for a client reconnecting with Last-Event-ID', async () => {
    const first = new StreamClient(base);
    await first.connect(`?runId=${RUN_ID}`);
    await until(() => server.clientCount === 1);

    const ledger = new Ledger(path.join(runsRootDir, RUN_ID), RUN_ID, 'democratic', bus);
    ledger.record('before_drop', {});
    await until(() => first.events('ledger').length === 1);
    const lastId = first.events('ledger')[0].id as string;

    first.close();
    await until(() => server.clientCount === 0);

    // Recorded while nobody was listening — the buffer has to carry it.
    ledger.record('during_gap_one', {});
    ledger.record('during_gap_two', {});

    const second = new StreamClient(base);
    await second.connect(`?runId=${RUN_ID}`, { 'Last-Event-ID': lastId });
    await until(() => second.events('ledger').length === 2);

    const types = second.events('ledger').map((f) => JSON.parse(f.data as string).entry.type);
    expect(types).toEqual(['during_gap_one', 'during_gap_two']);

    second.close();
    await until(() => server.clientCount === 0);
  });

  it('rejects a malformed runId', async () => {
    const client = new StreamClient(base);
    await expect(client.connect('?runId=' + encodeURIComponent('../../etc'))).rejects.toThrow(/status 400/);
  });
});

describe('leak gate', () => {
  it('keeps bus listeners at one and clients at zero across 20 connect/disconnect cycles', async () => {
    for (let i = 0; i < 20; i += 1) {
      const client = new StreamClient(base);
      await client.connect(`?runId=${RUN_ID}`);
      await until(() => server.clientCount === 1);
      client.close();
      await until(() => server.clientCount === 0);
    }

    // One subscription for the server's lifetime, fanned out internally — never one per tab.
    expect(bus.listenerCount()).toBe(1);
    expect(server.clientCount).toBe(0);
  });

  it('releases its bus subscription on stop', async () => {
    const localBus = new EventBus();
    const local = new DashboardServer({
      runStore: new RunStore(runsRootDir, localBus),
      runsRootDir,
      bus: localBus,
      config: CONFIG,
    });
    await local.start();
    expect(localBus.listenerCount()).toBe(1);
    await local.stop();
    expect(localBus.listenerCount()).toBe(0);
  });
});
