import { describe, it, expect } from 'vitest';
import {
  buildProbeMessages,
  classifyFailure,
  mapWithConcurrency,
  selectModelsToProbe,
  PROBE_CASES,
  type ModelProbeResult,
  type ProbeCache,
} from './modelProbe.js';
import type { CatalogModel } from '../engine/OpenRouterClient.js';

const NOW = Date.parse('2026-08-25T00:00:00.000Z');
const DAY = 86_400_000;
const OPTIONS = { maxAgeDays: 30, force: false };

function model(overrides: Partial<CatalogModel> = {}): CatalogModel {
  return {
    id: 'vendor/model',
    name: 'Vendor Model',
    contextLength: 131_072,
    inputPricePerMTok: 1,
    outputPricePerMTok: 2,
    supportsJsonMode: true,
    supportsToolCalls: true,
    ...overrides,
  };
}

function cached(overrides: Partial<ModelProbeResult> = {}): ModelProbeResult {
  return {
    id: 'vendor/model',
    supportsJsonMode: true,
    supportsToolCalls: true,
    inputPricePerMTok: 1,
    outputPricePerMTok: 2,
    contextLength: 131_072,
    cases: { planner: { ok: true, latencyMs: 100, costUsd: 0 }, implementer: { ok: true, latencyMs: 100, costUsd: 0 } },
    verified: true,
    costUsd: 0,
    probedAt: new Date(NOW - DAY).toISOString(),
    ...overrides,
  };
}

function cacheOf(...results: ModelProbeResult[]): ProbeCache {
  return { results: Object.fromEntries(results.map((r) => [r.id, r])) };
}

describe('selectModelsToProbe', () => {
  it('probes a model absent from the cache', () => {
    const selection = selectModelsToProbe([model()], {}, NOW, OPTIONS);

    expect(selection.toProbe.map((t) => t.reason)).toEqual(['new']);
    expect(selection.reused).toEqual([]);
  });

  it('reuses a fresh cached verdict without probing', () => {
    const selection = selectModelsToProbe([model()], cacheOf(cached()), NOW, OPTIONS);

    expect(selection.toProbe).toEqual([]);
    expect(selection.reused).toHaveLength(1);
  });

  it('re-probes a verdict older than maxAgeDays', () => {
    const stale = cached({ probedAt: new Date(NOW - 31 * DAY).toISOString() });

    const selection = selectModelsToProbe([model()], cacheOf(stale), NOW, OPTIONS);

    expect(selection.toProbe.map((t) => t.reason)).toEqual(['stale']);
  });

  it('re-probes when catalog pricing changed under the same id', () => {
    const selection = selectModelsToProbe(
      [model({ inputPricePerMTok: 5 })],
      cacheOf(cached()),
      NOW,
      OPTIONS,
    );

    expect(selection.toProbe.map((t) => t.reason)).toEqual(['metadata-changed']);
  });

  it('re-probes when catalog capability flags changed under the same id', () => {
    const selection = selectModelsToProbe(
      [model({ supportsJsonMode: false })],
      cacheOf(cached()),
      NOW,
      OPTIONS,
    );

    expect(selection.toProbe.map((t) => t.reason)).toEqual(['metadata-changed']);
  });

  it('retries a timeout failure sooner than a real verdict expires', () => {
    const timedOut = cached({
      verified: false,
      cases: {
        planner: { ok: true, latencyMs: 100, costUsd: 0 },
        implementer: { ok: false, failureKind: 'timeout', latencyMs: 60_000, costUsd: 0 },
      },
      probedAt: new Date(NOW - 2 * DAY).toISOString(),
    });

    const selection = selectModelsToProbe([model()], cacheOf(timedOut), NOW, OPTIONS);

    expect(selection.toProbe.map((t) => t.reason)).toEqual(['transient-retry']);
  });

  it('keeps a schema failure cached — it is a property of the model, not the provider', () => {
    const badSchema = cached({
      verified: false,
      cases: {
        planner: { ok: false, failureKind: 'schema', latencyMs: 100, costUsd: 0 },
        implementer: { ok: true, latencyMs: 100, costUsd: 0 },
      },
      probedAt: new Date(NOW - 2 * DAY).toISOString(),
    });

    const selection = selectModelsToProbe([model()], cacheOf(badSchema), NOW, OPTIONS);

    expect(selection.toProbe).toEqual([]);
    expect(selection.reused).toHaveLength(1);
  });

  it('drops a cached model that has left the catalog', () => {
    const selection = selectModelsToProbe([], cacheOf(cached()), NOW, OPTIONS);

    expect(selection.toProbe).toEqual([]);
    expect(selection.reused).toEqual([]);
  });

  it('re-probes everything under --force', () => {
    const selection = selectModelsToProbe([model()], cacheOf(cached()), NOW, { maxAgeDays: 30, force: true });

    expect(selection.toProbe.map((t) => t.reason)).toEqual(['stale']);
    expect(selection.reused).toEqual([]);
  });

  it('treats a cache entry with an unparseable probedAt as expired', () => {
    const selection = selectModelsToProbe([model()], cacheOf(cached({ probedAt: 'not-a-date' })), NOW, OPTIONS);

    expect(selection.toProbe.map((t) => t.reason)).toEqual(['stale']);
  });
});

describe('classifyFailure', () => {
  it('reports a timeout as transient regardless of the message', () => {
    expect(classifyFailure(new Error('anything'), true).kind).toBe('timeout');
  });

  it('separates an unrecoverable response from a schema violation', () => {
    expect(classifyFailure(new Error('Unexpected token < in JSON at position 0'), false).kind).toBe('unparseable');
    expect(classifyFailure(new Error('tasks must be an array'), false).kind).toBe('schema');
  });

  it('recognises a transport fault', () => {
    expect(classifyFailure(new Error('HTTP 503 from provider'), false).kind).toBe('transport');
    expect(classifyFailure(new Error('OpenRouter 502 for model vendor/m'), false).kind).toBe('transport');
  });

  // The client signals a timeout by throwing, in which case its result flag was never read. Reading
  // the flag alone filed every timed-out model under "schema" — a verdict about the model rather
  // than about that afternoon's congestion, and one the transient-retry path would never revisit.
  it('recognises a timeout reported only in the thrown message', () => {
    expect(classifyFailure(new Error('request timed out after 60000ms'), false).kind).toBe('timeout');
    expect(classifyFailure(new Error('The operation was aborted'), false).kind).toBe('timeout');
  });

  it('separates a provider refusing an advertised capability from a schema violation', () => {
    const error = new Error('OpenRouter 400 for model g/x: JSON mode is not enabled for this model');

    expect(classifyFailure(error, false).kind).toBe('capability-mismatch');
  });
});

describe('buildProbeMessages', () => {
  it('sends the schema in the user turn, matching the dispatcher framing', () => {
    const messages = buildProbeMessages(PROBE_CASES[0]!);

    expect(messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(messages[1]!.content).toContain(PROBE_CASES[0]!.schemaDescription);
    expect(messages[1]!.content).toContain('no prose, no markdown fences');
  });
});

describe('mapWithConcurrency', () => {
  it('preserves input order in the results', async () => {
    const out = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => n * 10);

    expect(out).toEqual([10, 20, 30, 40, 50]);
  });

  it('never exceeds the concurrency limit', async () => {
    let inFlight = 0;
    let peak = 0;

    await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 3, async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return n;
    });

    expect(peak).toBeLessThanOrEqual(3);
  });
});
