import { createHash } from 'node:crypto';
import { readFileSync, existsSync, mkdirSync, statSync, truncateSync } from 'node:fs';
import path from 'node:path';
import { appendFileDurable } from '../util/durableFile.js';
import type { EventBus } from './EventBus.js';
import type { StrategyId } from './types.js';

// Append-only audit trail: every proposal, assignment, worker call, vote/bid, review verdict,
// decision, and human intervention for a run. This is the transparent record every governance
// doc requires (civil-service audit log / transparent accounting / disclosure).
//
// Each entry carries `seq` and `prevHash`, the sha256 of the line before it, so an edited,
// dropped or reordered entry breaks the chain and `verifyLedgerFile` names where. Ledgers written
// before the chain existed have no `seq`; they verify as an unchained prefix.
export interface LedgerEntry {
  ts: string;
  runId: string;
  strategy: StrategyId;
  type: string;
  data: Record<string, unknown>;
  seq?: number;
  prevHash?: string | null;
}

interface ChainTail {
  seq: number;
  hash: string | null;
  /** File size the tail was read at; any other size means someone else wrote, so re-read. */
  size: number;
}

// Several Ledger instances can write one run in one process (each launch, resume and requeue
// builds its own), so the chain tail and transcript counter live per file, not per instance.
const chainTails = new Map<string, ChainTail>();
const transcriptCounters = new Map<string, number>();

export function hashLedgerLine(line: string): string {
  return createHash('sha256').update(line, 'utf8').digest('hex');
}

function completeLines(raw: string): string[] {
  return raw.split('\n').filter((line) => line.trim().length > 0);
}

/**
 * Parse a ledger file's lines. Only the final line may be unparseable: an append cut off by a
 * crash. Anything earlier is corruption, and reading past it would hand replay a wrong history.
 */
function parseLines(filePath: string): { lines: string[]; entries: LedgerEntry[] } {
  if (!existsSync(filePath)) return { lines: [], entries: [] };
  const lines = completeLines(readFileSync(filePath, 'utf8'));
  const entries: LedgerEntry[] = [];
  const kept: string[] = [];
  lines.forEach((line, index) => {
    try {
      entries.push(JSON.parse(line) as LedgerEntry);
      kept.push(line);
    } catch (error) {
      if (index === lines.length - 1) return;
      throw new Error(`Corrupt ledger ${filePath} at line ${index + 1}: ${String(error)}`);
    }
  });
  return { lines: kept, entries };
}

export interface LedgerVerification {
  ok: boolean;
  entries: number;
  /** Entries written before the hash chain existed. */
  unchainedPrefix: number;
  problems: string[];
}

/** Check that every chained entry follows from the one before it. */
export function verifyLedgerFile(filePath: string): LedgerVerification {
  const problems: string[] = [];
  let lines: string[] = [];
  let entries: LedgerEntry[] = [];
  try {
    ({ lines, entries } = parseLines(filePath));
  } catch (error) {
    return { ok: false, entries: 0, unchainedPrefix: 0, problems: [String(error)] };
  }
  let unchainedPrefix = 0;
  let previous: { seq: number; hash: string } | null = null;
  entries.forEach((entry, index) => {
    const lineNo = index + 1;
    if (entry.seq === undefined) {
      if (previous) problems.push(`line ${lineNo}: unchained entry after the chain began`);
      else unchainedPrefix += 1;
      return;
    }
    const expectedSeq = previous ? previous.seq + 1 : unchainedPrefix + 1;
    if (entry.seq !== expectedSeq) problems.push(`line ${lineNo}: seq ${entry.seq}, expected ${expectedSeq}`);
    const expectedPrev = previous ? previous.hash : unchainedPrefix > 0 ? hashLedgerLine(lines[index - 1]) : null;
    if ((entry.prevHash ?? null) !== expectedPrev) problems.push(`line ${lineNo}: prevHash does not match line ${lineNo - 1}`);
    previous = { seq: entry.seq, hash: hashLedgerLine(lines[index]) };
  });
  return { ok: problems.length === 0, entries: entries.length, unchainedPrefix, problems };
}

export class Ledger {
  private readonly filePath: string;
  private readonly transcriptsFilePath: string;

