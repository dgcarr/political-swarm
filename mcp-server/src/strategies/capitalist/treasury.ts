// Section 6's Public Goods Authority, its Internal Monetary Policy, and its Venture Capital pool —
// the three places the doctrine admits the market will not fund something the market needs.
//
// This is the part of a market-liberal design that is easiest to leave out and worst to leave out.
// Section 6 is explicit: "Some valuable work cannot be funded reliably through private contracts",
// and its list is exactly the work a swarm lives on — shared test infrastructure, documentation
// standards, security baselines, build systems, technical debt reduction. Olson is the doctrine's
// citation, and the mechanism it proposes is plain: "A levy on profitable contracts may fund these
// services." Without one, articles 8 and 9 are unenforceable, because there is nothing for a
// contract to have failed to pay into.
//
// The levy falls on profit, not on revenue, and that follows the doctrine's wording rather than
// convenience — a loss-making contract has already lost its firm capital, and taxing it as well
// would make failure compound rather than merely cost.
//
// The bounded bailout is the load-bearing constraint here, not a footnote. Section 6: "It should not
// rescue every failing firm. Permanent bailouts destroy market discipline." A treasury that can
// rescue is a treasury that will be asked to, so the limits are structural — a cap per run, nothing
// for a firm already rescued once, and never more than the fund actually holds. Section 14 names
// what this is guarding against: moral hazard, whose safeguard is "capital at risk, deductibles and
// bounded bailouts".
//
// Deterministic. Who is rescued and who is allowed to fail is the sharpest distributive question in
// the doctrine, and it should be answerable from published rules rather than from a judgment call.

/** Section 6's own list of what the market underprovides. */
export const PUBLIC_GOODS = [
  'shared test infrastructure',
  'documentation standards',
  'security baselines',
  'repository indexing',
  'build systems',
  'dependency management',
  'observability',
  'disaster recovery',
  'technical debt reduction',
] as const;

export type PublicGood = (typeof PUBLIC_GOODS)[number];

