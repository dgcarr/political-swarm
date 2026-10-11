// Dependency and ownership bookkeeping for section 8 of each doctrine.
//
// The three docs describe the same artefact under three names — the Cabinet's "dependency and
// ownership map", the coordinating council's "public dependency and stewardship map", the task
// exchange's "dependency and property schedule" — and impose the same two rules on it: work may
// run concurrently only where ownership is disjoint or an overlap was declared in advance, and
// anything overlapping that nobody declared is a coordination defect rather than implied
// permission to overwrite another worker's files.

import type { OwnershipEntry, OwnershipMap } from './packets.js';
import type { Assignment, FileOp, TaskGraph } from './types.js';
import { matchesAnyGlob } from '../util/glob.js';

/** Seeds an ownership map from what the planner already declared in each node's targetGlobs.
 * Each doctrine's coordinating body refines this in its own declareOwnership(). */
export function ownershipFromGraph(graph: TaskGraph, testPathGlobs: string[]): OwnershipMap {
  const entries: Record<string, OwnershipEntry> = {};
  for (const id of graph.order) {
    const node = graph.nodes[id];
    const paths = [...new Set(node.targetGlobs)];
    entries[id] = {
      taskId: id,
      paths,
      interfaces: [],
      generated: [],
      tests: paths.filter((p) => matchesAnyGlob(p, testPathGlobs)),
    };
  }
  return { entries, declaredOverlaps: [], publishedAt: new Date().toISOString() };
}

function overlaps(a: OwnershipEntry | undefined, b: OwnershipEntry | undefined): boolean {
  if (!a || !b) return true; // an undeclared task is treated as touching everything
  const claimed = new Set([...a.paths, ...a.interfaces, ...a.generated]);
  if (claimed.size === 0) return true;
  const other = [...b.paths, ...b.interfaces, ...b.generated];
  if (other.length === 0) return true;
  // Compare both directions as globs — "src/auth/**" and "src/auth/login.ts" overlap even though
  // neither string equals the other.
  return other.some((p) => claimed.has(p) || matchesAnyGlob(p, [...claimed])) ||
    [...claimed].some((p) => matchesAnyGlob(p, other));
}

/**
 * Groups assignments into batches whose declared ownership is disjoint. Members of one batch may
 * have their execute() calls run concurrently; batches themselves run in order. A task that
 * overlaps anything already in the current batch starts a new one — the docs allow concurrency
 * only "with disjoint ownership or an agreed shared interface".
 */
