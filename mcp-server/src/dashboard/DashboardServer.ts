import http from 'node:http';
import path from 'node:path';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { migrateLegacyTaskNodes, type RunStore, type RunState } from '../engine/RunStore.js';
import type { EventBus, SwarmEvent } from '../engine/EventBus.js';
import type { LedgerEntry } from '../engine/Ledger.js';
import { logger } from '../util/logger.js';
import { loadDashboardConfig, dashboardUrl, DEFAULT_BANNER_MS, type DashboardConfig } from './config.js';
import { assetPath, assetsPresent } from './paths.js';
import { narrate, titleResolverFor, type TickerLine } from './DoctrineNarrator.js';
import { aggregate, buildStatement, type DoctrinalStatement } from './DoctrinalStatement.js';
import type { LlmRhetorician } from './LlmRhetorician.js';
import { RunWatcher } from './RunWatcher.js';
import { openInBrowser } from './openBrowser.js';
// Run ids outside this charset are not run ids, and in particular cannot climb out of runsRootDir.
import { RUN_ID_PATTERN } from '../util/ids.js';
import { bannerRoot, buildManifest, contentTypeFor, isBannerStrategy, resolvePoster } from './banner.js';
import {
  buildReelManifest,
  contentTypeFor as newsreelContentTypeFor,
  newsreelRoot,
  resolveClip,
} from './newsreel.js';

export interface DashboardServerDeps {
  runStore: RunStore;
  runsRootDir: string;
  bus?: EventBus;
  config?: DashboardConfig;
  /** Optional, opt-in prose re-voicing. Never on the critical path. */
  rhetorician?: LlmRhetorician;
}

export interface RunSummary {
  runId: string;
  strategy: string;
  status: string;
  goal: string;
  costUsd: number;
  budgetUsd: number;
  workerCalls: number;
  taskCount: number;
  pendingApprovals: number;
  createdAt: string;
  updatedAt: string;
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};


/**
 * Posters are the one thing on this page worth caching.
 *
 * Every other response is `no-store`, because it describes a run that is still moving. A poster
 * is a file on disk that the page re-requests every few seconds; without this the banner would
 * re-read and re-send megabytes a minute for images that never change. Private, because the
 * library is the user's own directory.
 */
const POSTER_CACHE = 'private, max-age=3600';

/** Proxies and browsers drop an idle event-stream; a comment frame is the cheapest keep-alive. */
const HEARTBEAT_MS = 15_000;

/**
 * Everything the page is allowed to do, which is very little: load its own two assets, call its
 * own API, and nothing else. `frame-ancestors 'none'` matters even for a loopback bind — a page
 * on the open web can frame http://127.0.0.1 even though the same-origin policy stops it reading
 * the result. The page has no inline script or style, so no relaxation is needed for it to work.
 */
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  // The newsreel reel is the one thing on the page that isn't an image or a fetch response.
  "media-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/** Per-run replay depth for a client that reconnects with Last-Event-ID. */
const BUFFER_LIMIT = 500;

/**
 * Replay depth kept for a run that has finished.
 *
 * Once a run has finished, its ring only has to cover a reconnect already in flight. Holding the
 * full 500 for every run that has ever ended is the expensive part — state frames carry a whole
 * RunState — and it buys nothing.
 */
const TERMINAL_BUFFER_LIMIT = 50;

/**
 * How many runs the server keeps any per-run memory for.
 *
 * The watcher discovers every run under runs/, including the whole historical archive, so these
 * maps are keyed by a set that only grows. The MCP server is long-lived; without a ceiling this
 * is a slow leak. Eviction is oldest-first, and costs a page nothing it cannot re-fetch: state
 * comes back from state.json and a statement falls back to the deterministic template.
 */
const TRACKED_RUN_LIMIT = 32;

/** Caps an insertion-ordered collection, dropping the oldest entries first. */
function capOldest(collection: Map<string, unknown> | Set<string>, limit = TRACKED_RUN_LIMIT): void {
  while (collection.size > limit) {
    const oldest = collection.keys().next();
    if (oldest.done) return;
    collection.delete(oldest.value);
  }
}

