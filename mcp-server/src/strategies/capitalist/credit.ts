// Section 6's Credit and Banking.
//
// "Agents may borrow resources against expected future earnings. Credit can support large refactors,
// infrastructure investment and exploratory research." Without it a firm can only ever take work it
// could already fund from retained capital, which quietly makes the exchange an auction among
// whoever happens to be richest — and on a run where capital only accumulates, that is whoever won
// first. Credit is what lets a firm's *record* rather than its balance decide what it can take on.
//
// Section 6 also names the danger in the same breath, and it is the sharper half: "Unchecked
// leverage is dangerous because agents can consume shared compute while shifting losses to the
// repository." That is not a metaphor here. A firm borrowing against future earnings spends real
// metered tokens now; if it then fails, the tokens are gone and the loss lands on the run's budget
// rather than on the firm. So the ceiling is not a per-firm limit alone — it is a cap on total
// outstanding credit against what actually backs it, which is the one control that stops the market
// as a whole writing cheques the repository has to cover.
//
// Deterministic, and the limit is computed from the six things section 6 lists rather than from a
// single number. A credit limit a firm cannot predict is a credit limit it cannot plan around,
// which is the opposite of what the instrument is for.

import type { RiskClass } from '../../engine/types.js';
import { calibrationScore } from './capital.js';
import type { CapitalAccount } from './types.js';

export interface CreditPolicy {
  /** A firm with a neutral record may borrow this fraction of its own capital. */
  baseLimitFraction: number;
  /** Settlements a firm must have behind it before it may borrow at all. */
  minSettlementsForCredit: number;
  /** The limit is scaled down for riskier work. */
  riskDiscount: Record<RiskClass, number>;
  /**
   * Total outstanding credit may not exceed this multiple of what backs it. Section 6's "unchecked
   * leverage": past this point the market is spending compute it cannot cover.
   */
  maxSystemLeverage: number;
}

export const DEFAULT_CREDIT_POLICY: CreditPolicy = {
  baseLimitFraction: 0.5,
  // A firm with no record has no expected future earnings to borrow against. Lending to it would be
  // lending against nothing, which is where the losses that land on the repository come from.
  minSettlementsForCredit: 1,
  riskDiscount: { low: 1, medium: 0.75, high: 0.5 },
  maxSystemLeverage: 1,
};

export interface CreditLine {
  factor: string;
  basis: string;
  multiplier: number;
}