export function batchByOwnership(
  assignments: Assignment[],
  ownership: OwnershipMap,
  maxConcurrent: number,
): Assignment[][] {
  const batches: Assignment[][] = [];
  let current: Assignment[] = [];

  for (const assignment of assignments) {
    const entry = ownership.entries[assignment.taskId];
    const collides = current.some((a) => overlaps(ownership.entries[a.taskId], entry));
    if (current.length > 0 && (collides || current.length >= maxConcurrent)) {
      batches.push(current);
      current = [];
    }
    current.push(assignment);
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * Paths a task actually wrote that its ownership entry never claimed. Checked after execute() and
 * before the work is accepted, mirroring "repository status and diffs are checked again at every
 * barrier to detect undeclared dependencies".
 */
export function undeclaredPaths(taskId: string, fileOps: FileOp[], ownership: OwnershipMap): string[] {
  const entry = ownership.entries[taskId];
  const declared = entry ? [...entry.paths, ...entry.interfaces, ...entry.generated, ...entry.tests] : [];
  const allowedByOverlap = new Set(
    ownership.declaredOverlaps.filter((o) => o.taskIds.includes(taskId)).map((o) => o.path),
  );
  if (!entry && allowedByOverlap.size === 0) return [];

  // A path missing entirely (a malformed FileOp that slipped past a caller's own translation)
  // can't be checked against ownership globs — skip it rather than let matchesAnyGlob throw on a
  // non-string. Undeclared-ness for a path that doesn't parse is a different problem than this
  // function answers, and crashing here turns a correctable validation error into a hard failure.
  const touched = [...new Set(fileOps.map((op) => op.path).filter((p): p is string => typeof p === 'string'))];
  return touched.filter((p) => !allowedByOverlap.has(p) && !matchesAnyGlob(p, declared) && !declared.includes(p));
}

/** The other tasks whose declared ownership covers `filePath`. */
export function otherOwners(filePath: string, taskId: string, ownership: OwnershipMap): string[] {
  return Object.values(ownership.entries)
    .filter((entry) => entry.taskId !== taskId)
    .filter((entry) => {
      const declared = [...entry.paths, ...entry.interfaces, ...entry.generated, ...entry.tests];
      return declared.includes(filePath) || matchesAnyGlob(filePath, declared);
    })
    .map((entry) => entry.taskId);
}

/** A planned task as the dispatcher sees it in a planner's raw response. */
export interface PlannedTask {
  id: string;
  dependsOn: readonly string[];
  targetGlobs: readonly string[];
  acceptanceCriteria: readonly string[];
}

/** An acceptance criterion that names a file only a task outside its own upstream will write. */
export interface CriterionAheadOfOwner {
  taskId: string;
  criterion: string;
  ownerTaskId: string;
  path: string;
}

/**
 * Criteria a task cannot meet when it is accepted, because they name a file another task writes
 * and that task is not upstream of it. A real plan required the package-scaffold task to make
 * "python -m alloydamage calculate" work through cli.py, which a later task owned; its council
 * rightly refused, and no doctrine can accept such a task on its own evidence. Named files only:
 * a concrete path or a distinctive basename, exactly as ownershipTermMatches reads them.
 */
export function criteriaAheadOfTheirOwners(tasks: readonly PlannedTask[]): CriterionAheadOfOwner[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const upstream = (id: string): Set<string> => {
    const seen = new Set<string>();
    const stack = [...(byId.get(id)?.dependsOn ?? [])];
    while (stack.length) {
      const next = stack.pop()!;
      if (seen.has(next)) continue;
      seen.add(next);
      stack.push(...(byId.get(next)?.dependsOn ?? []));
    }
    return seen;
  };
  const found: CriterionAheadOfOwner[] = [];
  for (const task of tasks) {
    const before = upstream(task.id);
    const ownsOrInherits = (path: string) => task.targetGlobs.includes(path) ||
      [...before].some((id) => byId.get(id)?.targetGlobs.includes(path));
    for (const criterion of task.acceptanceCriteria) {
      for (const other of tasks) {
        if (other.id === task.id || before.has(other.id)) continue;
        const path = other.targetGlobs.find((owned) => !/[*?[]/.test(owned) && !ownsOrInherits(owned) &&
          ownershipTermMatches(criterion, owned));
        if (path) found.push({ taskId: task.id, criterion, ownerTaskId: other.id, path });
      }
    }
  }
  return found;
}

/**
 * One dependency cycle in a plan, as the ids around it with the first repeated at the end
 * ("a → b → a"), or undefined when the graph is acyclic. A single-agent plan once made
 * core-package and docs-example depend on each other; no task was ever runnable and the run
 * ended five seconds after planning. Dependencies on unknown ids are ignored here.
 */
export function dependencyCycle(tasks: readonly Pick<PlannedTask, 'id' | 'dependsOn'>[]): string[] | undefined {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const done = new Set<string>();
  const path: string[] = [];
  const visit = (id: string): string[] | undefined => {
    const open = path.indexOf(id);
    if (open >= 0) return [...path.slice(open), id];
    if (done.has(id) || !byId.has(id)) return undefined;
    path.push(id);
    for (const next of byId.get(id)!.dependsOn) {
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    path.pop();
    done.add(id);
    return undefined;
  };
  for (const task of tasks) {
    const cycle = visit(task.id);
    if (cycle) return cycle;
  }
  return undefined;
}

const SOURCE_FILE = /\.(py|ts|tsx|js|jsx|mjs|cjs|go|rs|java|rb)$/;

/**
 * Source files a task owns that do not exist. "No change" is a valid answer only for a task whose
 * files already meet it; a socialist arm on 2026-10-04 had damage.py, nuclear_data.py and
 * __init__.py tasks approved with no file operations while those files were absent, and the
 * councils then refused the tree as incomplete. Concrete source paths only: a glob names nothing
 * in particular, and a missing output such as results/x.csv may be generated at run time.
 */
export function missingOwnedSources(taskId: string, ownership: OwnershipMap, exists: (path: string) => boolean): string[] {
  return (ownership.entries[taskId]?.paths ?? []).filter((p) => !/[*?[]/.test(p) && SOURCE_FILE.test(p) && !exists(p));
}

export interface PlannedTaskText {
  id?: string;
  title?: string;
  description?: string;
  targetGlobs: string[];
}

const READING_VERB = /^\s*(read|inspect|examine|study|explore|survey|inventory|understand)\b/i;

/**
 * Tasks whose only job is reading what the repository already holds. Planners in three of five
 * arms made one ("Read and validate supplied nuclear-data files") owning the supplied data: its
 * implementer had nothing to write, looped through validation and the fallback model for 45
 * minutes, and finally rewrote a data file the task statement says to leave untouched. Matched
 * narrowly: the task leads with a reading verb and every target is a file already present.
 */
export function readingOnlyTasks(tasks: readonly PlannedTaskText[], exists: (path: string) => boolean): PlannedTaskText[] {
  return tasks.filter((task) =>
    (READING_VERB.test(task.title ?? '') || READING_VERB.test(task.description ?? '')) &&
    task.targetGlobs.length > 0 &&
    task.targetGlobs.every((glob) => !/[*?[]/.test(glob) && !glob.endsWith('/') && exists(glob)),
  );
}

const DOCUMENTATION_PATH = /\.(md|markdown|rst|txt|adoc)$/i;

/** Files that live among the tests without being tests: a package marker, shared fixtures, a
 * placeholder. Owning only these is not owning the tests. Socialist cycle 3 planned a task whose
 * only test path was tests/__init__.py; the engine held it to a suite that collected nothing, and
 * it was reworked six times however right its code was. */
const TEST_SUPPORT_FILE = /(^|\/)(__init__\.[^/]+|conftest\.py|\.gitkeep|\.keep)$/i;

export function isTestSupportFile(path: string): boolean {
  return TEST_SUPPORT_FILE.test(path);
}

/**
 * Whether a plan changes source code without giving any task a test path. Nobody may write a file
 * no task owns, so such a plan can never produce the automated evidence section 9 of every doctrine
 * requires for a change. The 2026-10-08 socialist cycle-1 planner made four tasks, none owning a
 * test: every task was approved three times, and the delivery was refused each time for having no
 * tests. A broad glob (`**`) counts as owning tests, since it covers them.
 */
export function planWithoutTests(tasks: readonly PlannedTaskText[], testPathGlobs: readonly string[]): boolean {
  if (testPathGlobs.length === 0) return false;
  const globs = tasks.flatMap((task) => task.targetGlobs);
  const ownsTests = globs.some((glob) =>
    glob.includes('**') || (matchesAnyGlob(glob, [...testPathGlobs]) && !isTestSupportFile(glob)));
  if (ownsTests) return false;
  return globs.some((glob) => !DOCUMENTATION_PATH.test(glob));
}

/** Merges a doctrine's refinements over the seeded map without losing the planner's own globs. */
export function mergeOwnership(base: OwnershipMap, refined: OwnershipMap): OwnershipMap {
  const entries: Record<string, OwnershipEntry> = { ...base.entries };
  for (const [taskId, entry] of Object.entries(refined.entries)) {
    const existing = entries[taskId];
    entries[taskId] = existing
      ? {
          taskId,
          paths: [...new Set([...existing.paths, ...entry.paths])],
          interfaces: [...new Set([...existing.interfaces, ...entry.interfaces])],
          generated: [...new Set([...existing.generated, ...entry.generated])],
          tests: [...new Set([...existing.tests, ...entry.tests])],
        }
      : entry;
  }
  return {
    entries,
    declaredOverlaps: [...base.declaredOverlaps, ...refined.declaredOverlaps],
    publishedAt: new Date().toISOString(),
  };
}

function normalizeOwnershipPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Whether a finding, refusal, or check output names an owned path. Full owned paths match as
 * substrings; a concrete file's basename also matches as a path token so "cli.py" still maps to
 * "alloydamage/cli.py". Globs and very short names stay exact to avoid reopening unrelated work.
 */
export function ownershipTermMatches(text: string, term: string): boolean {
  const owned = normalizeOwnershipPath(term);
  if (!owned) return false;
  if (text.includes(owned) || text.includes(term)) return true;
  if (/[*?\[]/.test(owned)) return false;
  const base = owned.split('/').pop() ?? '';
  if (!base.includes('.') || base.length < 5) return false;
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^A-Za-z0-9_])${escaped}(?:[^A-Za-z0-9_]|$)`).test(text);
}

/** Task ids whose declared ownership is named by `text`, ignoring ephemeral check-artifact paths. */
export function ownedTaskIdsForText(
  ownership: OwnershipMap | undefined,
  text: string,
  ignorePaths: readonly string[] = [],
): string[] {
  const ignored = new Set(ignorePaths.map(normalizeOwnershipPath));
  return Object.values(ownership?.entries ?? {})
    .filter((entry) =>
      [...entry.paths, ...entry.tests, ...entry.interfaces, ...entry.generated].some((term) => {
        if (!term) return false;
        if (ignored.has(normalizeOwnershipPath(term))) return false;
        return ownershipTermMatches(text, term);
      }),
    )
    .map((entry) => entry.taskId);
}

/** One path moved off an owner that can no longer run, to the task that will now write it. */
export interface OrphanTransfer {
  path: string;
  from: string[];
  to: string;
}

function dependsOn(graph: TaskGraph, taskId: string, ancestors: ReadonlySet<string>): boolean {
  const seen = new Set<string>();
  const stack = [...(graph.nodes[taskId]?.dependsOn ?? [])];
  while (stack.length) {
    const id = stack.pop()!;
    if (ancestors.has(id)) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(graph.nodes[id]?.dependsOn ?? []));
  }
  return false;
}

/**
 * Paths a remediation finding names whose every owner is gone — abandoned and past reopening — and
 * the one live task that should own each instead.
 *
 * Without this, work an abandoned task owned could never be repaired: every other task that tried
 * to write the file was refused as outside its ownership, and the owner itself had no attempts
 * left. A real run could not add a missing `__main__.py` for that reason alone. Each path goes to a
 * single task, so ownership stays one owner per file: first a reopened `candidate` that depends on
 * the old owner, then any candidate, then the first live task in graph order that depends on it.
 */
export function orphanedPathTransfers(
  ownership: OwnershipMap,
  graph: TaskGraph,
  text: string,
  candidates: readonly string[],
  isGone: (taskId: string) => boolean,
  ignorePaths: readonly string[] = [],
): OrphanTransfer[] {
  const ignored = new Set(ignorePaths.map(normalizeOwnershipPath));
  const entries = Object.values(ownership.entries);
  const ownersOf = (path: string) =>
    entries
      .filter((e) => [...e.paths, ...e.tests].some((p) => normalizeOwnershipPath(p) === normalizeOwnershipPath(path)))
      .map((e) => e.taskId);

  const named = new Set<string>();
  for (const entry of entries) {
    if (!isGone(entry.taskId)) continue;
    for (const path of [...entry.paths, ...entry.tests]) {
      if (path && !ignored.has(normalizeOwnershipPath(path)) && ownershipTermMatches(text, path)) named.add(path);
    }
  }

  const transfers: OrphanTransfer[] = [];
  for (const path of named) {
    const from = ownersOf(path);
    if (!from.every(isGone)) continue;
    const owners = new Set(from);
    const live = candidates.filter((id) => graph.nodes[id] && !isGone(id));
    const to =
      live.find((id) => dependsOn(graph, id, owners)) ??
      live[0] ??
      graph.order.find((id) => !isGone(id) && dependsOn(graph, id, owners));
    if (to) transfers.push({ path, from, to });
  }
  return transfers;
}

/** Applies transfers to the map in place: each path joins its new owner's declared paths. */
export function applyOrphanTransfers(ownership: OwnershipMap, transfers: readonly OrphanTransfer[]): void {
  for (const { path, to } of transfers) {
    const entry = (ownership.entries[to] ??= { taskId: to, paths: [], interfaces: [], generated: [], tests: [] });
    if (!entry.paths.includes(path)) entry.paths.push(path);
  }
}

/** How a run's changed files divide between the tasks chosen for a partial apply and the rest. */
export interface SubsetFiles {
  /** Changed files a chosen task owns. */
  selected: string[];
  /** Changed files only unchosen tasks own, with those owners. */
  othersOwn: Array<{ path: string; owners: string[] }>;
  /** Changed files no task's ownership covers. */
  unowned: string[];
}

/**
 * Divides a run's changed files by owner for swarm_apply's `taskIds`. A file a chosen task owns
 * goes with it, even if another task shares it by declared overlap: the chosen work is unusable
 * without it, and the overlap was declared up front.
 */
export function filesForTasks(changed: readonly string[], taskIds: readonly string[], ownership: OwnershipMap): SubsetFiles {
  const chosen = new Set(taskIds);
  const owners = (filePath: string): string[] => [
    ...Object.values(ownership.entries)
      .filter((entry) => {
        const declared = [...entry.paths, ...entry.interfaces, ...entry.generated, ...entry.tests];
        return declared.includes(filePath) || matchesAnyGlob(filePath, declared);
      })
      .map((entry) => entry.taskId),
    ...ownership.declaredOverlaps.filter((overlap) => overlap.path === filePath).flatMap((overlap) => overlap.taskIds),
  ];
  const result: SubsetFiles = { selected: [], othersOwn: [], unowned: [] };
  for (const filePath of changed) {
    const by = [...new Set(owners(filePath))];
    if (by.some((id) => chosen.has(id))) result.selected.push(filePath);
    else if (by.length > 0) result.othersOwn.push({ path: filePath, owners: by });
    else result.unowned.push(filePath);
  }
  return result;
}
