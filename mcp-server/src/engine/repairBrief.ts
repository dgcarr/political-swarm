// The engineering evidence a reworked task's next implementer reads, built once by the engine and
// rendered identically for every doctrine.
//
// Each doctrine used to assemble this itself — five builders with different output caps, some
// keeping reviewer flags and some dropping them — and none showed the code that had failed: the
// engine reverts a rejected attempt before the next one, so a retry was told what broke but not
// what it had written, rewrote from scratch, and re-broke what an earlier round had fixed. The
// facts live here; why the work was refused, and who does it next, stays the doctrine's to say.

import type { CheckRunRecord } from './packets.js';
import type { FileOp, ReviewResult, TaskNode, TestResult } from './types.js';
import { clipCheckOutput } from '../util/checkOutput.js';

/** Per failing check. The full record is already clipped to 4000 chars where it was run. */
const CHECK_OUTPUT_CHARS = 1_800;
const MAX_CHECKS = 3;
const FINDING_CHARS = 500;
const MAX_FINDINGS = 6;
const DOCTRINE_CHANGE_CHARS = 400;
const MAX_DOCTRINE_CHANGES = 6;
// The whole attempt, for a task-sized change. At 3,000 a 12,600-character attempt reached the next
// implementer as a head and tail per file, about 85% cut: managerial's composition task was shown
// its failing assertion but not the code around it, rewrote from scratch eight times, and never
// recovered the 17-of-18 suite its first attempt had.
const PRIOR_ATTEMPT_CHARS = 24_000;
const HISTORY_ATTEMPTS = 3;
const HISTORY_LINE_CHARS = 240;

export interface BriefCheck {
  categoryId: string;
  /** `new`: passed before this change and fails with it. `still_failing`: required, and was not
   * passing before either — work this task may still owe. */
  status: 'new' | 'still_failing';
  output?: string;
}

export interface RepairBrief {
  attempt: number;
  maxAttempts: number;
  checks: BriefCheck[];
  /** Failing categories that are not required: named, never charged to the task. */
  advisoryFailures: string[];
  /** Required categories with no tests in them yet. */
  emptyChecks?: string[];
  findings: Array<{ reviewerId: string; verdict: 'reject' | 'flag'; rationale: string; evidenceRefs?: string[] }>;
  /** Changes the doctrine's own review asked for in its structured output (review.meta.requiredChanges). */
  reviewRequiredChanges: string[];
  /** The reverted attempt's file operations, rendered and clipped. */
  priorAttempt: string;
  /** Paths kept for the next attempt to edit (TaskNode.retainedAttempt); absent when it was discarded. */
  retainedPaths?: string[];
  /** Earlier attempts, oldest first, one line each. */
  history: string[];
  /** Consecutive attempts, including this one, that ended with the same failure signature. */
  repeatCount: number;
}

// --- failure signature -------------------------------------------------------------------------

/** Lines that carry the actual failure in common runners' output. */
const ERROR_LINE = /^(E\s|FAILED\b|ERROR\b|\S*(Error|Exception)\b:|error[:\s]|AssertionError|Traceback)/;

/** Removes what changes between two runs of the same failure: timings, addresses, temp paths,
 * line numbers. Without this every pytest run differs in its "in 0.53s" tail. */
function normalizeErrorLine(line: string): string {
  return line
    .replace(/\bin \d+(\.\d+)?s\b/g, 'in Ns')
    .replace(/0x[0-9a-f]+/gi, '0x?')
    .replace(/\/tmp\/\S+/g, '/tmp/?')
    .replace(/:\d+(:\d+)?\b/g, ':?')
    .replace(/\s+/g, ' ')
    .trim();
}

export function errorLines(output: string | undefined): string[] {
  if (!output) return [];
  return output.split('\n').map((line) => line.trimEnd()).filter((line) => ERROR_LINE.test(line.trimStart()));
}

/**
 * What failed, independent of the code that failed and of anyone's prose about it. Two attempts
 * that hit the same error with differently worded code share a signature; the code fingerprint
 * (attemptFingerprint.ts) could never say so, since it hashed reviewer text and test timings.
 * Empty when nothing a check could see failed.
 */
