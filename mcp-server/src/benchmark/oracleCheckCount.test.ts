import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ORACLE_CHECK_COUNT } from './runBenchmark.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * Counts the checks listed in `OracleChecks.run_all`, which is what the oracle actually returns.
 *
 * The oracle is Python and the harness is TypeScript, so the count cannot be imported across the
 * boundary and has to be asserted instead.
 */
function checksDeclaredInOracle(): number {
  const source = readFileSync(path.join(repoRoot, 'benchmark/oracle/checks.py'), 'utf8');
  const start = source.indexOf('checks: tuple[tuple[str, Callable[[], str]], ...] = (');
  expect(start, 'the checks tuple in run_all moved or was renamed').toBeGreaterThan(-1);
  const body = source.slice(start, source.indexOf('\n        )', start));
  return [...body.matchAll(/^\s+\("/gm)].length;
}

describe('oracle check count', () => {
  it('matches the number of checks the oracle declares', () => {
    expect(ORACLE_CHECK_COUNT).toBe(checksDeclaredInOracle());
  });

  /**
   * Adding a twelfth check without updating this constant left it at 11. The engine refuses a
   * delivery whose evaluation count is not exactly `requiredExternalEvaluationCount`, so every run
   * became unacceptable and sat until the harness poll deadline killed it — a 135-minute run
   * reported as `harness_error` with no indication that the cause was an off-by-one here.
   */
  it('is what the engine requires before a delivery can be accepted', () => {
    const source = readFileSync(path.join(repoRoot, 'mcp-server/src/benchmark/runBenchmark.ts'), 'utf8');
    expect(source).toContain('requiredExternalEvaluationCount: ORACLE_CHECK_COUNT');
    expect(source).not.toMatch(/requiredExternalEvaluationCount:\s*\d/);
  });
});