export interface CreditAssessment {
  limit: number;
  lines: CreditLine[];
  rationale: string;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function clamp01(n: number): number {
  if (Number.isNaN(n) || !Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/**
 * What a firm may borrow, from the six things section 6 says credit limits should depend on:
 * delivery history, estimate calibration, current liabilities, defect history, project risk, and
 * reusable assets offered as collateral.
 *
 * Liabilities are subtracted from the borrowing base rather than merely scaling it. A firm whose
 * capital is already committed to obligations it owes is not a firm with capital; treating those
 * obligations as a discount rather than a deduction is how a balance sheet comes to show borrowing
 * capacity that does not exist.
 */
export function creditLimit(
  account: CapitalAccount,
  context: { projectRisk: RiskClass; collateral?: number },
  policy: CreditPolicy = DEFAULT_CREDIT_POLICY,
): CreditAssessment {
  const settlements = account.settlements ?? 0;
  if (settlements < policy.minSettlementsForCredit) {
    return {
      limit: 0,
      lines: [],
      rationale:
        `${account.personaId} has ${settlements} settlement(s) behind it and may not borrow yet. ` +
        'Credit is lent against expected future earnings, and a firm with no record has none to lend against.',
    };
  }
  if (account.bankrupt) {
    return { limit: 0, lines: [], rationale: `${account.personaId} is insolvent and may not borrow.` };
  }

  // The borrowing base: capital genuinely free, plus whatever collateral is pledged.
  const free = Math.max(0, account.capital - (account.liabilities ?? 0));
  const collateral = Math.max(0, context.collateral ?? 0);
  const base = free + collateral;

  const deliveryRate = settlements > 0 ? clamp01((settlements - account.defects) / settlements) : 0;
  const defectRate = settlements > 0 ? clamp01(account.defects / settlements) : 0;

  const lines: CreditLine[] = [
    {
      factor: 'delivery history',
      basis: `${settlements - account.defects} of ${settlements} contract(s) delivered`,
      multiplier: 0.5 + deliveryRate,
    },
    {
      factor: 'estimate calibration',
      basis: `standing of ${account.reputationScore.toFixed(2)} across this firm's domains`,
      multiplier: 0.5 + clamp01(account.reputationScore),
    },
    {
      factor: 'defect history',
      basis: `${account.defects} defect(s) on record`,
      multiplier: 1 - 0.5 * defectRate,
    },
    {
      factor: 'project risk',
      basis: `borrowing against ${context.projectRisk}-risk work`,
      multiplier: policy.riskDiscount[context.projectRisk] ?? 1,
    },
    {
      factor: 'collateral',
      basis: collateral > 0 ? `${collateral.toFixed(2)} in reusable assets pledged` : 'nothing pledged',
      multiplier: 1,
    },
  ];

  const combined = lines.reduce((product, line) => product * line.multiplier, policy.baseLimitFraction);
  const limit = round(base * combined);

  return {
    limit,
    lines,
    rationale:
      `${account.personaId} may borrow up to ${limit.toFixed(2)} against a base of ${base.toFixed(2)} ` +
      `(capital ${account.capital.toFixed(2)} less liabilities ${(account.liabilities ?? 0).toFixed(2)}` +
      `${collateral > 0 ? `, plus ${collateral.toFixed(2)} pledged` : ''}).`,
  };
}

// ------------------------------------------------------------------ the book

export interface CreditBook {
  /** personaId -> outstanding principal. */
  outstanding: Record<string, number>;
  totalDrawn: number;
  totalRepaid: number;
  /** Draws that were refused, and why. A refusal is market information too. */
  refusals: Array<{ personaId: string; requested: number; reason: string }>;
}

export function openCreditBook(): CreditBook {
  return { outstanding: {}, totalDrawn: 0, totalRepaid: 0, refusals: [] };
}

export function outstandingCredit(book: CreditBook): number {
  return round(Object.values(book.outstanding).reduce((sum, n) => sum + n, 0));
}

export interface DrawResult {
  drawn: number;
  refused: number;
  reason?: string;
}

/**
 * Draws against a firm's limit, subject to the system-wide leverage ceiling.
 *
 * Two ceilings, and the second is the one that matters. A per-firm limit stops any one firm
 * overextending; it does nothing about every firm borrowing prudently at once and the market as a
 * whole spending compute nothing backs. Section 6's warning is specifically about that: agents
 * "consume shared compute while shifting losses to the repository". `backing` is what actually
 * stands behind the book — the treasury and the insurance reserve — and past its multiple the loan
 * is refused however good the borrower is.
 */
export function drawCredit(
  book: CreditBook,
  personaId: string,
  amount: number,
  limit: number,
  backing: number,
  policy: CreditPolicy = DEFAULT_CREDIT_POLICY,
): DrawResult {
  const requested = Math.max(0, amount);
  if (requested === 0) return { drawn: 0, refused: 0 };

  const already = book.outstanding[personaId] ?? 0;
  const headroom = Math.max(0, limit - already);
  if (headroom === 0) {
    const reason = `${personaId} is already drawn to its limit of ${limit.toFixed(2)}.`;
    book.refusals.push({ personaId, requested, reason });
    return { drawn: 0, refused: requested, reason };
  }

  const systemCeiling = Math.max(0, backing) * policy.maxSystemLeverage;
  const systemHeadroom = Math.max(0, systemCeiling - outstandingCredit(book));
  const drawn = round(Math.min(requested, headroom, systemHeadroom));

  if (drawn <= 0) {
    const reason =
      `Refused: total outstanding credit of ${outstandingCredit(book).toFixed(2)} is at the leverage ceiling of ` +
      `${systemCeiling.toFixed(2)}. Lending further would spend compute the market cannot cover, and the loss ` +
      'would land on the repository rather than on any firm.';
    book.refusals.push({ personaId, requested, reason });
    return { drawn: 0, refused: requested, reason };
  }

  book.outstanding[personaId] = round(already + drawn);
  book.totalDrawn = round(book.totalDrawn + drawn);

  const refused = round(requested - drawn);
  return {
    drawn,
    refused,
    reason:
      refused > 0
        ? `${personaId} drew ${drawn.toFixed(2)} of ${requested.toFixed(2)}; the rest exceeds its limit or the ` +
          'market-wide leverage ceiling.'
        : undefined,
  };
}

/** Repays principal. Repaying more than is owed clears the debt rather than creating a balance. */
export function repayCredit(book: CreditBook, personaId: string, amount: number): number {
  const owed = book.outstanding[personaId] ?? 0;
  const repaid = round(Math.min(Math.max(0, amount), owed));
  const remaining = round(owed - repaid);

  if (remaining === 0) delete book.outstanding[personaId];
  else book.outstanding[personaId] = remaining;

  book.totalRepaid = round(book.totalRepaid + repaid);
  return repaid;
}

/** Whether the book as a whole has passed what backs it. */
export function overLeveraged(book: CreditBook, backing: number, policy: CreditPolicy = DEFAULT_CREDIT_POLICY): boolean {
  return outstandingCredit(book) > Math.max(0, backing) * policy.maxSystemLeverage;
}

export function resolveCreditPolicy(raw: Partial<CreditPolicy> | undefined): CreditPolicy {
  return {
    ...DEFAULT_CREDIT_POLICY,
    ...(raw ?? {}),
    riskDiscount: { ...DEFAULT_CREDIT_POLICY.riskDiscount, ...(raw?.riskDiscount ?? {}) },
  };
}

/** Re-exported so callers assessing a limit and a settlement use the same calibration measure. */
export { calibrationScore };
