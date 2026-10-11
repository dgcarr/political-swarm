// Runs the configured verification categories and records exactly what happened to each one.
//
// Section 9 of every doctrine demands the same evidence ledger: "exact commands, working context
// when material, outcomes, relevant output, environmental limitations, skipped or inapplicable
// checks with reasons, and every unresolved failure." A category whose command isn't installed in
// the target repo is a recorded limitation, never a silent pass.

import type { CheckSandbox } from '../util/sandbox.js';
import type { RepoWorktree } from './RepoWorktree.js';
import type { CheckCategory, ChecksConfig } from '../util/config.js';
import type { CheckRunRecord } from './packets.js';
import type { TestResult } from './types.js';
import { clipCheckOutput } from '../util/checkOutput.js';
import { briefChecks } from './repairBrief.js';

/** Output is truncated before it reaches the ledger and the delivery packet — a failing suite can
 * emit megabytes, and the packet is read by both a model and a human. */
const MAX_OUTPUT_CHARS = 4_000;

// These identify only the unambiguous empty-suite messages emitted by common test runners.
// Add another runner's phrase here rather than trying to parse its complete output format.
const EMPTY_SUITE_OUTPUT_PATTERNS = [
  /collected\s+0\s+items?/i,
  /\bno\s+tests?\s+ran\b/i,
  /\bno\s+test\s+files?\s+found\b/i,
  /\bno\s+tests?\s+found\b/i,
];

// These markers mean collection or transformation failed before any tests could execute.
// They take precedence over empty-suite messages that may appear in the same output.
const BROKEN_COLLECTION_OUTPUT_PATTERNS = [
  /\bcollected\s+0\s+items?\s*\/\s*[1-9]\d*\s+errors?\b/i,
  /^\s*(?:FAIL|ERROR)\b/im,
  /\b(?:test files?|test suites?)\s*:\s*[1-9]\d*\s+failed\b/i,
  /\bfailed\s+suites?\s+[1-9]\d*\b/i,
  /\btest suites?\s+failed to run\b/i,
];

function truncate(output: string | undefined): string | undefined {
  if (!output) return output;
  return clipCheckOutput(output, MAX_OUTPUT_CHARS);
}

async function runCategory(worktree: RepoWorktree, category: CheckCategory, sandbox: CheckSandbox): Promise<CheckRunRecord> {
  const result = await worktree
    .runAllowListedCommand(category.command, category.args, category.timeoutMs, { sandbox })
    .catch((err) => ({ ran: false, passed: false, output: String(err) }));

  return {
    categoryId: category.id,
    command: category.command,
    args: category.args,
    ran: result.ran,
    passed: result.passed,
    output: truncate(result.output),
    // runAllowListedCommand reports ran:false only when the command itself couldn't be executed,
    // which is precisely "this check is unavailable here" rather than "this check failed".
    skippedReason: result.ran
      ? undefined
      : sandbox === 'bubblewrap' && result.output?.includes('sandbox: bubblewrap')
        ? result.output
        : `Command "${[category.command, ...category.args].join(' ')}" could not be executed in this repository.`,
  };
}

export async function runAllChecks(worktree: RepoWorktree, checks: ChecksConfig): Promise<CheckRunRecord[]> {
  return runCheckCategories(worktree, checks.categories, checks.sandbox);
}

export async function runCheckCategories(
  worktree: RepoWorktree,
  categories: CheckCategory[],
  sandbox: CheckSandbox = 'none',
): Promise<CheckRunRecord[]> {
  const records: CheckRunRecord[] = [];
  for (const category of categories) {
    records.push(await runCategory(worktree, category, sandbox));
  }
  return records;
}

/** Returns true when a check command ran successfully enough to report that it found no tests. */
export function executedNothing(record: CheckRunRecord): boolean {
  const output = record.output ?? '';
  return (
    record.ran &&
    EMPTY_SUITE_OUTPUT_PATTERNS.some((pattern) => pattern.test(output)) &&
    !BROKEN_COLLECTION_OUTPUT_PATTERNS.some((pattern) => pattern.test(output))
  );
}

/** Marks records whose category already failed (or was unavailable) at baseline, so a pre-existing
 * failure is disclosed as a limitation instead of being charged to the swarm's change. */
export function attributeAgainstBaseline(
  records: CheckRunRecord[],
  baseline: CheckRunRecord[] | undefined,
): CheckRunRecord[] {
  if (!baseline?.length) return records;
  const brokenAtBaseline = new Set(
    baseline.filter((record) => !record.passed && !executedNothing(record)).map((record) => record.categoryId),
  );
  return records.map((r) => (brokenAtBaseline.has(r.categoryId) ? { ...r, failedAtBaseline: true } : r));
}

/** A required category that failed or executed nothing on this change — the set that blocks
 * acceptance. Categories already broken at baseline are excluded: the swarm cannot be held to a
 * suite it did not break. */
export function blockingFailures(records: CheckRunRecord[], checks: ChecksConfig): CheckRunRecord[] {
  const required = new Set(checks.categories.filter((c) => c.required).map((c) => c.id));
  return records.filter(
    (r) => required.has(r.categoryId) && (!r.passed || executedNothing(r)) && !r.failedAtBaseline,
  );
}

export function strictBlockingFailures(records: CheckRunRecord[], checks: ChecksConfig): CheckRunRecord[] {
  const required = new Set(checks.categories.filter((category) => category.required).map((category) => category.id));
  return records.filter((record) => required.has(record.categoryId) && (!record.ran || !record.passed || executedNothing(record)));
}

