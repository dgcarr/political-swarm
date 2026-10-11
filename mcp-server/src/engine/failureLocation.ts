// Where a failing check actually fails, read off its output and mapped to the tasks that own those
// files — a fact the engine has and a reviewer otherwise has to guess.
//
// In repairbrief-r1 the unit suite failed to collect because of tests/test_damage.py, owned by the
// tests task. Every other task's reviewers saw the same failing suite, concluded the task under
// review had broken it, and rejected it — one called the file "owned by this task" with the
// ownership list in front of it. Those rejections then handed the defect around until tasks were
// waiting on each other. Stating the location outright removes the guess.

import type { OwnershipMap } from './packets.js';
import { otherOwners } from './ownership.js';
import { stripAnsi } from '../util/checkOutput.js';

export interface FailureLocation {
  path: string;
  owners: string[];
}

/** A file named as a failure site: `path:12`, `path::test_name`, or a traceback's `File "path", line 3`. */
const LOCATED_PATH = /(?:^|[\s"'(\[])((?:[\w.-]+\/)*[\w.-]+\.[A-Za-z0-9]+)(?=:\d+|::)/gm;
const TRACEBACK_FILE = /File "([^"]+)", line \d+/g;

/** Every task that owns `filePath`. */
function ownersOf(filePath: string, ownership: OwnershipMap): string[] {
  return otherOwners(filePath, '', ownership);
}

/** An absolute traceback path, matched to the repository path it ends with. */
function repositoryPath(candidate: string, ownership: OwnershipMap): { path: string; owners: string[] } | undefined {
  const direct = ownersOf(candidate, ownership);
  if (direct.length) return { path: candidate, owners: direct };
  if (!candidate.startsWith('/') || candidate.includes('site-packages')) return undefined;
  const segments = candidate.split('/').filter(Boolean);
  for (let start = 1; start < segments.length; start += 1) {
    const suffix = segments.slice(start).join('/');
    const owners = ownersOf(suffix, ownership);
    if (owners.length) return { path: suffix, owners };
  }
  return undefined;
}

export function failureLocations(output: string | undefined, ownership: OwnershipMap | undefined): FailureLocation[] {
  if (!output || !ownership) return [];
  const text = stripAnsi(output);
  const candidates = [
    ...[...text.matchAll(LOCATED_PATH)].map((match) => match[1]),
    ...[...text.matchAll(TRACEBACK_FILE)].map((match) => match[1]),
  ];
  const found = new Map<string, string[]>();
  for (const candidate of candidates) {
    const located = repositoryPath(candidate.replace(/^\.\//, ''), ownership);
    if (located && !found.has(located.path)) found.set(located.path, located.owners);
  }
  return [...found].map(([path, owners]) => ({ path, owners }));
}

/** The reviewer-facing statement of where the checks fail, relative to the task under review. */
export function renderFailureLocations(locations: readonly FailureLocation[], taskId: string): string {
  if (locations.length === 0) return '';
  const lines = locations.map(({ path, owners }) =>
    `- ${path}: ${owners.includes(taskId) ? 'owned by this task' : `owned by ${owners.map((owner) => `task ${owner}`).join(', ')}`}`);
  const foreignOnly = locations.every(({ owners }) => !owners.includes(taskId));
  return (
    `Where the failing checks fail, read by the engine from their output:\n${lines.join('\n')}\n` +
    (foreignOnly
      ? `None of these files belong to task ${taskId}, and its worker may not write them: the failure is ` +
        `not this task's defect. Do not reject this task for it; judge this task's own files.\n\n`
      : `Only a failure in this task's own files is this task's defect.\n\n`)
  );
}
