// Section 6's Task Exchange — "the internal market where work is offered and agents submit bids" —
// and section 8's comparative advantage, which decides who should win.
//
// Two things were missing before this module, and they were the same thing twice.
//
// Section 6 lists nine things a listing must state and eight a bid must state. The exchange offered
// four of the first and five of the second, so bidders were pricing work whose deadline, budget,
// warranty period and required capabilities they had never been told, and the buyer was choosing
// between offers that disclosed neither their expected resource use nor who would actually do the
// work. A market where neither side can see the terms is not a market, it is a queue.
//
// And the award ran on absolute score. Section 8 opens by warning against exactly that — "The
// strongest agent should not automatically perform every task" — and gives Ricardo's reason: when
// one agent is better at everything, total output is still higher if it concentrates where its
// relative advantage is greatest. An exchange that always awards to the best bidder available
// spends its scarcest specialist on whatever listing happens to come up first.
//
// Everything here is deterministic. The award is the moment the market allocates capital, and a
// model asked to pick a winner would make it unauditable without making it better — the bids are
// already the model's judgment, and this is the arithmetic over them.

import type { RiskClass, TaskNode } from '../../engine/types.js';
import type { Bid, CapitalAccount } from './types.js';

// ------------------------------------------------------------------- listings

/** The nine things section 6 requires a listing to state. */
export interface Listing {
  taskId: string;
  scope: string;
  acceptanceCriteria: string[];
  /** Section 6's deadline, in minutes. */
  deadlineMinutes: number;
  riskClass: RiskClass;
  dependencies: string[];
  /** What the buyer will pay at most, in the economy's abstract token unit. */
  availableBudget: number;
  requiredCapabilities: string[];
  /** How many further settlements the warranty runs for. */
  warrantyPeriodTasks: number;
  /** Who owns the artefacts the contract produces. */
  artefactOwnership: string;
  /** The paths the statement of work covers. Article 3 is checked against these. */
  targetGlobs: string[];
}

export interface ListingTerms {
  /** Budget for an ordinary low-risk listing, before the risk and breadth multipliers. */
  baseBudget: number;
  /** Minutes allowed for an ordinary low-risk listing. */
  baseDeadlineMinutes: number;
  /** Warranty length for a low-risk listing; high-risk work carries longer. */
  baseWarrantyTasks: number;
}

export const DEFAULT_LISTING_TERMS: ListingTerms = {
  baseBudget: 100,
  baseDeadlineMinutes: 20,
  baseWarrantyTasks: 1,
};

/** Risk multiplies what a listing is worth, how long it gets, and how long it is warranted for. */
const RISK_MULTIPLIER: Record<RiskClass, number> = { low: 1, medium: 1.5, high: 2.5 };

/**
 * The capabilities a listing calls for, inferred from what it touches and what it is called.
 *
 * Deterministic keyword matching rather than a model call, for the same reason the socialist
 * doctrine infers its guilds that way: this decides who is eligible to bid, and an eligibility rule
 * that varies between runs is a barrier to entry nobody published. Article 4 keeps entry open, which
 * means the rule for entry has to be one a bidder can read.
 */
const CAPABILITY_PATTERNS: Array<[string, RegExp]> = [
  ['security', /\b(auth|security|credential|secret|token|encrypt|permission|privileg)/i],
  ['testing', /\b(test|spec|assert|coverage|fixture)/i],
  ['documentation', /\b(doc|readme|guide|changelog|comment)/i],
  ['frontend', /\b(ui|frontend|component|css|render|view|page|form)/i],
  ['backend', /\b(api|server|endpoint|route|handler|service|backend)/i],
  ['data', /\b(schema|migration|database|query|model|store|sql)/i],
  ['operations', /\b(deploy|build|ci|pipeline|release|config|docker)/i],
];

export function inferCapabilities(node: Pick<TaskNode, 'title' | 'description' | 'targetGlobs'>): string[] {
  const haystack = `${node.title} ${node.description} ${node.targetGlobs.join(' ')}`;
  const found = CAPABILITY_PATTERNS.filter(([, pattern]) => pattern.test(haystack)).map(([capability]) => capability);
  // A listing that matches nothing still needs somebody able to write code for it. Returning an
  // empty list would make every bidder equally qualified, which is true but useless; 'implementation'
  // is the honest floor.
  return found.length > 0 ? found : ['implementation'];
}

/**
 * Turns a planned node into a listing carrying every term section 6 requires.
 *
 * Budget, deadline and warranty all scale with risk and with how much of the tree the listing may
 * touch, because both are what actually makes a contract expensive to perform and expensive to get
 * wrong. None of it is a model's estimate: a buyer who could not state its own terms without asking
 * a model what they should be is not a buyer.
 */