export function toTaskTestResult(
  records: CheckRunRecord[],
  previousAcceptedSnapshot: CheckRunRecord[],
  checks: ChecksConfig,
): TestResult & { newFailures: string[]; preExistingFailures: string[] } {
  const required = new Set(checks.categories.filter((category) => category.required).map((category) => category.id));
  const previousPassing = new Set(
    previousAcceptedSnapshot
      .filter((record) => required.has(record.categoryId) && record.ran && record.passed && !executedNothing(record))
      .map((record) => record.categoryId),
  );
  // An empty suite is a clean slate, not a pre-existing failure: once a task makes it fail for real,
  // that failure is the task's. Otherwise no repo that starts without tests could ever register one.
  const previousEmpty = new Set(
    previousAcceptedSnapshot
      .filter((record) => required.has(record.categoryId) && executedNothing(record))
      .map((record) => record.categoryId),
  );
  const currentFailures = records.filter(
    (record) => required.has(record.categoryId) && (!record.ran || !record.passed || executedNothing(record)),
  );
  const regressions = currentFailures.filter(
    (record) =>
      previousPassing.has(record.categoryId) ||
      (previousEmpty.has(record.categoryId) && record.ran && !executedNothing(record)),
  );
  // A category is new or pre-existing, never both: a suite that was empty and now fails for real
  // is a regression only, or the rework directive tells the task to restore what never passed.
  const incomplete = currentFailures.filter((record) => !regressions.includes(record));
  // Output comes from the required categories charged to the task, whatever `passed` says: a task
  // meant to make a still-failing suite pass is `passed` (it regressed nothing) yet needs that
  // suite's output more than anything. Non-required failures are named, never pasted.
  // A suite that collected nothing before and still collects nothing is not a failure to repair:
  // reported as "required, and still failing", it sent every early task — none of which owned a
  // test — after a suite with no tests in it. It is named instead; the task that owns the tests is
  // still held to it by suiteBoundTestResult.
  const emptyChecks = incomplete.filter((record) => executedNothing(record)).map((record) => record.categoryId);
  const { checks: chargedChecks, advisoryFailures } = briefChecks(
    records,
    regressions.map((record) => record.categoryId),
    incomplete.filter((record) => !executedNothing(record)).map((record) => record.categoryId),
  );
  // Reviewers still read an empty suite's log, as before; only the repair brief stops calling it failing.
  const failedOutput = [
    ...chargedChecks,
    ...incomplete.filter((record) => executedNothing(record)).map((record) => ({ categoryId: record.categoryId, output: record.output?.trim() })),
  ].filter((check) => check.output);
  return {
    ran: records.some((record) => record.ran),
    suitePassed: strictBlockingFailures(records, checks).length === 0,
    introducedRegression: regressions.length > 0,
    incompleteCategories: incomplete.map((record) => record.categoryId),
    passed: regressions.length === 0,
    newFailures: regressions.map((record) => record.categoryId),
    preExistingFailures: incomplete.map((record) => record.categoryId),
    command: records.map((record) => [record.command, ...record.args].join(' ')).join(' && '),
    output: truncate(failedOutput.map((check) => `[${check.categoryId}]\n${check.output}`).join('\n\n')) || undefined,
    checks: chargedChecks,
    advisoryFailures: advisoryFailures.filter((id) => !emptyChecks.includes(id)),
    ...(emptyChecks.length ? { emptyChecks } : {}),
  };
}

export function limitationsFrom(records: CheckRunRecord[]): string[] {
  const limitations: string[] = [];
  for (const r of records) {
    if (r.skippedReason) limitations.push(`Check "${r.categoryId}" not run: ${r.skippedReason}`);
    else if (r.failedAtBaseline && !r.passed) {
      limitations.push(`Check "${r.categoryId}" was already failing before this run; its failure is pre-existing.`);
    } else if (executedNothing(r)) {
      limitations.push(`Check "${r.categoryId}" found no tests to run; nothing was verified by it.`);
    } else if (!r.passed) limitations.push(`Check "${r.categoryId}" failed.`);
  }
  return limitations;
}

/** Collapses the category records into the single TestResult the per-task strategy hooks expect.
 *
 * A suite that collected nothing does not block an individual task: early tasks legitimately land
 * before any test exists, and "no tests ran" is an absence of evidence, not a failure the task
 * caused. It is still reported as a limitation so no reviewer mistakes it for a verified pass.
 * The final delivery gate keeps using blockingFailures() directly, so a run that never grows a
 * real suite still cannot be delivered. */
export function toTestResult(
  records: CheckRunRecord[],
  checks: ChecksConfig,
): TestResult & { newFailures: string[]; preExistingFailures: string[] } {
  const blocking = blockingFailures(records, checks).filter((record) => !executedNothing(record));
  const ran = records.some((r) => r.ran);
  const passed = ran && blocking.length === 0;
  const failed = records.filter((r) => !r.passed && r.ran);
  return {
    ran,
    suitePassed: passed,
    introducedRegression: blocking.length > 0,
    incompleteCategories: records
      .filter((record) => !record.passed && (record.failedAtBaseline || executedNothing(record)))
      .map((record) => record.categoryId),
    passed,
    newFailures: blocking.map((record) => record.categoryId),
    preExistingFailures: records
      .filter((record) => !record.passed && record.failedAtBaseline)
      .map((record) => record.categoryId),
    command: records.map((r) => [r.command, ...r.args].join(' ')).join(' && '),
    output: truncate(failed.map((r) => `[${r.categoryId}]\n${r.output ?? ''}`).join('\n\n')) || undefined,
  };
}
