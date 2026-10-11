import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TREASURY_POLICY,
  PUBLIC_GOODS,
  collectLevy,
  considerBailout,
  fundExperiment,
  fundPublicGood,
  openTreasury,
  publicGoodForWork,
  resolveTreasuryPolicy,
  subsidizePublicGoodListing,
  subsidizeExperimentListing,
  treasuryBalance,
  type Treasury,
} from './treasury.js';

function funded(publicGoodsFund = 100, venturePool = 50): Treasury {
  return { ...openTreasury(), publicGoodsFund, venturePool };
}

it('identifies shared work from the commissioned listing, not the bidder', () => {
  expect(publicGoodForWork('Repair CI tests', ['tests/ci.test.ts'])).toBe('shared test infrastructure');
  expect(publicGoodForWork('Implement private profile screen', ['src/profile.tsx'])).toBeNull();
});

it('commissions a named exploratory listing only from unpledged venture funds', () => {
  const treasury = funded(0, 50);
  const request = {
    taskId: 'spike', title: 'Prototype a parser', publishedBudget: 100, cheapestBid: 120,
    outstandingCredit: 20, reserveBalance: 0, scopeUnderstood: false,
  };
  expect(subsidizeExperimentListing(treasury, request)).toMatchObject({ amount: 20 });
  expect(treasury.venturePool).toBe(30);
  expect(treasury.grants[0]).toMatchObject({ taskId: 'spike', evidenceRefs: ['listing:spike'] });
  expect(subsidizeExperimentListing(funded(0, 30), { ...request, outstandingCredit: 20, cheapestBid: 120 })).toBeNull();
  expect(subsidizeExperimentListing(funded(0, 50), { ...request, scopeUnderstood: true })).toBeNull();
});

describe('commissioning shared work from unpledged funds', () => {
  const listing = {
    taskId: 'test-infra', title: 'Repair CI tests', paths: ['tests/ci.test.ts'],
    publishedBudget: 100, cheapestBid: 120, outstandingCredit: 0, reserveBalance: 0,
  };

  it('funds a complete named tender shortfall with evidence', () => {
    const treasury = funded(100, 0);
    expect(subsidizePublicGoodListing(treasury, listing)).toEqual({ good: 'shared test infrastructure', amount: 20 });
    expect(treasury.publicGoodsFund).toBe(80);
    expect(treasury.grants[0]).toMatchObject({ taskId: 'test-infra', evidenceRefs: ['listing:test-infra'] });
  });

  it('does not spend capital pledged to outstanding credit or fund a partial tender', () => {
    const treasury = funded(100, 0);
    expect(subsidizePublicGoodListing(treasury, { ...listing, outstandingCredit: 90 })).toBeNull();
    expect(treasury.grants).toHaveLength(0);
    expect(subsidizePublicGoodListing(treasury, { ...listing, cheapestBid: 170 })).toBeNull();
    expect(treasury.publicGoodsFund).toBe(100);
  });
});

describe('the levy', () => {
  it('takes a share of a profitable contract', () => {
    const treasury = openTreasury();
    const result = collectLevy(treasury, { taskId: 't1', personaId: 'firm-a', profit: 100 });
    expect(result.amount).toBe(10);
    expect(treasuryBalance(treasury)).toBe(10);
  });

  it('splits it between public goods and the venture pool', () => {
    const treasury = openTreasury();
    const result = collectLevy(treasury, { taskId: 't1', personaId: 'firm-a', profit: 100 });
    expect(result.toPublicGoods).toBe(7);
    expect(result.toVenturePool).toBe(3);
    expect(treasury.publicGoodsFund).toBe(7);
    expect(treasury.venturePool).toBe(3);
  });

  // Section 6 says a levy on *profitable* contracts. A loss-making one has already cost its firm
  // capital; taxing it as well makes failure compound rather than merely cost, which pushes firms
  // away from the uncertain work the venture pool exists to fund.
  it('takes nothing from a contract that made a loss', () => {
    const treasury = openTreasury();
    expect(collectLevy(treasury, { taskId: 't1', personaId: 'firm-a', profit: -50 }).amount).toBe(0);
    expect(treasuryBalance(treasury)).toBe(0);
  });

  // Article 9 asks whether a settled contract paid what it owed, and "nothing, because it earned
  // nothing" is a complete answer. Leaving it off the record would report free-riding where there
  // was none.
  it('still records an unprofitable contract as having discharged its obligation', () => {
    const treasury = openTreasury();
    const result = collectLevy(treasury, { taskId: 't1', personaId: 'firm-a', profit: 0 });
    expect(treasury.levies.map((l) => l.taskId)).toEqual(['t1']);
    expect(result.rationale).toContain('discharged, not evaded');
  });

  it('accumulates across a run', () => {
    const treasury = openTreasury();
    collectLevy(treasury, { taskId: 't1', personaId: 'firm-a', profit: 100 });
    collectLevy(treasury, { taskId: 't2', personaId: 'firm-b', profit: 200 });
    expect(treasuryBalance(treasury)).toBe(30);
    expect(treasury.levies).toHaveLength(2);
  });
});

