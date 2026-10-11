import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  watch,
  type FSWatcher,
} from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { EventBus } from '../engine/EventBus.js';
import type { LedgerEntry } from '../engine/Ledger.js';
import { migrateLegacyTaskNodes, type RunState } from '../engine/RunStore.js';
import { logger } from '../util/logger.js';

/**
 * Publishes runs written by *other* processes onto this process's event bus.
 *
 * The engine publishes directly when it is the one writing, which covers interactive runs. The
 * benchmark harness is a separate process, so its runs only ever reach the page by watching the
 * files. Everything it emits is tagged `source: 'watch'`; a consumer that also hears 'engine'
 * events for a run must ignore the watched copy, or every line appears twice.
 *
 * Tailing is by byte offset, and a newly discovered file starts at its current end: history is
 * served by /api/run/:id, so replaying it here would only duplicate what the page already has.
 */

/** Coalesce the burst of change events a single append can produce. */
const DEBOUNCE_MS = 120;

/** Re-scan for run directories this often, in case a watch event is missed. */
const SWEEP_MS = 5000;

const EMPTY = Buffer.alloc(0);
const NEWLINE = 0x0a;

interface Tracked {
  ledgerOffset: number;
  /** Hash of the last state.json this watcher successfully parsed and published. */
  lastStateSignature: string;
  /**
   * Carries a trailing partial line between reads.
   *
   * Held as bytes, not text: a read stops at whatever byte the writer had reached, which may be
   * the middle of a multi-byte character. Decoding that half would bake a replacement character
   * into the line before the next read could complete it.
   */
  partial: Buffer;
}

export class RunWatcher {
  private watcher: FSWatcher | null = null;
  private sweep: NodeJS.Timeout | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private readonly tracked = new Map<string, Tracked>();
  private started = false;

  constructor(
    private readonly runsRootDir: string,
    private readonly bus: EventBus,
  ) {}

  get trackedRuns(): number {
    return this.tracked.size;
  }

  start(): void {
    if (this.started) return;
    this.started = true;

    // Adopt whatever is already on disk at their current ends, so starting the watcher does not
    // replay finished runs into the ticker.
    this.adoptExistingRuns();

    try {
      this.watcher = watch(this.runsRootDir, { recursive: true }, () => this.schedule());
      this.watcher.on('error', (err) => {
        logger.warn('Run watcher error; falling back to periodic sweeps', { error: String(err) });
        this.watcher?.close();
        this.watcher = null;
      });
    } catch (err) {
      // Recursive watch is not available on every platform/filesystem. The sweep below still
      // picks changes up, just less promptly.
      logger.info('Recursive watch unavailable; using periodic sweeps only', { error: String(err) });
    }

    this.sweep = setInterval(() => this.scan(), SWEEP_MS);
    this.sweep.unref();
  }

  stop(): void {
    this.started = false;
    this.watcher?.close();
    this.watcher = null;
    if (this.sweep) clearInterval(this.sweep);
    this.sweep = null;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = null;
    this.tracked.clear();
    // Kept parallel to `tracked`: the two are only ever populated together, in consider().
    this.paths.clear();
  }

  private schedule(): void {
    if (this.debounce) return;
    this.debounce = setTimeout(() => {
      this.debounce = null;
      this.scan();
    }, DEBOUNCE_MS);
    this.debounce.unref();
  }

