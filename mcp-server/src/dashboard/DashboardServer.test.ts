import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { DashboardServer, readLedgerTolerant, toSummary } from './DashboardServer.js';
import { RunStore, type RunState } from '../engine/RunStore.js';
import { EventBus } from '../engine/EventBus.js';
import type { DashboardConfig } from './config.js';

const TEST_CONFIG: DashboardConfig = {
  enabled: true,
  port: 0, // ephemeral — never collide with a real dashboard on the developer's machine
  host: '127.0.0.1',
  autoOpen: false,
  rhetoric: 'template',
};

function makeState(overrides: Partial<RunState> = {}): RunState {
  return {
    runId: 'democratic-abc123-ff00aa',
    strategy: 'democratic',
    task: { goal: 'Repair the drainage in the west wing', acceptanceCriteria: ['tests pass'] },
    repoPath: '/repo',
    baseBranch: 'main',
    worktreePath: '/repo/.worktree',
    branch: 'swarm/democratic-abc123',
    status: 'running',
    createdAt: '2026-01-01T10:00:00.000Z',
    updatedAt: '2026-01-01T10:05:00.000Z',
    budgetUsd: 5,
    costUsd: 0.4213,
    tokensUsed: { prompt: 100, completion: 50 },
    workerCalls: 3,
    graph: {
      order: ['t1', 't2'],
      nodes: {
        t1: {
          id: 't1',
          title: 'Survey the culvert',
          phase: 'settled',
          attempts: [{ attempt: 1, outcome: 'approved', rationale: 'approved by test', evidenceRefs: [], at: '2026-01-01T10:04:00.000Z' }],
          dependsOn: [],
        },
        t2: { id: 't2', title: 'Lay the new pipe', phase: 'running', attempts: [], dependsOn: ['t1'] },
      },
    },
    pendingApprovals: [],
    ...overrides,
  } as RunState;
}

let runsRootDir: string;
let bannerDir: string;
let server: DashboardServer;
let base: string;

/**
 * fetch() normalises the request path and forbids overriding Host, so the traversal and
 * DNS-rebinding cases have to go over a raw socket to reach the server as an attacker would
 * actually send them.
 */
