// Section 6's Insurance, whose closing line is the whole justification: "Insurance converts hidden
// risk into an explicit price."
//
// That is the point rather than the payout. A run where risky work costs the same as safe work has
// no signal telling anyone which is which — the risk is still there, it is just not on anybody's
// books. Section 14 names the failure mode this answers as moral hazard, "agents take excessive risk
// because losses will be socialised", with the safeguard "capital at risk, deductibles and bounded
// bailouts". All three are here: the premium is paid out of the firm's own capital, the firm bears
// a deductible on every claim, and the reserve can run out.
//
// Section 6 lists six things premiums rise with — poor history, weak test coverage, large blast
// radius, irreversible changes, uncertainty, inadequate rollback plans — and each is a line here,
// with the basis it was computed from, for the same reason prices carry theirs: a premium a firm
// cannot see the derivation of is a tax, not a price.
//
// Deterministic. A premium is charged against a firm's capital before it has done anything wrong,
// which is only defensible if the firm could have worked out what it would be.

import type { RiskClass } from '../../engine/types.js';

export interface PremiumFactors {
  /** Rejected contracts over settlements — section 6's "poor history". */
  defectRate: number;
  /** Whether the delivery is accompanied by tests. */
  hasTests: boolean;
  /** Files the contract may touch, and contracts depending on it — the blast radius. */
  filesInScope: number;
  dependants: number;
  /** Deletions, migrations and other changes that cannot simply be reverted. */
  irreversible: boolean;
  /** The bid's own stated confidence. Low confidence is disclosed uncertainty. */
  confidence: number;
  /** Whether the contract carries a stated rollback plan. */
  hasRollbackPlan: boolean;
}

export interface InsurancePolicy {
  /** Premium on a low-risk contract with a clean firm and every mitigation, as a fraction of price. */
  basePremiumFraction: number;
  /** Multiplier per risk class, before the six factors. */
  riskMultiplier: Record<RiskClass, number>;
  /** The share of any claim the firm bears itself. Section 14's deductible. */
  deductibleFraction: number;
  /** Risk classes at or above which a contract must be insured to be let. */
  requiredAtRisk: RiskClass[];
  /** A premium may never exceed this fraction of the contract price. */
  maxPremiumFraction: number;
}

export const DEFAULT_INSURANCE_POLICY: InsurancePolicy = {
  basePremiumFraction: 0.02,
  riskMultiplier: { low: 1, medium: 2, high: 4 },
  deductibleFraction: 0.25,
  requiredAtRisk: ['high'],
  // Capped so insurance cannot swallow the contract. An uninsurable premium is a refusal to let the
  // work at all, and that decision belongs to the buyer and the regulator, not to an actuarial table.
  maxPremiumFraction: 0.4,
};

export interface PremiumLine {
  factor: string;
  basis: string;
  /** Multiplier this factor contributes. 1 means it neither raised nor lowered the premium. */
  multiplier: number;
}

