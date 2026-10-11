import { describe, expect, it } from 'vitest';

import type { RunState } from './RunStore.js';
import { ORACLE_WITHHELD_EVIDENCE, oracleAffectedTaskIds, oracleRemediationFindings } from './SwarmEngine.js';

function stateWithBenchmarkOwnership(): RunState {
  const taskIds = ['composition', 'nuclear', 'damage', 'plotting', 'cli', 'docs', 'tests'];
  const paths: Record<string, string[]> = {
    composition: ['alloydamage/composition.py'],
    nuclear: ['alloydamage/nuclear_data.py'],
    damage: ['alloydamage/damage.py'],
    plotting: ['alloydamage/plotting.py'],
    cli: ['alloydamage/cli.py', 'alloydamage/__main__.py'],
    docs: ['README.md'],
    tests: ['tests/test_integration.py'],
  };
  return {
    graph: {
      order: taskIds,
      nodes: Object.fromEntries(taskIds.map((id) => [id, { id, targetGlobs: paths[id] }])),
    },
    ownership: {
      entries: Object.fromEntries(taskIds.map((id) => [id, {
        taskId: id,
        paths: paths[id],
        interfaces: [],
        generated: [],
        tests: id === 'tests' ? paths[id] : [],
      }])),
      declaredOverlaps: [],
      publishedAt: new Date(0).toISOString(),
    },
  } as unknown as RunState;
}

describe('oracleAffectedTaskIds', () => {
  it('maps interpolation failures only to nuclear-data and damage owners', () => {
    expect(oracleAffectedTaskIds(stateWithBenchmarkOwnership(), 6)).toEqual(['nuclear', 'damage']);
  });

  it('sends an exit-status check to the entry point as well as the module that raises', () => {
    // Socialist cycle 3b: composition raised, cli printed, __main__.py dropped the exit code.
    expect(oracleAffectedTaskIds(stateWithBenchmarkOwnership(), 5)).toEqual(['composition', 'nuclear', 'cli']);
  });

  it('maps composition and CSV failures to their exact source owners', () => {
    const state = stateWithBenchmarkOwnership();
    expect(oracleAffectedTaskIds(state, 3)).toEqual(['composition']);
    expect(oracleAffectedTaskIds(state, 8)).toEqual(['damage', 'cli']);
  });

  it('does not reopen documentation or broad integration tests for unrelated numeric failures', () => {
    const state = stateWithBenchmarkOwnership();
    const affected = new Set([1, 2, 3, 4, 6, 8].flatMap((checkId) => oracleAffectedTaskIds(state, checkId)));
    expect([...affected]).toEqual(['nuclear', 'damage', 'composition', 'cli']);
  });
});

describe('oracleRemediationFindings', () => {
  it('names the failed check and its owners but withholds the oracle detail', () => {
    // Verbatim from the 2026-10-05 repairbrief managerial arm.
    const detail = 'Fe contribution: got 381.176690219, independently expected one of ' +
      '[380.917775401..380.917775408, 379.476525489..379.476525495]';
    const [finding] = oracleRemediationFindings(stateWithBenchmarkOwnership(), [
      { id: 8, description: 'CSV output schema and values', passed: false, detail },
    ]);

    expect(finding).toEqual({
      summary: 'External oracle check 8 failed: CSV output schema and values',
      evidence: ORACLE_WITHHELD_EVIDENCE,
      affectedTaskIds: ['damage', 'cli'],
      severity: 'high',
    });
    expect(JSON.stringify(finding)).not.toMatch(/380\.9|379\.4|381\.1|independently expected/);
  });
});