function rawGet(
  requestPath: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname, port, path: requestPath, method: 'GET', headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

beforeAll(async () => {
  runsRootDir = mkdtempSync(path.join(tmpdir(), 'swarm-dash-'));

  const state = makeState();
  const runDir = path.join(runsRootDir, state.runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(path.join(runDir, 'state.json'), JSON.stringify(state, null, 2), 'utf8');
  writeFileSync(
    path.join(runDir, 'ledger.jsonl'),
    [
      JSON.stringify({ ts: '2026-01-01T10:00:01.000Z', runId: state.runId, type: 'plan_created', data: { nodeCount: 2 } }),
      JSON.stringify({ ts: '2026-01-01T10:00:09.000Z', runId: state.runId, type: 'worker_call', data: { role: 'planner' } }),
      '',
    ].join('\n'),
    'utf8',
  );

  // A poster library of its own, so these tests neither depend on nor disturb the one that ships.
  bannerDir = mkdtempSync(path.join(tmpdir(), 'swarm-posters-'));
  mkdirSync(path.join(bannerDir, 'socialist'), { recursive: true });
  writeFileSync(path.join(bannerDir, 'socialist', 'plan.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>', 'utf8');
  writeFileSync(path.join(bannerDir, 'socialist', 'secret-note.txt'), 'not a poster', 'utf8');

  server = new DashboardServer({
    runStore: new RunStore(runsRootDir),
    runsRootDir,
    config: { ...TEST_CONFIG, bannerDir },
  });
  const url = await server.start();
  expect(url).not.toBeNull();
  base = (url as string).replace(/\/$/, '');
});

afterAll(async () => {
  await server.stop();
  rmSync(runsRootDir, { recursive: true, force: true });
  rmSync(bannerDir, { recursive: true, force: true });
});

describe('the propaganda banner', () => {
  it('lists a tradition’s posters', async () => {
    const res = await fetch(`${base}/api/banner/socialist`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.strategy).toBe('socialist');
    expect(body.intervalMs).toBeGreaterThan(0);
    expect(body.posters).toHaveLength(1);
    expect(body.posters[0]).toMatchObject({ file: 'plan.svg', url: '/banner/socialist/plan.svg' });
  });

  it('reports an unfilled library as empty rather than as an error', async () => {
    const res = await fetch(`${base}/api/banner/capitalist`);
    expect(res.status).toBe(200);
    expect((await res.json()).posters).toEqual([]);
  });

  it('404s a tradition that has no poster tradition', async () => {
    expect((await fetch(`${base}/api/banner/noop`)).status).toBe(404);
    expect((await fetch(`${base}/api/banner/${encodeURIComponent('../../etc')}`)).status).toBe(404);
  });

  it('serves a poster with its own type, and lets the browser cache it', async () => {
    const res = await fetch(`${base}/banner/socialist/plan.svg`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/svg+xml');
    // Every other route is no-store; a poster re-requested every few seconds must not be.
    expect(res.headers.get('cache-control')).toMatch(/max-age=\d+/);
    // Still carries the page's policy, so a poster opened in a tab cannot run inline script.
    expect(res.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('serves only images, never another file that happens to sit in the library', async () => {
    expect((await fetch(`${base}/banner/socialist/secret-note.txt`)).status).toBe(404);
  });

  it('refuses to climb out of the poster library, however the path is spelled', async () => {
    for (const attempt of [
      '/banner/socialist/../../../etc/passwd',
      '/banner/socialist/..%2f..%2fsecret.png',
      '/banner/socialist/%2e%2e%2fplan.svg',
      '/banner/../socialist/plan.svg',
      '/banner/socialist/sub/plan.svg',
      '/banner/socialist/.hidden.png',
    ]) {
      const res = await rawGet(attempt);
      expect(res.status, attempt).toBe(404);
      expect(res.body, attempt).not.toContain('<svg');
    }
  });

  it('turns the banner off entirely when configured off', async () => {
    const dark = new DashboardServer({
      runStore: new RunStore(runsRootDir),
      runsRootDir,
      config: { ...TEST_CONFIG, bannerDir, banner: false },
    });
    const url = await dark.start();
    try {
      const res = await fetch(`${(url as string).replace(/\/$/, '')}/api/banner/socialist`);
      expect((await res.json()).posters).toEqual([]);
    } finally {
      await dark.stop();
    }
  });
});

describe('routes', () => {
  it('binds loopback only', () => {
    expect(base).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('GET /api/runs returns a summary per run', async () => {
    const res = await fetch(`${base}/api/runs`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0]).toMatchObject({
      runId: 'democratic-abc123-ff00aa',
      strategy: 'democratic',
      status: 'running',
      taskCount: 2,
      pendingApprovals: 0,
    });
  });

  it.each([
    { task: undefined },
    { task: null },
    { task: {} },
    { pendingApprovals: undefined },
    { pendingApprovals: [null] },
    { graph: { order: [], nodes: null } },
  ])('keeps valid runs available alongside an incomplete snapshot: %j', async (overrides) => {
    const exampleDir = path.join(runsRootDir, 'examples', 'incomplete-example');
    mkdirSync(exampleDir, { recursive: true });
    writeFileSync(path.join(exampleDir, 'state.json'), JSON.stringify({
      ...makeState({ runId: 'incomplete-example' }),
      ...overrides,
    }));
    try {
      const res = await fetch(`${base}/api/runs`);
      expect(res.status).toBe(200);
      expect((await res.json()).runs.map((run: { runId: string }) => run.runId))
        .toEqual(['democratic-abc123-ff00aa']);
    } finally {
      rmSync(exampleDir, { recursive: true, force: true });
    }
  });

  it('GET /api/run/:id returns state and the parsed ledger', async () => {
    const res = await fetch(`${base}/api/run/democratic-abc123-ff00aa`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.state.task.goal).toBe('Repair the drainage in the west wing');
    expect(body.ledger.map((e: { type: string }) => e.type)).toEqual(['plan_created', 'worker_call']);
  });

  it('404s an unknown run and 400s a malformed run id', async () => {
    expect((await fetch(`${base}/api/run/does-not-exist`)).status).toBe(404);
    expect((await fetch(`${base}/api/run/${encodeURIComponent('../../etc/passwd')}`)).status).toBe(400);
  });

  it('serves the page and its assets, and nothing outside public/', async () => {
    const page = await fetch(`${base}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toMatch(/text\/html/);
    expect(await page.text()).toContain('Political Swarm');

    expect((await fetch(`${base}/assets/app.js`)).status).toBe(200);
    expect((await fetch(`${base}/assets/styles.css`)).status).toBe(200);
    expect((await fetch(`${base}/assets/nothing.js`)).status).toBe(404);
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });

  it('refuses to climb out of public/, however the path is spelled', async () => {
    for (const attempt of [
      '/assets/../paths.js',
      '/assets/../../index.js',
      '/assets/%2e%2e%2fpaths.js',
      '/assets/..%2fpaths.js',
      '/assets/../public/../paths.js',
    ]) {
      const res = await rawGet(attempt);
      expect(res.status, attempt).toBe(404);
      // 'publicDir' is unique to paths.ts — its absence proves no compiled source was served.
      expect(res.body, attempt).not.toContain('publicDir');
    }

    // A bare '/assets/..' is resolved to '/' by URL normalisation before routing, so it serves
    // the page rather than 404ing. Harmless, but worth pinning: it must never reach a file.
    const bare = await rawGet('/assets/..');
    expect(bare.body).toContain('Political Swarm');
    expect(bare.body).not.toContain('publicDir');
  });
});

describe('read-only and same-origin guarantees', () => {
  it('rejects every method that could mutate state', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await fetch(`${base}/api/runs`, { method });
      expect(res.status).toBe(405);
    }
  });

  it('rejects a foreign Host header, blunting DNS rebinding', async () => {
    expect((await rawGet('/api/runs', { Host: 'evil.example.com' })).status).toBe(403);
    expect((await rawGet('/api/runs', { Host: 'localhost:1234' })).status).toBe(200);
  });

  it('never sends CORS headers — no other origin may read the ledger', async () => {
    const res = await fetch(`${base}/api/runs`, { headers: { Origin: 'https://evil.example.com' } });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });
});

describe('startup', () => {
  it('stands down rather than throwing when the port is taken', async () => {
    const first = new DashboardServer({ runStore: new RunStore(runsRootDir), runsRootDir, config: TEST_CONFIG });
    const firstUrl = await first.start();
    expect(firstUrl).not.toBeNull();

    const takenPort = Number(new URL(firstUrl as string).port);
    const second = new DashboardServer({
      runStore: new RunStore(runsRootDir),
      runsRootDir,
      config: { ...TEST_CONFIG, port: takenPort },
    });

    await expect(second.start()).resolves.toBeNull();
    // The first instance is unharmed and still serving.
    expect((await fetch(`${firstUrl}api/runs`)).status).toBe(200);

    await second.stop();
    await first.stop();
  });

  it('does not start at all when disabled', async () => {
    const disabled = new DashboardServer({
      runStore: new RunStore(runsRootDir),
      runsRootDir,
      config: { ...TEST_CONFIG, enabled: false },
    });
    await expect(disabled.start()).resolves.toBeNull();
    expect(disabled.url).toBeNull();
  });
});

describe('malformed requests', () => {
  it('answers 400, not 500, for a run id that is not valid percent-encoding', async () => {
    // decodeURIComponent throws on a lone '%'. Reporting that as an internal error would blame
    // the server for the client's request.
    const res = await fetch(`${base}/api/run/%`);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Invalid run id');
  });

  it('still rejects a traversal attempt that decodes cleanly', async () => {
    const res = await fetch(`${base}/api/run/${encodeURIComponent('../../etc/passwd')}`);
    expect(res.status).toBe(400);
  });
});

describe('security headers on the wire', () => {
  it('sends the content security policy with an asset, not only with JSON', async () => {
    for (const route of ['/', '/api/runs']) {
      const res = await fetch(`${base}${route}`);
      const csp = res.headers.get('content-security-policy');
      expect(csp, route).toContain("default-src 'none'");
      expect(csp, route).toContain("frame-ancestors 'none'");
      expect(csp, route).not.toContain('unsafe-inline');
      expect(res.headers.get('x-content-type-options'), route).toBe('nosniff');
      expect(res.headers.get('access-control-allow-origin'), route).toBeNull();
    }
  });

  it('serves a page whose own assets the policy actually permits', async () => {
    // 'self' covers /assets/*, so the two files the page loads must both come back 200.
    for (const asset of ['/assets/app.js', '/assets/styles.css']) {
      expect((await fetch(`${base}${asset}`)).status, asset).toBe(200);
    }
  });
});

describe('readLedgerTolerant', () => {
  it('returns [] for a ledger that does not exist yet', () => {
    expect(readLedgerTolerant(path.join(runsRootDir, 'nope', 'ledger.jsonl'))).toEqual([]);
  });

  it('skips a torn final line instead of throwing', () => {
    const file = path.join(runsRootDir, 'democratic-abc123-ff00aa', 'ledger.jsonl');
    appendFileSync(file, '{"ts":"2026-01-01T10:00:11.000Z","runId":"x","type":"worker_ca', 'utf8');
    const entries = readLedgerTolerant(file);
    expect(entries).toHaveLength(2);
    expect(entries[1].type).toBe('worker_call');
  });
});

describe('toSummary', () => {
  it('reports zero tasks before a plan exists', () => {
    expect(toSummary(makeState({ graph: null })).taskCount).toBe(0);
  });

  it('counts only unresolved approvals as pending', () => {
    const approval = (id: string, resolvedAt?: string) =>
      ({ id, kind: 'budget_increase', description: 'more budget', createdAt: '2026-01-01T10:00:00.000Z', resolvedAt }) as const;
    const summary = toSummary(
      makeState({
        pendingApprovals: [approval('a1', '2026-01-01T10:01:00.000Z'), approval('a2'), approval('a3', '2026-01-01T10:02:00.000Z')],
      }),
    );
    expect(summary.pendingApprovals).toBe(1);
  });
});

describe('memory held per run', () => {
  /**
   * The watcher surfaces every run under runs/, including the whole historical archive, and the
   * MCP server outlives all of them. Without a ceiling these structures only ever grow — so the
   * ceiling is asserted rather than assumed.
   */
  it('stops tracking the oldest runs rather than growing without bound', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'swarm-ceiling-'));
    const bus = new EventBus();
    const server = new DashboardServer({
      runStore: new RunStore(dir, bus),
      runsRootDir: dir,
      bus,
      config: { ...TEST_CONFIG, watch: false },
    });
    await server.start();

    try {
      for (let i = 0; i < 200; i++) {
        bus.publish({
          kind: 'state',
          runId: `democratic-run-${i}`,
          state: makeState({ runId: `democratic-run-${i}` }),
          source: 'engine',
        });
      }
      expect(server.bufferedRuns).toBeLessThanOrEqual(32);

      // A finished run keeps only enough replay depth for a reconnect already in flight.
      const runId = 'democratic-terminal-run';
      for (let i = 0; i < 120; i++) {
        bus.publish({
          kind: 'ledger',
          runId,
          entry: { ts: '2026-01-01T10:00:00.000Z', runId, strategy: 'democratic', type: 'worker_call', data: {} },
          source: 'engine',
        });
      }
      expect(server.bufferedFrames).toBeGreaterThan(100);
      bus.publish({ kind: 'state', runId, state: makeState({ runId, status: 'completed' }), source: 'engine' });
      expect(server.bufferedFrames).toBeLessThan(100);

      await server.stop();
      // A stopped server holds nothing for pages that can no longer reach it.
      expect(server.bufferedRuns).toBe(0);
      expect(server.settledRuns).toBe(0);
    } finally {
      await server.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
