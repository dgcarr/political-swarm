import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { loadProbeResults } from './swarmListModels.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'probe-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeProbe(contents: unknown): void {
  writeFileSync(path.join(dir, 'model-probe.json'), JSON.stringify(contents), 'utf8');
}

describe('loadProbeResults', () => {
  // The probe is optional. /swarm-setup must still work before anyone has run it, so a missing
  // file is "unverified", never an error — and undefined is what lets the skill say so.
  it('returns undefined when no probe has been run', () => {
    expect(loadProbeResults(dir)).toBeUndefined();
  });

  it('returns undefined for an unreadable probe file rather than throwing', () => {
    writeFileSync(path.join(dir, 'model-probe.json'), '{ not json', 'utf8');

    expect(loadProbeResults(dir)).toBeUndefined();
  });

  it('summarises a clean pass with no failures key', () => {
    writeProbe({
      probedAt: '2026-08-25T10:00:00.000Z',
      probed: 1,
      verifiedCount: 1,
      results: {
        'vendor/good': {
          verified: true,
          probedAt: '2026-08-25T10:00:00.000Z',
          cases: { planner: { ok: true }, implementer: { ok: true } },
        },
      },
    });

    const probe = loadProbeResults(dir)!;

    expect(probe.verdicts['vendor/good']).toEqual({
      verified: true,
      probedAt: '2026-08-25T10:00:00.000Z',
    });
  });

  it('surfaces the per-case failure kind the skill warns on', () => {
    writeProbe({
      probedAt: '2026-08-25T10:00:00.000Z',
      results: {
        'vendor/bad': {
          verified: false,
          probedAt: '2026-08-25T10:00:00.000Z',
          cases: {
            planner: { ok: true },
            implementer: { ok: false, failureKind: 'capability-mismatch' },
          },
        },
      },
    });

    const probe = loadProbeResults(dir)!;

    expect(probe.verdicts['vendor/bad']!.verified).toBe(false);
    expect(probe.verdicts['vendor/bad']!.failures).toEqual({ implementer: 'capability-mismatch' });
  });

  it('derives counts when the file omits them', () => {
    writeProbe({
      probedAt: '2026-08-25T10:00:00.000Z',
      results: {
        'vendor/a': { verified: true, cases: { planner: { ok: true } } },
        'vendor/b': { verified: false, cases: { planner: { ok: false, failureKind: 'schema' } } },
      },
    });

    const probe = loadProbeResults(dir)!;

    expect(probe.probed).toBe(2);
    expect(probe.verifiedCount).toBe(1);
  });

  it('falls back to the file-level probedAt for an entry that lacks its own', () => {
    writeProbe({
      probedAt: '2026-08-25T10:00:00.000Z',
      results: { 'vendor/a': { verified: true, cases: {} } },
    });

    expect(loadProbeResults(dir)!.verdicts['vendor/a']!.probedAt).toBe('2026-08-25T10:00:00.000Z');
  });

  it('treats a file with no results block as no probe at all', () => {
    writeProbe({ probedAt: '2026-08-25T10:00:00.000Z' });

    expect(loadProbeResults(dir)).toBeUndefined();
  });
});