interface BufferedEvent {
  seq: number;
  runId: string;
  kind: SwarmEvent['kind'];
  /** Pre-serialised frame body, so a replayed event is byte-identical to the live one. */
  payload: string;
}

interface SseClient {
  res: http.ServerResponse;
  /** A specific run id, or 'all'. */
  runId: string;
}

type DashboardMethod = 'GET' | 'HEAD';

interface DashboardRoute {
  methods: readonly DashboardMethod[];
  pattern: RegExp;
  handler: (context: RouteContext) => void;
}

interface RouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  match: RegExpExecArray;
}

interface SendOptions {
  res: http.ServerResponse;
  status: number;
  payload: unknown;
  extra?: Record<string, string>;
}

/**
 * Locates a run's directory, allowing for one level of grouping.
 *
 * RunStore addresses runs as `runsRootDir/<runId>`, but the plugin groups the benchmark harness
 * and smoke tests under `runs/benchmark/<runId>` and `runs/smoke/<runId>`. Those are exactly the
 * out-of-process runs the file watcher exists to surface, so the dashboard has to be able to read
 * them even though RunStore cannot.
 */
export function resolveRunDir(runsRootDir: string, runId: string): string | null {
  const flat = path.join(runsRootDir, runId);
  if (existsSync(path.join(flat, 'state.json'))) return flat;

  if (!existsSync(runsRootDir)) return null;
  for (const group of readdirSync(runsRootDir, { withFileTypes: true })) {
    if (!group.isDirectory() || group.name === 'knowledge') continue;
    const nested = path.join(runsRootDir, group.name, runId);
    if (existsSync(path.join(nested, 'state.json'))) return nested;
  }
  return null;
}

/** Every run under runsRootDir, flat or grouped one level deep, newest first. */
export function listAllRuns(runsRootDir: string): RunState[] {
  if (!existsSync(runsRootDir)) return [];
  const found: RunState[] = [];
  const seen = new Set<string>();

  const take = (dir: string) => {
    const file = path.join(dir, 'state.json');
    if (!existsSync(file)) return;
    try {
      const state = migrateLegacyTaskNodes(JSON.parse(readFileSync(file, 'utf8')) as RunState);
      // Example snapshots can carry a runId without the fields needed by the dashboard.
      if (typeof state?.task?.goal !== 'string' || !Array.isArray(state.pendingApprovals)) return;
      if (state.pendingApprovals.some((approval) => !approval || typeof approval !== 'object')) return;
      if (state.graph && (!state.graph.nodes || typeof state.graph.nodes !== 'object')) return;
      if (state?.runId && !seen.has(state.runId)) {
        seen.add(state.runId);
        found.push(state);
      }
    } catch {
      /* half-written state.json; the next poll picks it up */
    }
  };

  for (const entry of readdirSync(runsRootDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'knowledge') continue;
    const dir = path.join(runsRootDir, entry.name);
    take(dir);
    try {
      for (const inner of readdirSync(dir, { withFileTypes: true })) {
        if (inner.isDirectory()) take(path.join(dir, inner.name));
      }
    } catch {
      /* unreadable; skip */
    }
  }

  return found.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

/**
 * A run in one of the states from which it will never publish anything again.
 *
 * `awaiting_acceptance` is deliberately NOT terminal: the swarm has stopped working, but the run
 * still moves — to `completed` when Claude accepts the delivery, or back to `running` when Claude
 * returns defects. Treating it as an ending would close the stream on a page that is about to see
 * more. `terminated_incomplete` is terminal, and is not a synonym for `failed`.
 */
export function isTerminal(status: RunState['status']): boolean {
  return (
    status === 'completed' || status === 'failed' || status === 'stopped' || status === 'terminated_incomplete'
  );
}

export function toSummary(state: RunState): RunSummary {
  return {
    runId: state.runId,
    strategy: state.strategy,
    status: state.status,
    goal: state.task.goal,
    costUsd: state.costUsd,
    budgetUsd: state.budgetUsd,
    workerCalls: state.workerCalls,
    taskCount: state.graph ? Object.keys(state.graph.nodes).length : 0,
    pendingApprovals: state.pendingApprovals.filter((approval) => !approval.resolvedAt).length,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
  };
}

/**
 * Reads a run's ledger, tolerating a torn final line.
 *
 * Ledger.readAll() parses every line strictly, which is right for an audit consumer. The
 * dashboard reads the same file while the engine is appending to it, so a half-written last
 * line is expected rather than exceptional and must not turn into a 500.
 */
export function readLedgerTolerant(filePath: string): LedgerEntry[] {
  if (!existsSync(filePath)) return [];
  const lines = readFileSync(filePath, 'utf8').split('\n');
  const entries: LedgerEntry[] = [];
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    try {
      entries.push(JSON.parse(line) as LedgerEntry);
    } catch {
      // Only ever expected on the final line, mid-append. The next poll or event picks it up.
    }
  }
  return entries;
}