/** Public-good classification is based on the commissioned work, not a bidder's assertion. */
export function publicGoodForWork(title: string, paths: readonly string[]): PublicGood | null {
  const text = `${title} ${paths.join(' ')}`.toLowerCase();
  if (/\btest|spec\b|fixture|ci\//.test(text)) return 'shared test infrastructure';
  if (/\bdocs?\b|readme|\.md\b/.test(text)) return 'documentation standards';
  if (/\bsecurity\b|\bauth\b|credential/.test(text)) return 'security baselines';
  if (/\bbuild\b|package\.json|tsconfig/.test(text)) return 'build systems';
  if (/\bobservability\b|telemetry|monitoring/.test(text)) return 'observability';
  return null;
}

export interface TreasuryPolicy {
  /** Section 6's levy, as a fraction of a contract's profit. */
  levyFraction: number;
  /** Share of each levy that goes to public goods rather than the venture pool. */
  publicGoodsShare: number;
  /** How many firms one run may rescue. Section 6: not every failing firm. */
  maxBailoutsPerRun: number;
  /** The fraction of a firm's shortfall a rescue may cover. Never the whole of it. */
  bailoutFraction: number;
  /** A grant may not exceed this fraction of the public-goods fund. */
  maxGrantFraction: number;
}

export const DEFAULT_TREASURY_POLICY: TreasuryPolicy = {
  levyFraction: 0.1,
  publicGoodsShare: 0.7,
  // One. A treasury that can rescue is a treasury that will be asked to, and section 6 is explicit
  // that permanent bailouts destroy the discipline the whole model runs on.
  maxBailoutsPerRun: 1,
  bailoutFraction: 0.5,
  maxGrantFraction: 0.5,
};

export interface Levy {
  taskId: string;
  personaId: string;
  profit: number;
  amount: number;
}

export interface Grant {
  good: string;
  amount: number;
  rationale: string;
  taskId?: string;
  evidenceRefs?: string[];
}

export interface Bailout {
  personaId: string;
  shortfall: number;
  amount: number;
  rationale: string;
}

export interface Treasury {
  publicGoodsFund: number;
  venturePool: number;
  levies: Levy[];
  grants: Grant[];
  bailouts: Bailout[];
  /** Rescues refused, with the ground. Refusing is the discipline; the record is the proof of it. */
  bailoutsRefused: Array<{ personaId: string; reason: string }>;
}

export function openTreasury(): Treasury {
  return { publicGoodsFund: 0, venturePool: 0, levies: [], grants: [], bailouts: [], bailoutsRefused: [] };
}

export function treasuryBalance(treasury: Treasury): number {
  return round(treasury.publicGoodsFund + treasury.venturePool);
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function clamp01(n: number): number {
  if (Number.isNaN(n) || !Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

// ------------------------------------------------------------------- the levy

export interface LevyResult {
  amount: number;
  toPublicGoods: number;
  toVenturePool: number;
  rationale: string;
}

/**
 * Section 6's levy on profitable contracts.
 *
 * On profit rather than on revenue, following the doctrine's own wording. A loss-making contract has
 * already cost its firm capital, and levying it as well would make failure compound rather than
 * merely cost — which would push firms away from exactly the uncertain work the venture pool exists
 * to fund.
 *
 * A contract that made no profit still settles, and is still recorded as levied: article 9 asks
 * whether a settled contract paid what it owed, and "nothing, because it earned nothing" is a
 * complete answer. Recording it as unlevied would report free-riding where there was none.
 */
export function collectLevy(
  treasury: Treasury,
  contract: { taskId: string; personaId: string; profit: number },
  policy: TreasuryPolicy = DEFAULT_TREASURY_POLICY,
): LevyResult {
  const taxable = Math.max(0, contract.profit);
  const amount = round(taxable * clamp01(policy.levyFraction));
  const toPublicGoods = round(amount * clamp01(policy.publicGoodsShare));
  const toVenturePool = round(amount - toPublicGoods);

  treasury.publicGoodsFund = round(treasury.publicGoodsFund + toPublicGoods);
  treasury.venturePool = round(treasury.venturePool + toVenturePool);
  treasury.levies.push({ taskId: contract.taskId, personaId: contract.personaId, profit: contract.profit, amount });

  return {
    amount,
    toPublicGoods,
    toVenturePool,
    rationale:
      amount > 0
        ? `${contract.personaId} pays ${amount.toFixed(2)} on a profit of ${contract.profit.toFixed(2)}: ` +
          `${toPublicGoods.toFixed(2)} to public goods, ${toVenturePool.toFixed(2)} to the venture pool.`
        : `${contract.taskId} returned no profit, so no levy falls on it. The obligation is discharged, not evaded.`,
  };
}

// ------------------------------------------------------------- funding the commons

export interface GrantResult {
  granted: number;
  refused: number;
  rationale: string;
}

/**
 * Funds a public good out of the levy.
 *
 * Capped as a share of the fund so one grant cannot empty it. The goods section 6 names are all
 * standing obligations rather than one-off purchases — test infrastructure and security baselines
 * need funding again next run — and a treasury that spent everything on the first request would
 * fund the first thing asked for rather than the most needed.
 */
export function fundPublicGood(
  treasury: Treasury,
  request: { good: string; amount: number; rationale: string; taskId?: string; evidenceRefs?: string[] },
  policy: TreasuryPolicy = DEFAULT_TREASURY_POLICY,
): GrantResult {
  const requested = Math.max(0, request.amount);
  const ceiling = round(treasury.publicGoodsFund * clamp01(policy.maxGrantFraction));
  const granted = round(Math.min(requested, ceiling));
  const refused = round(requested - granted);

  if (granted > 0) {
    treasury.publicGoodsFund = round(treasury.publicGoodsFund - granted);
    treasury.grants.push({ good: request.good, amount: granted, rationale: request.rationale,
      ...(request.taskId ? { taskId: request.taskId } : {}),
      ...(request.evidenceRefs ? { evidenceRefs: request.evidenceRefs } : {}) });
  }

  return {
    granted,
    refused,
    rationale:
      granted === requested
        ? `${granted.toFixed(2)} granted toward ${request.good}.`
        : `${granted.toFixed(2)} of ${requested.toFixed(2)} granted toward ${request.good}; the fund holds ` +
          `${treasury.publicGoodsFund.toFixed(2)} and no single grant may take more than a share of it.`,
  };
}

/** Commission a named shared-work listing only when the whole tender shortfall is available
 * after reserving treasury assets already pledged to outstanding credit. */
export function subsidizePublicGoodListing(
  treasury: Treasury,
  request: {
    taskId: string;
    title: string;
    paths: readonly string[];
    publishedBudget: number;
    cheapestBid: number;
    outstandingCredit: number;
    reserveBalance: number;
  },
  policy: TreasuryPolicy = DEFAULT_TREASURY_POLICY,
): { good: PublicGood; amount: number } | null {
  const good = publicGoodForWork(request.title, request.paths);
  const shortfall = Math.round(Math.max(0, request.cheapestBid - request.publishedBudget) * 100) / 100;
  const pledged = Math.max(0, request.outstandingCredit - request.reserveBalance);
  const unpledged = Math.max(0, treasury.publicGoodsFund - pledged);
  const ceiling = Math.min(unpledged, treasury.publicGoodsFund * clamp01(policy.maxGrantFraction));
  if (!good || shortfall <= 0 || shortfall > ceiling) return null;
  const grant = fundPublicGood(treasury, {
    good, amount: shortfall, taskId: request.taskId,
    evidenceRefs: [`listing:${request.taskId}`],
    rationale: `The lowest sealed bid exceeded the published budget for ${request.title} by ${shortfall.toFixed(2)}.`,
  }, policy);
  return grant.granted === shortfall ? { good, amount: grant.granted } : null;
}

// ---------------------------------------------------------------- the venture pool

/**
 * Funds an experiment out of the venture pool.
 *
 * Section 6: "Failed experiments lose capital but should still publish useful findings." So this
 * returns the obligation alongside the money — a grant that produced nothing and said nothing about
 * why is the one outcome the pool cannot afford, since the finding is the return on a failed
 * experiment.
 */
export function fundExperiment(
  treasury: Treasury,
  request: { experiment: string; amount: number; taskId?: string; evidenceRefs?: string[] },
): GrantResult & { publicationObligation: string } {
  const requested = Math.max(0, request.amount);
  const granted = round(Math.min(requested, treasury.venturePool));
  treasury.venturePool = round(treasury.venturePool - granted);
  if (granted > 0) {
    treasury.grants.push({
      good: `experiment: ${request.experiment}`,
      amount: granted,
      rationale: 'Funded from the venture pool against a publication obligation.',
      taskId: request.taskId,
      evidenceRefs: request.evidenceRefs,
    });
  }

  return {
    granted,
    refused: round(requested - granted),
    rationale:
      granted > 0
        ? `${granted.toFixed(2)} committed to ${request.experiment} from the venture pool.`
        : `The venture pool holds ${treasury.venturePool.toFixed(2)} and cannot fund ${request.experiment}.`,
    publicationObligation:
      'A failed experiment still owes its findings to the commons. Losing the capital discharges the ' +
      'investment; it does not discharge the obligation to say what was learned.',
  };
}

/** Commission a named exploratory listing only if the full shortfall is unpledged. */
export function subsidizeExperimentListing(
  treasury: Treasury,
  request: { taskId: string; title: string; publishedBudget: number; cheapestBid: number;
    outstandingCredit: number; reserveBalance: number; scopeUnderstood: boolean },
): { amount: number; publicationObligation: string } | null {
  if (request.scopeUnderstood || !/\b(prototype|experiment|spike|investigat\w*|research)\b/i.test(request.title)) return null;
  const shortfall = round(Math.max(0, request.cheapestBid - request.publishedBudget));
  const pledgedVenture = Math.max(0, request.outstandingCredit - request.reserveBalance - treasury.publicGoodsFund);
  if (shortfall <= 0 || shortfall > Math.max(0, treasury.venturePool - pledgedVenture)) return null;
  const grant = fundExperiment(treasury, {
    experiment: request.title, amount: shortfall, taskId: request.taskId,
    evidenceRefs: [`listing:${request.taskId}`],
  });
  return grant.granted === shortfall
    ? { amount: grant.granted, publicationObligation: grant.publicationObligation }
    : null;
}

// ------------------------------------------------------------- the bounded bailout

export interface BailoutResult {
  granted: boolean;
  amount: number;
  reason: string;
}

/**
 * Whether the treasury rescues a failing firm, and how far.
 *
 * Section 6 permits a treasury to "prevent systemic collapse" and forbids it in the same paragraph
 * from rescuing every failing firm, because "permanent bailouts destroy market discipline". The
 * limits are therefore structural rather than discretionary, and every one of them can refuse:
 *
 *   - a cap on rescues per run, so the second failure is not saved by the first firm's precedent;
 *   - nothing at all for a firm already rescued, which is what makes a bailout an event rather than
 *     a facility;
 *   - never the whole shortfall, so the firm still bears a loss and the failure still means
 *     something; and
 *   - never more than the fund holds, since a treasury that can print has no constraint at all.
 *
 * Refusals are recorded as deliberately as grants. The discipline is the refusing, and a run that
 * cannot show what it declined to rescue cannot show it had any.
 */
export function considerBailout(
  treasury: Treasury,
  request: { personaId: string; shortfall: number; systemic: boolean },
  policy: TreasuryPolicy = DEFAULT_TREASURY_POLICY,
): BailoutResult {
  const refuse = (reason: string): BailoutResult => {
    treasury.bailoutsRefused.push({ personaId: request.personaId, reason });
    return { granted: false, amount: 0, reason };
  };

  if (!request.systemic) {
    return refuse(
      `${request.personaId} fails without threatening the run. A firm that can be allowed to fail is allowed to: ` +
        'that is the discipline profit and loss are for.',
    );
  }
  if (treasury.bailouts.some((b) => b.personaId === request.personaId)) {
    return refuse(
      `${request.personaId} has been rescued once already. A second rescue would make the treasury a facility ` +
        'rather than an event, which is the permanent bailout section 6 rules out.',
    );
  }
  if (treasury.bailouts.length >= policy.maxBailoutsPerRun) {
    return refuse(
      `This run has already rescued ${treasury.bailouts.length} firm(s), which is its limit. The second failure ` +
        'is not saved by the first one’s precedent.',
    );
  }

  const wanted = round(Math.max(0, request.shortfall) * clamp01(policy.bailoutFraction));
  const amount = round(Math.min(wanted, treasury.publicGoodsFund));
  if (amount <= 0) {
    return refuse(
      `The fund holds ${treasury.publicGoodsFund.toFixed(2)} and cannot rescue ${request.personaId}. A treasury ` +
        'that could print would be no constraint at all.',
    );
  }

  const reason =
    `${request.personaId} is rescued with ${amount.toFixed(2)} of a ${request.shortfall.toFixed(2)} shortfall — ` +
    'part of it, never all, so the failure still costs the firm something. This run will not rescue another.';
  treasury.bailouts.push({ personaId: request.personaId, shortfall: request.shortfall, amount, rationale: reason });
  treasury.publicGoodsFund = round(treasury.publicGoodsFund - amount);
  return { granted: true, amount, reason };
}

export function resolveTreasuryPolicy(raw: Partial<TreasuryPolicy> | undefined): TreasuryPolicy {
  return { ...DEFAULT_TREASURY_POLICY, ...(raw ?? {}) };
}
