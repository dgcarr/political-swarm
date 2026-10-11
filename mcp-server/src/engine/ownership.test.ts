import { describe, it, expect } from 'vitest';
import {
  applyOrphanTransfers,
  batchByOwnership,
  criteriaAheadOfTheirOwners,
  dependencyCycle,
  missingOwnedSources,
  filesForTasks,
  orphanedPathTransfers,
  mergeOwnership,
  ownedTaskIdsForText,
  ownershipFromGraph,
  planWithoutTests,
  readingOnlyTasks,
  undeclaredPaths,
} from './ownership.js';
import { emptyOwnershipMap, type OwnershipMap } from './packets.js';
import type { Assignment, FileOp, TaskGraph, TaskNode } from './types.js';

const TEST_GLOBS = ['**/*.test.*'];

function node(id: string, targetGlobs: string[]): TaskNode {
  return {
    id,
    title: id,
    description: id,
    acceptanceCriteria: [],
    dependsOn: [],
    targetGlobs,
    riskTags: [],
    riskClass: 'low',
    phase: 'queued',
    attempts: [],
  };
}

function graphOf(spec: Record<string, string[]>): TaskGraph {
  const nodes: Record<string, TaskNode> = {};
  for (const [id, globs] of Object.entries(spec)) nodes[id] = node(id, globs);
  return { nodes, order: Object.keys(spec) };
}

function assignmentsFor(ids: string[]): Assignment[] {
  return ids.map((taskId) => ({ taskId, assigneeId: 'worker', role: 'implementer' }));
}

function mapOf(spec: Record<string, string[]>): OwnershipMap {
  return ownershipFromGraph(graphOf(spec), TEST_GLOBS);
}

describe('ownershipFromGraph', () => {
  it('seeds one entry per node from its declared target globs', () => {
    const map = mapOf({ a: ['src/a.ts'], b: ['src/b.ts', 'src/b.test.ts'] });

    expect(map.entries.a.paths).toEqual(['src/a.ts']);
    expect(map.entries.b.tests).toEqual(['src/b.test.ts']);
    expect(map.declaredOverlaps).toEqual([]);
  });
});

describe('batchByOwnership', () => {
  it('batches tasks whose declared paths do not touch', () => {
    const map = mapOf({ a: ['src/a.ts'], b: ['src/b.ts'], c: ['src/c.ts'] });
    const batches = batchByOwnership(assignmentsFor(['a', 'b', 'c']), map, 3);

    expect(batches).toHaveLength(1);
    expect(batches[0].map((x) => x.taskId)).toEqual(['a', 'b', 'c']);
  });

  it('separates tasks that claim the same path', () => {
    const map = mapOf({ a: ['src/shared.ts'], b: ['src/shared.ts'] });
    const batches = batchByOwnership(assignmentsFor(['a', 'b']), map, 3);

    expect(batches.map((b) => b.map((x) => x.taskId))).toEqual([['a'], ['b']]);
  });

  it('treats a glob and a concrete path under it as overlapping', () => {
    const map = mapOf({ a: ['src/auth/**'], b: ['src/auth/login.ts'] });
    const batches = batchByOwnership(assignmentsFor(['a', 'b']), map, 3);

    expect(batches).toHaveLength(2);
  });

  it('never exceeds the concurrency cap', () => {
    const map = mapOf({ a: ['a.ts'], b: ['b.ts'], c: ['c.ts'], d: ['d.ts'] });
    const batches = batchByOwnership(assignmentsFor(['a', 'b', 'c', 'd']), map, 2);

    expect(batches.map((b) => b.length)).toEqual([2, 2]);
  });

  it('isolates a task with no ownership entry, since it could touch anything', () => {
    const map = mapOf({ a: ['src/a.ts'] });
    const batches = batchByOwnership(assignmentsFor(['a', 'unknown']), map, 3);

    expect(batches).toHaveLength(2);
  });
});

