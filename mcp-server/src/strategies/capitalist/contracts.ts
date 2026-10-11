// Section 8's contract types, and the rule that picks one.
//
// The exchange had a single shape: fixed price, with a flat escrow fraction, whatever the work was.
// Section 8 names five and gives each a distinct risk, which is the point — the shape of a contract
// is how the parties divide uncertainty, and using one shape for everything means somebody is
// always holding risk they are not equipped to price.
//
//   Fixed price       — a fixed reward for a clearly scoped delivery.
//                       Risk: "quality may be reduced to preserve margin."
//   Time and materials— payment for verified effort and resource use.
//                       Best for uncertain investigation; risk: "weak incentive to finish".
//   Outcome           — payment depends on a measured improvement.
//                       Risk: metric gaming.
//   Tournament        — several agents attempt the same task and the strongest result wins.
//                       Risk: duplicated expenditure.
//   Warranty          — part of the reward is retained until a defect-free period passes.
//                       Best for "production changes, migrations and security-sensitive work".
//
// Each risk is answered by the terms rather than by hoping: a fixed-price contract carries a
// warranty retention precisely because margin pressure is where quality goes; time and materials
// carries a hard cap because "weak incentive to finish efficiently" is otherwise unbounded.
//
// The selection is deterministic. It decides how a firm is paid, and a payment structure that
// varied with a model's reading of the listing would be impossible to bid against — which would
// defeat the disclosure the exchange runs on, since a bidder prices the terms as much as the work.

import type { Listing } from './exchange.js';

export type ContractType = 'fixed-price' | 'time-and-materials' | 'outcome' | 'tournament' | 'warranty';

export interface ContractTerms {
  type: ContractType;
  /** Fraction of the price held back at settlement, released after the warranty period. */
  retentionFraction: number;
  /** Settlements the retention is held across. */
  warrantyPeriodTasks: number;
  /**
   * A ceiling on what the contract may consume before it is stopped, as a multiple of the price.
   * Undefined where the type does not need one.
   */
  spendCapMultiple?: number;
  /** How many firms are commissioned. Only a tournament commissions more than one. */
  competingSuppliers: number;
  /** The risk section 8 attaches to this shape, and how these terms answer it. */
  risk: string;
  rationale: string;
}

export interface ContractPolicy {
  /** Retention on an ordinary fixed-price contract. */
  baseRetention: number;
  /** Retention on security-sensitive or otherwise high-risk work. */
  warrantyRetention: number;
  /** Time and materials stops at this multiple of the quoted price. */
  timeAndMaterialsCapMultiple: number;
  /** How many firms a tournament commissions. */
  tournamentSuppliers: number;
  /** Whether tournaments may be commissioned at all — they cost real money to run. */
  tournamentsEnabled: boolean;
  /** Outcome payment requires a frozen evaluator-owned baseline, which this runtime does not yet hold. */
  outcomeContractsEnabled: boolean;
}

export const DEFAULT_CONTRACT_POLICY: ContractPolicy = {
  baseRetention: 0.2,
  warrantyRetention: 0.4,
  timeAndMaterialsCapMultiple: 2,
  tournamentSuppliers: 2,
  // Off by default. Section 8 is candid that the risk is "duplicated expenditure", and a swarm
  // running on a metered budget pays that twice over for every tournament it holds.
  tournamentsEnabled: false,
  outcomeContractsEnabled: false,
};

/** What is known about a listing at the moment the contract shape must be chosen. */
export interface SelectionInput {
  listing: Listing;
  /**
   * Whether due diligence could establish what the work actually involves. False means the baseline
   * was unreadable or the cause is unknown — which is section 8's "uncertain investigation".
   */
  scopeUnderstood: boolean;
  /** Whether any acceptance criterion is a measured quantity rather than a behaviour. */
  hasMeasurableCriterion: boolean;
  /** Whether the buyer explicitly wants competing implementations of this listing. */
  tournamentRequested: boolean;
}

/**
 * Picks the contract shape, in the order the risks bite.
 *
 * High risk goes to warranty first and unconditionally. Section 8 says warranty contracts are "best
 * for production changes, migrations and security-sensitive work", and section 10's safety floor
 * is not something a cheaper contract shape may trade away — so this is checked before anything
 * that could route security work into a shape with a lighter retention.
 *
 * Unclear scope goes to time and materials, because a fixed price on work nobody can size is a
 * fixed price on a guess: the firm either pads the quote or discovers mid-contract that finishing
 * costs more than the contract pays, and section 8's warning about quality "reduced to preserve
 * margin" is exactly what happens next.
 *
 * A measurable criterion admits an outcome contract, and everything else is fixed price — which is
 * the right default for the case the doctrine describes as "a clearly scoped delivery".
 */
