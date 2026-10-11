import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LISTING_TERMS,
  buildListing,
  comparativeAdvantage,
  inferCapabilities,
  renderListing,
  scoreBid,
  withinBudget,
  type AwardContext,
  type Listing,
} from './exchange.js';
import type { TaskNode } from '../../engine/types.js';
import type { Bid, CapitalAccount } from './types.js';

function node(over: Partial<TaskNode> = {}): TaskNode {
  return {
    id: 't1',
    title: 'Add an endpoint',
    description: 'Add a backend API route',
    acceptanceCriteria: ['it responds'],
    dependsOn: [],
    targetGlobs: ['src/api/**'],
    riskTags: [],
    riskClass: 'low',
    phase: 'queued',
    attempts: [],
    ...over,
  } as TaskNode;
}

function bid(over: Partial<Bid> = {}): Bid {
  return { priceTokens: 20, estTime: 10, confidence: 0.8, approach: 'x', ...over };
}

function account(over: Partial<CapitalAccount> = {}): CapitalAccount {
  return {
    personaId: 'p',
    capital: 100,
    reputationScore: 0.5,
    defects: 0,
    cleanTasksInARow: 0,
    heldEscrow: 0,
    bankrupt: false,
    ...over,
  };
}

function ctx(over: Partial<AwardContext> = {}): AwardContext {
  const listing = over.listing ?? buildListing(node());
  return {
    listing,
    allBids: over.allBids ?? [bid()],
    queueLength: 0,
    specialistsAvailable: 3,
    holdsDependency: false,
    capabilities: listing.requiredCapabilities,
    ...over,
  };
}

describe('what a listing has to state', () => {
  // Section 6 lists nine terms. A bidder pricing work whose deadline, budget and warranty it was
  // never told is not making an offer, it is guessing.
  it('states every term section 6 requires', () => {
    const listing = buildListing(node());
    expect(listing.deadlineMinutes).toBeGreaterThan(0);
    expect(listing.availableBudget).toBeGreaterThan(0);
    expect(listing.warrantyPeriodTasks).toBeGreaterThan(0);
    expect(listing.requiredCapabilities.length).toBeGreaterThan(0);
    expect(listing.artefactOwnership.trim().length).toBeGreaterThan(0);
    expect(listing.acceptanceCriteria).toEqual(['it responds']);
    expect(listing.targetGlobs).toEqual(['src/api/**']);
  });

  it('pays and allows more for riskier work', () => {
    const low = buildListing(node({ riskClass: 'low' }));
    const high = buildListing(node({ riskClass: 'high' }));
    expect(high.availableBudget).toBeGreaterThan(low.availableBudget);
    expect(high.deadlineMinutes).toBeGreaterThan(low.deadlineMinutes);
    expect(high.warrantyPeriodTasks).toBeGreaterThan(low.warrantyPeriodTasks);
  });

  it('treats a broader statement of work as a bigger promise', () => {
    const narrow = buildListing(node({ targetGlobs: ['src/api/handler.ts'] }));
    const broad = buildListing(node({ targetGlobs: ['**/*', 'src/**'] }));
    expect(broad.availableBudget).toBeGreaterThan(narrow.availableBudget);
  });

  // Otherwise an unscoped listing would carry an unbounded budget, which is the opposite of a term.
  it('caps how far breadth can inflate a budget', () => {
    const veryBroad = buildListing(node({ targetGlobs: ['**/a', '**/b', '**/c', '**/d', '**/e', '**/f'] }));
    expect(veryBroad.availableBudget).toBeLessThanOrEqual(DEFAULT_LISTING_TERMS.baseBudget * 2);
  });

  // Article 2: control rights must be explicit. A contractor paid to write a module does not
  // thereby come to own it — that is the lock-in section 6 warns about.
  it('says who owns what the contract produces, and it is not the contractor', () => {
    expect(buildListing(node()).artefactOwnership).toContain('buyer retains');
  });

  it('renders every term into the text a bidder actually reads', () => {
    const text = renderListing(buildListing(node()));
    for (const term of ['Deadline', 'Available budget', 'Required capabilities', 'Warranty period', 'Ownership']) {
      expect(text).toContain(term);
    }
  });
});