describe('undeclaredPaths', () => {
  const ops = (paths: string[]): FileOp[] => paths.map((path) => ({ op: 'write', path, content: '' }));

  it('reports paths a task wrote but never claimed', () => {
    const map = mapOf({ a: ['src/a.ts'] });

    expect(undeclaredPaths('a', ops(['src/a.ts', 'src/sneaky.ts']), map)).toEqual(['src/sneaky.ts']);
  });

  it('accepts writes covered by a declared glob', () => {
    const map = mapOf({ a: ['src/auth/**'] });

    expect(undeclaredPaths('a', ops(['src/auth/login.ts']), map)).toEqual([]);
  });

  it('accepts a path the coordinating body declared as a shared overlap', () => {
    const map = mapOf({ a: ['src/a.ts'], b: ['src/b.ts'] });
    map.declaredOverlaps.push({ taskIds: ['a', 'b'], path: 'src/shared.ts', rationale: 'agreed interface' });

    expect(undeclaredPaths('a', ops(['src/a.ts', 'src/shared.ts']), map)).toEqual([]);
  });

  it('stays silent when nothing was declared at all, rather than flagging every write', () => {
    expect(undeclaredPaths('a', ops(['anything.ts']), emptyOwnershipMap())).toEqual([]);
  });

  /**
   * Regression: WorkerDispatcher's corrective-retry loop calls this against a model's raw,
   * not-yet-translated wire JSON. A malformed or (for democratic, pre-fix) wire-format-mismatched
   * FileOp can carry no string `path` at all — this must degrade (skip the unparseable op) rather
   * than crash matchesAnyGlob on a non-string, which turned a correctable validation error into a
   * hard failure that killed the whole task attempt.
   */
  it('skips a fileOp with no string path instead of throwing', () => {
    const map = mapOf({ a: ['src/a.ts'] });
    const malformed = [{ op: 'write', path: undefined, content: '' } as unknown as FileOp];

    expect(() => undeclaredPaths('a', malformed, map)).not.toThrow();
    expect(undeclaredPaths('a', malformed, map)).toEqual([]);
  });
});

describe('mergeOwnership', () => {
  it('keeps the planner globs when a doctrine adds its own', () => {
    const base = mapOf({ a: ['src/a.ts'] });
    const refined = mapOf({ a: ['src/a-helper.ts'] });
    refined.entries.a.interfaces = ['portfolio:backend'];
    refined.declaredOverlaps.push({ taskIds: ['a'], path: 'src/a.ts', rationale: 'shared' });

    const merged = mergeOwnership(base, refined);

    expect(merged.entries.a.paths.sort()).toEqual(['src/a-helper.ts', 'src/a.ts']);
    expect(merged.entries.a.interfaces).toEqual(['portfolio:backend']);
    expect(merged.declaredOverlaps).toHaveLength(1);
  });
});

describe('ownedTaskIdsForText', () => {
  it('maps a two-path finding to exactly the owning tasks', () => {
    const map = mapOf({
      composition: ['alloydamage/composition.py'],
      cli: ['alloydamage/cli.py'],
      damage: ['alloydamage/damage.py'],
      docs: ['README.md'],
    });
    const owners = ownedTaskIdsForText(
      map,
      'Interpolation is duplicated in alloydamage/cli.py and alloydamage/damage.py',
    );

    expect(owners.sort()).toEqual(['cli', 'damage']);
  });

  it('maps a basename token such as cli.py to the owned source path', () => {
    const map = mapOf({
      cli: ['alloydamage/cli.py'],
      docs: ['README.md'],
    });

    expect(ownedTaskIdsForText(map, 'cli.py still duplicates _log_interp')).toEqual(['cli']);
  });

  it('ignores check-artifact paths listed separately from authored ownership', () => {
    const map = mapOf({
      cli: ['alloydamage/cli.py', 'Simplified 304L.csv'],
    });

    expect(
      ownedTaskIdsForText(map, 'Simplified 304L.csv looks authored', ['Simplified 304L.csv']),
    ).toEqual([]);
  });

  it('does not treat a basename as matching a glob ownership term', () => {
    const map = mapOf({ src: ['src/**'] });

    expect(ownedTaskIdsForText(map, 'cli.py failed')).toEqual([]);
    expect(ownedTaskIdsForText(map, 'src/** is incomplete')).toEqual(['src']);
  });
});

