import { describe, expect, it } from 'vitest';
import { failureLocations, renderFailureLocations } from './failureLocation.js';
import { emptyOwnershipMap, type OwnershipMap } from './packets.js';

const ownership: OwnershipMap = {
  ...emptyOwnershipMap(),
  entries: {
    cli: { taskId: 'cli', paths: ['alloydamage/cli.py'], interfaces: [], generated: [], tests: [] },
    tests: { taskId: 'tests', paths: [], interfaces: [], generated: [], tests: ['tests/test_damage.py'] },
  },
};

// The repairbrief-r1 collection error that every democratic task was rejected for.
const COLLECTION_ERROR = [
  '==================================== ERRORS ====================================',
  '____________________ ERROR collecting tests/test_damage.py _____________________',
  'tests/test_damage.py:27: in <module>',
  '    DATA_DIR = Path(__file__).resolve().parent.parent / "data"',
  "E   NameError: name 'Path' is not defined",
  'ERROR tests/test_damage.py - NameError',
].join('\n');

describe('failureLocations', () => {
  it('maps a collection error to the task owning the test file', () => {
    expect(failureLocations(COLLECTION_ERROR, ownership)).toEqual([{ path: 'tests/test_damage.py', owners: ['tests'] }]);
  });

  it('reads pytest node ids and absolute traceback paths, skipping installed packages', () => {
    const output = [
      'FAILED tests/test_damage.py::test_cli_runs - SystemExit: 2',
      'Traceback (most recent call last):',
      '  File "/home/u/runs/benchmark/x/wt/alloydamage/cli.py", line 40, in main',
      '  File "/home/u/.venv/lib/python3.14/site-packages/numpy/core.py", line 9, in f',
    ].join('\n');
    expect(failureLocations(output, ownership)).toEqual([
      { path: 'tests/test_damage.py', owners: ['tests'] },
      { path: 'alloydamage/cli.py', owners: ['cli'] },
    ]);
  });

  it('finds nothing without ownership or output', () => {
    expect(failureLocations(undefined, ownership)).toEqual([]);
    expect(failureLocations(COLLECTION_ERROR, undefined)).toEqual([]);
  });
});

describe('renderFailureLocations', () => {
  it('tells the reviewer a failure entirely in other tasks\' files is not this task\'s defect', () => {
    const text = renderFailureLocations([{ path: 'tests/test_damage.py', owners: ['tests'] }], 'cli');
    expect(text).toContain('tests/test_damage.py: owned by task tests');
    expect(text).toContain('Do not reject this task for it');
  });

  it('marks the task\'s own files and drops the absolution when one is involved', () => {
    const text = renderFailureLocations([
      { path: 'tests/test_damage.py', owners: ['tests'] },
      { path: 'alloydamage/cli.py', owners: ['cli'] },
    ], 'cli');
    expect(text).toContain('alloydamage/cli.py: owned by this task');
    expect(text).not.toContain('Do not reject this task for it');
  });

  it('is empty when nothing was located', () => {
    expect(renderFailureLocations([], 'cli')).toBe('');
  });
});