export function buildListing(node: TaskNode, terms: ListingTerms = DEFAULT_LISTING_TERMS): Listing {
  const risk = RISK_MULTIPLIER[node.riskClass] ?? 1;
  // A listing free to touch anything is a broader promise than one scoped to a directory, and
  // breadth is priced as such. Capped so an unscoped listing does not get an unbounded budget.
  const breadth = Math.min(2, 1 + node.targetGlobs.filter((g) => g.includes('**')).length * 0.25);

  return {
    taskId: node.id,
    scope: node.description,
    acceptanceCriteria: node.acceptanceCriteria,
    deadlineMinutes: Math.round(terms.baseDeadlineMinutes * risk * breadth),
    riskClass: node.riskClass,
    dependencies: [...node.dependsOn],
    availableBudget: Math.round(terms.baseBudget * risk * breadth),
    requiredCapabilities: inferCapabilities(node),
    warrantyPeriodTasks: Math.max(1, Math.round(terms.baseWarrantyTasks * risk)),
    // Article 2: control rights must be explicit. The default is that the buyer keeps them — a
    // contractor paid to write a module does not thereby come to own it, which is the lock-in
    // section 6 warns about under private module ownership.
    artefactOwnership: 'buyer retains control rights; the contractor warrants the delivery',
    targetGlobs: [...node.targetGlobs],
  };
}

/** The listing as the text a bidder actually reads. */
export function renderListing(listing: Listing): string {
  return [
    `Listing "${listing.taskId}" (risk class: ${listing.riskClass})`,
    `Scope: ${listing.scope}`,
    `Acceptance criteria: ${listing.acceptanceCriteria.join('; ') || 'none given'}`,
    `Deadline: ${listing.deadlineMinutes} minutes`,
    `Dependencies: ${listing.dependencies.join(', ') || 'none'}`,
    `Available budget: ${listing.availableBudget} tokens — a bid above this may be refused outright`,
    `Required capabilities: ${listing.requiredCapabilities.join(', ')}`,
    `Warranty period: ${listing.warrantyPeriodTasks} further settlement(s) after acceptance`,
    `Ownership of resulting artefacts: ${listing.artefactOwnership}`,
    `Declared target globs (paths this contract may touch): ${listing.targetGlobs.join(', ')}`,
  ].join('\n');
}

// -------------------------------------------------------------- who can do what

/**
 * The capabilities each bidder is taken to hold.
 *
 * Comparative advantage is meaningless if every bidder is identical, so the personas have to differ
 * in something. They differ here, by a published rule rather than a draw: bidder-N takes the Nth
 * speciality in the vocabulary, plus the implementation floor everyone has. Article 4 keeps entry
 * open, and entry is only open if a bidder can work out in advance what it is eligible for.
 *
 * `configured` lets a deployment state the roster explicitly. That is the honest place for it —
 * these are the swarm's own personas, and pretending the runtime discovered their skills would be
 * fiction.
 */
export const CAPABILITY_VOCABULARY = [
  'backend',
  'testing',
  'frontend',
  'security',
  'data',
  'documentation',
  'operations',
] as const;

export function bidderCapabilities(personaId: string, configured?: Record<string, string[]>): string[] {
  const explicit = configured?.[personaId];
  if (explicit && explicit.length > 0) return [...explicit];

  const index = Number.parseInt(personaId.replace(/\D+/g, ''), 10);
  if (!Number.isFinite(index) || index < 1) return ['implementation'];
  return [CAPABILITY_VOCABULARY[(index - 1) % CAPABILITY_VOCABULARY.length], 'implementation'];
}

/** How many of these bidders could do this listing's specialised work. 1 means a sole specialist. */
export function specialistsAvailable(listing: Listing, bidders: ReadonlyArray<{ capabilities: readonly string[] }>): number {
  const required = new Set(listing.requiredCapabilities);
  const able = bidders.filter((b) => b.capabilities.some((c) => required.has(c))).length;
  // Never zero: a listing nobody specialises in is one anybody may take, not one nobody may.
  return Math.max(1, able);
}

// --------------------------------------------------------------------- awards

/** Everything about a bidder's position that bears on whether it should win this listing. */
export interface AwardContext {
  listing: Listing;
  allBids: readonly Bid[];
  /** Open listings this bidder already holds. Section 8's opportunity cost and queue length. */
  queueLength: number;
  /** How many eligible bidders hold this listing's required capabilities. 1 means a sole specialist. */
  specialistsAvailable: number;
  /** Whether this bidder already holds a contract this listing depends on — section 8's switching cost. */
  holdsDependency: boolean;
  /** The capabilities this bidder is taken to hold. */
  capabilities: readonly string[];
}

export interface AwardWeights {
  price: number;
  confidence: number;
  reputation: number;
  warranty: number;
  comparativeAdvantage: number;
  continuity: number;
}

export const DEFAULT_AWARD_WEIGHTS: AwardWeights = {
  price: 0.25,
  confidence: 0.2,
  reputation: 0.2,
  warranty: 0.05,
  comparativeAdvantage: 0.25,
  continuity: 0.05,
};

