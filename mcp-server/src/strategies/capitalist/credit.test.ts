import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CREDIT_POLICY,
  creditLimit,
  drawCredit,
  openCreditBook,
  outstandingCredit,
  overLeveraged,
  repayCredit,
  resolveCreditPolicy,
} from './credit.js';
import { openAccount } from './capital.js';
import type { CapitalAccount } from './types.js';

function established(over: Partial<CapitalAccount> = {}): CapitalAccount {
  return { ...openAccount('firm-a'), settlements: 5, defects: 0, reputationScore: 0.7, ...over };
}

describe('what a firm may borrow', () => {
  // Credit is lent against expected future earnings. A firm with no record has none to lend
  // against, and lending to it is where the losses that land on the repository come from.
  it('lends nothing to a firm with no record', () => {
    const assessment = creditLimit(openAccount('firm-a'), { projectRisk: 'low' });
    expect(assessment.limit).toBe(0);
    expect(assessment.rationale).toContain('no record');
  });

  it('lends nothing to an insolvent firm', () => {
    expect(creditLimit(established({ bankrupt: true }), { projectRisk: 'low' }).limit).toBe(0);
  });

  it('lends to a firm with a delivery record', () => {
    expect(creditLimit(established(), { projectRisk: 'low' }).limit).toBeGreaterThan(0);
  });

  it('prices every factor section 6 lists', () => {
    const assessment = creditLimit(established(), { projectRisk: 'low' });
    expect(assessment.lines.map((l) => l.factor)).toEqual([
      'delivery history',
      'estimate calibration',
      'defect history',
      'project risk',
      'collateral',
    ]);
  });

  it('lends less to a firm with defects on its record', () => {
    const clean = creditLimit(established({ defects: 0 }), { projectRisk: 'low' }).limit;
    const defective = creditLimit(established({ defects: 3 }), { projectRisk: 'low' }).limit;
    expect(defective).toBeLessThan(clean);
  });

  it('lends less against riskier work', () => {
    const low = creditLimit(established(), { projectRisk: 'low' }).limit;
    const high = creditLimit(established(), { projectRisk: 'high' }).limit;
    expect(high).toBeLessThan(low);
  });

  it('lends more against pledged collateral', () => {
    const unsecured = creditLimit(established(), { projectRisk: 'low' }).limit;
    const secured = creditLimit(established(), { projectRisk: 'low', collateral: 100 }).limit;
    expect(secured).toBeGreaterThan(unsecured);
  });

  // A firm whose capital is already committed to obligations it owes is not a firm with capital.
  // Treating liabilities as a discount rather than a deduction is how a balance sheet comes to show
  // borrowing capacity that does not exist.
  it('deducts liabilities from the borrowing base rather than discounting it', () => {
    const unencumbered = creditLimit(established({ capital: 100, liabilities: 0 }), { projectRisk: 'low' }).limit;
    const encumbered = creditLimit(established({ capital: 100, liabilities: 90 }), { projectRisk: 'low' }).limit;
    expect(encumbered).toBeLessThan(unencumbered * 0.2);
  });

  it('lends nothing to a firm whose liabilities exceed its capital', () => {
    expect(creditLimit(established({ capital: 10, liabilities: 50 }), { projectRisk: 'low' }).limit).toBe(0);
  });

  it('says what the limit was computed from', () => {
    const assessment = creditLimit(established({ capital: 100, liabilities: 20 }), { projectRisk: 'low' });
    expect(assessment.rationale).toContain('capital 100.00');
    expect(assessment.rationale).toContain('liabilities 20.00');
  });
});