describe('orphanedPathTransfers', () => {
  function skeletonRun() {
    const graph = graphOf({
      skeleton: ['pkg/__init__.py', 'pkg/__main__.py'],
      core: ['pkg/core.py'],
      cli: ['pkg/cli.py'],
    });
    graph.nodes.core.dependsOn = ['skeleton'];
    graph.nodes.cli.dependsOn = ['skeleton'];
    return { graph, ownership: ownershipFromGraph(graph, TEST_GLOBS) };
  }
  const skeletonGone = (id: string) => id === 'skeleton';

  it('moves a gone owner\'s file to the reopened task that depends on it', () => {
    const { graph, ownership } = skeletonRun();
    const transfers = orphanedPathTransfers(ownership, graph, 'Missing __main__.py: python -m pkg fails', ['cli'], skeletonGone);

    expect(transfers).toEqual([{ path: 'pkg/__main__.py', from: ['skeleton'], to: 'cli' }]);
    applyOrphanTransfers(ownership, transfers);
    expect(undeclaredPaths('cli', [{ op: 'write', path: 'pkg/__main__.py', content: '' }], ownership)).toEqual([]);
  });

  it('falls back to the first live dependent when the finding names no live task', () => {
    const { graph, ownership } = skeletonRun();
    expect(orphanedPathTransfers(ownership, graph, 'pkg/__main__.py is missing', ['skeleton'], skeletonGone))
      .toEqual([{ path: 'pkg/__main__.py', from: ['skeleton'], to: 'core' }]);
  });

  it('leaves a file alone while any of its owners can still run', () => {
    const { graph, ownership } = skeletonRun();
    expect(orphanedPathTransfers(ownership, graph, 'pkg/__main__.py is missing', ['cli'], () => false)).toEqual([]);
  });

  it('moves nothing the finding does not name', () => {
    const { graph, ownership } = skeletonRun();
    expect(orphanedPathTransfers(ownership, graph, 'core.py raises on empty input', ['cli'], skeletonGone)).toEqual([]);
  });
});

// Real plans (30 of 44 since 2026-10-02) asked a task to meet a criterion through a file a task
// outside its upstream writes: the scaffold's __main__.py "dispatches to cli.py" before cli.py exists.
describe('missingOwnedSources', () => {
  it('names absent concrete source paths only, never globs or runtime outputs', () => {
    const ownership = {
      entries: { calc: { taskId: 'calc', paths: ['pkg/damage.py', 'pkg/__init__.py', 'pkg/*.py', 'results/304L.csv'], interfaces: [], generated: [], tests: [] } },
      declaredOverlaps: [],
      publishedAt: '',
    };
    expect(missingOwnedSources('calc', ownership, (p) => p === 'pkg/__init__.py')).toEqual(['pkg/damage.py']);
    expect(missingOwnedSources('other', ownership, () => false)).toEqual([]);
  });
});

describe('dependencyCycle', () => {
  const task = (id: string, dependsOn: string[] = []) => ({ id, dependsOn });

  it('names the cycle a real single-agent plan made, and passes an acyclic plan', () => {
    expect(dependencyCycle([task('core-package', ['docs-example']), task('tests', ['core-package']), task('docs-example', ['core-package'])]))
      .toEqual(['core-package', 'docs-example', 'core-package']);
    expect(dependencyCycle([task('a'), task('b', ['a']), task('c', ['a', 'b'])])).toBeUndefined();
  });

  it('finds a self-dependency and ignores ids the plan does not define', () => {
    expect(dependencyCycle([task('a', ['a'])])).toEqual(['a', 'a']);
    expect(dependencyCycle([task('a', ['missing'])])).toBeUndefined();
  });
});