describe('inferring what a listing needs', () => {
  it('reads capabilities off what the work touches and what it is called', () => {
    expect(inferCapabilities({ title: 'Add auth middleware', description: 'x', targetGlobs: ['src/**'] })).toContain(
      'security',
    );
    expect(inferCapabilities({ title: 'x', description: 'Write unit tests', targetGlobs: ['test/**'] })).toContain(
      'testing',
    );
    expect(inferCapabilities({ title: 'x', description: 'y', targetGlobs: ['docs/README.md'] })).toContain(
      'documentation',
    );
  });

  it('can find more than one', () => {
    const found = inferCapabilities({ title: 'Add an API route with tests', description: 'x', targetGlobs: ['src/**'] });
    expect(found).toContain('backend');
    expect(found).toContain('testing');
  });

  // An empty list would make every bidder equally qualified — true, but useless as an eligibility
  // rule, and article 4 needs entry to run on something a bidder can read.
  it('falls back to a floor rather than qualifying everybody', () => {
    expect(inferCapabilities({ title: 'zzz', description: 'qqq', targetGlobs: ['zzz'] })).toEqual(['implementation']);
  });
});

describe('the budget as an actual term', () => {
  it('admits a bid at or under the published budget', () => {
    const listing = buildListing(node());
    expect(withinBudget(bid({ priceTokens: listing.availableBudget }), listing)).toBe(true);
  });

  it('refuses a bid above it — a budget that can be ignored was never a term', () => {
    const listing = buildListing(node());
    expect(withinBudget(bid({ priceTokens: listing.availableBudget + 1 }), listing)).toBe(false);
  });
});

