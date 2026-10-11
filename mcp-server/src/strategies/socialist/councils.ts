// Section 6's worker councils — "the primary units of production and self-government", organised
// "around a module, service, feature or bounded user outcome".
//
// A council is therefore per work unit, not per discipline: it is the group that owns one node of
// the plan. Its members are the guild members whose disciplines that node touches, so expertise
// still federates across councils (guilds.ts) while authority over the work stays with the people
// doing it. Each council "selects a temporary delegate for cross-council coordination" and "may
// challenge or recall its delegate".
//
// Everything here is deterministic. Section 9 puts correctness on reproducible evidence rather than
// preference, and asking a model which comrade should carry a council's instructions would make the
// federation unauditable without making it better. Draws are seeded from the run id so a council
// register can be re-derived from the ledger.

import { drawByLot, seededRandom } from '../../util/lots.js';
import { guildMembers } from './guilds.js';
import type { SocialistConfig } from './types.js';
import { SOCIALIST_DEFAULTS } from '../../constitution/schema.js';

export interface WorkerCouncil {
  /** Stable id derived from the work unit the council was formed around. */
  id: string;
  taskId: string;
  /** The disciplines this unit of production touches. */
  guilds: string[];
  /** Every worker eligible to speak in this council. */
  members: string[];
  /** The member carrying this council's instructions to the coordinating council. */
  delegate: string;
  termId: number;
}

export interface CouncilPlanBallot {
  member: string;
  choice: 'approve' | 'amend' | 'reject' | 'abstain';
  amendment?: string;
  recallGround?: 'concealed-evidence' | 'lost-confidence';
  recallReason?: string;
}

export interface CouncilRecallBallot {
  member: string;
  choice: 'recall' | 'retain' | 'abstain';
}

/** A recall requires an absolute majority of the frozen council membership. */
export function tallyCouncilRecallBallots(council: WorkerCouncil, ballots: readonly CouncilRecallBallot[]): boolean {
  const eligible = new Set(council.members);
  const cast = new Set<string>();
  for (const ballot of ballots) {
    if (!eligible.has(ballot.member)) throw new Error(`Foreign council recall ballot: ${ballot.member}.`);
    if (cast.has(ballot.member)) throw new Error(`Duplicate council recall ballot: ${ballot.member}.`);
    cast.add(ballot.member);
  }
  if (cast.size !== eligible.size) throw new Error(`Missing recall ballot in ${council.id}.`);
  return ballots.filter((ballot) => ballot.choice === 'recall').length > eligible.size / 2;
}

/** Equal member ballots; quorum and an absolute approval majority are distinct requirements. */
export function tallyCouncilPlanBallots(council: WorkerCouncil, ballots: readonly CouncilPlanBallot[]):
  { choice: 'approve' | 'amend' | 'reject'; amendment?: string } {
  const eligible = new Set(council.members);
  const cast = new Set<string>();
  for (const ballot of ballots) {
    if (!eligible.has(ballot.member)) throw new Error(`Foreign council ballot: ${ballot.member}.`);
    if (cast.has(ballot.member)) throw new Error(`Duplicate council ballot: ${ballot.member}.`);
    cast.add(ballot.member);
  }
  if (cast.size !== eligible.size) throw new Error(`Missing ballot in ${council.id}.`);
  const active = ballots.filter((ballot) => ballot.choice !== 'abstain');
  if (active.length < Math.floor(eligible.size / 2) + 1) return { choice: 'reject', amendment: 'Council quorum was not met.' };
  const approvals = ballots.filter((ballot) => ballot.choice === 'approve').length;
  if (approvals > eligible.size / 2) return { choice: 'approve' };
  const amendments = ballots.filter((ballot) => ballot.choice === 'amend');
  const rejections = ballots.filter((ballot) => ballot.choice === 'reject');
  if (amendments.length > rejections.length) {
    return { choice: 'amend', amendment: amendments.map((ballot) => ballot.amendment).filter(Boolean).join('; ') };
  }
  return { choice: 'reject', amendment: rejections.map((ballot) => ballot.amendment).filter(Boolean).join('; ') ||
    'No proposal won an absolute majority; the plan is withheld.' };
}

