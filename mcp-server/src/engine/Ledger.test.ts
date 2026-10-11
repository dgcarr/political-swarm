import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { Ledger, hashLedgerLine, verifyLedgerFile } from './Ledger.js';
import type { EventBus } from './EventBus.js';

let dir: string;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function readTranscripts(runDir: string): unknown[] {
  const file = path.join(runDir, 'transcripts.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

describe('Ledger.recordTranscript', () => {
  it('is a no-op when full transcripts are disabled', () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'ledger-test-'));
    const ledger = new Ledger(dir, 'run-1', 'democratic', undefined, false);
    const callId = ledger.recordTranscript({ role: 'planner', messages: [] });
    expect(callId).toBeUndefined();
    expect(readTranscripts(dir)).toEqual([]);
  });

  it('writes a transcript line and returns an incrementing callId when enabled', () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'ledger-test-'));
    const ledger = new Ledger(dir, 'run-1', 'democratic', undefined, true);
    const firstId = ledger.recordTranscript({ role: 'planner', messages: [{ role: 'user', content: 'hi' }] });
    const secondId = ledger.recordTranscript({ role: 'implementer', messages: [] });
    expect(firstId).toBe(1);
    expect(secondId).toBe(2);
    const entries = readTranscripts(dir) as Array<{ callId: number; runId: string; strategy: string; role: string }>;
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ callId: 1, runId: 'run-1', strategy: 'democratic', role: 'planner' });
    expect(entries[1]).toMatchObject({ callId: 2, role: 'implementer' });
  });

  it('never publishes transcript writes to the event bus', () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'ledger-test-'));
    const publish = () => {
      throw new Error('bus.publish must not be called for transcript writes');
    };
    const ledger = new Ledger(dir, 'run-1', 'democratic', { publish } as unknown as EventBus, true);
    expect(() => ledger.recordTranscript({ role: 'planner', messages: [] })).not.toThrow();
  });
});

describe('Ledger hash chain', () => {
  const ledgerFile = () => path.join(dir, 'ledger.jsonl');

  it('numbers entries and links each to the one before it', () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'ledger-chain-'));
    const ledger = new Ledger(dir, 'run-chain-1', 'democratic');
    const first = ledger.record('a', {});
    const second = ledger.record('b', { n: 1 });
    expect(first).toMatchObject({ seq: 1, prevHash: null });
    expect(second.seq).toBe(2);
    expect(second.prevHash).toBe(hashLedgerLine(readFileSync(ledgerFile(), 'utf8').split('\n')[0]));
    expect(verifyLedgerFile(ledgerFile())).toEqual({ ok: true, entries: 2, unchainedPrefix: 0, problems: [] });
  });

  it('continues one chain across Ledger instances, as every launch builds its own', () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'ledger-chain-'));
    new Ledger(dir, 'run-chain-2', 'socialist').record('a', {});
    new Ledger(dir, 'run-chain-2', 'socialist').record('b', {});
    expect(verifyLedgerFile(ledgerFile()).ok).toBe(true);
  });

  it('names the line where an edited entry breaks the chain', () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'ledger-chain-'));
    const ledger = new Ledger(dir, 'run-chain-3', 'capitalist');
    ledger.record('vote', { result: 'reject' });
    ledger.record('next', {});
    writeFileSync(ledgerFile(), readFileSync(ledgerFile(), 'utf8').replace('"reject"', '"approve"'));
    const verdict = verifyLedgerFile(ledgerFile());
    expect(verdict.ok).toBe(false);
    expect(verdict.problems).toEqual(['line 2: prevHash does not match line 1']);
  });

  it('accepts a pre-chain ledger as an unchained prefix and chains on from it', () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'ledger-chain-'));
    const legacy = JSON.stringify({ ts: 't', runId: 'run-chain-4', strategy: 'democratic', type: 'old', data: {} });
    writeFileSync(ledgerFile(), legacy + '\n');
    const entry = new Ledger(dir, 'run-chain-4', 'democratic').record('new', {});
    expect(entry).toMatchObject({ seq: 2, prevHash: hashLedgerLine(legacy) });
    expect(verifyLedgerFile(ledgerFile())).toMatchObject({ ok: true, entries: 2, unchainedPrefix: 1 });
  });
});

describe('Ledger after a crash', () => {
  it('reads past a torn final line but refuses corruption earlier in the file', () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'ledger-torn-'));
    const file = path.join(dir, 'ledger.jsonl');
    new Ledger(dir, 'run-torn-1', 'democratic').record('a', {});
    appendFileSync(file, '{"ts":"2026');
    expect(new Ledger(dir, 'run-torn-1', 'democratic').readAll().map((e) => e.type)).toEqual(['a']);

    writeFileSync(file, 'not json\n' + readFileSync(file, 'utf8'));
    expect(() => new Ledger(dir, 'run-torn-1', 'democratic').readAll()).toThrow(/Corrupt ledger .* line 1/);
  });

  it('cuts the torn line on the next write and records that it did', () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'ledger-torn-'));
    const file = path.join(dir, 'ledger.jsonl');
    writeFileSync(file, JSON.stringify({ ts: 't', runId: 'run-torn-2', strategy: 'democratic', type: 'a', data: {} }) + '\n{"ts":"20');
    new Ledger(dir, 'run-torn-2', 'democratic').record('b', {});
    const types = new Ledger(dir, 'run-torn-2', 'democratic').readAll().map((e) => e.type);
    expect(types).toEqual(['a', 'ledger_repaired', 'b']);
    expect(verifyLedgerFile(file).ok).toBe(true);
  });
});

describe('Ledger transcript ids', () => {
  it('keep counting across Ledger instances for one run', () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'ledger-transcript-ids-'));
    expect(new Ledger(dir, 'run-tx-1', 'democratic', undefined, true).recordTranscript({})).toBe(1);
    expect(new Ledger(dir, 'run-tx-1', 'democratic', undefined, true).recordTranscript({})).toBe(2);
  });
});

describe('Ledger chain tail', () => {
  it('re-reads the file when another writer appended to it', () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'ledger-tail-'));
    const file = path.join(dir, 'ledger.jsonl');
    const ledger = new Ledger(dir, 'run-tail-1', 'democratic');
    ledger.record('a', {});
    const outside = JSON.stringify({ ts: 't', runId: 'run-tail-1', strategy: 'democratic', type: 'x', data: {}, seq: 2, prevHash: hashLedgerLine(readFileSync(file, 'utf8').trim()) });
    appendFileSync(file, outside + '\n');
    expect(ledger.record('b', {})).toMatchObject({ seq: 3, prevHash: hashLedgerLine(outside) });
    expect(verifyLedgerFile(file).ok).toBe(true);
  });
});
