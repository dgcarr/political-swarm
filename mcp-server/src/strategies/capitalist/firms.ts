// Section 6's Agent Firms, section 5's subcontracting, and the Coase rule that decides between
// them.
//
// Before this module a listing was won by one persona who did everything: implementation, tests,
// documentation and security, alone. Section 6 describes something else — a firm with "a lead
// contractor, implementation agents, test agents, documentation agents, a security subcontractor,
// a release agent" — and section 5 lets the winner "subcontract independent modules for parallel
// production after recording their dependencies and deliverables".
//
// The interesting part is not that firms exist but when they should. The doctrine cites Coase twice
// and takes both halves seriously: "Firms arise when internal coordination is cheaper than repeated
// market exchange", so "form temporary agent firms for tightly coupled work rather than auctioning
// every small action" — and the converse, "use markets for modular work but integrated control
// where coordination and interface costs are high". A market that auctions every small action pays
// the transaction cost of an auction on work that two contracts cannot cleanly divide anyway.
//
// So: coupling is measured, and where it is high the firm that won the first listing takes the
// coupled one too, rather than a second auction handing an interlocking change to a stranger.
//
// Deterministic throughout. Which firm holds what, and who bears liability for it, decides where
// money and blame land; that cannot be a model's opinion on the day. Subcontractor draws are seeded
// from the run id so a firm's composition can be re-derived from the ledger.

import { drawByLot, seededRandom } from '../../util/lots.js';
import type { TaskGraph } from '../../engine/types.js';
import { bidderCapabilities, type Listing } from './exchange.js';

/** Section 6's roster of what a firm may contain. */
export type FirmRole = 'lead' | 'implementation' | 'test' | 'documentation' | 'security' | 'release';

export interface FirmMember {
  personaId: string;
  role: FirmRole;
  /** The capability that made this member worth engaging. */
  capability: string;
}

export interface Firm {
  leadId: string;
  members: FirmMember[];
  /**
   * Who answers for the delivery. Always the lead: section 6 gives the firm the contract and says
   * it "bears responsibility for delivery", and section 10 forbids externalising that risk — "firms
   * may insure or subcontract that risk but may not externalise it to the repository or user."
   */
  liableId: string;
}

/** Which subcontracted role answers for which capability. */
const ROLE_FOR_CAPABILITY: Record<string, FirmRole> = {
  testing: 'test',
  documentation: 'documentation',
  security: 'security',
  operations: 'release',
};

export interface FormFirmInput {
  leadId: string;
  listing: Listing;
  /** Whoever the winning bid said it would engage. Honoured where it can be. */
  declaredSubcontractors?: readonly string[];
  /** Other personas available to subcontract to. */
  pool: readonly string[];
  seed: string;
  maxSubcontractors: number;
  /** The published capability roster, so a subcontractor is engaged for something it can do. */
  specialisations?: Record<string, string[]>;
}

/**
 * Forms the firm that will deliver one listing.
 *
 * A subcontractor is engaged only for a capability the listing needs and the lead does not hold.
 * That is Coase applied at the level of the single contract: work you can do in-house is cheaper
 * done in-house, and paying an outside specialist for something you already do well is transaction
 * cost with nothing bought. It also means a firm's shape is a fact about the work rather than a
 * preference — a listing that needs no speciality the lead lacks is delivered by the lead alone,
 * which is the common case and should stay cheap.
 */
export function formFirm(input: FormFirmInput): Firm {
  const leadCapabilities = new Set(bidderCapabilities(input.leadId, input.specialisations));
  const members: FirmMember[] = [{ personaId: input.leadId, role: 'lead', capability: 'lead' }];

  const gaps = input.listing.requiredCapabilities.filter(
    (capability) => ROLE_FOR_CAPABILITY[capability] && !leadCapabilities.has(capability),
  );

  for (const capability of gaps) {
    if (members.length - 1 >= input.maxSubcontractors) break;

    const able = input.pool.filter(
      (persona) =>
        persona !== input.leadId &&
        !members.some((m) => m.personaId === persona) &&
        bidderCapabilities(persona, input.specialisations).includes(capability),
    );
    if (able.length === 0) continue;

    // A subcontractor the bid actually named is preferred over one drawn by lot: the buyer chose
    // that bid partly on who it said would do the work, and quietly substituting somebody else
    // would make the declaration worthless.
    const declared = (input.declaredSubcontractors ?? []).find((persona) => able.includes(persona));
    const random = seededRandom(`${input.seed}:subcontract:${input.listing.taskId}:${capability}`);
    const chosen = declared ?? drawByLot(able, 1, random)[0];
    if (!chosen) continue;

    members.push({ personaId: chosen, role: ROLE_FOR_CAPABILITY[capability], capability });
  }

  return { leadId: input.leadId, members, liableId: input.leadId };
}

