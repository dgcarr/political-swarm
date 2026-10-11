// Reminders surfaced directly on the specific task that needs them, not left to compete with a
// task's own title and description for attention inside a large pasted spec.
//
// Each one generalises a failure seen in benchmark validation runs, where the requirement was
// stated in the task spec yet workers of every doctrine still missed it, because it sat somewhere
// other than on the task it governs. They are phrased without any task-specific detail and every
// strategy attaches them identically, so no arm receives guidance another does not.

/** Sampling temperature for every arm's implementer calls, so no arm writes code with different sampling. */
export const IMPLEMENTER_TEMPERATURE = 0.2;

export interface CliTaskLike {
  title: string;
  description: string;
  targetGlobs: readonly string[];
}

function haystack(node: CliTaskLike): string {
  return `${node.title} ${node.description} ${node.targetGlobs.join(' ')}`.toLowerCase();
}

/** True when a task's own title, description or target paths suggest it builds or touches the
 * package's command-line entry point. */
export function looksLikeCliTask(node: CliTaskLike): boolean {
  return /\bcli\.py\b|__main__\.py|\bcommand-line\b|\bcommand line interface\b/.test(haystack(node));
}

/** Append to an implementer prompt only when looksLikeCliTask(node) is true. */
export function cliEntryPointReminder(): string {
  return (
    'REMINDER: `python -m <package>` requires an `__main__.py` inside that package to run at all — ' +
    'a `cli.py` with argument parsing is not enough by itself. Create `__main__.py` and have it ' +
    'dispatch into your CLI logic, and confirm `python -m <package> <args>` actually runs before ' +
    'considering this task done. Pass the CLI\'s result on as the process exit status ' +
    '(`raise SystemExit(main())`, not a bare `main()`), or every error it reports still exits 0.\n\n'
  );
}

/**
 * A request outside the range the data covers was silently extrapolated instead of refused, in
 * runs of several doctrines. Separately, a planner-invented criterion demanded one shared range
 * built over the union of several sources' ranges — which forces extrapolation for any source
 * that does not cover the whole span, so no implementation could satisfy both.
 */
export function looksLikeRangeTask(node: CliTaskLike): boolean {
  return /\binterpolat|\bextrapolat|\bout[- ]of[- ]range\b|\bsupported range\b|\bdata range\b/.test(haystack(node));
}

/** Append to an implementer prompt only when looksLikeRangeTask(node) is true. */
export function rangeReminder(): string {
  return (
    'REMINDER: a request outside the range the data actually covers must not be silently ' +
    'extrapolated or clamped. Read the supported bounds from the data itself rather than assuming ' +
    'a documented default, check each request against them before computing, and either refuse it ' +
    '(non-zero exit with a message saying it is outside the supported range) or state that clearly ' +
    'in the output.\n\n' +
    'When several sources are combined onto one shared range, build it over the INTERSECTION of ' +
    'their ranges, never the union: the union forces extrapolation for any source that does not ' +
    'cover the whole span. Treat a boundary value that misses by floating-point rounding as inside ' +
    'the range.\n\n'
  );
}

/**
 * A parser written against a guessed key name found nothing in the real input files, and a
 * command that was meant to report several identifying fields printed only the one a helper
 * happened to return.
 */
export function looksLikeMetadataTask(node: CliTaskLike): boolean {
  return /\bprovenance\b|\bmetadata\b|\bparse\b|\bparser\b/.test(haystack(node));
}

/** Append to an implementer prompt only when looksLikeMetadataTask(node) is true. */
export function metadataReminder(): string {
  return (
    'REMINDER: parse the key names the real input files actually use — open them and read them — ' +
    'rather than a shorter or more guessable name you assume they use; a parser written against a ' +
    'guess silently finds nothing. Test the parser against the real files in the repository. Where ' +
    'a command must report several identifying fields, print every field the spec asks for, not ' +
    'only whichever one a helper happens to return.\n\n'
  );
}

/**
 * Three arms of one sweep shipped the same rejected numerical convention behind a test that could
 * not have caught it: each built its fixture by applying the very transform the implementation
 * applies, so the assertion restated the implementation rather than constraining it. All three had
 * been asked for "a known-answer test" and all three supplied an answer that was only known under
 * the convention under test.
 */
export function looksLikeTestTask(node: CliTaskLike): boolean {
  return /(?:^|[\s/])tests?\/|(?:^|[\s/])test_[a-z]|_test\.|\.test\.|\bunit tests?\b|\btest suite\b|\bwrite tests?\b|\bknown[- ]answer\b|\bregression tests?\b/.test(
    haystack(node),
  );
}

/** Append to an implementer prompt only when looksLikeTestTask(node) is true. */
export function testIndependenceReminder(): string {
  return (
    'REMINDER: a test is only worth writing if it can fail. Derive every expected value from ' +
    'something independent of the code under test — a closed-form result, a value worked out by ' +
    'hand, or a figure published in the spec or the input data. Do not build the fixture by ' +
    'applying the same transform the implementation applies, and do not compute the expectation by ' +
    'calling the function under test or a helper it shares: such a test restates the ' +
    'implementation and passes whatever the implementation does.\n\n' +
    'Where the spec leaves a choice of method or convention open, include one case whose correct ' +
    'answer is the same under every reasonable choice — that case catches an outright mistake — and ' +
    'one that separates them, with a comment saying which convention it pins and why.\n\n'
  );
}

/** Every reminder that applies to a task, in a fixed order, so all strategies attach the same text. */
export function implementerReminders(node: CliTaskLike): string {
  return (
    (looksLikeCliTask(node) ? cliEntryPointReminder() : '') +
    (looksLikeRangeTask(node) ? rangeReminder() : '') +
    (looksLikeMetadataTask(node) ? metadataReminder() : '') +
    (looksLikeTestTask(node) ? testIndependenceReminder() : '')
  );
}