export class DashboardServer {
  private readonly config: DashboardConfig;
  private readonly routes: readonly DashboardRoute[] = [
    {
      methods: ['GET', 'HEAD'],
      pattern: /^\/api\/stream$/,
      handler: ({ req, res, url }) => this.openStream(req, res, url),
    },
    {
      methods: ['GET', 'HEAD'],
      pattern: /^\/api\/runs$/,
      handler: ({ res }) => {
        this.send({ res, status: 200, payload: { runs: listAllRuns(this.deps.runsRootDir).map(toSummary) } });
      },
    },
    {
      methods: ['GET', 'HEAD'],
      pattern: /^\/api\/run\/([^/]+)$/,
      handler: ({ res, match }) => {
        let runId: string;
        try {
          runId = decodeURIComponent(match[1]);
        } catch {
          // A malformed percent-escape ('/api/run/%') throws here. That is a bad request, and
          // answering 500 would report it as a fault of this server's own.
          this.send({ res, status: 400, payload: { error: 'Invalid run id' } });
          return;
        }
        this.sendRun(res, runId);
      },
    },
    {
      methods: ['GET', 'HEAD'],
      pattern: /^\/api\/banner\/([^/]+)$/,
      handler: ({ res, match }) => this.sendBannerManifest(res, match[1]),
    },
    {
      methods: ['GET', 'HEAD'],
      pattern: /^\/banner\/([^/]+)\/([^/]+)$/,
      handler: ({ res, match }) => this.sendPoster(res, match[1], match[2]),
    },
    {
      methods: ['GET', 'HEAD'],
      pattern: /^\/api\/newsreel$/,
      handler: ({ res }) => this.sendReelManifest(res),
    },
    {
      methods: ['GET', 'HEAD'],
      pattern: /^\/newsreel\/([^/]+)$/,
      handler: ({ res, match }) => this.sendClip(res, match[1]),
    },
    {
      methods: ['GET', 'HEAD'],
      pattern: /^\/(?:index\.html)?$/,
      handler: ({ res }) => this.sendAsset(res, 'index.html'),
    },
    {
      methods: ['GET', 'HEAD'],
      pattern: /^\/assets\/([A-Za-z0-9._-]+)$/,
      handler: ({ res, match }) => this.sendAsset(res, match[1]),
    },
  ];
  private server: http.Server | null = null;
  private boundPort: number | null = null;

  private readonly clients = new Set<SseClient>();
  private readonly buffers = new Map<string, BufferedEvent[]>();
  private busUnsubscribe: (() => void) | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private watcher: RunWatcher | null = null;
  private seq = 0;

  constructor(private readonly deps: DashboardServerDeps) {
    this.config = deps.config ?? loadDashboardConfig();
  }

  get url(): string | null {
    return this.boundPort === null ? null : dashboardUrl(this.config, this.boundPort);
  }

  /** Diagnostic for the leak gate: open SSE connections right now. */
  get clientCount(): number {
    return this.clients.size;
  }

  /** Diagnostic: runs whose closing statement has settled and is being served from memory. */
  get settledRuns(): number {
    return this.settledStatements.size;
  }

  /** Diagnostic for the memory ceiling: runs holding a replay ring, and frames held in total. */
  get bufferedRuns(): number {
    return this.buffers.size;
  }

  get bufferedFrames(): number {
    let total = 0;
    for (const ring of this.buffers.values()) total += ring.length;
    return total;
  }