export function failureSignature(test: TestResult, review: ReviewResult): string {
  const checks = test.checks ?? [];
  if (checks.length > 0) {
    const parts = checks
      .map((check) => `${check.categoryId}:${check.status}\n${[...new Set(errorLines(check.output).map(normalizeErrorLine))].sort().join('\n')}`)
      .sort();
    return `checks\n${parts.join('\n')}`;
  }
  const blockers = review.findings.filter((finding) => finding.verdict === 'reject').map((finding) => finding.reviewerId).sort();
  return blockers.length ? `review\n${blockers.join(',')}` : '';
}

/** One line for the attempt history: what failed, and the first thing it said. */
export function failureSummary(test: TestResult, rationale: string): string {
  const failing = (test.checks ?? []).map((check) => `${check.categoryId} (${check.status.replace('_', ' ')})`);
  const firstError = (test.checks ?? []).flatMap((check) => errorLines(check.output))[0]?.trim();
  const what = failing.length ? `checks failing: ${failing.join(', ')}` : 'checks passed';
  const why = firstError ?? rationale.trim().split('\n')[0];
  return clip(`${what}${why ? ` — ${why}` : ''}`, HISTORY_LINE_CHARS);
}

// --- building ----------------------------------------------------------------------------------

/** Per-category check status for a task's TestResult, from the records it was built from. */
export function briefChecks(
  records: CheckRunRecord[],
  newFailures: readonly string[],
  stillFailing: readonly string[],
): { checks: BriefCheck[]; advisoryFailures: string[] } {
  const charged = new Set([...newFailures, ...stillFailing]);
  const checks: BriefCheck[] = [];
  for (const record of records) {
    if (!charged.has(record.categoryId)) continue;
    checks.push({
      categoryId: record.categoryId,
      status: newFailures.includes(record.categoryId) ? 'new' : 'still_failing',
      output: record.output?.trim() || undefined,
    });
  }
  const advisoryFailures = records
    .filter((record) => record.ran && !record.passed && !charged.has(record.categoryId))
    .map((record) => record.categoryId);
  // New regressions first: they are what this change broke.
  checks.sort((a, b) => (a.status === b.status ? 0 : a.status === 'new' ? -1 : 1));
  return { checks, advisoryFailures };
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function renderFileOp(op: FileOp, budget: number): string {
  switch (op.op) {
    case 'delete':
      return `delete ${op.path}`;
    case 'write':
      return `write ${op.path} (${op.content.length} chars):\n${clipCheckOutput(op.content, budget)}`;
    case 'edit': {
      const half = Math.max(80, Math.floor(budget / 2));
      return `edit ${op.path}:\n--- find\n${clipCheckOutput(op.find, half)}\n+++ replace\n${clipCheckOutput(op.replace, half)}`;
    }
  }
}

export function renderPriorAttempt(fileOps: readonly FileOp[], maxChars = PRIOR_ATTEMPT_CHARS): string {
  if (fileOps.length === 0) return '';
  const perOp = Math.max(160, Math.floor(maxChars / fileOps.length) - 40);
  const rendered = fileOps.map((op) => renderFileOp(op, perOp)).join('\n\n');
  return clipCheckOutput(rendered, maxChars);
}

export function buildRepairBrief(input: {
  node: TaskNode;
  attemptNumber: number;
  maxAttempts: number;
  test: TestResult;
  review: ReviewResult;
  fileOps: readonly FileOp[];
  repeatCount: number;
  retainedPaths?: string[];
}): RepairBrief {
  const { node, test, review } = input;
  const metaChanges = review.meta?.requiredChanges;
  return {
    attempt: input.attemptNumber,
    maxAttempts: input.maxAttempts,
    checks: (test.checks ?? []).slice(0, MAX_CHECKS).map((check) => ({
      ...check,
      output: check.output ? clipCheckOutput(check.output, CHECK_OUTPUT_CHARS) : undefined,
    })),
    advisoryFailures: test.advisoryFailures ?? [],
    ...(test.emptyChecks?.length ? { emptyChecks: test.emptyChecks } : {}),
    findings: review.findings
      .filter((finding): finding is typeof finding & { verdict: 'reject' | 'flag' } =>
        (finding.verdict === 'reject' || finding.verdict === 'flag') && Boolean(finding.rationale.trim()))
      .slice(0, MAX_FINDINGS)
      .map((finding) => ({
        reviewerId: finding.reviewerId,
        verdict: finding.verdict,
        rationale: clip(finding.rationale.trim(), FINDING_CHARS),
        ...(finding.evidenceRefs?.length ? { evidenceRefs: finding.evidenceRefs.slice(0, 8) } : {}),
      })),
    reviewRequiredChanges: Array.isArray(metaChanges)
      ? metaChanges
        .filter((change): change is string => typeof change === 'string' && Boolean(change.trim()))
        .slice(0, MAX_DOCTRINE_CHANGES)
        .map((change) => clip(change.trim(), DOCTRINE_CHANGE_CHARS))
      : [],
    priorAttempt: renderPriorAttempt(input.fileOps),
    ...(input.retainedPaths?.length ? { retainedPaths: [...input.retainedPaths] } : {}),
    history: node.attempts
      .filter((attempt) => !attempt.transient && attempt.attempt < input.attemptNumber && attempt.failureSummary)
      .slice(-HISTORY_ATTEMPTS)
      .map((attempt) => `attempt ${attempt.attempt} (${attempt.outcome}): ${attempt.failureSummary}`),
    repeatCount: input.repeatCount,
  };
}

/** Consecutive non-transient attempts, newest first, sharing the latest attempt's signature. */
export function trailingRepeatCount(node: TaskNode): number {
  const judged = node.attempts.filter((attempt) => !attempt.transient);
  const latest = judged.at(-1)?.failureSignature;
  if (!latest) return 0;
  let count = 0;
  for (let index = judged.length - 1; index >= 0 && judged[index].failureSignature === latest; index -= 1) count += 1;
  return count;
}

// --- rendering ---------------------------------------------------------------------------------

export function renderRepairBrief(brief: RepairBrief): string {
  const sections: string[] = [
    brief.retainedPaths?.length
      ? `REPAIR BRIEF — attempt ${brief.attempt} of at most ${brief.maxAttempts} was not accepted. Its ` +
        `files are kept for you as your starting point: your repository tools show them exactly as ` +
        `they were judged (${brief.retainedPaths.join(', ')}). Read them, then change only what the ` +
        `failures below require; an \`edit\` operation is enough for a small fix. A kept file you do ` +
        `not touch is resubmitted as it stands, so do not rewrite what was right.`
      : `REPAIR BRIEF — attempt ${brief.attempt} of at most ${brief.maxAttempts} was not accepted. Every ` +
        `file it changed has been reverted: the repository holds the code from before that attempt, ` +
        `not the attempt itself.`,
  ];
  if (brief.repeatCount >= 2) {
    sections.push(
      `The last ${brief.repeatCount} attempts failed with the same error. Repeating that approach will ` +
        `fail again; find the cause in the output below before changing anything.`,
    );
  }
  if (brief.checks.length) {
    sections.push(
      'Failing checks:\n' +
        brief.checks
          .map((check) =>
            `[${check.categoryId}] ${check.status === 'new' ? 'passed before this change and fails with it' : 'required, and still failing'}` +
            (check.output ? `\n${check.output}` : ''))
          .join('\n\n'),
    );
  }
  if (brief.emptyChecks?.length) {
    sections.push(`No tests exist yet in: ${brief.emptyChecks.join(', ')}. These checks verify nothing until tests are written.`);
  }
  if (brief.advisoryFailures.length) {
    sections.push(`Also failing, but not required of this task: ${brief.advisoryFailures.join(', ')}.`);
  }
  if (brief.findings.length) {
    sections.push(
      'Review findings:\n' +
        brief.findings
          .map((finding) =>
            `- ${finding.reviewerId} (${finding.verdict}): ${finding.rationale}` +
            (finding.evidenceRefs?.length ? ` [evidence: ${finding.evidenceRefs.join(', ')}]` : ''))
          .join('\n'),
    );
  }
  if (brief.reviewRequiredChanges.length) {
    sections.push(`The review asked for:\n${brief.reviewRequiredChanges.map((change) => `- ${change}`).join('\n')}`);
  }
  if (brief.history.length) {
    sections.push(
      'Earlier attempts — keep what they got right; do not reintroduce what they broke:\n' +
        brief.history.map((line) => `- ${line}`).join('\n'),
    );
  }
  if (brief.priorAttempt) {
    sections.push(
      brief.retainedPaths?.length
        ? `What attempt ${brief.attempt} submitted (kept as above; edit it rather than re-sending it):\n${brief.priorAttempt}`
        : `What attempt ${brief.attempt} submitted (reverted; reuse what was right, but re-send every ` +
          `change in full against the current files):\n${brief.priorAttempt}`,
    );
  }
  return `${sections.join('\n\n')}\n\n`;
}
