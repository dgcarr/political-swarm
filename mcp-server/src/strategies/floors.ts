// Two constraints every doctrine's constitution states in its own words, written once.
//
// The Westminster charter calls them article 10 ("constraints beyond the reach of an ordinary
// majority") and article 8 ("minority reports must be preserved"). The socialist constitution calls
// them article 12 (human sovereignty and the safety floor) and article 9 ("minority reports remain
// visible"). The capitalist charter reaches the same place through its regulatory safety floor and
// its disclosure duty. Three institutions, the same two prohibitions — so, like
// engine/testIntegrity.ts, they belong above the strategies rather than being written out once per
// doctrine and left to drift apart.
//
// Nothing here names an institution, and nothing here makes a model call. Each doctrine cites its
// own article number at the call site; this file only decides what the ground *is*.

import type { Finding } from '../engine/packets.js';

/** The grounds an ordinary majority, a council vote or a paid contract may not waive. */
export const NON_WAIVABLE_GROUNDS = [
  'security',
  'safety',
  'privacy',
  'licensing',
  'human-control',
  'test-integrity',
  'acceptance-evidence',
] as const;

export type NonWaivableGround = (typeof NON_WAIVABLE_GROUNDS)[number];

const GROUND_PATTERNS: Array<[NonWaivableGround, RegExp]> = [
  // Bare `auth[a-z]*` and `token` once caught "not authored repository files" and model token
  // counts, putting a [low] note on the floor and withholding escrow from 12/12 work twice.
  ['security', /\b(security|vulnerab|injection|xss|csrf|auth\b|authenticat|authori[sz]|authn\b|authz\b|credential|secret|(?:access|api|auth|bearer|session|refresh) tokens?\b|privileg)/i],
  ['safety', /\b(safety|unsafe|data loss|corrupt|destructive|irreversible)/i],
  ['privacy', /\b(privacy|personal data|pii|gdpr)/i],
  ['licensing', /\b(licen[cs]e|licensing|copyright|gpl|proprietary)/i],
  ['human-control', /\b(human approval|human sign-?off|sovereign|override the user)/i],
  // Weakening counts only when it is a test or assertion being weakened, not "weakening the
  // provenance requirement" in a README note.
  ['test-integrity', /\b(deleted? a test|weaken\w* (?:the |a |an |its )?(?:tests?|assert)|skipped? a test|lower(ed)? the threshold|disable[d]? .*test)/i],
  ['acceptance-evidence', /\b(acceptance criterion|no satisfying evidence|unevidenced)/i],
];

/**
 * Whether a finding sits on non-waivable ground, and which one.
 *
 * Deliberately conservative in the safe direction: this only ever *adds* non-waivability. A finding
 * already marked non-waivable stays that way regardless of what the text looks like, so no doctrine
 * can talk a floor away by rewording a summary.
 */
export function nonWaivableGround(
  finding: Pick<Finding, 'summary' | 'evidenceRefs' | 'nonWaivable'>,
): NonWaivableGround | null {
  if (finding.nonWaivable) return 'human-control';
  const haystack = `${finding.summary} ${finding.evidenceRefs.join(' ')}`;
  for (const [ground, pattern] of GROUND_PATTERNS) {
    if (pattern.test(haystack)) return ground;
  }
  return null;
}

/**
 * A doctrine's review of the combined delivery, put under the floor.
 *
 * Every finding on a non-waivable ground is marked `nonWaivable` and labelled with its ground and the
 * doctrine's own article, so the disposition step reads it as something to remedy or refute with
 * counter-evidence, not to defer. The engine then refuses to let it be accepted unremedied, and the
 * doctrine's acceptance gate refuses delivery while it stays open. The Westminster House of Review
 * does the same to a point it raises with a veto. Only ever adds the mark; a finding already marked
 * is left as it is.
 */
export function markNonWaivableFindings<T extends Pick<Finding, 'summary' | 'evidenceRefs' | 'nonWaivable'>>(
  findings: readonly T[],
  article: string,
): { findings: T[]; grounds: NonWaivableGround[] } {
  const grounds: NonWaivableGround[] = [];
  const marked = findings.map((finding) => {
    if (finding.nonWaivable) return finding;
    const ground = nonWaivableGround(finding);
    if (!ground) return finding;
    grounds.push(ground);
    return {
      ...finding,
      summary: `On non-waivable ground (${ground}, ${article}): ${finding.summary}`,
      nonWaivable: true,
    };
  });
  return { findings: marked, grounds };
}

/**
 * Dissent that entered the record as a minority report and left it as anything else has been
 * converted into apparent consensus, which is precisely what every doctrine's dissent article
 * forbids.
 *
 * Compares the findings as they stood before disposition against the same findings after, and
 * returns the ids that lost the mark. The caller restores them.
 */
export function droppedMinorityReports(before: Finding[], after: Finding[]): string[] {
  const wasMinority = new Set(before.filter((f) => f.minority).map((f) => f.id));
  return after.filter((f) => wasMinority.has(f.id) && !f.minority).map((f) => f.id);
}
