import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CAPITAL_POLICY,
  applySettlement,
  claimWarranty,
  assessInsolvency,
  calibrationScore,
  domainReputation,
  eligibleForHighRisk,
  openAccount,
  recordDomainOutcome,
  resolveCapitalPolicy,
  type SettlementRecord,
} from './capital.js';
import type { CapitalAccount } from './types.js';

function settlement(over: Partial<SettlementRecord> = {}): SettlementRecord {
  return {
    taskId: 't1',
    domains: ['backend'],
    verified: true,
    profit: 30,
    quotedPrice: 100,
    actualCost: 100,
    risksDisclosedAndRealised: 0,
    externalisedObligations: 0,
    retentionWithheld: 20,
    ...over,
  };
}

describe('opening an account', () => {
  it('starts a firm at neutral, with nothing proved either way', () => {
    const account = openAccount('firm-a');
    expect(account.capital).toBe(DEFAULT_CAPITAL_POLICY.initialCapital);
    expect(account.reputationScore).toBe(DEFAULT_CAPITAL_POLICY.neutralReputation);
    expect(account.liabilities).toBe(0);
    expect(account.reputationByDomain).toEqual({});
  });
});

describe('domain-specific reputation', () => {
  // Zero would mean "known to be bad", and treating the unknown as the bad is a barrier to entry —
  // exactly what article 4 keeps open.
  it('treats a domain with no evidence as neutral, not as bad', () => {
    expect(domainReputation(openAccount('firm-a'), 'security')).toBe(0.5);
  });

  it('keeps a firm’s domains apart — a security record is not a documentation record', () => {
    const account = openAccount('firm-a');
    recordDomainOutcome(account, 'security', 0.95);
    expect(domainReputation(account, 'security')).toBeGreaterThan(0.5);
    expect(domainReputation(account, 'documentation')).toBe(0.5);
  });

  // Section 6: reputation "should decay over time". A record earned twenty settlements ago is
  // evidence about a firm that no longer exists in the same form.
  it('decays a standing record back toward neutral as settlements pass', () => {
    const account = openAccount('firm-a');
    recordDomainOutcome(account, 'backend', 1);
    const fresh = domainReputation(account, 'backend');

    account.settlements = 10;
    const stale = domainReputation(account, 'backend');

    expect(stale).toBeLessThan(fresh);
    expect(stale).toBeGreaterThan(0.5);
  });

  it('decays a bad record toward neutral too, so a firm can recover', () => {
    const account = openAccount('firm-a');
    recordDomainOutcome(account, 'backend', 0);
    const fresh = domainReputation(account, 'backend');
    account.settlements = 20;
    expect(domainReputation(account, 'backend')).toBeGreaterThan(fresh);
  });

  // Section 14 lists reputation-weighted selection as the safeguard against a race to the bottom,
  // and a score that whipsaws on the latest result cannot do that job.
  it('lets a long record resist a single bad settlement', () => {
    const seasoned = openAccount('firm-a');
    for (let i = 0; i < 10; i += 1) recordDomainOutcome(seasoned, 'backend', 0.9);
    const newcomer = openAccount('firm-b');
    recordDomainOutcome(newcomer, 'backend', 0.9);

    recordDomainOutcome(seasoned, 'backend', 0);
    recordDomainOutcome(newcomer, 'backend', 0);

    expect(domainReputation(seasoned, 'backend')).toBeGreaterThan(domainReputation(newcomer, 'backend'));
  });

  it('stays inside [0, 1] however extreme the evidence', () => {
    const account = openAccount('firm-a');
    for (let i = 0; i < 20; i += 1) recordDomainOutcome(account, 'backend', 1);
    expect(domainReputation(account, 'backend')).toBeLessThanOrEqual(1);
    for (let i = 0; i < 40; i += 1) recordDomainOutcome(account, 'backend', 0);
    expect(domainReputation(account, 'backend')).toBeGreaterThanOrEqual(0);
  });
});

describe('estimate calibration', () => {
  it('scores a quote that matched its cost highest', () => {
    expect(calibrationScore(100, 100)).toBe(1);
  });

  // Section 6 rewards "accurate estimation", not quoting high. Under an asymmetric measure the safe
  // play is always to pad, which makes every price useless.
  it('punishes padding exactly as much as underquoting', () => {
    expect(calibrationScore(100, 300)).toBeCloseTo(calibrationScore(300, 100), 6);
  });

  it('bottoms out at a large miss in either direction', () => {
    expect(calibrationScore(100, 400)).toBe(0);
    expect(calibrationScore(400, 100)).toBe(0);
  });

  it('treats a contract that promised nothing as neither accurate nor misleading', () => {
    expect(calibrationScore(0, 50)).toBe(0.5);
  });
});

