import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DashboardServer } from './DashboardServer.js';
import { EventBus } from '../engine/EventBus.js';
import { RunStore, type RunState } from '../engine/RunStore.js';
import type { DashboardConfig } from './config.js';
import type { DoctrinalStatement } from './DoctrinalStatement.js';
import type { LlmRhetorician } from './LlmRhetorician.js';

/**
 * Delivery of the re-voiced closing statement, end to end over the wire.
 *
 * LlmRhetorician.test.ts covers what the model is allowed to say. These cover whether any of it
 * ever reaches a page — which is a separate question, and the one that was actually broken: the
 * statement is composed after the terminal state frame, so anything that closes the stream on
 * that frame loses it, and nothing about revoice() in isolation would show that.
 */

const CONFIG: DashboardConfig = {
  enabled: true,
  port: 0,
  host: '127.0.0.1',
  autoOpen: false,
  rhetoric: 'llm',
  watch: false,
};

const RUN_ID = 'democratic-revoice-01';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await wait(10);
  }
  throw new Error('condition not met within timeout');
}

/** Minimal SSE client: EventSource is a browser API, so the framing is parsed here directly. */
class StreamClient {
  readonly frames: { event?: string; data?: string }[] = [];
  private req: http.ClientRequest | null = null;
  private buffer = '';

  constructor(private readonly base: string) {}

