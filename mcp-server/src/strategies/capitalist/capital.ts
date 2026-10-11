// Section 6's Capital Accounts, section 6's Reputation and Disclosure, and section 11's Bankruptcy
// and Exit.
//
// What existed was a single number per persona plus a scalar `reputationScore` nudged by ±0.05 on
// every settlement. Three things about the doctrine were missing from it.
//
// Capital was moved by the contract price alone, so none of section 6's actual list of what earns
// and loses capital was represented — accurate estimation, early risk detection and reusable
// components on one side; misleading bids, budget overruns and externalised maintenance on the
// other. A firm that quoted well and one that quoted wildly ended a clean run identically.
//
// Reputation was one number for everything. Section 6 is explicit that it "should be domain-specific
// and decay over time", and both halves matter: a firm with an excellent security record is not
// thereby a good documentation supplier, and a record earned twenty settlements ago is evidence
// about a different firm than the one bidding now. A single undecaying score is how an incumbent
// coasts, which is the market power section 6 warns about under monopoly.
//
// And insolvency was `capital < threshold`. Section 11 defines it as liabilities exceeding capital
// *or* repeated contract failure, and is clear about why it exists: "The purpose is not punishment.
// It is to stop scarce resources remaining trapped in failing organisations." A firm can be solvent
// on paper and still be the wrong place for the next contract.
//
// All deterministic. This decides who may bid on what, which is the market's entry rule, and
// article 4 keeps entry open — an entry rule a bidder cannot predict is a barrier nobody published.

import type { CapitalAccount, DomainReputation } from './types.js';

export interface CapitalPolicy {
  initialCapital: number;
  /** Reputation starts here, and decays back toward it. */
  neutralReputation: number;
  /** Fraction of the distance to neutral that a domain's score loses per intervening settlement. */
  reputationDecayPerSettlement: number;
  /** Consecutive failed contracts that constitute repeated failure under section 11. */
  consecutiveFailuresForInsolvency: number;
  /** Capital below which a firm may not take high-risk work, whatever its reputation. */
  capitalFloorForHighRisk: number;
  /** Settlements a firm must complete cleanly before withheld retention is released. */
  retentionReleaseAfterCleanTasks: number;
}

export const DEFAULT_CAPITAL_POLICY: CapitalPolicy = {
  initialCapital: 100,
  neutralReputation: 0.5,
  reputationDecayPerSettlement: 0.1,
  consecutiveFailuresForInsolvency: 3,
  capitalFloorForHighRisk: 0,
  retentionReleaseAfterCleanTasks: 3,
};

export function openAccount(personaId: string, policy: CapitalPolicy = DEFAULT_CAPITAL_POLICY): CapitalAccount {
  return {
    personaId,
    capital: policy.initialCapital,
    reputationScore: policy.neutralReputation,
    defects: 0,
    cleanTasksInARow: 0,
    heldEscrow: 0,
    bankrupt: false,
    reputationByDomain: {},
    liabilities: 0,
    consecutiveFailures: 0,
    settlements: 0,
  };
}

