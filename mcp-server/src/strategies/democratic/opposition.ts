// Section 6's Loyal Opposition, and the half of section 7 stage 4 that was missing.
//
// Two things were wrong with a single 'opposition' persona answering every motion. First, section 6
// asks for a Shadow Cabinet mirroring the executive portfolios, so that the agent challenging a
// security change is the one that has been watching security. Second, and worse, the Opposition
// spoke and nobody answered: section 7 stage 4 requires that "agents must answer objections rather
// than repeat conclusions", and a debate in which only one side speaks is not a debate.
//
// The reply is the government's, so it belongs to the responsible minister. It costs a dispatch, so
// it is made only when there is actually an objection to answer.
//
// The last piece is section 6's "prepare a replacement plan if confidence is lost". That is
// assembled deterministically from what the Opposition has already said — a programme invented
// fresh at the moment of crisis would not be the alternative it had been arguing for all along.

import type { OfficeRegister } from './offices.js';
import { shadowFor } from './offices.js';
import type { Finding } from '../../engine/packets.js';
import type { DemocraticConfig, OppositionFinding } from './types.js';
import { DEMOCRATIC_DEFAULTS } from '../../constitution/schema.js';

/** The shadow minister who answers for a portfolio. */
export function shadowMinisterFor(
  register: OfficeRegister | undefined,
  cfg: DemocraticConfig,
  portfolioTag: string,
): string {
  return register?.shadowCabinet[portfolioTag] ?? shadowFor(cfg, portfolioTag);
}

/**
 * Whether the Opposition has said anything the government is obliged to answer. A round of debate
 * is one objection and its reply, so a motion allowed no rounds gets no reply.
 */
export function replyIsDue(verdict: OppositionFinding['verdict'], cfg: DemocraticConfig): boolean {
  if (!(cfg.debate?.governmentReplyOnObjection ?? DEMOCRATIC_DEFAULTS.debate.governmentReplyOnObjection)) return false;
  if ((cfg.debate?.maxRoundsPerMotion ?? DEMOCRATIC_DEFAULTS.debate.maxRoundsPerMotion) < 1) return false;
  return verdict !== 'approve';
}

export interface GovernmentReply {
  /** Whether the minister accepted the objection instead of answering it. */
  conceded: boolean;
  /** The objections the minister answered point by point. */
  objectionsAnswered: string[];
  rationale: string;
  /** Files or commands the reply pointed at. */
  citations: string[];
}

/**
 * Whether a reply is worth anything.
 *
 * Section 7 stage 4's evidence rules are explicit that "factual claims must be linked to code,
 * tests, logs or sources" and that "confidence scores do not substitute for evidence". A reply that
 * asserts the Opposition is wrong without pointing at anything is a repeated conclusion, which is
 * the thing the stage forbids — so it is recorded, and then it changes nothing.
 */
export function replyCitesEvidence(reply: GovernmentReply): boolean {
  return !reply.conceded && reply.citations.some((c) => c.trim().length > 0);
}

/**
 * How a reply bears on the division.
 *
 * A conceded objection is the government agreeing with the Opposition, so the objection stands at
 * full weight. An answered-and-cited objection softens a flag but never a reject: the Opposition
 * saw the diff, and a minister's account of why it is fine is not the same as evidence that it is.
 * Anything else leaves the objection exactly as it was.
 */
export function severityAfterReply(
  verdict: OppositionFinding['verdict'],
  severity: OppositionFinding['severity'],
  reply: GovernmentReply | null,
): OppositionFinding['severity'] {
  if (!reply || !replyCitesEvidence(reply)) return severity;
  if (verdict !== 'flag') return severity;
  if (severity === 'high') return 'medium';
  if (severity === 'medium') return 'low';
  return 'low';
}

export interface AlternativeProgramme {
  author: string;
  /** The motions the Opposition would put instead, drawn from what it already argued. */
  motions: string[];
  rationale: string;
}

/**
 * Section 6: "prepare a replacement plan if confidence is lost."
 *
 * Assembled from the record rather than invented: every motion the House refused, and every finding
 * the Opposition raised that nobody resolved. If it has nothing on the record, it says so — an
 * Opposition that produced no alternative should be seen to have produced none, not handed a
 * plausible-looking list at the moment it might take office.
 */
export function prepareAlternativeProgramme(
  author: string,
  refusedMotions: readonly { id: string; title: string }[],
  findings: readonly Finding[],
): AlternativeProgramme {
  const unresolved = findings.filter(
    (f) => f.source.startsWith('shadow-') || f.source.startsWith('opposition'),
  );
  const motions = [
    ...refusedMotions.map((m) => `Re-put "${m.title}" (${m.id}) on terms the House would carry.`),
    ...unresolved.filter((f) => f.disposition !== 'accepted').map((f) => `Answer the standing objection: ${f.summary}`),
  ];

  return {
    author,
    motions,
    rationale: motions.length
      ? 'The Opposition would put the business the House refused, on the evidence it has already laid before it.'
      : 'The Opposition has no alternative programme on the record: it raised nothing the House left standing.',
  };
}