export interface Premium {
  amount: number;
  lines: PremiumLine[];
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
 * The premium for one contract, and why.
 *
 * Every one of section 6's six factors either raises the premium or leaves it alone; none lowers it
 * below the base. A firm with a clean history, tests, a rollback plan, a small blast radius and a
 * confident bid pays the base rate for its risk class and no more — which is the signal the
 * instrument exists to send. The mitigations are worth having because they are cheaper than the
 * premium, not because they earn a discount below cost.
 */
export function premiumFor(
  price: number,
  riskClass: RiskClass,
  factors: PremiumFactors,
  policy: InsurancePolicy = DEFAULT_INSURANCE_POLICY,
): Premium {
  const lines: PremiumLine[] = [
    {
      factor: 'risk class',
      basis: `contract is classed ${riskClass}`,
      multiplier: policy.riskMultiplier[riskClass] ?? 1,
    },
    {
      factor: 'poor history',
      basis: `${(clamp01(factors.defectRate) * 100).toFixed(0)}% of this firm's contracts have failed`,
      multiplier: 1 + clamp01(factors.defectRate),
    },
    {
      factor: 'weak test coverage',
      basis: factors.hasTests ? 'the delivery carries tests' : 'the delivery carries no tests',
      multiplier: factors.hasTests ? 1 : 1.5,
    },
    {
      factor: 'blast radius',
      basis: `${factors.filesInScope} file(s) in scope, ${factors.dependants} dependent contract(s)`,
      multiplier: 1 + Math.min(1, (Math.max(0, factors.filesInScope) + Math.max(0, factors.dependants) * 2) / 20),
    },
    {
      factor: 'irreversible change',
      basis: factors.irreversible ? 'the contract deletes or migrates, and cannot simply be reverted' : 'the change is reversible',
      multiplier: factors.irreversible ? 2 : 1,
    },
    {
      factor: 'uncertainty',
      basis: `the bid stated ${(clamp01(factors.confidence) * 100).toFixed(0)}% confidence`,
      multiplier: 1 + (1 - clamp01(factors.confidence)),
    },
    {
      factor: 'inadequate rollback plan',
      basis: factors.hasRollbackPlan ? 'a rollback plan is stated' : 'no rollback plan is stated',
      multiplier: factors.hasRollbackPlan ? 1 : 1.5,
    },
  ];

  const combined = lines.reduce((product, line) => product * line.multiplier, policy.basePremiumFraction);
  const fraction = Math.min(policy.maxPremiumFraction, combined);
  const amount = round(Math.max(0, price) * fraction);

  const raised = lines.filter((l) => l.multiplier > 1).map((l) => l.factor);
  return {
    amount,
    lines,
    rationale:
      raised.length === 0
        ? `Base rate: ${amount.toFixed(2)} on a price of ${price.toFixed(2)}. Nothing about this contract raises it.`
        : `Premium ${amount.toFixed(2)} on a price of ${price.toFixed(2)}, raised by: ${raised.join(', ')}.`,
  };
}

/** Whether the doctrine requires this contract to be insured before it may be let. */
export function insuranceRequired(riskClass: RiskClass, policy: InsurancePolicy = DEFAULT_INSURANCE_POLICY): boolean {
  return policy.requiredAtRisk.includes(riskClass);
}

// -------------------------------------------------------------- the pooled reserve

export interface Reserve {
  balance: number;
  premiumsCollected: number;
  claimsPaid: number;
  claims: Array<{ taskId: string; personaId: string; requested: number; paid: number; deductible: number; shortfall: number }>;
}

export function openReserve(): Reserve {
  return { balance: 0, premiumsCollected: 0, claimsPaid: 0, claims: [] };
}

export function collectPremium(reserve: Reserve, amount: number): Reserve {
  const collected = Math.max(0, amount);
  reserve.balance = round(reserve.balance + collected);
  reserve.premiumsCollected = round(reserve.premiumsCollected + collected);
  return reserve;
}

export interface ClaimResult {
  paid: number;
  /** What the firm bears itself, whatever the reserve holds. */
  deductible: number;
  /** What neither the reserve nor the deductible covered. */
  shortfall: number;
  rationale: string;
}

/**
 * Pays a claim against the pooled reserve.
 *
 * Two limits, both deliberate. The firm bears a deductible first — section 14's answer to moral
 * hazard is "capital at risk, deductibles and bounded bailouts", and a claim that made a firm whole
 * would make risky work free at the point of failure. And the reserve can run dry: it holds only
 * what premiums put into it, so a run whose risks all materialise cannot pay for all of them. The
 * shortfall is returned rather than absorbed, because an uncovered loss that nobody records is the
 * externalised risk the whole instrument exists to price.
 */
export function payClaim(
  reserve: Reserve,
  claim: { taskId: string; personaId: string; amount: number },
  policy: InsurancePolicy = DEFAULT_INSURANCE_POLICY,
): ClaimResult {
  const requested = Math.max(0, claim.amount);
  const deductible = round(requested * clamp01(policy.deductibleFraction));
  const coverable = round(requested - deductible);
  const paid = round(Math.min(coverable, reserve.balance));
  const shortfall = round(coverable - paid);

  reserve.balance = round(reserve.balance - paid);
  reserve.claimsPaid = round(reserve.claimsPaid + paid);
  reserve.claims.push({ taskId: claim.taskId, personaId: claim.personaId, requested, paid, deductible, shortfall });

  return {
    paid,
    deductible,
    shortfall,
    rationale:
      shortfall > 0
        ? `The reserve paid ${paid.toFixed(2)} of ${requested.toFixed(2)}; ${claim.personaId} bears the ` +
          `${deductible.toFixed(2)} deductible and ${shortfall.toFixed(2)} is uncovered — the pool holds only what ` +
          'premiums put into it.'
        : `The reserve paid ${paid.toFixed(2)} toward repair on ${claim.taskId}; ${claim.personaId} bears the ` +
          `${deductible.toFixed(2)} deductible.`,
  };
}

export function resolveInsurancePolicy(raw: Partial<InsurancePolicy> | undefined): InsurancePolicy {
  return {
    ...DEFAULT_INSURANCE_POLICY,
    ...(raw ?? {}),
    riskMultiplier: { ...DEFAULT_INSURANCE_POLICY.riskMultiplier, ...(raw?.riskMultiplier ?? {}) },
  };
}