export interface ScoredBid {
  score: number;
  /** Each weighted term, so an award can be argued with rather than merely announced. */
  terms: Record<keyof AwardWeights, number>;
}

function clamp01(n: number): number {
  if (Number.isNaN(n) || !Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/**
 * Section 8's comparative advantage, as a number.
 *
 * Ricardo's point is about *relative* cost, not absolute skill: even where one agent is better at
 * everything, total output rises when it concentrates where its advantage is greatest. Two things
 * follow, and both are in here.
 *
 * A bidder who matches what the listing actually needs is worth more on it than one who does not —
 * that is the straightforward half. The other half is the one an absolute-score exchange gets
 * wrong: a *scarce* specialist bidding on work that does not need their scarcity should score
 * worse, because awarding it spends the only agent who can do the specialised work on something
 * anyone could have done. Queue length enters the same way, as section 8's opportunity cost: a
 * bidder already holding three contracts is a more expensive choice than an idle one of equal
 * skill, whatever their reputation says.
 */
export function comparativeAdvantage(ctx: AwardContext): number {
  const required = ctx.listing.requiredCapabilities;
  const held = new Set(ctx.capabilities);
  const matched = required.filter((c) => held.has(c)).length;
  const match = required.length === 0 ? 1 : matched / required.length;

  // A bidder outside the listing's speciality is not useless — most coding work can be done by a
  // competent generalist — so the base is a floor rather than zero. Multiplying straight by `match`
  // would zero the term for every non-specialist and leave scarcity nothing to discriminate on,
  // which would collapse the very comparison this function exists to make.
  const aptitude = 0.25 + 0.75 * match;

  // 1 when this bidder is the only one who can do this kind of work, falling as others can too.
  const scarcity = 1 / Math.max(1, ctx.specialistsAvailable);
  // Spending a scarce bidder on work outside its speciality is the trade Ricardo says not to make.
  const misallocation = scarcity * (1 - match);
  // A queue is opportunity cost: taking this contract is declining whatever it displaces.
  const queuePressure = clamp01(Math.max(0, ctx.queueLength) / 3);

  return clamp01(aptitude * (1 - misallocation) * (1 - 0.5 * queuePressure));
}

/**
 * The deterministic expected-value function that awards a listing.
 *
 * Never "lowest price wins" — section 6 is explicit that "the task owner selects the best expected
 * value, not automatically the lowest price" — and, since section 8, never "best bidder wins"
 * either. Price is one weighted term among six.
 *
 * Returns the terms alongside the score. An award is the moment capital is allocated, and a firm
 * that loses is owed the arithmetic rather than the verdict.
 */
export function scoreBid(
  bid: Bid,
  account: CapitalAccount,
  ctx: AwardContext,
  weights: AwardWeights = DEFAULT_AWARD_WEIGHTS,
): ScoredBid {
  const maxPrice = Math.max(1, ...ctx.allBids.map((b) => b.priceTokens));
  const priceScore = 1 - clamp01(bid.priceTokens / maxPrice); // cheaper relative to the field -> higher
  const observedSuccess = account.settlements ? (account.settlements - account.defects + 1) / (account.settlements + 2) : 0.5;
  const confidenceScore = clamp01(Math.min(bid.confidence, observedSuccess));

  const totalRounds = Math.max(1, account.defects + account.cleanTasksInARow);
  const defectRate = account.defects / totalRounds;
  const reputationScore = clamp01(account.reputationScore) * (1 - clamp01(defectRate));

  const warrantyScore = clamp01(new Set((bid.warranties ?? []).map((w) => w.trim().toLowerCase()).filter(Boolean)).size / 3);
  const advantageScore = comparativeAdvantage(ctx);
  // Coase, in miniature: a firm that already holds what this listing depends on carries less
  // coordination cost across the interface than one that has to be brought up to speed on it.
  const continuityScore = ctx.holdsDependency ? 1 : 0;

  const terms = {
    price: weights.price * priceScore,
    confidence: weights.confidence * confidenceScore,
    reputation: weights.reputation * reputationScore,
    warranty: weights.warranty * warrantyScore,
    comparativeAdvantage: weights.comparativeAdvantage * advantageScore,
    continuity: weights.continuity * continuityScore,
  };

  return { score: Object.values(terms).reduce((sum, t) => sum + t, 0), terms };
}

/**
 * Whether a bid may be considered at all.
 *
 * A bid above the published budget is not a cheaper way of saying no — the buyer stated what it
 * would pay, and a listing whose budget can be ignored did not have one. Refusing is also what
 * makes `availableBudget` a term rather than decoration.
 */
export function withinBudget(bid: Bid, listing: Listing): boolean {
  return bid.priceTokens <= listing.availableBudget;
}