function clamp01(n: number): number {
  if (Number.isNaN(n) || !Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

// ------------------------------------------------------------------ reputation

/**
 * A domain's reputation as it stands now, with decay applied.
 *
 * Section 6: "Reputation should be domain-specific and decay over time." Decay is applied at read
 * rather than written on a schedule, because there is no clock in a run — settlements are the only
 * thing that passes. A score earned ten settlements ago has drifted most of the way back to neutral
 * by the time it is read, which is the point: it is evidence about a firm that no longer exists in
 * the same form, and letting it stand undecayed is how an early success becomes a permanent
 * advantage.
 *
 * A domain nobody has evidence about returns neutral rather than zero. Zero would mean "known to be
 * bad", and treating the unknown as the bad is a barrier to entry — precisely what article 4 keeps
 * open.
 */
export function domainReputation(
  account: CapitalAccount,
  domain: string,
  policy: CapitalPolicy = DEFAULT_CAPITAL_POLICY,
): number {
  const record = account.reputationByDomain?.[domain];
  if (!record || record.samples === 0) return policy.neutralReputation;

  const elapsed = Math.max(0, (account.settlements ?? 0) - record.lastUpdatedAtSettlement);
  const retained = Math.pow(1 - clamp01(policy.reputationDecayPerSettlement), elapsed);
  const drift = (record.score - policy.neutralReputation) * retained;
  return clamp01(policy.neutralReputation + drift);
}

/**
 * Records evidence about a firm in one domain.
 *
 * Weighted by how much evidence there already is, so a single settlement cannot swing a long record
 * and an early one is not treated as definitive. That asymmetry is deliberate: section 14 lists
 * reputation-weighted selection as the safeguard against a race to the bottom, and a reputation
 * that whipsaws on the latest result cannot do that job.
 */
export function recordDomainOutcome(
  account: CapitalAccount,
  domain: string,
  outcome: number,
  policy: CapitalPolicy = DEFAULT_CAPITAL_POLICY,
): DomainReputation {
  if (!account.reputationByDomain) account.reputationByDomain = {};
  const current = account.reputationByDomain[domain];
  const settlements = account.settlements ?? 0;

  if (!current || current.samples === 0) {
    const record = { domain, score: clamp01(outcome), samples: 1, lastUpdatedAtSettlement: settlements };
    account.reputationByDomain[domain] = record;
    return record;
  }

  // Decayed first: new evidence is weighed against what the old evidence is still worth, not
  // against what it was worth when it was fresh.
  const standing = domainReputation(account, domain, policy);
  const weight = 1 / (current.samples + 1);
  const record = {
    domain,
    score: clamp01(standing * (1 - weight) + clamp01(outcome) * weight),
    samples: current.samples + 1,
    lastUpdatedAtSettlement: settlements,
  };
  account.reputationByDomain[domain] = record;
  return record;
}

// ---------------------------------------------------------- what settles a firm

/** Section 6's two lists, as the things a settlement can actually establish about a firm. */
export interface SettlementRecord {
  taskId: string;
  /** The domains this contract exercised, from the listing's required capabilities. */
  domains: readonly string[];
  verified: boolean;
  /** Profit, already net of resources and liabilities. */
  profit: number;
  /** What the bid quoted against what it consumed, for section 6's "accurate estimation". */
  quotedPrice: number;
  successProbability?: number;
  estimatedResourceCost?: number;
  warrantyPeriodTasks?: number;
  attemptKey?: string;
  artifactDigest?: string;
  actualCost: number;
  /** Risks the bid disclosed that then materialised — section 6's "early risk detection". */
  risksDisclosedAndRealised: number;
  /** Obligations the contract leaves for somebody else to carry. */
  externalisedObligations: number;
  /** Retention withheld against the warranty. */
  retentionWithheld: number;
  /** Why an unverified contract failed, when it was not acceptance — e.g. a missed deadline. */
  failureReason?: string;
}

export interface SettlementEffect {
  capitalAfter: number;
  liabilitiesAfter: number;
  reputationAfter: number;
  domainScores: Record<string, number>;
  /** Every reason capital moved, in section 6's own vocabulary. */
  reasons: string[];
  retentionReleased: number;
}

/**
 * Applies one settlement to a firm's account.
 *
 * Profit is already section 8's arithmetic and moves capital directly. What this adds is section
 * 6's two lists — the things that should bear on a firm's standing but are not in the profit
 * number. Estimate calibration is the clearest case: a firm that quoted 40 and consumed 200 may
 * still have turned a profit on a generous contract, and the market should nonetheless know it
 * cannot estimate.
 */
export function applySettlement(
  account: CapitalAccount,
  record: SettlementRecord,
  policy: CapitalPolicy = DEFAULT_CAPITAL_POLICY,
): SettlementEffect {
  const reasons: string[] = [];
  if (!account.escrowLots && account.heldEscrow > 0) {
    account.escrowLots = [{
      taskId: 'legacy-unattributed',
      amount: account.heldEscrow,
      maturesAfterSettlement: (account.settlements ?? 0) + Math.max(1, policy.retentionReleaseAfterCleanTasks - account.cleanTasksInARow),
      claimed: false,
    }];
  }
  account.settlements = (account.settlements ?? 0) + 1;
  account.capital = round(account.capital + record.profit);
  reasons.push(
    record.profit >= 0
      ? `profit of ${record.profit.toFixed(2)} on a delivered contract`
      : `loss of ${Math.abs(record.profit).toFixed(2)}`,
  );

  // Cost forecasts are distinct from selling prices: a legitimate margin is not a forecasting error.
  const estimatedCost = record.estimatedResourceCost;
  const calibration = estimatedCost === undefined ? 0.5 : calibrationScore(estimatedCost, record.actualCost);
  if (estimatedCost !== undefined) {
    reasons.push(
      calibration >= 0.7
        ? `accurate estimation (forecast ${estimatedCost.toFixed(2)}, consumed ${record.actualCost.toFixed(2)})`
        : `misleading estimate (forecast ${estimatedCost.toFixed(2)}, consumed ${record.actualCost.toFixed(2)})`,
    );
  }

  // Section 6's "early risk detection", earned only by disclosure that turned out to matter. A firm
  // that saw a problem coming and said so is worth more than one that got lucky.
  if (record.risksDisclosedAndRealised > 0) {
    reasons.push(`early risk detection: ${record.risksDisclosedAndRealised} disclosed risk(s) materialised as warned`);
  }

  // Section 6's "externalised maintenance cost". A cheap implementation is not cheap when another
  // module pays for it, so the obligation sits on the firm's books as a liability rather than
  // vanishing at settlement.
  if (record.externalisedObligations > 0) {
    account.liabilities = round((account.liabilities ?? 0) + record.externalisedObligations);
    reasons.push(`${record.externalisedObligations} obligation(s) left for others to carry, booked as liabilities`);
  }

  if (record.verified) {
    account.cleanTasksInARow += 1;
    account.consecutiveFailures = 0;
    if (record.retentionWithheld > 0) {
      account.escrowLots ??= [];
      account.escrowLots.push({
        taskId: record.taskId,
        attemptKey: record.attemptKey,
        artifactDigest: record.artifactDigest,
        amount: record.retentionWithheld,
        maturesAfterSettlement: (account.settlements ?? 0) + Math.max(1, record.warrantyPeriodTasks ?? policy.retentionReleaseAfterCleanTasks),
        claimed: false,
      });
      account.heldEscrow = round(account.heldEscrow + record.retentionWithheld);
    }
  } else {
    account.defects += 1;
    account.cleanTasksInARow = 0;
    account.consecutiveFailures = (account.consecutiveFailures ?? 0) + 1;
    reasons.push(record.failureReason ?? 'the contract failed acceptance');
  }

  // The outcome recorded against each domain the contract exercised: delivery success first, tempered
  // by how well the firm estimated it.
  const probabilityAccuracy = record.successProbability === undefined
    ? 0.5
    : 1 - (Math.max(0, Math.min(1, record.successProbability)) - (record.verified ? 1 : 0)) ** 2;
  const outcome = record.verified
    ? 0.5 + 0.25 * calibration + 0.25 * probabilityAccuracy
    : 0.1 * calibration + 0.1 * probabilityAccuracy;
  const domainScores: Record<string, number> = {};
  for (const domain of record.domains.length > 0 ? record.domains : ['implementation']) {
    domainScores[domain] = recordDomainOutcome(account, domain, outcome, policy).score;
  }

  // The flat score is kept as the average of what is actually known, so it stays a summary of the
  // domain records rather than a second, competing opinion.
  const domains = Object.keys(account.reputationByDomain ?? {});
  account.reputationScore =
    domains.length === 0
      ? policy.neutralReputation
      : clamp01(domains.reduce((sum, d) => sum + domainReputation(account, d, policy), 0) / domains.length);

  let retentionReleased = 0;
  if (record.verified && account.escrowLots) {
    const matured = account.escrowLots.filter((lot) => !lot.claimed && lot.maturesAfterSettlement <= (account.settlements ?? 0));
    retentionReleased = round(matured.reduce((sum, lot) => sum + lot.amount, 0));
    account.capital = round(account.capital + retentionReleased);
    account.heldEscrow = round(account.heldEscrow - retentionReleased);
    account.escrowLots = account.escrowLots.filter((lot) => !matured.includes(lot));
    if (retentionReleased > 0) reasons.push(`retention of ${retentionReleased.toFixed(2)} released after its contract warranty period`);
  }

  return {
    capitalAfter: account.capital,
    liabilitiesAfter: account.liabilities ?? 0,
    reputationAfter: account.reputationScore,
    domainScores,
    reasons,
    retentionReleased,
  };
}

/** An attributed defect forfeits only the escrow still held on that contract. */
export function claimWarranty(account: CapitalAccount, taskId: string, attemptKey?: string): number {
  const lots = account.escrowLots ?? [];
  const matching = lots.filter((lot) => lot.taskId === taskId && !lot.claimed &&
    (attemptKey === undefined || lot.attemptKey === attemptKey));
  const claimable = attemptKey === undefined ? matching.slice(-1) : matching;
  const forfeited = round(claimable.reduce((sum, lot) => sum + lot.amount, 0));
  for (const lot of claimable) lot.claimed = true;
  account.escrowLots = lots.filter((lot) => !lot.claimed);
  account.heldEscrow = round(Math.max(0, account.heldEscrow - forfeited));
  return forfeited;
}

/**
 * How well a stated resource-cost forecast predicted consumption, on 0..1.
 *
 * Symmetric on purpose: a forecast four times actual cost is as inaccurate as one a quarter of it.
 * Selling price is a separate bid term and can include margin and risk.
 */
export function calibrationScore(quoted: number, actual: number): number {
  if (quoted <= 0) return 0.5; // nothing was promised, so nothing was missed
  const ratio = actual / quoted;
  const error = Math.abs(Math.log(Math.max(ratio, 1e-6)));
  return clamp01(1 - error / Math.log(4)); // a 4x miss in either direction scores zero
}

// ----------------------------------------------------------------- insolvency

export type InsolvencyGround = 'liabilities-exceed-capital' | 'repeated-contract-failure';

export interface Insolvency {
  insolvent: boolean;
  grounds: InsolvencyGround[];
  /** Section 11's list, as the consequences that actually follow here. */
  consequences: string[];
  rationale: string;
}

/**
 * Section 11, which is not a punishment rule.
 *
 * "The purpose is not punishment. It is to stop scarce resources remaining trapped in failing
 * organisations." Both of the doctrine's grounds are checked, and the second is the one a capital
 * threshold alone misses: a firm can be solvent on paper and still be the wrong place for the next
 * contract, because what it has actually demonstrated is that it cannot deliver.
 */
export function assessInsolvency(
  account: CapitalAccount,
  policy: CapitalPolicy = DEFAULT_CAPITAL_POLICY,
): Insolvency {
  const grounds: InsolvencyGround[] = [];

  if ((account.liabilities ?? 0) > account.capital) grounds.push('liabilities-exceed-capital');
  if ((account.consecutiveFailures ?? 0) >= policy.consecutiveFailuresForInsolvency) {
    grounds.push('repeated-contract-failure');
  }

  if (grounds.length === 0) {
    return { insolvent: false, grounds, consequences: [], rationale: `${account.personaId} remains solvent.` };
  }

  const consequences = [
    'existing contracts transfer to another firm',
    'exclusion from high-risk work',
    'reusable assets are liquidated to the commons',
  ];

  return {
    insolvent: true,
    grounds,
    consequences,
    rationale:
      `${account.personaId} is insolvent (${grounds.join(', ')}): capital ${account.capital.toFixed(2)} against ` +
      `liabilities ${(account.liabilities ?? 0).toFixed(2)}, ${account.consecutiveFailures ?? 0} consecutive failure(s). ` +
      'Its contracts move rather than its record being punished — the point is to stop scarce resources ' +
      'staying trapped in a firm that cannot deliver.',
  };
}

/**
 * Whether a firm may take high-risk work.
 *
 * Section 6: "Capital determines the scale and risk of future work an agent may undertake." Capital
 * net of liabilities, since a firm whose capital is entirely committed to obligations it already
 * owes has nothing left to put at risk.
 */
export function eligibleForHighRisk(account: CapitalAccount, policy: CapitalPolicy = DEFAULT_CAPITAL_POLICY): boolean {
  if (account.bankrupt) return false;
  return account.capital - (account.liabilities ?? 0) >= policy.capitalFloorForHighRisk;
}

export function resolveCapitalPolicy(raw: Partial<CapitalPolicy> | undefined): CapitalPolicy {
  return { ...DEFAULT_CAPITAL_POLICY, ...(raw ?? {}) };
}
