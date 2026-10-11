// Section 6's mutual-aid function: it "helps any council or worker that is blocked", providing
// "repository reconnaissance and context summaries, reusable test fixtures, debugging assistance,
// access to scarce tools or specialist attention, documentation of prior failures and solutions,
// temporary redistribution of workload".
//
// Two sentences in that paragraph decide the whole design. "Aid is allocated according to the need
// and importance of the work, not the status of the requester" — so eligibility reads the needs
// assessment and never the requester's capability score, and this file is not given the score at
// all. And "Recipients publish the resulting knowledge back to the commons" — so aid is not a
// private favour to one worker; it is written to the shared store, tagged, and available to whoever
// meets the same wall next, which is articles 2 and 7 in practice.
//
// Aid costs one dispatch and is gated on an actual block, so a run where nothing goes wrong pays
// nothing for it.

import type { KnowledgeEntry } from '../../engine/KnowledgeStore.js';
import type { NeedsAssessment } from './allocation.js';
import type { SocialistConfig } from './types.js';
import { SOCIALIST_DEFAULTS } from '../../constitution/schema.js';

export interface AidTrigger {
  /** The work's own assessed need. Never the worker's record. */
  needs: NeedsAssessment | undefined;
  /** Consecutive rejections on this node. */
  rejections: number;
  /** Whether a worker handed this node back. */
  wasReturned: boolean;
}

/**
 * Whether a blocked worker gets help.
 *
 * Blocked is necessary but not sufficient: simple, low-risk work that fails is more likely a defect
 * in the plan than a worker who needs context, and section 11 routes that case to diagnosis instead
 * (recovery.ts). Sending aid to every failure regardless would be the "endless rescue of an
 * unsuitable plan or assignment" section 14 warns about.
 *
 * A returned assignment always qualifies. A worker who says plainly that it cannot take the work
 * has demonstrated need in the most direct form available, whatever the node's difficulty score.
 */
export function aidIsDue(trigger: AidTrigger, cfg: SocialistConfig): boolean {
  if (!(cfg.mutualAid?.enabled ?? SOCIALIST_DEFAULTS.mutualAid.enabled)) return false;
  if (trigger.wasReturned) return true;

  const threshold = cfg.mutualAid?.rejectionsBeforeAid ?? SOCIALIST_DEFAULTS.mutualAid.rejectionsBeforeAid;
  if (threshold <= 0 || trigger.rejections < threshold) return false;
  return trigger.needs?.aidEligible ?? false;
}

export interface AidPacket {
  /** What the blocked worker was missing about the repository or the task. */
  context: string;
  /** A reusable fixture, command or harness the next worker can run. */
  fixture: string;
  /** What has already been tried and did not work. */
  priorAttempts: string;
}

/** The tags aid is filed under, so the next worker meeting the same wall finds it. */
export function aidTags(guilds: readonly string[], riskClass: string, topic: readonly string[]): string[] {
  return [...new Set([...guilds, riskClass, ...topic, 'mutual-aid'])];
}

/**
 * The aid packet as a commons entry.
 *
 * Written as a `fixture` rather than a `lesson` deliberately: section 9 calls tests, fixtures and
 * harnesses "collectively owned public infrastructure", and the distinction is what lets a later
 * query ask for reusable machinery rather than only for accounts of past failures.
 */
export function aidAsCommonsEntry(
  packet: AidPacket,
  input: { taskId: string; nodeTitle: string; tags: string[]; runId: string },
): Omit<KnowledgeEntry, 'id' | 'createdAt'> {
  return {
    kind: 'fixture',
    tags: input.tags,
    sourceRunId: input.runId,
    sourceTaskId: input.taskId,
    content:
      `Mutual aid supplied for "${input.nodeTitle}".\n` +
      `Context the worker was missing: ${packet.context}\n` +
      `Reusable fixture or command: ${packet.fixture}\n` +
      `Already tried, without success: ${packet.priorAttempts}`,
  };
}

/** The aid as it is handed to the next worker attempting the node. */
export function renderAid(packet: AidPacket): string {
  return (
    `The mutual-aid worker has been through this and published the following to the commons.\n` +
    `Context: ${packet.context}\n` +
    `Fixture or command you can reuse: ${packet.fixture}\n` +
    `Already tried and did not work — do not repeat it: ${packet.priorAttempts}`
  );
}

export function validateAidPacket(value: unknown): void {
  if (typeof value !== 'object' || value === null) throw new Error('Mutual aid must be a JSON object.');
  const v = value as Record<string, unknown>;
  for (const field of ['context', 'fixture', 'priorAttempts']) {
    if (typeof v[field] !== 'string' || (v[field] as string).trim().length === 0) {
      throw new Error(`Mutual aid must include a non-empty "${field}" string — write "none" if there truly is nothing.`);
    }
  }
}