describe('comparative advantage', () => {
  it('prefers a bidder who matches what the listing needs', () => {
    const listing: Listing = { ...buildListing(node()), requiredCapabilities: ['security', 'backend'] };
    const matched = comparativeAdvantage(ctx({ listing, capabilities: ['security', 'backend'] }));
    const unmatched = comparativeAdvantage(ctx({ listing, capabilities: ['documentation'] }));
    expect(matched).toBeGreaterThan(unmatched);
  });

  // Ricardo's actual point, and the one an absolute-score exchange gets wrong: awarding the only
  // available specialist a listing anyone could have done spends them on the wrong work.
  it('penalises spending a scarce specialist on work that does not need their scarcity', () => {
    const listing: Listing = { ...buildListing(node()), requiredCapabilities: ['documentation'] };
    const soleSpecialist = comparativeAdvantage(
      ctx({ listing, capabilities: ['security'], specialistsAvailable: 1 }),
    );
    const oneOfMany = comparativeAdvantage(ctx({ listing, capabilities: ['security'], specialistsAvailable: 8 }));
    expect(soleSpecialist).toBeLessThan(oneOfMany);
  });

  it('does not penalise a scarce specialist bidding on the work they are scarce for', () => {
    const listing: Listing = { ...buildListing(node()), requiredCapabilities: ['security'] };
    const onItsOwnGround = comparativeAdvantage(
      ctx({ listing, capabilities: ['security'], specialistsAvailable: 1 }),
    );
    expect(onItsOwnGround).toBe(1);
  });

  it('treats a full queue as the opportunity cost section 8 calls it', () => {
    const idle = comparativeAdvantage(ctx({ queueLength: 0 }));
    const busy = comparativeAdvantage(ctx({ queueLength: 3 }));
    expect(busy).toBeLessThan(idle);
  });

  it('stays within [0, 1] under any queue length', () => {
    for (const queueLength of [0, 1, 5, 50]) {
      const value = comparativeAdvantage(ctx({ queueLength }));
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });
});

describe('scoring a bid', () => {
  it('does not pay twice for duplicate promises', () => {
    const first = bid({ warranties: ['passes tests'] });
    const repeated = bid({ warranties: ['passes tests', ' passes tests ', 'PASSES TESTS'] });
    const context = ctx({ allBids: [first, repeated] });
    expect(scoreBid(first, account(), context).score).toBe(scoreBid(repeated, account(), context).score);
  });
  it('never picks purely on lowest price', () => {
    const cheapButRisky = bid({ priceTokens: 5, confidence: 0.3, warranties: [] });
    const pricierButTrusted = bid({ priceTokens: 20, confidence: 0.95, warranties: ['a', 'b', 'c'] });
    const allBids = [cheapButRisky, pricierButTrusted];

    const risky = scoreBid(cheapButRisky, account({ reputationScore: 0.2, defects: 4 }), ctx({ allBids }));
    const trusted = scoreBid(
      pricierButTrusted,
      account({ reputationScore: 0.9, cleanTasksInARow: 10 }),
      ctx({ allBids }),
    );

    expect(trusted.score).toBeGreaterThan(risky.score);
  });

  it('scores the same bid higher when it is the cheapest in the field', () => {
    const b = bid({ priceTokens: 10 });
    const cheapest = scoreBid(b, account(), ctx({ allBids: [b, bid({ priceTokens: 50 })] }));
    const notCheapest = scoreBid(b, account(), ctx({ allBids: [b, bid({ priceTokens: 2 })] }));
    expect(cheapest.score).toBeGreaterThan(notCheapest.score);
  });

  it('discounts reputation by historical defect rate', () => {
    const b = bid();
    const defective = scoreBid(b, account({ reputationScore: 0.8, defects: 9, cleanTasksInARow: 1 }), ctx());
    const clean = scoreBid(b, account({ reputationScore: 0.6, cleanTasksInARow: 10 }), ctx());
    expect(clean.score).toBeGreaterThan(defective.score);
  });

  // Section 8: "The strongest agent should not automatically perform every task." This is that
  // sentence as a test — an identical bid from an identical account loses when taking it would
  // misallocate the bidder.
  it('lets an identical bid lose on comparative advantage alone', () => {
    const listing: Listing = { ...buildListing(node()), requiredCapabilities: ['documentation'] };
    const b = bid();
    const wellPlaced = scoreBid(b, account(), ctx({ listing, capabilities: ['documentation'] }));
    const misallocated = scoreBid(
      b,
      account(),
      ctx({ listing, capabilities: ['security'], specialistsAvailable: 1 }),
    );
    expect(misallocated.score).toBeLessThan(wellPlaced.score);
  });

  it('rewards a firm that already holds what this listing depends on', () => {
    const b = bid();
    const incumbent = scoreBid(b, account(), ctx({ holdsDependency: true }));
    const stranger = scoreBid(b, account(), ctx({ holdsDependency: false }));
    expect(incumbent.score).toBeGreaterThan(stranger.score);
  });

  // An award allocates capital. A firm that loses is owed the arithmetic, not the verdict.
  it('returns every weighted term, so a losing bidder can argue with the award', () => {
    const scored = scoreBid(bid(), account(), ctx());
    expect(Object.keys(scored.terms).sort()).toEqual([
      'comparativeAdvantage',
      'confidence',
      'continuity',
      'price',
      'reputation',
      'warranty',
    ]);
    expect(Object.values(scored.terms).reduce((s, t) => s + t, 0)).toBeCloseTo(scored.score, 10);
  });

  it('returns a score within [0, 1] for well-formed inputs', () => {
    const scored = scoreBid(
      bid({ warranties: ['a', 'b', 'c', 'd'] }),
      account({ reputationScore: 1, cleanTasksInARow: 5 }),
      ctx({ holdsDependency: true }),
    );
    expect(scored.score).toBeGreaterThanOrEqual(0);
    expect(scored.score).toBeLessThanOrEqual(1);
  });

  it('does not divide by zero when every bid in the field is free', () => {
    const zero = bid({ priceTokens: 0 });
    expect(() => scoreBid(zero, account(), ctx({ allBids: [zero] }))).not.toThrow();
  });
});
