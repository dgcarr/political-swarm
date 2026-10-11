// Section 8: elections, appointment, sortition and rotation — "a purely electoral swarm risks
// popularity contests and factional capture. A purely expert swarm risks technocracy. A purely
// random swarm risks incompetence. A mixed system is preferable."
//
// The whole file is deterministic. Nothing here makes a model call: asking a model who should be
// Speaker would be a popularity contest with extra steps, and section 8's own criteria
// ("demonstrated success, calibration, reliability… cost effectiveness") are recorded facts, not
// judgments. Draws are seeded from the run id, so a run's office register can be re-derived from
// its ledger rather than being an unreproducible accident.
//
// The offices themselves are temporary by construction (article 9): every holder carries the term
// it was chosen for, rotation replaces the sortition and ordinary seats on a fixed cadence, and
// recall exists for a representative that stops representing.

import type { KnowledgeStore } from '../../engine/KnowledgeStore.js';
import { drawByLot, seededRandom } from '../../util/lots.js';
import { separationOfFunctionsBreaches, type FunctionHolders, type SeparationBreach } from './constitution.js';
import { DEFAULT_CONSTITUENCIES, DEFAULT_PORTFOLIOS, type DemocraticConfig } from './types.js';
import { DEMOCRATIC_DEFAULTS } from '../../constitution/schema.js';

/** How a seat was filled. Section 8 assigns each office to exactly one of these. */
export type SelectionMethod = 'election' | 'appointment' | 'sortition';

export interface OfficeHolder {
  personaId: string;
  /** 'prime-coordinator', 'speaker', 'representative', 'minister', … */
  office: string;
  /** The constituency or portfolio this seat answers for, where the office has one. */
  seat?: string;
  method: SelectionMethod;
  termId: number;
}

export interface OfficeRegister {
  termId: number;
  primeCoordinator: string;
  speaker: string;
  ceremonialHead: string;
  /** constituency -> representative persona id. */
  representatives: Record<string, string>;
  /** portfolio tag -> minister persona id. */
  cabinet: Record<string, string>;
  /** portfolio tag -> shadow minister persona id. */
  shadowCabinet: Record<string, string>;
  /** Section 6's second chamber: senior verifiers, security and maintainability agents, and
   * randomly selected reviewers. */
  houseOfReview: string[];
  /** Independently appointed security panel for security-boundary motions. */
  securityCommittee?: string[];
  /** Sortition seats drawn for this term's committee work. */
  sortitionPool: string[];
  holders: OfficeHolder[];
  constitutedAt: string;
}

/** One office holder's recorded record, as section 8's election criteria would read it. */
export interface OfficePerformance {
  personaId: string;
  carried: number;
  defeated: number;
}

export interface CandidateBallot {
  elector: string;
  candidate: string | null;
}

export interface ElectionResult {
  winner: string | null;
  votes: Record<string, number>;
  participation: number;
  quorumMet: boolean;
}

/** One equal ballot per eligible elector; ties go to the published candidate order. */
export function tallyElection(
  electors: readonly string[],
  candidates: readonly string[],
  ballots: readonly CandidateBallot[],
  minimumParticipation = 0.5,
): ElectionResult {
  if (new Set(electors).size !== electors.length || new Set(candidates).size !== candidates.length) {
    throw new Error('Election rolls and candidate rosters must contain unique identities.');
  }
  const eligible = new Set(electors);
  const contenders = new Set(candidates);
  const seen = new Set<string>();
  const votes = Object.fromEntries(candidates.map((candidate) => [candidate, 0]));
  for (const ballot of ballots) {
    if (!eligible.has(ballot.elector)) throw new Error(`Ineligible elector: ${ballot.elector}.`);
    if (seen.has(ballot.elector)) throw new Error(`Duplicate ballot: ${ballot.elector}.`);
    if (ballot.candidate !== null && !contenders.has(ballot.candidate)) {
      throw new Error(`Ineligible candidate: ${ballot.candidate}.`);
    }
    seen.add(ballot.elector);
    if (ballot.candidate !== null) votes[ballot.candidate] += 1;
  }
  const participation = ballots.length;
  const quorumMet = electors.length > 0 && participation / electors.length >= minimumParticipation;
  const ranked = [...candidates].sort((a, b) => votes[b] - votes[a]);
  const winner = quorumMet && ranked.length > 0 && votes[ranked[0]] > 0 ? ranked[0] : null;
  return { winner, votes, participation, quorumMet };
}

export interface ConstituteInput {
  /** The run's lot seed (lotSeed in util/lots.ts). */
  seed: string;
  cfg: DemocraticConfig;
  /** Prior performance, newest run first. Empty on a first run. */
  performance?: OfficePerformance[];
  termId?: number;
  constitutedAt: string;
}