describe('settling a contract against a firm', () => {
  it('moves capital by the profit and records why', () => {
    const account = openAccount('firm-a');
    const effect = applySettlement(account, settlement({ profit: 30 }));
    expect(effect.capitalAfter).toBe(130);
    expect(effect.reasons.join(' ')).toContain('profit of 30.00');
  });

  it('books a loss against capital', () => {
    const account = openAccount('firm-a');
    expect(applySettlement(account, settlement({ verified: false, profit: -40 })).capitalAfter).toBe(60);
  });

  // A firm that quoted 40 and consumed 200 may still profit on a generous contract. The market
  // should nonetheless know it cannot estimate.
  it('records a misleading estimate even on a profitable contract', () => {
    const account = openAccount('firm-a');
    const effect = applySettlement(account, settlement({ profit: 50, quotedPrice: 400, estimatedResourceCost: 40, actualCost: 200 }));
    expect(effect.capitalAfter).toBeGreaterThan(100);
    expect(effect.reasons.join(' ')).toContain('misleading estimate');
  });

  it('credits accurate estimation separately from profit', () => {
    const account = openAccount('firm-a');
    const effect = applySettlement(account, settlement({ quotedPrice: 150, estimatedResourceCost: 100, actualCost: 95 }));
    expect(effect.reasons.join(' ')).toContain('accurate estimation');
  });

  it('does not punish a margin when two firms forecast the same actual cost', () => {
    const lowMargin = openAccount('low-margin');
    const highMargin = openAccount('high-margin');
    applySettlement(lowMargin, settlement({ quotedPrice: 30, estimatedResourceCost: 25, actualCost: 25 }));
    applySettlement(highMargin, settlement({ quotedPrice: 100, estimatedResourceCost: 25, actualCost: 25 }));
    expect(lowMargin.reputationScore).toBe(highMargin.reputationScore);
  });

  // Section 6's "early risk detection": a firm that saw a problem coming and said so is worth more
  // than one that got lucky.
  it('credits a disclosed risk that materialised as warned', () => {
    const account = openAccount('firm-a');
    const effect = applySettlement(account, settlement({ risksDisclosedAndRealised: 2 }));
    expect(effect.reasons.join(' ')).toContain('early risk detection');
  });

  // "A cheap implementation is not cheap when another module pays the long-term cost." The
  // obligation sits on the firm's books rather than vanishing at settlement.
  it('books externalised obligations as liabilities against the firm', () => {
    const account = openAccount('firm-a');
    const effect = applySettlement(account, settlement({ externalisedObligations: 3 }));
    expect(effect.liabilitiesAfter).toBe(3);
    expect(effect.reasons.join(' ')).toContain('left for others to carry');
  });

  it('holds retention and releases it only after a clean warranty period', () => {
    const account = openAccount('firm-a');
    let effect = applySettlement(account, settlement({ retentionWithheld: 20 }));
    expect(effect.retentionReleased).toBe(0);
    expect(account.heldEscrow).toBe(20);

    applySettlement(account, settlement({ taskId: 't2', retentionWithheld: 20 }));
    effect = applySettlement(account, settlement({ taskId: 't3', retentionWithheld: 20 }));

    expect(effect.retentionReleased).toBe(0);
    expect(account.heldEscrow).toBe(60);
    effect = applySettlement(account, settlement({ retentionWithheld: 0 }));
    expect(effect.retentionReleased).toBe(20);
    expect(account.heldEscrow).toBe(40);
  });

  it('claims only the named contract while other warranties remain held', () => {
    const account = openAccount('firm-a');
    applySettlement(account, settlement({ taskId: 'a', warrantyPeriodTasks: 3, retentionWithheld: 5 }));
    applySettlement(account, settlement({ taskId: 'b', warrantyPeriodTasks: 3, retentionWithheld: 7 }));
    expect(claimWarranty(account, 'a')).toBe(5);
    expect(claimWarranty(account, 'a')).toBe(0);
    expect(account.heldEscrow).toBe(7);
  });

  it('claims only the latest attempt when a task has two live warranties', () => {
    const account = openAccount('firm-a');
    applySettlement(account, settlement({ taskId: 'a', attemptKey: 'a:1', artifactDigest: 'first',
      warrantyPeriodTasks: 5, retentionWithheld: 5 }));
    applySettlement(account, settlement({ taskId: 'a', attemptKey: 'a:2', artifactDigest: 'second',
      warrantyPeriodTasks: 5, retentionWithheld: 7 }));
    expect(claimWarranty(account, 'a')).toBe(7);
    expect(account.escrowLots).toMatchObject([{ attemptKey: 'a:1', artifactDigest: 'first' }]);
    expect(account.heldEscrow).toBe(5);
  });

  it('resets the clean run on a failure, so retention stays held', () => {
    const account = openAccount('firm-a');
    applySettlement(account, settlement());
    applySettlement(account, settlement({ verified: false, profit: -10 }));
    const effect = applySettlement(account, settlement());
    expect(effect.retentionReleased).toBe(0);
  });

  it('records the outcome against every domain the contract exercised', () => {
    const account = openAccount('firm-a');
    const effect = applySettlement(account, settlement({ domains: ['backend', 'testing'] }));
    expect(Object.keys(effect.domainScores).sort()).toEqual(['backend', 'testing']);
  });

  it('files a contract with no stated domain under implementation rather than nowhere', () => {
    const account = openAccount('firm-a');
    const effect = applySettlement(account, settlement({ domains: [] }));
    expect(Object.keys(effect.domainScores)).toEqual(['implementation']);
  });

  it('keeps the flat score a summary of the domain records', () => {
    const account = openAccount('firm-a');
    applySettlement(account, settlement({ domains: ['backend'], verified: true }));
    const expected = domainReputation(account, 'backend');
    expect(account.reputationScore).toBeCloseTo(expected, 6);
  });
});