  constructor(
    private readonly runDir: string,
    private readonly runId: string,
    private readonly strategy: StrategyId,
    private readonly bus?: EventBus,
    // Off by default: a full transcript can carry repository-tool file contents on every call,
    // so this is opt-in diagnostic capture, not something every routine run should pay for.
    private readonly fullTranscripts: boolean = process.env.SWARM_FULL_TRANSCRIPTS === '1',
  ) {
    mkdirSync(runDir, { recursive: true });
    this.filePath = path.join(runDir, 'ledger.jsonl');
    this.transcriptsFilePath = path.join(runDir, 'transcripts.jsonl');
  }

  /**
   * The chain tail, read once per file. A writer is the only party that may cut a torn final
   * line, so this runs on the first write, never on a read: a reader in another process could
   * otherwise truncate an append that is still in flight.
   */
  private tail(): ChainTail {
    const cached = chainTails.get(this.filePath);
    const size = existsSync(this.filePath) ? statSync(this.filePath).size : 0;
    if (cached && cached.size === size) return cached;
    let tail: ChainTail = { seq: 0, hash: null, size: 0 };
    let repairedBytes = 0;
    if (existsSync(this.filePath)) {
      const raw = readFileSync(this.filePath, 'utf8');
      const cut = raw.endsWith('\n') || raw.length === 0 ? raw.length : raw.lastIndexOf('\n') + 1;
      if (cut < raw.length) {
        repairedBytes = Buffer.byteLength(raw.slice(cut), 'utf8');
        truncateSync(this.filePath, statSync(this.filePath).size - repairedBytes);
      }
      const lines = completeLines(raw.slice(0, cut));
      if (lines.length > 0) {
        const last = lines[lines.length - 1];
        const parsed = JSON.parse(last) as LedgerEntry;
        tail = { seq: parsed.seq ?? lines.length, hash: hashLedgerLine(last), size: 0 };
      }
      tail.size = statSync(this.filePath).size;
    }
    chainTails.set(this.filePath, tail);
    if (repairedBytes > 0) this.record('ledger_repaired', { droppedPartialLineBytes: repairedBytes });
    return tail;
  }

  record(type: string, data: Record<string, unknown>): LedgerEntry {
    // Re-read after tail(): a first write that repairs a torn line records the repair first.
    this.tail();
    const tail = chainTails.get(this.filePath)!;
    const entry: LedgerEntry = {
      ts: new Date().toISOString(),
      runId: this.runId,
      strategy: this.strategy,
      type,
      data,
      seq: tail.seq + 1,
      prevHash: tail.hash,
    };
    const line = JSON.stringify(entry);
    appendFileDurable(this.filePath, line + '\n');
    chainTails.set(this.filePath, {
      seq: entry.seq!,
      hash: hashLedgerLine(line),
      size: tail.size + Buffer.byteLength(line + '\n', 'utf8'),
    });
    // Notify after the durable write, and never let an observer's failure fail the run — the
    // audit trail on disk is what matters; the dashboard is a bystander.
    try {
      this.bus?.publish({ kind: 'ledger', runId: this.runId, entry, source: 'engine' });
    } catch {
      /* ignore */
    }
    return entry;
  }

  /**
   * The full prompt/response for one model call — separate from `record()` so it never rides the
   * `bus.publish` path (the live dashboard's SSE feed would otherwise carry every repository-tool
   * file content pulled into a prompt). Returns the transcript's `callId` so the caller can echo
   * it onto the matching `worker_call` ledger entry for cross-reference; returns undefined when
   * transcripts are off, so callers can skip that echo entirely.
   */
  recordTranscript(data: Record<string, unknown>): number | undefined {
    if (!this.fullTranscripts) return undefined;
    // Numbered per run file, not per instance: every launch builds a new Ledger, and restarting
    // at 1 made two calls in one run share an id.
    let previous = transcriptCounters.get(this.transcriptsFilePath);
    if (previous === undefined) {
      previous = existsSync(this.transcriptsFilePath)
        ? completeLines(readFileSync(this.transcriptsFilePath, 'utf8')).length
        : 0;
    }
    const callId = previous + 1;
    transcriptCounters.set(this.transcriptsFilePath, callId);
    const entry = { ts: new Date().toISOString(), runId: this.runId, strategy: this.strategy, callId, ...data };
    appendFileDurable(this.transcriptsFilePath, JSON.stringify(entry) + '\n');
    return callId;
  }

  readAll(): LedgerEntry[] {
    return parseLines(this.filePath).entries;
  }
}