  /**
   * Resolves to the bound URL, or null when the dashboard did not start. Never rejects: the MCP
   * server must come up whether or not the dashboard can.
   */
  start(): Promise<string | null> {
    if (!this.config.enabled) {
      logger.info('Dashboard disabled by SWARM_DASHBOARD');
      return Promise.resolve(null);
    }
    if (!assetsPresent()) {
      logger.warn('Dashboard assets missing from the build; not starting', { expected: assetPath('index.html') });
      return Promise.resolve(null);
    }

    return new Promise((resolve) => {
      const server = http.createServer((req, res) => this.handle(req, res));

      server.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          // Almost always a second MCP server instance for the same plugin. The first one's page
          // already serves every run in the shared runs/ directory, so standing down is correct.
          logger.info('Dashboard port already in use; using the existing instance', {
            url: dashboardUrl(this.config),
          });
        } else {
          logger.warn('Dashboard failed to start', { error: err.message });
        }
        this.server = null;
        resolve(null);
      });

      server.listen(this.config.port, this.config.host, () => {
        this.server = server;
        this.boundPort = (server.address() as AddressInfo).port;
        // Do not hold the process open on the dashboard's account.
        server.unref();
        this.attachToBus();
        this.startHeartbeat();
        this.startWatcher();
        logger.info('Dashboard listening', { url: this.url });
        if (this.config.autoOpen) openInBrowser(this.url as string);
        resolve(this.url);
      });
    });
  }

  /**
   * Tails `runs/` so runs written by other processes — chiefly the benchmark harness — appear on
   * the page. Off when there is no bus to publish onto, or when explicitly disabled.
   */
  private startWatcher(): void {
    if (!this.deps.bus || this.config.watch === false || this.watcher) return;
    this.watcher = new RunWatcher(this.deps.runsRootDir, this.deps.bus);
    this.watcher.start();
  }

  /** Diagnostic: run directories the filesystem tailer is following. */
  get watchedRuns(): number {
    return this.watcher?.trackedRuns ?? 0;
  }

  async stop(): Promise<void> {
    this.watcher?.stop();
    this.watcher = null;
    this.busUnsubscribe?.();
    this.busUnsubscribe = null;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;

    // close() waits for open connections, and an event stream never ends on its own.
    for (const client of this.clients) client.res.end();
    this.clients.clear();

    // Every per-run structure goes with the server. A stopped server holding a run's replay ring
    // and cached state is holding it for a page that can no longer be connected to it.
    this.buffers.clear();
    this.stateCache.clear();
    this.ownedRuns.clear();
    this.revoiced.clear();
    this.settledStatements.clear();

    const server = this.server;
    if (!server) return;
    this.server = null;
    this.boundPort = null;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /**
   * One bus subscription for the lifetime of the server, fanned out to clients — not one per
   * connection. The bus listener count is therefore flat no matter how many tabs come and go,
   * and events still reach the replay buffer while nobody is watching.
   */
  private attachToBus(): void {
    if (!this.deps.bus || this.busUnsubscribe) return;
    this.busUnsubscribe = this.deps.bus.subscribe((event) => {
      if (this.isDuplicate(event)) return;
      const seq = ++this.seq;
      // Narrate once, here, and store the finished frame body: a replayed event is then byte-
      // identical to the live one, and the page never has to re-implement the templates.
      const buffered: BufferedEvent = {
        seq,
        runId: event.runId,
        kind: event.kind,
        payload: JSON.stringify(this.enrich(event)),
      };
      this.buffer(event.runId, buffered);
      this.broadcast(buffered);

      // Best effort, not a guarantee: the watcher publishes a run's state before the ledger lines
      // it found in the same sweep, so frames can still arrive after this and refill the ring.
      // BUFFER_LIMIT is what actually bounds it; this just gives back the bulk of a finished run's
      // depth in the common case. When a re-voicing is pending, settle() trims after the last frame.
      if (event.kind === 'state' && isTerminal(event.state.status) && !this.revoiced.has(event.runId)) {
        this.trimTerminalBuffer(event.runId);
      }
    });
  }

  private startHeartbeat(): void {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      for (const client of this.clients) {
        try {
          client.res.write(': keep-alive\n\n');
        } catch {
          this.dropClient(client);
        }
      }
    }, HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  private buffer(runId: string, buffered: BufferedEvent): void {
    let ring = this.buffers.get(runId);
    if (!ring) {
      ring = [];
      this.buffers.set(runId, ring);
      capOldest(this.buffers);
    }
    ring.push(buffered);
    if (ring.length > BUFFER_LIMIT) ring.splice(0, ring.length - BUFFER_LIMIT);
  }

  /** Shrinks a finished run's replay ring to what an in-flight reconnect could still want. */
  private trimTerminalBuffer(runId: string): void {
    const ring = this.buffers.get(runId);
    if (ring && ring.length > TERMINAL_BUFFER_LIMIT) {
      ring.splice(0, ring.length - TERMINAL_BUFFER_LIMIT);
    }
  }

  private replayBuffer(runId: string, afterSeq: number): BufferedEvent[] {
    const rings = runId === 'all' ? [...this.buffers.values()] : [this.buffers.get(runId) ?? []];
    return rings
      .flat()
      .filter((b) => b.seq > afterSeq)
      .sort((a, b) => a.seq - b.seq);
  }

  /**
   * Caches the latest state per run so narration can resolve task titles and the run's strategy
   * without re-reading state.json on every ledger line. State events keep it current.
   */
  private readonly stateCache = new Map<string, RunState>();

  /** Runs this process is itself writing; the watcher's copy of these must be discarded. */
  private readonly ownedRuns = new Set<string>();

  /**
   * A run written in this process is published twice — once by the engine, once by the file
   * watcher that sees the same append. Prefer the engine's copy and drop the watched one, or
   * every line appears twice on the page.
   */
  private isDuplicate(event: SwarmEvent): boolean {
    if (event.source === 'watch') return this.ownedRuns.has(event.runId);
    this.ownedRuns.add(event.runId);
    capOldest(this.ownedRuns);
    return false;
  }

  private readState(runDir: string): RunState | null {
    try {
      return migrateLegacyTaskNodes(JSON.parse(readFileSync(path.join(runDir, 'state.json'), 'utf8')) as RunState);
    } catch {
      return null;
    }
  }

  private currentState(runId: string): RunState | null {
    const cached = this.stateCache.get(runId);
    if (cached) return cached;
    // Grouped runs (runs/benchmark/<id>) are invisible to RunStore, so fall back to a direct read.
    const runDir = resolveRunDir(this.deps.runsRootDir, runId);
    const loaded = runDir ? this.readState(runDir) : this.deps.runStore.load(runId);
    if (loaded) this.cacheState(runId, loaded);
    return loaded;
  }

  /** Single entry point for the state cache, so the ceiling cannot be bypassed by a new caller. */
  private cacheState(runId: string, state: RunState): void {
    this.stateCache.set(runId, state);
    capOldest(this.stateCache);
  }

  /** Attaches the doctrine ticker line to a ledger event. Never throws into the engine's path. */
  private enrich(event: SwarmEvent): unknown {
    if (event.kind === 'state') {
      this.cacheState(event.runId, event.state);
      if (!isTerminal(event.state.status)) return event;
      // The run has just ended, so compose the closing statement now and let a watching page
      // show it without another round trip. Re-reading the ledger is affordable once per run.
      try {
        const runDir = resolveRunDir(this.deps.runsRootDir, event.runId) ?? path.join(this.deps.runsRootDir, event.runId);
        const ledger = readLedgerTolerant(path.join(runDir, 'ledger.jsonl'));
        const statement = buildStatement(event.state, ledger);
        // Ship the deterministic statement now; a re-voiced one may follow on its own frame.
        // `revoicing` tells the page one is coming, so it holds the stream open instead of
        // closing on the terminal state and never receiving it.
        const revoicing = this.maybeRevoice(event.runId, event.state, ledger, statement);
        return { ...event, statement, revoicing };
      } catch (err) {
        logger.warn('Could not compose the closing statement', {
          error: err instanceof Error ? err.message : String(err),
        });
        return event;
      }
    }
    let line: TickerLine | null = null;
    try {
      const state = this.currentState(event.runId);
      if (state) line = narrate(state.strategy, event.entry, titleResolverFor(state.graph));
    } catch (err) {
      logger.warn('Narration failed', { error: err instanceof Error ? err.message : String(err) });
    }
    return { ...event, line };
  }

  /** Runs whose statement has already been sent for re-voicing; the model is asked once. */
  private readonly revoiced = new Set<string>();

  /**
   * The statement a finished run should be shown with, once it is settled.
   *
   * Held so a page that loads after the run ended — or simply reloads — is served the same prose
   * a page that watched live was sent on the stream, rather than silently dropping back to the
   * template because the re-voiced version only ever existed in one SSE frame.
   */
  private readonly settledStatements = new Map<string, DoctrinalStatement>();

  /**
   * Asks the model to re-voice a finished run's statement, in the background. Returns whether a
   * call was actually started, which the terminal state frame carries to the page.
   *
   * Deliberately not awaited: the terminal state event must not wait on a network call, and if
   * the model never answers the page simply keeps the statement it already has.
   */
  private maybeRevoice(
    runId: string,
    state: RunState,
    ledger: LedgerEntry[],
    statement: DoctrinalStatement,
  ): boolean {
    if (!this.deps.rhetorician || this.revoiced.has(runId)) return false;
    this.revoiced.add(runId);
    capOldest(this.revoiced);

    const record = aggregate(state, ledger);
    void this.deps.rhetorician
      .revoice(statement, record)
      .then((revoiced) => this.settle(runId, revoiced ?? statement))
      .catch((err) => {
        logger.warn('Re-voicing failed', { error: err instanceof Error ? err.message : String(err) });
        this.settle(runId, statement);
      });
    return true;
  }

  /**
   * Publishes the run's final statement, re-voiced or not.
   *
   * Sent even when the model was rejected or never answered, because the page is holding its
   * stream open waiting for exactly this frame: a run whose re-voicing quietly failed must not
   * leave a connection open until the client's own timeout expires.
   */
  private settle(runId: string, statement: DoctrinalStatement): void {
    this.settledStatements.set(runId, statement);
    capOldest(this.settledStatements);
    this.pushFrame(runId, 'statement', { kind: 'statement', runId, statement });
    // Nothing further will ever be published for this run, so the replay ring can shrink to what
    // a reconnect still in flight might ask for.
    this.trimTerminalBuffer(runId);
  }

  /** Sends an out-of-band frame that did not originate on the bus. */
  private pushFrame(runId: string, kind: string, payload: unknown): void {
    const buffered: BufferedEvent = {
      seq: ++this.seq,
      runId,
      kind: kind as SwarmEvent['kind'],
      payload: JSON.stringify(payload),
    };
    this.buffer(runId, buffered);
    this.broadcast(buffered);
  }

  private broadcast(buffered: BufferedEvent): void {
    for (const client of this.clients) {
      if (client.runId !== 'all' && client.runId !== buffered.runId) continue;
      this.writeEvent(client, buffered);
    }
  }

  private writeEvent(client: SseClient, buffered: BufferedEvent): void {
    try {
      // JSON.stringify cannot emit a raw newline inside a string, so a payload can never break
      // out of its own data: frame.
      client.res.write(`id: ${buffered.seq}\nevent: ${buffered.kind}\ndata: ${buffered.payload}\n\n`);
    } catch (err) {
      logger.warn('Dropping dashboard client', { error: err instanceof Error ? err.message : String(err) });
      this.dropClient(client);
    }
  }

  private dropClient(client: SseClient): void {
    this.clients.delete(client);
    try {
      client.res.end();
    } catch {
      /* already gone */
    }
  }

  private openStream(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
    const requested = url.searchParams.get('runId') ?? 'all';
    if (requested !== 'all' && !RUN_ID_PATTERN.test(requested)) {
      this.send({ res, status: 400, payload: { error: 'Invalid run id' } });
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      // Harmless locally; stops an intermediary from buffering the stream into uselessness.
      'X-Accel-Buffering': 'no',
      ...this.securityHeaders(),
    });

    const client: SseClient = { res, runId: requested };
    this.clients.add(client);

    // Client reconnect delay, and an immediate frame so the browser sees a live stream at once.
    res.write('retry: 3000\n\n');

    // EventSource replays Last-Event-ID automatically on reconnect; honouring it means a dropped
    // connection loses nothing that is still in the buffer.
    const lastEventId = Number(req.headers['last-event-id']);
    if (Number.isInteger(lastEventId) && lastEventId > 0) {
      for (const buffered of this.replayBuffer(requested, lastEventId)) {
        this.writeEvent(client, buffered);
      }
    }

    const drop = () => this.dropClient(client);
    res.on('close', drop);
    res.on('error', drop);
    req.on('close', drop);
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    try {
      if (!this.validateMethod(req, res) || !this.validateHost(req, res)) return;
      const url = this.parseRequestUrl(req);
      if (this.dispatch(req, res, url)) return;
      this.send({ res, status: 404, payload: { error: 'Not found' } });
    } catch (err) {
      logger.warn('Dashboard request failed', { url: req.url, error: err instanceof Error ? err.message : String(err) });
      this.send({ res, status: 500, payload: { error: 'Internal dashboard error' } });
    }
  }

  private validateMethod(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    // Every route is read-only by design. Approvals stay in the MCP tools, where they are
    // authenticated by the host and recorded in the ledger.
    if (req.method === 'GET' || req.method === 'HEAD') return true;
    this.send({
      res,
      status: 405,
      payload: { error: 'This dashboard is read-only' },
      extra: { Allow: 'GET, HEAD' },
    });
    return false;
  }

  private validateHost(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    if (this.hostAllowed(req)) return true;
    // Blunts DNS rebinding: a loopback bind alone does not stop a page on the open web from
    // resolving its own hostname to 127.0.0.1 and reading the ledger through the browser.
    this.send({ res, status: 403, payload: { error: 'Unrecognised Host header' } });
    return false;
  }

  private parseRequestUrl(req: http.IncomingMessage): URL {
    return new URL(req.url ?? '/', 'http://127.0.0.1');
  }

  private dispatch(req: http.IncomingMessage, res: http.ServerResponse, url: URL): boolean {
    for (const route of this.routes) {
      if (!route.methods.includes(req.method as DashboardMethod)) continue;
      const match = route.pattern.exec(url.pathname);
      if (!match) continue;
      route.handler({ req, res, url, match });
      return true;
    }
    return false;
  }

  private hostAllowed(req: http.IncomingMessage): boolean {
    const host = req.headers.host;
    if (!host) return false;
    const hostname = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  }

  private sendRun(res: http.ServerResponse, runId: string): void {
    if (!RUN_ID_PATTERN.test(runId)) {
      this.send({ res, status: 400, payload: { error: 'Invalid run id' } });
      return;
    }
    const runDir = resolveRunDir(this.deps.runsRootDir, runId);
    const state = runDir ? this.readState(runDir) : this.deps.runStore.load(runId);
    if (!state) {
      this.send({ res, status: 404, payload: { error: 'Unknown run' } });
      return;
    }
    this.cacheState(runId, state);
    const ledger = readLedgerTolerant(path.join(runDir ?? path.join(this.deps.runsRootDir, runId), 'ledger.jsonl'));
    // Narrate the whole record here so a page opening mid-run shows the same doctrine ticker as
    // one that watched from the beginning.
    const resolveTitle = titleResolverFor(state.graph);
    const ticker = ledger.map((entry) => narrate(state.strategy, entry, resolveTitle));

    // Only a finished run has a closing statement to make. Composing one mid-run would be a
    // claim about work that has not happened yet. A statement already settled for this run wins:
    // it is what live viewers were shown, and re-deriving would discard any re-voicing.
    const statement = isTerminal(state.status)
      ? (this.settledStatements.get(runId) ?? buildStatement(state, ledger))
      : null;

    this.send({ res, status: 200, payload: { state, ledger, ticker, statement } });
  }

  /**
   * The posters available for one tradition.
   *
   * An empty list is a 200, not a 404: a library nobody has filled in yet is the normal state of a
   * fresh checkout for every strategy but the three that ship with posters, and the page treats an
   * empty manifest as "no banner" rather than as an error to report.
   */
  private sendBannerManifest(res: http.ServerResponse, strategy: string): void {
    if (!isBannerStrategy(strategy)) {
      this.send({ res, status: 404, payload: { error: 'No poster tradition by that name' } });
      return;
    }
    if (this.config.banner === false) {
      this.send({ res, status: 200, payload: { strategy, intervalMs: 0, posters: [] } });
      return;
    }
    const intervalMs = this.config.bannerMs ?? DEFAULT_BANNER_MS;
    this.send({ res, status: 200, payload: buildManifest(strategy, bannerRoot(this.config.bannerDir), intervalMs) });
  }

  /** One poster, straight off disk. Path validation lives in banner.ts; this only serves. */
  private sendPoster(res: http.ServerResponse, strategy: string, rawFile: string): void {
    let file: string;
    try {
      file = decodeURIComponent(rawFile);
    } catch {
      this.send({ res, status: 400, payload: { error: 'Invalid poster name' } });
      return;
    }

    const resolved = resolvePoster(strategy, file, bannerRoot(this.config.bannerDir));
    const type = contentTypeFor(file);
    if (!resolved || !type) {
      this.send({ res, status: 404, payload: { error: 'Not found' } });
      return;
    }

    let body: Buffer;
    try {
      body = readFileSync(resolved);
    } catch {
      // Deleted between the resolve and the read — a fetch script writing into the library while
      // the page is rotating makes this a real race, not a theoretical one.
      this.send({ res, status: 404, payload: { error: 'Not found' } });
      return;
    }

    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': body.byteLength,
      'Cache-Control': POSTER_CACHE,
      ...this.securityHeaders(),
    });
    res.end(body);
  }

  /**
   * The clips in the newsreel library. An empty list is a 200, not a 404 — same reasoning as
   * sendBannerManifest: a fresh checkout with nobody having fetched clips is the normal state.
   */
  private sendReelManifest(res: http.ServerResponse): void {
    if (this.config.newsreel === false) {
      this.send({ res, status: 200, payload: { clips: [] } });
      return;
    }
    this.send({ res, status: 200, payload: buildReelManifest(newsreelRoot(this.config.newsreelDir)) });
  }

  /** One clip, straight off disk. Path validation lives in newsreel.ts; this only serves. */
  private sendClip(res: http.ServerResponse, rawFile: string): void {
    let file: string;
    try {
      file = decodeURIComponent(rawFile);
    } catch {
      this.send({ res, status: 400, payload: { error: 'Invalid clip name' } });
      return;
    }

    const root = newsreelRoot(this.config.newsreelDir);
    const resolved = resolveClip(file, root);
    const type = newsreelContentTypeFor(file);
    if (!resolved || !type) {
      this.send({ res, status: 404, payload: { error: 'Not found' } });
      return;
    }

    let body: Buffer;
    try {
      body = readFileSync(resolved);
    } catch {
      this.send({ res, status: 404, payload: { error: 'Not found' } });
      return;
    }

    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': body.byteLength,
      'Cache-Control': POSTER_CACHE,
      ...this.securityHeaders(),
    });
    res.end(body);
  }

  private sendAsset(res: http.ServerResponse, name: string): void {
    const file = assetPath(name);
    // Defence in depth behind the route regex: never serve anything outside public/.
    if (!file.startsWith(assetPath()) || !existsSync(file)) {
      this.send({ res, status: 404, payload: { error: 'Not found' } });
      return;
    }
    const body = readFileSync(file);
    res.writeHead(200, {
      'Content-Type': CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': body.byteLength,
      'Cache-Control': 'no-store',
      ...this.securityHeaders(),
    });
    res.end(body);
  }

  private send({ res, status, payload, extra = {} }: SendOptions): void {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': body.byteLength,
      'Cache-Control': 'no-store',
      ...this.securityHeaders(),
      ...extra,
    });
    res.end(body);
  }

  private securityHeaders(): Record<string, string> {
    return {
      // No Access-Control-Allow-Origin anywhere: the ledger carries prompts, diffs and raw model
      // output, so no other origin may read it.
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      // The page renders raw model output and diff text, so the no-innerHTML rule in the client
      // is the thing standing between the ledger and script execution. This states the same
      // property where the browser will enforce it: nothing loads that the dashboard did not
      // serve, nothing inline runs, and no other page may frame it.
      'Content-Security-Policy': CSP,
    };
  }
}