export function selectContractType(
  input: SelectionInput,
  policy: ContractPolicy = DEFAULT_CONTRACT_POLICY,
): ContractTerms {
  const { listing } = input;

  if (input.tournamentRequested && policy.tournamentsEnabled) {
    return {
      type: 'tournament',
      retentionFraction: policy.baseRetention,
      warrantyPeriodTasks: listing.warrantyPeriodTasks,
      competingSuppliers: Math.max(2, policy.tournamentSuppliers),
      risk: 'Duplicated expenditure: every losing implementation is paid for in compute and produces nothing.',
      rationale:
        'The buyer asked for competing implementations, which is the one thing that makes duplicate ' +
        'production a commissioned experiment rather than a breach.',
    };
  }

  if (listing.riskClass === 'high') {
    return {
      type: 'warranty',
      retentionFraction: policy.warrantyRetention,
      // Doubled: the whole instrument is the length of time the firm stays exposed, and section 9
      // is explicit that warranties survive acceptance.
      warrantyPeriodTasks: Math.max(2, listing.warrantyPeriodTasks * 2),
      competingSuppliers: 1,
      risk: 'The firm carries exposure past acceptance, and may price that in.',
      rationale:
        'Section 8: warranty contracts are best for production changes, migrations and ' +
        'security-sensitive work. A high-risk listing takes this shape before any other, because the ' +
        'safety floor is not something a lighter contract may trade away.',
    };
  }

  if (!input.scopeUnderstood) {
    return {
      type: 'time-and-materials',
      retentionFraction: policy.baseRetention,
      warrantyPeriodTasks: listing.warrantyPeriodTasks,
      spendCapMultiple: policy.timeAndMaterialsCapMultiple,
      competingSuppliers: 1,
      risk: 'Weak incentive to finish efficiently — answered by a hard cap on what the contract may consume.',
      rationale:
        'Due diligence could not establish what the work involves. Section 8 puts uncertain ' +
        'investigation on time and materials: a fixed price on work nobody can size is a fixed price ' +
        'on a guess, and the firm pays for the guess by cutting quality to hold its margin.',
    };
  }

  if (input.hasMeasurableCriterion && policy.outcomeContractsEnabled) {
    return {
      type: 'outcome',
      retentionFraction: policy.baseRetention,
      warrantyPeriodTasks: listing.warrantyPeriodTasks,
      competingSuppliers: 1,
      risk: 'Metric gaming — answered by independent assessment against the criterion, not the firm’s own measurement.',
      rationale:
        'An acceptance criterion states a measurable improvement, so payment can depend on it. ' +
        'Section 14 names the risk directly, which is why the measurement is never the supplier’s.',
    };
  }

  return {
    type: 'fixed-price',
    retentionFraction: policy.baseRetention,
    warrantyPeriodTasks: listing.warrantyPeriodTasks,
    competingSuppliers: 1,
    risk: 'Quality may be reduced to preserve margin — answered by the retention held past settlement.',
    rationale: 'A clearly scoped delivery, which is the case section 8 gives fixed price.',
  };
}

/**
 * Whether an acceptance criterion states something measurable rather than a behaviour.
 *
 * Deliberately narrow: it looks for a comparative quantity, not merely for a number. "Returns 200"
 * contains a number and is a behaviour; "reduces latency by 20%" is an outcome. Reading the first
 * as an outcome contract would put payment on a metric that was never a target, which is how metric
 * gaming starts — the firm optimises the number somebody happened to write down.
 */
export function hasMeasurableCriterion(criteria: readonly string[]): boolean {
  // Stems rather than whole words, so "reduces" and "reduced" count alongside "reduce". The digit
  // must follow the comparison within the same sentence — that is what separates a target from a
  // number that merely appears in a behaviour.
  const measurable =
    /\b(reduc\w*|increas\w*|improv\w*|decreas\w*|faster|slower|fewer|more than|less than|under|below|above|at least|at most|no more than|within)\b[^.]*?\d/i;
  return criteria.some((c) => measurable.test(c));
}

/**
 * What is actually withheld at settlement.
 *
 * Kept separate from the escrow fraction the run was configured with so the contract shape decides
 * it — which is the whole point of having shapes. A high-risk warranty contract withholds twice
 * what a routine fixed-price one does, because that is what the shape is for.
 */
export function retentionFor(terms: ContractTerms, price: number): number {
  return Math.max(0, price) * Math.min(1, Math.max(0, terms.retentionFraction));
}

/**
 * Whether a time-and-materials contract has consumed past its cap.
 *
 * Section 8's stated risk for this shape is a weak incentive to finish, and a cap is the only term
 * that answers it. Shapes without a cap always return false rather than pretending to a limit they
 * do not have.
 */
export function overSpendCap(terms: ContractTerms, price: number, consumed: number): boolean {
  if (terms.spendCapMultiple === undefined || price <= 0) return false;
  return consumed > price * terms.spendCapMultiple;
}

/** The supplier's clock stops on delivery, before buyer-controlled review and settlement. */
export function deliveryMissedDeadline(awardedAtMs: number | undefined, deliveredAtMs: number | undefined,
  deadlineMinutes: number | undefined): boolean {
  return awardedAtMs !== undefined && deliveredAtMs !== undefined && deadlineMinutes !== undefined &&
    Number.isFinite(deadlineMinutes) && deadlineMinutes > 0 &&
    deliveredAtMs - awardedAtMs > deadlineMinutes * 60_000;
}

/** Time and materials bills verified resource use at a published 10% coordination margin, bounded
 * by the agreed ceiling. Other shapes keep the quoted reward and still require acceptance. */
export function payableRevenue(terms: ContractTerms | undefined, quotedPrice: number, consumed: number): number {
  if (terms?.type !== 'time-and-materials') return Math.max(0, quotedPrice);
  const cap = Math.max(0, quotedPrice * (terms.spendCapMultiple ?? 1));
  return Math.round(Math.min(cap, Math.max(0, consumed) * 1.1) * 100) / 100;
}

export function resolveContractPolicy(raw: Partial<ContractPolicy> | undefined): ContractPolicy {
  if (raw?.outcomeContractsEnabled || raw?.tournamentsEnabled) {
    throw new Error('Outcome and tournament contracts require evaluator baselines or isolated candidate worktrees and are unavailable in this runtime.');
  }
  return { ...DEFAULT_CONTRACT_POLICY, ...(raw ?? {}) };
}