describe('drawing against the book', () => {
  const BACKING = 1000;

  it('draws what was asked when there is headroom', () => {
    const book = openCreditBook();
    const result = drawCredit(book, 'firm-a', 40, 100, BACKING);
    expect(result.drawn).toBe(40);
    expect(book.outstanding['firm-a']).toBe(40);
    expect(outstandingCredit(book)).toBe(40);
  });

  it('draws only up to the firm’s own limit', () => {
    const book = openCreditBook();
    const result = drawCredit(book, 'firm-a', 200, 100, BACKING);
    expect(result.drawn).toBe(100);
    expect(result.refused).toBe(100);
  });

  it('refuses a firm already drawn to its limit', () => {
    const book = openCreditBook();
    drawCredit(book, 'firm-a', 100, 100, BACKING);
    const result = drawCredit(book, 'firm-a', 10, 100, BACKING);
    expect(result.drawn).toBe(0);
    expect(result.reason).toContain('already drawn to its limit');
  });

  // Section 6's actual warning. A per-firm limit stops any one firm overextending; it does nothing
  // about every firm borrowing prudently at once while the market spends compute nothing backs.
  it('refuses a prudent loan when the market as a whole is at its leverage ceiling', () => {
    const book = openCreditBook();
    drawCredit(book, 'firm-a', 100, 100, 100);
    const result = drawCredit(book, 'firm-b', 50, 100, 100);
    expect(result.drawn).toBe(0);
    expect(result.reason).toContain('leverage ceiling');
    expect(result.reason).toContain('land on the repository');
  });

  it('lends up to the ceiling and no further', () => {
    const book = openCreditBook();
    const result = drawCredit(book, 'firm-a', 200, 200, 120);
    expect(result.drawn).toBe(120);
    expect(overLeveraged(book, 120)).toBe(false);
  });

  it('lends nothing at all when nothing backs the book', () => {
    const book = openCreditBook();
    expect(drawCredit(book, 'firm-a', 50, 100, 0).drawn).toBe(0);
  });

  // A refusal is market information: it says the market could not fund work somebody was willing
  // to do, which is exactly what a report of the run should carry.
  it('keeps refusals on the record', () => {
    const book = openCreditBook();
    drawCredit(book, 'firm-a', 50, 100, 0);
    expect(book.refusals).toHaveLength(1);
    expect(book.refusals[0]).toMatchObject({ personaId: 'firm-a', requested: 50 });
  });

  it('treats a zero draw as a no-op rather than a refusal', () => {
    const book = openCreditBook();
    expect(drawCredit(book, 'firm-a', 0, 100, BACKING)).toEqual({ drawn: 0, refused: 0 });
    expect(book.refusals).toEqual([]);
  });
});

describe('repaying', () => {
  it('clears principal and leaves nothing owed', () => {
    const book = openCreditBook();
    drawCredit(book, 'firm-a', 60, 100, 1000);
    expect(repayCredit(book, 'firm-a', 60)).toBe(60);
    expect(book.outstanding['firm-a']).toBeUndefined();
    expect(outstandingCredit(book)).toBe(0);
  });

  it('repays part of a debt without clearing it', () => {
    const book = openCreditBook();
    drawCredit(book, 'firm-a', 60, 100, 1000);
    repayCredit(book, 'firm-a', 20);
    expect(book.outstanding['firm-a']).toBe(40);
  });

  // Overpaying should clear the debt, not turn the book into a place a firm keeps a balance.
  it('cannot repay more than is owed', () => {
    const book = openCreditBook();
    drawCredit(book, 'firm-a', 30, 100, 1000);
    expect(repayCredit(book, 'firm-a', 500)).toBe(30);
    expect(outstandingCredit(book)).toBe(0);
  });

  it('shrugs at a repayment from a firm that never borrowed', () => {
    const book = openCreditBook();
    expect(repayCredit(book, 'firm-z', 10)).toBe(0);
  });
});

describe('the leverage ceiling itself', () => {
  it('can be tightened by policy', () => {
    const policy = resolveCreditPolicy({ maxSystemLeverage: 0.5 });
    const book = openCreditBook();
    expect(drawCredit(book, 'firm-a', 100, 100, 100, policy).drawn).toBe(50);
  });

  it('defaults to lending no more than what backs it', () => {
    expect(DEFAULT_CREDIT_POLICY.maxSystemLeverage).toBe(1);
  });
});