// ---------------------------------------------------------------- seeded draw
//
// The draw itself is doctrine-neutral — it names no office and no institution — so it lives in
// util/lots.ts, where the socialist councils draw their delegates from the same implementation.
// Re-exported here because section 8's sortition is what this file is about.

export { drawByLot, seededRandom } from '../../util/lots.js';

// ------------------------------------------------------------------ election

/**
 * Section 8's election criteria, reduced to the part that is actually recorded: how often this
 * agent's motions were carried rather than defeated.
 *
 * A candidate with no record scores at the neutral prior rather than at zero — otherwise the first
 * agent ever to hold an office could never be replaced by an untried one, which is the entrenchment
 * rotation exists to prevent.
 */
export function performanceScore(personaId: string, performance: readonly OfficePerformance[]): number {
  const record = performance.find((p) => p.personaId === personaId);
  if (!record) return 0.5;
  const total = record.carried + record.defeated;
  if (total === 0) return 0.5;
  // Laplace-smoothed, so one lucky win does not outrank a long solid record.
  return (record.carried + 1) / (total + 2);
}

/**
 * Selects the strongest recorded performer for an appointment. A ballot election uses
 * tallyElection instead; performance may inform electors but cannot override their votes.
 */
export function electOne(
  candidates: readonly string[],
  performance: readonly OfficePerformance[],
  random: () => number,
): string {
  if (candidates.length === 0) return '';
  let best = candidates[0];
  let bestScore = performanceScore(best, performance);
  for (const candidate of candidates.slice(1)) {
    const score = performanceScore(candidate, performance);
    if (score > bestScore || (score === bestScore && random() < 0.5)) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

/** The candidate roster for an office in a given term. Stable and inspectable by construction. */
export function candidatesFor(office: string, count: number, termId: number): string[] {
  const n = Math.max(1, count);
  return Array.from({ length: n }, (_, i) => `${office}-t${termId}c${i + 1}`);
}

// -------------------------------------------------------------- constitution

export function constituencyList(cfg: DemocraticConfig): string[] {
  const named = cfg.constituencies?.filter((c) => c.trim().length > 0);
  return named?.length ? named : [...DEFAULT_CONSTITUENCIES];
}

export function portfolioList(cfg: DemocraticConfig): string[] {
  const named = cfg.cabinet?.portfolios?.filter((p) => p.trim().length > 0);
  return named?.length ? named : [...DEFAULT_PORTFOLIOS];
}

/** The shadow minister mirroring a portfolio, falling back to the configured default. */
export function shadowFor(cfg: DemocraticConfig, portfolioTag: string): string {
  const map = cfg.shadowCabinet ?? DEMOCRATIC_DEFAULTS.shadowCabinet;
  return map[portfolioTag] ?? map.default ?? 'shadow-general-reviewer';
}

/**
 * Constitutes a full office register for a term.
 *
 * Performance-appointed: Prime Coordinator, Speaker, representatives, ministers. The strategy may
 * replace the provisional Prime Coordinator with a constituency ballot before work begins.
 * Appointed: shadow ministers, which mirror the executive's portfolios rather than being chosen
 * independently. Drawn by lot: the sortition pool and the lay seats of the House of Review, which
 * is section 8's "random selection for review juries, audit panels… ordinary committee seats".
 */
export function constituteOffices(input: ConstituteInput): OfficeRegister {
  const { cfg, seed, constitutedAt } = input;
  const termId = input.termId ?? 1;
  const performance = input.performance ?? [];
  const seedBasis = cfg.offices?.seed === 'fixed' ? 'fixed' : seed;
  const random = seededRandom(`${seedBasis}:term-${termId}`);
  const perOffice = cfg.offices?.candidatesPerOffice ?? DEMOCRATIC_DEFAULTS.offices.candidatesPerOffice;

  const holders: OfficeHolder[] = [];
  const elect = (office: string, seat?: string): string => {
    const personaId = electOne(candidatesFor(seat ? `${office}-${seat}` : office, perOffice, termId), performance, random);
    holders.push({ personaId, office, seat, method: 'appointment', termId });
    return personaId;
  };

  const primeCoordinator = elect('prime-coordinator');
  const speaker = elect('speaker');

  // The Ceremonial Head is not elected: section 6 gives it reserve powers over the formation of
  // governments, and an office that owes its seat to the government it appoints is not a check on
  // it. It is drawn by lot from a roster the executive does not control.
  const ceremonialHead = drawByLot(candidatesFor('ceremonial-head', perOffice, termId), 1, random)[0] ?? '';
  holders.push({ personaId: ceremonialHead, office: 'ceremonial-head', method: 'sortition', termId });

  const representatives: Record<string, string> = {};
  for (const constituency of constituencyList(cfg)) {
    representatives[constituency] = elect('representative', constituency);
  }

  const cabinet: Record<string, string> = {};
  const shadowCabinet: Record<string, string> = {};
  for (const portfolio of portfolioList(cfg)) {
    cabinet[portfolio] = elect('minister', portfolio);
    const shadow = shadowFor(cfg, portfolio);
    shadowCabinet[portfolio] = shadow;
    holders.push({ personaId: shadow, office: 'shadow-minister', seat: portfolio, method: 'appointment', termId });
  }

  // Section 6: the House of Review mixes senior verification, security and maintainability agents
  // with randomly selected reviewers, so it neither duplicates the Commons nor becomes a second
  // expert clique.
  const standing = ['senior-verification-reviewer', 'security-reviewer', 'maintainability-reviewer'];
  const lay = drawByLot(candidatesFor('review-juror', perOffice + 2, termId), 2, random);
  const houseOfReview = [...standing, ...lay];
  for (const member of standing) {
    holders.push({ personaId: member, office: 'house-of-review', method: 'appointment', termId });
  }
  for (const member of lay) {
    holders.push({ personaId: member, office: 'house-of-review', method: 'sortition', termId });
  }

  const securityCommittee = ['verification', 'threat-review', 'operations']
    .map((seat) => `security-committee-${seat}-t${termId}`);
  for (const member of securityCommittee) {
    holders.push({ personaId: member, office: 'security-committee', method: 'appointment', termId });
  }

  const sortitionCalls = Math.max(0, cfg.committee?.sortitionCalls ?? DEMOCRATIC_DEFAULTS.committee.sortitionCalls);
  const sortitionPool = drawByLot(candidatesFor('sortition-citizen', sortitionCalls + 3, termId), sortitionCalls, random);
  for (const citizen of sortitionPool) {
    holders.push({ personaId: citizen, office: 'sortition-citizen', method: 'sortition', termId });
  }

  return {
    termId,
    primeCoordinator,
    speaker,
    ceremonialHead,
    representatives,
    cabinet,
    shadowCabinet,
    houseOfReview,
    securityCommittee,
    sortitionPool,
    holders,
    constitutedAt,
  };
}

/** Adapts a register to the shape article 6 checks. */
export function functionHolders(register: OfficeRegister, implementers: string[], integrator: string, verifier: string): FunctionHolders {
  return {
    primeCoordinator: register.primeCoordinator,
    speaker: register.speaker,
    ceremonialHead: register.ceremonialHead,
    implementers,
    integrator,
    verifier,
  };
}

export interface RepairResult {
  register: OfficeRegister;
  repairs: SeparationBreach[];
}

/**
 * Repairs an article 6 breach by reassigning the *procedural* office, never the executive one.
 *
 * The direction matters. A Speaker who is also Prime Coordinator is a problem with the Speaker's
 * neutrality, not with the government's mandate, and the government holds its mandate by
 * confidence — so the office that moves is the one that does not. If no distinct candidate is
 * available the breach is returned unrepaired, for the caller to raise as a finding rather than
 * paper over.
 */
export function repairSeparationBreaches(register: OfficeRegister, perOffice: number): RepairResult {
  const repaired: OfficeRegister = { ...register, holders: [...register.holders] };
  const unrepaired: SeparationBreach[] = [];

  // Only the offices this register actually owns can be moved; implementer/integrator/verifier
  // conflicts are settled where those personas are chosen, and engine/delivery.ts refuses the
  // integrator-is-verifier case structurally in any event.
  const movable: Array<['speaker' | 'ceremonial-head', () => string, (id: string) => void]> = [
    ['speaker', () => repaired.speaker, (id) => { repaired.speaker = id; }],
    ['ceremonial-head', () => repaired.ceremonialHead, (id) => { repaired.ceremonialHead = id; }],
  ];

  for (const breach of separationOfFunctionsBreaches(functionHolders(repaired, [], '', ''))) {
    const target = movable.find(([office]) => breach.offices.includes(office));
    if (!target) {
      unrepaired.push(breach);
      continue;
    }
    const [office, read, write] = target;
    const taken = new Set([repaired.primeCoordinator, repaired.speaker, repaired.ceremonialHead]);
    const replacement = candidatesFor(office, perOffice + 2, repaired.termId).find((c) => !taken.has(c));
    if (!replacement) {
      unrepaired.push(breach);
      continue;
    }
    const outgoing = read();
    write(replacement);
    repaired.holders = repaired.holders.map((h) =>
      h.office === office && h.personaId === outgoing ? { ...h, personaId: replacement } : h,
    );
  }

  return { register: repaired, repairs: unrepaired };
}

// ----------------------------------------------------------- rotation, recall

/** Article 9's cadence. A term length of 0 (or an absent one) means offices do not rotate. */
export function shouldRotate(completedTasks: number, cfg: DemocraticConfig): boolean {
  const term = cfg.offices?.termLengthInTasks ?? DEMOCRATIC_DEFAULTS.offices.termLengthInTasks;
  if (term <= 0 || completedTasks <= 0) return false;
  return completedTasks % term === 0;
}

/**
 * Opens a new term. Section 8: rotation exists to prevent "permanent hierarchy, stale assumptions,
 * capture of shared memory, dependency on one agent, concentration of repository knowledge" — so a
 * new term re-runs the whole selection rather than renewing the incumbents by default. An
 * incumbent with a good record may well win again; it simply does not keep the seat by inertia.
 */
export function rotateOffices(previous: OfficeRegister, input: ConstituteInput): OfficeRegister {
  return constituteOffices({ ...input, termId: previous.termId + 1 });
}

export interface RecallResult {
  register: OfficeRegister;
  outgoing: string;
  incoming: string;
}

/**
 * Section 8: a representative "remains subject to recall for persistent misrepresentation or
 * incompetence". The successor is the next unused candidate on the same roster, so a recall
 * replaces the holder without disturbing any other seat.
 */
export function recallRepresentative(register: OfficeRegister, constituency: string, perOffice: number): RecallResult | null {
  const outgoing = register.representatives[constituency];
  if (!outgoing) return null;

  const taken = new Set(Object.values(register.representatives));
  const incoming = candidatesFor(`representative-${constituency}`, perOffice + 2, register.termId).find((c) => !taken.has(c));
  if (!incoming) return null;

  return {
    register: {
      ...register,
      representatives: { ...register.representatives, [constituency]: incoming },
      holders: register.holders.map((h) =>
        h.office === 'representative' && h.seat === constituency ? { ...h, personaId: incoming } : h,
      ),
    },
    outgoing,
    incoming,
  };
}

// ------------------------------------------------- cross-run performance record

const OFFICE_PERFORMANCE_TAG = 'democratic:office';

/**
 * Reads prior office performance out of the civil service's cross-run memory.
 *
 * Deliberately forgiving: the KnowledgeStore is shared infrastructure that may be absent, empty or
 * hold entries written by an older version of this code. An election that cannot read a record
 * falls back to the neutral prior and the seeded draw — never to a crash, because a swarm that
 * cannot hold an election because a cache is malformed has no way to govern itself.
 */
export function readOfficePerformance(knowledge: KnowledgeStore | undefined, limit = 200): OfficePerformance[] {
  if (!knowledge || typeof knowledge.queryByTags !== 'function') return [];
  let entries;
  try {
    entries = knowledge.queryByTags([OFFICE_PERFORMANCE_TAG], limit);
  } catch {
    return [];
  }

  const totals = new Map<string, OfficePerformance>();
  for (const entry of entries) {
    let parsed: Partial<OfficePerformance>;
    try {
      parsed = JSON.parse(entry.content) as Partial<OfficePerformance>;
    } catch {
      continue;
    }
    if (typeof parsed.personaId !== 'string' || !parsed.personaId) continue;
    const record = totals.get(parsed.personaId) ?? { personaId: parsed.personaId, carried: 0, defeated: 0 };
    record.carried += Number.isFinite(parsed.carried) ? Number(parsed.carried) : 0;
    record.defeated += Number.isFinite(parsed.defeated) ? Number(parsed.defeated) : 0;
    totals.set(parsed.personaId, record);
  }
  return [...totals.values()];
}

/** Writes one holder's record for future elections to read. Silent on failure, for the same reason. */
export function recordOfficePerformance(
  knowledge: KnowledgeStore | undefined,
  runId: string,
  record: OfficePerformance,
  createdAtIso: string,
): void {
  if (!knowledge || typeof knowledge.add !== 'function') return;
  try {
    knowledge.add(
      {
        kind: 'lesson',
        tags: [OFFICE_PERFORMANCE_TAG, record.personaId],
        sourceRunId: runId,
        content: JSON.stringify(record),
      },
      `${OFFICE_PERFORMANCE_TAG}:${runId}:${record.personaId}`,
      createdAtIso,
    );
  } catch {
    // A civil service that cannot file a record still has to let the government govern.
  }
}