  connect(query = ''): Promise<void> {
    const { hostname, port } = new URL(this.base);
    return new Promise((resolve, reject) => {
      this.req = http.request(
        { hostname, port, path: `/api/stream${query}`, method: 'GET', headers: { Accept: 'text/event-stream' } },
        (res) => {
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            this.buffer += chunk;
            let split;
            while ((split = this.buffer.indexOf('\n\n')) !== -1) {
              const raw = this.buffer.slice(0, split);
              this.buffer = this.buffer.slice(split + 2);
              const frame: { event?: string; data?: string } = {};
              for (const l of raw.split('\n')) {
                if (l.startsWith('event: ')) frame.event = l.slice(7);
                else if (l.startsWith('data: ')) frame.data = l.slice(6);
              }
              this.frames.push(frame);
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

function makeState(status: RunState['status'] = 'running'): RunState {
  return {
    runId: RUN_ID,
    strategy: 'democratic',
    task: { goal: 'Drain the fens', acceptanceCriteria: [] },
    repoPath: '/repo',
    baseBranch: 'main',
    worktreePath: '/repo/.wt',
    branch: 'swarm/x',
    status,
    createdAt: '2026-01-01T10:00:00.000Z',
    updatedAt: '2026-01-01T10:05:00.000Z',
    budgetUsd: 5,
    costUsd: 1,
    tokensUsed: { prompt: 0, completion: 0 },
    workerCalls: 2,
    graph: null,
    pendingApprovals: [],
  };
}

/** Stands in for the model: slow, like a real call, and answering however the test needs. */
function rhetoricianReturning(result: DoctrinalStatement | null, delayMs = 150): LlmRhetorician {
  return {
    revoice: async () => {
      await wait(delayMs);
      return result;
    },
  } as unknown as LlmRhetorician;
}

const REVOICED: DoctrinalStatement = {
  title: 'Statement to the House',
  paragraphs: ['The House rose having carried what it came to carry.'],
  closing: 'deterministic closing, preserved',
};

let runsRootDir: string;
let bus: EventBus;
let server: DashboardServer;
let base: string;

async function startServer(rhetorician?: LlmRhetorician): Promise<void> {
  runsRootDir = mkdtempSync(path.join(tmpdir(), 'swarm-revoice-'));
  mkdirSync(path.join(runsRootDir, RUN_ID), { recursive: true });
  writeFileSync(path.join(runsRootDir, RUN_ID, 'state.json'), JSON.stringify(makeState()), 'utf8');
  writeFileSync(path.join(runsRootDir, RUN_ID, 'ledger.jsonl'), '', 'utf8');

  bus = new EventBus();
  server = new DashboardServer({
    runStore: new RunStore(runsRootDir, bus),
    runsRootDir,
    bus,
    config: CONFIG,
    rhetorician,
  });
  base = ((await server.start()) as string).replace(/\/$/, '');
}

async function getJson(url: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve(JSON.parse(body)));
      })
      .on('error', reject);
  });
}

beforeEach(() => {
  runsRootDir = '';
});

afterEach(async () => {
  await server?.stop();
  if (runsRootDir) rmSync(runsRootDir, { recursive: true, force: true });
});

describe('the re-voiced closing statement reaches the page', () => {
  it('announces on the terminal state frame that one is coming, then sends it', async () => {
    await startServer(rhetoricianReturning(REVOICED));
    const client = new StreamClient(base);
    await client.connect(`?runId=${RUN_ID}`);
    await until(() => server.clientCount === 1);

    bus.publish({ kind: 'state', runId: RUN_ID, state: makeState('completed'), source: 'engine' });

    // The terminal frame must carry the deterministic statement *and* the promise of another,
    // because that flag is the only thing telling the page not to close the connection.
    await until(() => client.events('state').length === 1);
    const state = JSON.parse(client.events('state')[0].data as string);
    expect(state.revoicing).toBe(true);
    expect(state.statement.paragraphs.length).toBeGreaterThan(0);
    expect(client.events('statement')).toHaveLength(0);

    await until(() => client.events('statement').length === 1);
    const frame = JSON.parse(client.events('statement')[0].data as string);
    expect(frame.statement.paragraphs).toEqual(REVOICED.paragraphs);
    client.close();
  });

  it('still sends a statement frame when the model is rejected, so no page waits forever', async () => {
    // revoice() returns null for invented figures, a failed call, or unusable output. The page is
    // holding its stream open on the strength of `revoicing`, so silence here would strand it.
    await startServer(rhetoricianReturning(null));
    const client = new StreamClient(base);
    await client.connect(`?runId=${RUN_ID}`);
    await until(() => server.clientCount === 1);

    bus.publish({ kind: 'state', runId: RUN_ID, state: makeState('completed'), source: 'engine' });

    await until(() => client.events('statement').length === 1);
    const frame = JSON.parse(client.events('statement')[0].data as string);
    // The deterministic statement, unchanged — the run still gets its closing words.
    expect(frame.statement.title).toBe('Statement to the House');
    expect(frame.statement.closing).toBe('The business of the House is concluded. The programme is commended to the House.');
    client.close();
  });

  it('serves the re-voiced statement to a page that loads after the run ended', async () => {
    await startServer(rhetoricianReturning(REVOICED));
    bus.publish({ kind: 'state', runId: RUN_ID, state: makeState('completed'), source: 'engine' });
    writeFileSync(path.join(runsRootDir, RUN_ID, 'state.json'), JSON.stringify(makeState('completed')), 'utf8');

    // A reload must not silently fall back to the template: what one viewer was shown is what
    // the next viewer, and the record of the run, should show too.
    await until(() => server.settledRuns === 1);
    const body = await getJson(`${base}/api/run/${RUN_ID}`);
    expect((body.statement as DoctrinalStatement).paragraphs).toEqual(REVOICED.paragraphs);
  });

  it('does not promise a statement when no rhetorician is configured', async () => {
    await startServer(undefined);
    const client = new StreamClient(base);
    await client.connect(`?runId=${RUN_ID}`);
    await until(() => server.clientCount === 1);

    bus.publish({ kind: 'state', runId: RUN_ID, state: makeState('completed'), source: 'engine' });

    await until(() => client.events('state').length === 1);
    const state = JSON.parse(client.events('state')[0].data as string);
    // Off by default: the page closes on the terminal frame exactly as it always did.
    expect(state.revoicing).toBe(false);
    await wait(200);
    expect(client.events('statement')).toHaveLength(0);
    client.close();
  });
});
