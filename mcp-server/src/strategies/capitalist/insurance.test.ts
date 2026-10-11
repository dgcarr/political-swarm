import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INSURANCE_POLICY,
  collectPremium,
  insuranceRequired,
  openReserve,
  payClaim,
  premiumFor,
  resolveInsurancePolicy,
  type PremiumFactors,
} from './insurance.js';

function factors(over: Partial<PremiumFactors> = {}): PremiumFactors {
  return {
    defectRate: 0,
    hasTests: true,
    filesInScope: 2,
    dependants: 0,
    irreversible: false,
    confidence: 1,
    hasRollbackPlan: true,
    ...over,
  };
}

describe('what a premium is made of', () => {
  // Section 6 names six things premiums rise with, plus the risk class itself. A factor missing from
  // the table is a risk the market is not pricing.
  it('prices every factor section 6 names', () => {
    const premium = premiumFor(100, 'low', factors());
    expect(premium.lines.map((l) => l.factor)).toEqual([
      'risk class',
      'poor history',
      'weak test coverage',
      'blast radius',
      'irreversible change',
      'uncertainty',
      'inadequate rollback plan',
    ]);
  });

  // A premium a firm cannot see the derivation of is a tax, not a price — and it is charged against
  // the firm's capital before it has done anything wrong.
  it('shows the basis of every line', () => {
    for (const line of premiumFor(100, 'high', factors()).lines) {
      expect(line.basis.trim().length, line.factor).toBeGreaterThan(0);
    }
  });

  it('charges the base rate when nothing about the contract raises it', () => {
    const premium = premiumFor(100, 'low', factors({ filesInScope: 0 }));
    expect(premium.amount).toBeCloseTo(100 * DEFAULT_INSURANCE_POLICY.basePremiumFraction, 2);
    expect(premium.rationale).toContain('Nothing about this contract raises it');
  });

  // Blast radius is continuous rather than a threshold: a contract touching two files really is a
  // slightly larger exposure than one touching none, and pretending otherwise would put a step in
  // the price where there is none in the risk.
  it('scales blast radius from the first file rather than from a threshold', () => {
    const untouched = premiumFor(100, 'low', factors({ filesInScope: 0 })).amount;
    const small = premiumFor(100, 'low', factors({ filesInScope: 2 })).amount;
    const large = premiumFor(100, 'low', factors({ filesInScope: 12 })).amount;
    expect(small).toBeGreaterThan(untouched);
    expect(large).toBeGreaterThan(small);
  });

  it('charges more for a riskier class', () => {
    const low = premiumFor(100, 'low', factors()).amount;
    const high = premiumFor(100, 'high', factors()).amount;
    expect(high).toBeGreaterThan(low);
  });

  it.each([
    ['poor history', { defectRate: 0.8 }],
    ['weak test coverage', { hasTests: false }],
    ['blast radius', { filesInScope: 30, dependants: 5 }],
    ['irreversible change', { irreversible: true }],
    ['uncertainty', { confidence: 0.1 }],
    ['inadequate rollback plan', { hasRollbackPlan: false }],
  ])('raises the premium for %s', (_label, over) => {
    const clean = premiumFor(100, 'medium', factors()).amount;
    const raised = premiumFor(100, 'medium', factors(over as Partial<PremiumFactors>)).amount;
    expect(raised).toBeGreaterThan(clean);
  });

  // The mitigations are worth having because they are cheaper than the premium, not because they
  // buy a discount below cost. Nothing lowers the premium under its base rate.
  it('never discounts below the base rate for the risk class', () => {
    const base = premiumFor(100, 'medium', factors()).amount;
    const everythingRight = premiumFor(100, 'medium', factors({ confidence: 1, defectRate: 0 })).amount;
    expect(everythingRight).toBeGreaterThanOrEqual(base);
  });

  // An uninsurable premium is a refusal to let the work at all, and that decision belongs to the
  // buyer and the regulator rather than to an actuarial table.
  it('caps the premium so insurance cannot swallow the contract', () => {
    const worst = premiumFor(
      100,
      'high',
      factors({ defectRate: 1, hasTests: false, filesInScope: 200, dependants: 50, irreversible: true, confidence: 0, hasRollbackPlan: false }),
    );
    expect(worst.amount).toBeLessThanOrEqual(100 * DEFAULT_INSURANCE_POLICY.maxPremiumFraction);
  });

  it('names what raised the premium, not just the number', () => {
    const premium = premiumFor(100, 'medium', factors({ irreversible: true, hasTests: false }));
    expect(premium.rationale).toContain('irreversible change');
    expect(premium.rationale).toContain('weak test coverage');
  });

  it('charges nothing on a contract worth nothing', () => {
    expect(premiumFor(0, 'high', factors()).amount).toBe(0);
  });
});

describe('when cover is required', () => {
  it('requires it for high-risk work', () => {
    expect(insuranceRequired('high')).toBe(true);
    expect(insuranceRequired('low')).toBe(false);
  });

  it('can be widened by policy', () => {
    const policy = resolveInsurancePolicy({ requiredAtRisk: ['medium', 'high'] });
    expect(insuranceRequired('medium', policy)).toBe(true);
  });
});

describe('the pooled reserve', () => {
  it('starts empty and holds only what premiums put in', () => {
    const reserve = openReserve();
    expect(reserve.balance).toBe(0);
    collectPremium(reserve, 30);
    collectPremium(reserve, 20);
    expect(reserve.balance).toBe(50);
    expect(reserve.premiumsCollected).toBe(50);
  });

  it('pays a covered claim toward repair', () => {
    const reserve = openReserve();
    collectPremium(reserve, 100);
    const result = payClaim(reserve, { taskId: 't1', personaId: 'firm-a', amount: 40 });
    expect(result.paid).toBe(30); // 40 less the 25% deductible
    expect(reserve.balance).toBe(70);
  });

  // Section 14's answer to moral hazard. A claim that made a firm whole would make risky work free
  // at the point of failure, which is the behaviour the instrument exists to discourage.
  it('always leaves the firm bearing a deductible', () => {
    const reserve = openReserve();
    collectPremium(reserve, 1000);
    const result = payClaim(reserve, { taskId: 't1', personaId: 'firm-a', amount: 100 });
    expect(result.deductible).toBeGreaterThan(0);
    expect(result.paid).toBeLessThan(100);
  });

  // The pool holds only what premiums put into it. A run whose risks all materialise cannot pay for
  // all of them, and an uncovered loss nobody records is the externalised risk this exists to price.
  it('runs dry rather than paying money it never collected, and says so', () => {
    const reserve = openReserve();
    collectPremium(reserve, 10);
    const result = payClaim(reserve, { taskId: 't1', personaId: 'firm-a', amount: 100 });
    expect(result.paid).toBe(10);
    expect(result.shortfall).toBe(65); // 75 coverable, 10 available
    expect(reserve.balance).toBe(0);
    expect(result.rationale).toContain('uncovered');
  });

  it('never pays a negative claim or drives the balance below zero', () => {
    const reserve = openReserve();
    const result = payClaim(reserve, { taskId: 't1', personaId: 'firm-a', amount: -50 });
    expect(result.paid).toBe(0);
    expect(reserve.balance).toBe(0);
  });

  it('keeps every claim on the record, paid or not', () => {
    const reserve = openReserve();
    payClaim(reserve, { taskId: 't1', personaId: 'firm-a', amount: 40 });
    expect(reserve.claims).toHaveLength(1);
    expect(reserve.claims[0]).toMatchObject({ taskId: 't1', personaId: 'firm-a', requested: 40 });
  });
});