export function tallyCouncilAcceptance(council: WorkerCouncil,
  ballots: readonly { member: string; choice: 'approve' | 'reject' | 'abstain'; reason: string }[]):
  { choice: 'approve' | 'reject'; reason: string } {
  const eligible = new Set(council.members);
  const cast = new Set<string>();
  for (const ballot of ballots) {
    if (!eligible.has(ballot.member)) throw new Error(`Foreign council ballot: ${ballot.member}.`);
    if (cast.has(ballot.member)) throw new Error(`Duplicate council ballot: ${ballot.member}.`);
    cast.add(ballot.member);
  }
  if (cast.size !== eligible.size) throw new Error(`Missing ballot in ${council.id}.`);
  const approvals = ballots.filter((ballot) => ballot.choice === 'approve').length;
  if (approvals > eligible.size / 2) return { choice: 'approve', reason: `${approvals} of ${eligible.size} members approved.` };
  return { choice: 'reject', reason: ballots.filter((ballot) => ballot.choice !== 'approve')
    .map((ballot) => ballot.reason).join('; ') || 'An absolute majority did not approve.' };
}

/**
 * What the draws are seeded from. 'run-id' (the run's lot seed) makes a run reproducible from its own ledger; 'fixed'
 * makes every run draw identically, which is only useful in tests.
 */
export function seedBasis(lotSeed: string, cfg: SocialistConfig): string {
  return cfg.councils?.seed === 'fixed' ? 'socialist-fixed-seed' : lotSeed;
}

export function councilIdFor(taskId: string): string {
  return `council-${taskId}`;
}

export interface ConstituteCouncilInput {
  taskId: string;
  guilds: readonly string[];
  cfg: SocialistConfig;
  seed: string;
  termId: number;
}

/**
 * Forms one council around one work unit.
 *
 * The delegate is drawn by lot rather than by capability score, and that is deliberate. Section 6
 * gives the delegate no authority over the work — it "carries instructions and dependency
 * information between councils" — so selecting the highest scorer would spend the council's best
 * worker on errand-running and quietly turn a recorded metric into a route to office. Article 5:
 * delegation "conveys no ownership or permanent status".
 */
export function constituteCouncil(input: ConstituteCouncilInput): WorkerCouncil {
  const { taskId, cfg, seed, termId } = input;
  const guilds = input.guilds.length > 0 ? [...input.guilds] : ['backend'];
  const membersPerGuild = cfg.councils?.membersPerGuild;
  const members = [...new Set(guilds.flatMap((g) => guildMembers(g, membersPerGuild)))];
  const random = seededRandom(`${seed}:council:${taskId}:term-${termId}`);
  const delegate = drawByLot(members, 1, random)[0] ?? members[0] ?? '';

  return { id: councilIdFor(taskId), taskId, guilds, members, delegate, termId };
}

export function constituteCouncils(
  units: readonly { taskId: string; guilds: readonly string[] }[],
  cfg: SocialistConfig,
  seed: string,
  termId: number,
): Record<string, WorkerCouncil> {
  const councils: Record<string, WorkerCouncil> = {};
  for (const unit of units) {
    councils[unit.taskId] = constituteCouncil({ taskId: unit.taskId, guilds: unit.guilds, cfg, seed, termId });
  }
  return councils;
}

// ----------------------------------------------------------------- recall

/**
 * Section 11's grounds: a council may recall its delegate "for exceeding the mandate, concealing
 * evidence, blocking information, repeatedly misallocating work or losing the council's confidence".
 */
export type RecallGround = 'exceeded-mandate' | 'concealed-evidence' | 'misallocated-work' | 'lost-confidence';

export interface DelegateRecall {
  council: string;
  outgoing: string;
  incoming: string;
  ground: RecallGround;
}

/**
 * Replaces a council's delegate with another of its own members.
 *
 * Returns null when the council has nobody else to send. A council of one that recalled its only
 * member would stop being represented at all, which turns a power the council holds over its
 * delegate into a way of removing the council from the federation — so the recall does not happen
 * and the caller records that it could not. Section 11 is explicit that recall "immediately
 * transfers records and access to a replacement".
 */
export function recallDelegate(council: WorkerCouncil, ground: RecallGround, seed: string): DelegateRecall | null {
  const eligible = council.members.filter((m) => m !== council.delegate);
  if (eligible.length === 0) return null;

  const random = seededRandom(`${seed}:recall:${council.id}:${council.delegate}:${ground}`);
  const incoming = drawByLot(eligible, 1, random)[0];
  const outgoing = council.delegate;
  council.delegate = incoming;
  return { council: council.id, outgoing, incoming, ground };
}

/**
 * Whether a delegate's record has reached the ground section 11 calls "repeatedly misallocating
 * work". Counted in reassignments that followed this delegate's own allocation, so a delegate is
 * never recalled for work it did not route.
 */
export function misallocationRecallDue(misallocations: number, cfg: SocialistConfig): boolean {
  const threshold = cfg.recall?.delegateMisallocations ?? SOCIALIST_DEFAULTS.recall.delegateMisallocations;
  return threshold > 0 && misallocations >= threshold;
}
