// The one verification rule no doctrine may vote, negotiate or contract its way around.
//
// Democratic (section 9): "No office, committee or majority may delete, skip, dilute assertions,
// lower thresholds or otherwise weaken a valid test merely to obtain a passing result."
// Socialist (section 9): "No council or worker may delete, skip, dilute assertions, lower
// thresholds or otherwise weaken a valid test merely to manufacture a pass."
// Capitalist (section 9): "No party may delete, skip, dilute assertions, lower thresholds or
// otherwise weaken a valid test merely to release escrow."
//
// Three institutions, one prohibition — so it belongs to the engine, above the strategies, and is
// enforced before a task's fileOps ever reach the worktree the check command then runs against.
// A doctrine may refuse a change on top of this floor. None may waive it from underneath, and nor
// can a human: a `test_waiver` answer only returns the task for another attempt, which this guard
// checks again. A test that is genuinely obsolete has to be changed outside the swarm.

import type { FileOp } from './types.js';
import { matchesAnyGlob } from '../util/glob.js';

export interface TestIntegrityViolation {
  path: string;
  kind: 'test_deleted' | 'assertions_removed' | 'test_emptied';
  detail: string;
}

/** Assertion-ish call sites across the test frameworks a target repo is likely to use. Counting
 * these is deliberately crude: it needs to notice "this edit removed checks", not to parse a test
 * suite. Renaming or reformatting an assertion keeps the count and passes. */
const ASSERTION_PATTERN =
  /\b(?:expect|assert|assertEquals|assertTrue|assertFalse|assertRaises|should|chai\.expect|t\.(?:is|deepEqual|throws|truthy|falsy)|require\.(?:Equal|NoError))\s*[(.]/g;

/**
 * Test cases, so emptying a file of its cases is caught even when a stray assertion survives.
 *
 * The xUnit-style names require an opening paren, which keeps prose from counting: a comment
 * reading "tests removed pending a rewrite" is not a test case. `def test_` and `func Test` are
 * declaration forms and need no paren.
 */
const TEST_CASE_PATTERN = /\b(?:it|test|describe|context)\s*\(|\bdef test_|\bfunc Test/g;

/** Comments are stripped before counting, so reformatting or re-commenting a suite never reads as
 * removing coverage — and, more importantly, so a comment mentioning tests cannot disguise their
 * removal by keeping the count up. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1').replace(/^\s*#[^\n]*/gm, '');
}

function countMatches(text: string, pattern: RegExp): number {
  // Fresh lastIndex per call — these are module-level /g regexes.
  pattern.lastIndex = 0;
  const source = stripComments(text);
  let n = 0;
  while (pattern.exec(source) !== null) n++;
  pattern.lastIndex = 0;
  return n;
}

export function isTestPath(path: string, testPathGlobs: string[]): boolean {
  return matchesAnyGlob(path, testPathGlobs);
}

/**
 * Inspects proposed fileOps against the worktree as it stands, before they are applied.
 *
 * `readCurrent` returns the file's existing content, or null when it does not exist yet. A brand
 * new test file can never be a violation — adding tests is what the docs ask for.
 */
export function detectTestIntegrityViolations(
  fileOps: FileOp[],
  testPathGlobs: string[],
  readCurrent: (path: string) => string | null,
): TestIntegrityViolation[] {
  const violations: TestIntegrityViolation[] = [];

  for (const op of fileOps) {
    if (!isTestPath(op.path, testPathGlobs)) continue;
    const current = readCurrent(op.path);
    if (current === null) continue; // new test file — always allowed

    if (op.op === 'delete') {
      violations.push({
        path: op.path,
        kind: 'test_deleted',
        detail: `Deletes existing test file ${op.path}.`,
      });
      continue;
    }

    const next = op.op === 'write' ? op.content : applyEditPreview(current, op.find, op.replace);
    if (next === null) continue; // find-text absent; applyFileOps will reject this op on its own

    const beforeAssertions = countMatches(current, ASSERTION_PATTERN);
    const afterAssertions = countMatches(next, ASSERTION_PATTERN);
    const beforeCases = countMatches(current, TEST_CASE_PATTERN);
    const afterCases = countMatches(next, TEST_CASE_PATTERN);

    if (beforeCases > 0 && afterCases === 0) {
      violations.push({
        path: op.path,
        kind: 'test_emptied',
        detail: `Removes every test case from ${op.path} (${beforeCases} -> 0).`,
      });
    } else if (afterAssertions < beforeAssertions) {
      violations.push({
        path: op.path,
        kind: 'assertions_removed',
        detail: `Reduces assertions in ${op.path} from ${beforeAssertions} to ${afterAssertions}.`,
      });
    } else if (afterCases < beforeCases) {
      violations.push({
        path: op.path,
        kind: 'assertions_removed',
        detail: `Removes test cases from ${op.path} (${beforeCases} -> ${afterCases}).`,
      });
    }
  }

  return violations;
}

/** Mirrors RepoWorktree.applyFileOps' single-occurrence replace, without touching the filesystem. */
function applyEditPreview(current: string, find: string, replace: string): string | null {
  if (!current.includes(find)) return null;
  return current.replace(find, replace);
}

export function describeViolations(violations: TestIntegrityViolation[]): string {
  return violations.map((v) => `${v.kind}: ${v.detail}`).join(' ');
}