/** The members other than the lead, in the order they were engaged. */
export function subcontractorsOf(firm: Firm): FirmMember[] {
  return firm.members.filter((m) => m.role !== 'lead');
}

// -------------------------------------------------------------- Coase's margin

export interface CouplingScore {
  score: number;
  /** Why these two listings are (or are not) coupled, for the record. */
  reasons: string[];
}

/**
 * How tightly two listings are coupled, on 0..1.
 *
 * Section 5's own list of what makes parallel production unsafe is the basis: shared files, shared
 * interfaces, and a dependency on something not yet settled. Two contracts writing the same paths
 * are not two contracts, they are one change with a seam down the middle, and the seam is exactly
 * where the integration defect will be.
 */
export function coupling(graph: TaskGraph, taskIdA: string, taskIdB: string): CouplingScore {
  const a = graph.nodes[taskIdA];
  const b = graph.nodes[taskIdB];
  if (!a || !b || taskIdA === taskIdB) return { score: 0, reasons: [] };

  const reasons: string[] = [];
  let score = 0;

  const sharedGlobs = a.targetGlobs.filter((g) => b.targetGlobs.includes(g));
  if (sharedGlobs.length > 0) {
    score += 0.5;
    reasons.push(`both statements of work claim ${sharedGlobs.join(', ')}`);
  }

  if (a.dependsOn.includes(taskIdB) || b.dependsOn.includes(taskIdA)) {
    score += 0.4;
    reasons.push('one depends directly on the other');
  }

  const sharedDeps = a.dependsOn.filter((d) => b.dependsOn.includes(d));
  if (sharedDeps.length > 0) {
    score += 0.2;
    reasons.push(`both depend on ${sharedDeps.join(', ')}`);
  }

  return { score: Math.min(1, score), reasons };
}

/**
 * Whether coupling is high enough that one firm should take both listings.
 *
 * Above the threshold, auctioning the second listing separately buys a stranger's implementation of
 * one half of an interlocking change, plus an integration defect nobody is liable for. Below it,
 * the market is the cheaper coordinator and the listing goes to tender — which is the case the
 * doctrine wants to be the default, and is why the threshold sits high rather than low.
 */
export function shouldIntegrate(score: number, threshold: number): boolean {
  return threshold > 0 && score >= threshold;
}

/**
 * The listings a firm should absorb alongside one it has just won.
 *
 * Only unawarded, unblocked listings are candidates: absorbing work another firm already holds
 * would be taking a contract off a party that won it, which no amount of coordination saving
 * justifies.
 */
export function integrableListings(
  graph: TaskGraph,
  awardedTaskId: string,
  candidateTaskIds: readonly string[],
  threshold: number,
): Array<{ taskId: string; score: number; reasons: string[] }> {
  return candidateTaskIds
    .filter((id) => id !== awardedTaskId)
    .map((id) => ({ taskId: id, ...coupling(graph, awardedTaskId, id) }))
    .filter((c) => shouldIntegrate(c.score, threshold));
}

// ----------------------------------------------------------- merging delivery

export interface DeliveredOp {
  op: string;
  path: string;
}

/**
 * Which of a subcontractor's file operations may stand.
 *
 * A subcontractor engaged to write tests must not overwrite the implementation the lead just
 * delivered, and under a naive last-write-wins merge it silently would — the test author's view of
 * the module replacing the actual module, with the contract still reported as delivered. So a
 * subcontractor may add and it may touch what nobody else claimed, but it may not overwrite a path
 * the lead wrote.
 *
 * The dropped operations are returned rather than discarded, because the lead is liable for the
 * delivery and needs to know a member of its firm tried to write over the work.
 */
export function mergeSubcontractedOps<T extends DeliveredOp>(
  leadOps: readonly T[],
  subcontractedOps: readonly T[],
): { kept: T[]; dropped: T[] } {
  const claimed = new Set(leadOps.map((op) => op.path));
  const kept: T[] = [];
  const dropped: T[] = [];

  for (const op of subcontractedOps) {
    if (claimed.has(op.path)) {
      dropped.push(op);
      continue;
    }
    claimed.add(op.path);
    kept.push(op);
  }
  return { kept, dropped };
}