describe('criteriaAheadOfTheirOwners', () => {
  const task = (id: string, targetGlobs: string[], acceptanceCriteria: string[], dependsOn: string[] = []) =>
    ({ id, targetGlobs, acceptanceCriteria, dependsOn });

  it('flags a criterion that needs a file a later task writes', () => {
    const hits = criteriaAheadOfTheirOwners([
      task('scaffold', ['pkg/__main__.py'], ['pkg/__main__.py exists and dispatches to cli.py']),
      task('cli', ['pkg/cli.py'], ['The CLI parses arguments'], ['scaffold']),
    ]);
    expect(hits).toEqual([{ taskId: 'scaffold', criterion: 'pkg/__main__.py exists and dispatches to cli.py',
      ownerTaskId: 'cli', path: 'pkg/cli.py' }]);
  });

  it('accepts a file from an upstream task, its own, or one nobody plans to write', () => {
    expect(criteriaAheadOfTheirOwners([
      task('scaffold', ['pkg/__main__.py'], ['Imports data/Fe/Fe_dpa_nrt.csv']),
      task('cli', ['pkg/cli.py'], ['pkg/cli.py is called by pkg/__main__.py'], ['scaffold']),
      task('docs', ['README.md'], ['README documents cli.py usage'], ['cli']),
    ])).toEqual([]);
  });
});

describe('readingOnlyTasks', () => {
  const exists = (path: string) => ['data/Fe.csv', 'README.md'].includes(path);

  it('flags a task that leads with reading and owns only files already present', () => {
    const hits = readingOnlyTasks([
      { id: 'read-data', title: 'Read and inventory supplied data', targetGlobs: ['data/Fe.csv', 'README.md'] },
      { id: 'docs', title: 'Write the README', targetGlobs: ['README.md'] },
      { id: 'loader', title: 'Read CSVs in a new loader', targetGlobs: ['pkg/loader.py', 'data/Fe.csv'] },
      { id: 'globbed', description: 'Inspect the data', targetGlobs: ['data/**'] },
    ], exists);
    expect(hits.map((task) => task.id)).toEqual(['read-data']);
  });
});

describe('filesForTasks', () => {
  it('sends a file with any chosen owner, names the owners of the rest, and lists unowned files', () => {
    const ownership = {
      entries: {
        a: { taskId: 'a', paths: ['src/a.py'], interfaces: [], generated: [], tests: ['tests/test_a.py'] },
        b: { taskId: 'b', paths: ['src/b/**'], interfaces: [], generated: [], tests: [] },
      },
      declaredOverlaps: [{ taskIds: ['a', 'b'], path: 'src/shared.py', rationale: 'both extend it' }],
      publishedAt: '',
    };
    expect(filesForTasks(['src/a.py', 'tests/test_a.py', 'src/b/x.py', 'src/shared.py', 'notes.txt'], ['a'], ownership)).toEqual({
      selected: ['src/a.py', 'tests/test_a.py', 'src/shared.py'],
      othersOwn: [{ path: 'src/b/x.py', owners: ['b'] }],
      unowned: ['notes.txt'],
    });
  });
});

describe('planWithoutTests', () => {
  const globs = ['**/*.test.*', '**/tests/**', '**/test/**'];
  const task = (targetGlobs: string[]) => ({ id: targetGlobs[0], targetGlobs, acceptanceCriteria: [], dependsOn: [] });

  it('flags a plan that changes source but gives no task a test', () => {
    // The 2026-10-08 socialist cycle-1 plan.
    expect(planWithoutTests([
      task(['alloydamage/__init__.py', 'alloydamage/nuclear_data.py']),
      task(['alloydamage/cli.py', 'examples/304L.yaml']),
      task(['README.md']),
    ], globs)).toBe(true);
  });

  it('accepts a plan with a test path, a broad glob, only documentation, or no test globs configured', () => {
    expect(planWithoutTests([task(['src/a.ts']), task(['tests/test_a.py'])], globs)).toBe(false);
    expect(planWithoutTests([task(['src/a.test.ts', 'src/a.ts'])], globs)).toBe(false);
    expect(planWithoutTests([task(['src/**'])], globs)).toBe(false);
    expect(planWithoutTests([task(['README.md', 'docs/guide.rst'])], globs)).toBe(false);
    expect(planWithoutTests([task(['src/a.ts'])], [])).toBe(false);
  });

  it('does not count a package marker or fixtures as owning tests', () => {
    expect(planWithoutTests([task(['pkg/core.py', 'tests/__init__.py', 'tests/conftest.py'])], globs)).toBe(true);
  });
});