describe('funding the commons', () => {
  it('names the goods section 6 says the market underprovides', () => {
    expect(PUBLIC_GOODS).toContain('shared test infrastructure');
    expect(PUBLIC_GOODS).toContain('security baselines');
    expect(PUBLIC_GOODS).toContain('technical debt reduction');
  });

  it('grants toward a public good and draws down the fund', () => {
    const treasury = funded();
    const result = fundPublicGood(treasury, { good: 'security baselines', amount: 20, rationale: 'needed' });
    expect(result.granted).toBe(20);
    expect(treasury.publicGoodsFund).toBe(80);
    expect(treasury.grants).toHaveLength(1);
  });

  // The goods section 6 names are standing obligations, not one-off purchases. A treasury that
  // spent everything on the first request would fund the first thing asked for, not the most needed.
  it('caps a single grant so one request cannot empty the fund', () => {
    const treasury = funded(100);
    const result = fundPublicGood(treasury, { good: 'build systems', amount: 100, rationale: 'x' });
    expect(result.granted).toBe(50);
    expect(result.refused).toBe(50);
    expect(treasury.publicGoodsFund).toBe(50);
  });

  it('grants nothing from an empty fund', () => {
    const treasury = openTreasury();
    expect(fundPublicGood(treasury, { good: 'observability', amount: 20, rationale: 'x' }).granted).toBe(0);
    expect(treasury.grants).toEqual([]);
  });
});

describe('the venture pool', () => {
  it('funds an experiment from the pool', () => {
    const treasury = funded(100, 50);
    const result = fundExperiment(treasury, { experiment: 'a faster test harness', amount: 30 });
    expect(result.granted).toBe(30);
    expect(treasury.venturePool).toBe(20);
  });

  it('cannot commit more than the pool holds', () => {
    const treasury = funded(100, 10);
    expect(fundExperiment(treasury, { experiment: 'x', amount: 50 }).granted).toBe(10);
    expect(treasury.venturePool).toBe(0);
  });

  // "Failed experiments lose capital but should still publish useful findings." The finding is the
  // return on a failed experiment, so the obligation travels with the money.
  it('attaches the publication obligation the doctrine requires', () => {
    const result = fundExperiment(funded(), { experiment: 'x', amount: 10 });
    expect(result.publicationObligation).toContain('owes its findings');
  });

  it('does not take public-goods money to fund experiments', () => {
    const treasury = funded(100, 10);
    fundExperiment(treasury, { experiment: 'x', amount: 50 });
    expect(treasury.publicGoodsFund).toBe(100);
  });
});

describe('the bounded bailout', () => {
  // "A firm that can be allowed to fail is allowed to." Section 6 permits a treasury to prevent
  // systemic collapse, not to prevent failure.
  it('refuses a firm whose failure threatens nothing', () => {
    const treasury = funded();
    const result = considerBailout(treasury, { personaId: 'firm-a', shortfall: 50, systemic: false });
    expect(result.granted).toBe(false);
    expect(result.reason).toContain('allowed to fail');
  });

  it('rescues a systemic failure, in part', () => {
    const treasury = funded();
    const result = considerBailout(treasury, { personaId: 'firm-a', shortfall: 50, systemic: true });
    expect(result.granted).toBe(true);
    expect(result.amount).toBe(25);
    expect(treasury.publicGoodsFund).toBe(75);
  });

  // Never all of it: the firm still bears a loss, so the failure still means something.
  it('never covers the whole shortfall', () => {
    const result = considerBailout(funded(1000), { personaId: 'firm-a', shortfall: 100, systemic: true });
    expect(result.amount).toBeLessThan(100);
  });

  // What makes a bailout an event rather than a facility.
  it('refuses a firm it has already rescued', () => {
    const treasury = funded(1000);
    considerBailout(treasury, { personaId: 'firm-a', shortfall: 50, systemic: true });
    const second = considerBailout(treasury, { personaId: 'firm-a', shortfall: 50, systemic: true });
    expect(second.granted).toBe(false);
    expect(second.reason).toContain('rescued once already');
  });

  // "It should not rescue every failing firm. Permanent bailouts destroy market discipline."
  it('refuses a second firm once the run has spent its one rescue', () => {
    const treasury = funded(1000);
    considerBailout(treasury, { personaId: 'firm-a', shortfall: 50, systemic: true });
    const second = considerBailout(treasury, { personaId: 'firm-b', shortfall: 50, systemic: true });
    expect(second.granted).toBe(false);
    expect(second.reason).toContain('limit');
  });

  // A treasury that could print would be no constraint at all.
  it('cannot rescue with money it does not hold', () => {
    const treasury = openTreasury();
    const result = considerBailout(treasury, { personaId: 'firm-a', shortfall: 50, systemic: true });
    expect(result.granted).toBe(false);
    expect(result.reason).toContain('cannot rescue');
  });

  // The discipline is the refusing. A run that cannot show what it declined to rescue cannot show
  // it had any.
  it('records every refusal, with the ground', () => {
    const treasury = funded();
    considerBailout(treasury, { personaId: 'firm-a', shortfall: 50, systemic: false });
    considerBailout(treasury, { personaId: 'firm-b', shortfall: 50, systemic: false });
    expect(treasury.bailoutsRefused).toHaveLength(2);
    expect(treasury.bailoutsRefused[0].reason.length).toBeGreaterThan(0);
  });

  it('can be barred entirely by policy', () => {
    const policy = resolveTreasuryPolicy({ maxBailoutsPerRun: 0 });
    const result = considerBailout(funded(1000), { personaId: 'firm-a', shortfall: 50, systemic: true }, policy);
    expect(result.granted).toBe(false);
  });

  it('defaults to at most one rescue in a run', () => {
    expect(DEFAULT_TREASURY_POLICY.maxBailoutsPerRun).toBe(1);
  });
});
