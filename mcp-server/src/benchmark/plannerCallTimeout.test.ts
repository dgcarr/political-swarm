import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { FAST_ROLE_CALL_TIMEOUT_MS, PLANNER_CALL_TIMEOUT_MS } from './runBenchmark.js';

const source = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'runBenchmark.ts'),
  'utf8',
);

/**
 * The planner has taken an entire benchmark arm down twice by exceeding a budget that was set from
 * prompt size rather than from how long planning actually takes. Both times the repair was to raise
 * the number; neither time was anything left behind to notice the next regression.
 */
describe('planner call timeout', () => {
  it('is longer than the leash the genuinely fast roles share', () => {
    expect(PLANNER_CALL_TIMEOUT_MS).toBeGreaterThan(FAST_ROLE_CALL_TIMEOUT_MS);
  });

  /**
   * Measured against the live roster on 2026-09-25: 339.9s for stealth/space-bunny-alpha and 179.2s
   * for z-ai/glm-5.3-flash, both returning valid graphs. A budget at or below the slower of those is
   * one that fails a working model, which is precisely the bug — so the floor is that observation,
   * not an arbitrary constant.
   */
  it('clears the slowest planning call actually observed on the roster', () => {
    const slowestObservedMs = 340_000;
    expect(PLANNER_CALL_TIMEOUT_MS).toBeGreaterThan(slowestObservedMs);
  });

  it('is handed to the engine as a per-role override, not left on the default', () => {
    expect(source).toMatch(/perCallTimeoutMsByRole\s*=\s*\{[^}]*planner:\s*PLANNER_CALL_TIMEOUT_MS/s);
  });
});