  private scan(): void {
    try {
      this.discoverNewRuns();
      for (const runId of this.tracked.keys()) {
        // State before ledger: a consumer needs the run's strategy and task graph to make sense
        // of a ledger line, and for an out-of-process run this event is the only way it gets them.
        this.checkState(runId);
        this.drainLedger(runId);
      }
    } catch (err) {
      logger.warn('Run watcher sweep failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private adoptExistingRuns(): void {
    this.discoverRuns((ledgerPath) => (existsSync(ledgerPath) ? statSync(ledgerPath).size : 0));
  }

  private discoverNewRuns(): void {
    this.discoverRuns(() => 0);
  }

  /** Finds run directories one and two levels deep — runs/<id> and runs/<group>/<id>. */
  private discoverRuns(initialLedgerOffset: (ledgerPath: string) => number): void {
    if (!existsSync(this.runsRootDir)) return;

    const consider = (dir: string, runId: string) => {
      if (this.tracked.has(runId)) return;
      if (!existsSync(path.join(dir, 'ledger.jsonl')) && !existsSync(path.join(dir, 'state.json'))) return;

      const ledgerPath = path.join(dir, 'ledger.jsonl');
      const offset = initialLedgerOffset(ledgerPath);
      this.tracked.set(runId, { ledgerOffset: offset, lastStateSignature: '', partial: EMPTY });
      this.paths.set(runId, dir);
    };

    for (const name of readdirSync(this.runsRootDir, { withFileTypes: true })) {
      if (!name.isDirectory() || name.name === 'knowledge') continue;
      const dir = path.join(this.runsRootDir, name.name);
      consider(dir, name.name);

      // One level deeper: the plugin groups benchmark and smoke runs under a parent directory.
      try {
        for (const inner of readdirSync(dir, { withFileTypes: true })) {
          if (inner.isDirectory()) consider(path.join(dir, inner.name), inner.name);
        }
      } catch {
        /* not a directory we can read; ignore */
      }
    }
  }

  private readonly paths = new Map<string, string>();

  private drainLedger(runId: string): void {
    const dir = this.paths.get(runId);
    const tracked = this.tracked.get(runId);
    if (!dir || !tracked) return;

    const file = path.join(dir, 'ledger.jsonl');
    if (!existsSync(file)) return;

    const size = statSync(file).size;
    if (size === tracked.ledgerOffset) return;
    if (size < tracked.ledgerOffset) {
      // Truncated or replaced — start over rather than emit garbage.
      tracked.ledgerOffset = 0;
      tracked.partial = EMPTY;
    }

    const chunk = this.readNewBytes(file, tracked);
    if (chunk === null) return;

    // Split on the last newline: everything before it is whole lines, everything after is a line
    // the writer has not finished, which is held back until the read that completes it.
    const combined = tracked.partial.byteLength === 0 ? chunk : Buffer.concat([tracked.partial, chunk]);
    const lastNewline = combined.lastIndexOf(NEWLINE);
    if (lastNewline === -1) {
      tracked.partial = combined;
      return;
    }
    tracked.partial = Buffer.from(combined.subarray(lastNewline + 1));

    for (const line of combined.subarray(0, lastNewline).toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      let entry: LedgerEntry;
      try {
        entry = JSON.parse(line) as LedgerEntry;
      } catch {
        continue;
      }
      this.bus.publish({ kind: 'ledger', runId, entry, source: 'watch' });
    }
  }

  /**
   * Reads from the tracked offset to the end of the ledger, and only that.
   *
   * A whole-file read would make a sweep cost O(file size), and so cost O(n²) over a run that
   * appends n lines — a ledger is append-only and unbounded, and the sweep runs on every write.
   * The offset advances by the bytes actually read rather than by any size observed beforehand,
   * so an append landing between the stat and the read is picked up next time instead of skipped.
   */
  private readNewBytes(file: string, tracked: Tracked): Buffer | null {
    let fd: number | null = null;
    try {
      fd = openSync(file, 'r');
      const length = fstatSync(fd).size - tracked.ledgerOffset;
      if (length <= 0) return null;

      const buffer = Buffer.allocUnsafe(length);
      const read = readSync(fd, buffer, 0, length, tracked.ledgerOffset);
      tracked.ledgerOffset += read;
      return buffer.subarray(0, read);
    } catch (err) {
      logger.warn('Could not read new ledger bytes', {
        file,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    } finally {
      if (fd !== null) closeSync(fd);
    }
  }

  private checkState(runId: string): void {
    const dir = this.paths.get(runId);
    const tracked = this.tracked.get(runId);
    if (!dir || !tracked) return;

    const file = path.join(dir, 'state.json');
    if (!existsSync(file)) return;

    // Compared by content, not by mtime. An mtime gate drops a write whose timestamp matches the
    // previous one — possible wherever the filesystem's timestamps are coarser than the interval
    // between two writes — and drops it *permanently*, because every later sweep compares equal
    // too. If the lost write is the terminal one, an out-of-process run shows as running forever.
    // state.json is a few kilobytes, so hashing it each sweep costs far less than that bug.
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      return;
    }
    const signature = createHash('sha1').update(raw).digest('hex');
    if (signature === tracked.lastStateSignature) return;

    try {
      const state = migrateLegacyTaskNodes(JSON.parse(raw) as RunState);
      // Recorded only after a successful parse, so a half-written state.json really is retried
      // on the next sweep rather than being marked as seen and then never published.
      tracked.lastStateSignature = signature;
      this.bus.publish({ kind: 'state', runId, state, source: 'watch' });
    } catch {
      /* A half-written state.json is normal mid-write; the next sweep picks it up. */
    }
  }
}