describe('insolvency, which is not a punishment rule', () => {
  it('leaves a solvent firm alone', () => {
    expect(assessInsolvency(openAccount('firm-a')).insolvent).toBe(false);
  });

  it('finds a firm insolvent when its liabilities exceed its capital', () => {
    const account: CapitalAccount = { ...openAccount('firm-a'), capital: 10, liabilities: 50 };
    const result = assessInsolvency(account);
    expect(result.insolvent).toBe(true);
    expect(result.grounds).toContain('liabilities-exceed-capital');
  });

  // The ground a capital threshold alone misses: a firm can be solvent on paper and still be the
  // wrong place for the next contract.
  it('finds a firm that keeps failing insolvent even while it is solvent on paper', () => {
    const account: CapitalAccount = { ...openAccount('firm-a'), capital: 500, consecutiveFailures: 3 };
    const result = assessInsolvency(account);
    expect(result.insolvent).toBe(true);
    expect(result.grounds).toEqual(['repeated-contract-failure']);
  });

  it('transfers the work rather than punishing the firm', () => {
    const account: CapitalAccount = { ...openAccount('firm-a'), capital: 0, liabilities: 5 };
    const result = assessInsolvency(account);
    expect(result.consequences).toContain('existing contracts transfer to another firm');
    expect(result.rationale).toContain('stop scarce resources');
  });

  it('clears the failure count on a delivered contract', () => {
    const account = openAccount('firm-a');
    applySettlement(account, settlement({ verified: false, profit: -5 }));
    applySettlement(account, settlement({ verified: true }));
    expect(account.consecutiveFailures).toBe(0);
  });
});

describe('what capital lets a firm take on', () => {
  it('admits a solvent firm to high-risk work', () => {
    expect(eligibleForHighRisk(openAccount('firm-a'))).toBe(true);
  });

  it('excludes a bankrupt firm outright', () => {
    expect(eligibleForHighRisk({ ...openAccount('firm-a'), bankrupt: true })).toBe(false);
  });

  // Capital net of liabilities: a firm whose capital is entirely committed to obligations it
  // already owes has nothing left to put at risk.
  it('measures capital net of what the firm already owes', () => {
    const policy = resolveCapitalPolicy({ capitalFloorForHighRisk: 50 });
    const committed: CapitalAccount = { ...openAccount('firm-a'), capital: 100, liabilities: 80 };
    expect(eligibleForHighRisk(committed, policy)).toBe(false);
  });
});
