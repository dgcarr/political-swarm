// Section 12 of docs/philosophy/neoliberal_capitalist_ai_code_swarm.md — the minimal market
// constitution — as checked data rather than prose.
//
// Section 6 is explicit that the constitution "should be stable enough for agents to plan around
// it", which is only true of a rule someone can look up and check. Each article below names the
// mechanism that actually holds it up, and the predicates in this file are the ones review(),
// settlement and the regulator's acceptance gate call. Where an article is upheld somewhere else —
// the engine's evidence floor, the human's sovereignty over the run — the entry says so plainly
// rather than pretending this module enforces it.
//
// Nothing here makes a model call. Article 10 requires that "the regulator acts only under stable,
// published and reviewable rules", and a regulator whose rulings are a model's opinion on the day is
// neither stable nor reviewable. Section 14 names the failure this avoids by name: regulatory
// capture, whose safeguard is "transparent rules". So the market's law is arithmetic over the
// record, and the model calls stay where genuine commercial judgment lives — bids, review,
// assessment and, when the parties actually disagree, arbitration.

import { matchesAnyGlob } from '../../util/glob.js';
import type { Article, EnforcementSite } from '../../constitution/articles.js';

export type { Article, EnforcementSite };

export const ARTICLES: readonly Article[] = [
  {
    id: 'article-1',
    title: 'Purpose',
    text: 'The market allocates scarce computational and cognitive resources toward useful, secure and maintainable software.',
    enforcedBy: 'engine',
    mechanism: "The user's acceptance criteria are the run's objective; engine/delivery.ts refuses a criterion without evidence.",
  },
  {
    id: 'article-2',
    title: 'Property',
    text: 'Control rights over modules, data, interfaces and tools must be explicit, transferable and limited by repository law.',
    enforcedBy: 'strategy',
    mechanism: "The task exchange's dependency and property schedule — declareOwnership() in CapitalistStrategy.ts.",
  },
  {
    id: 'article-3',
    title: 'Contract',
    text: 'No agent may claim payment or authority beyond an agreed mandate.',
    enforcedBy: 'constitution',
    mechanism: 'scopeBreaches() — work delivered outside the awarded statement of work is authority nobody bought.',
  },
  {
    id: 'article-4',
    title: 'Competition',
    text: 'Entry remains open to qualified agents, and no incumbent may monopolise essential infrastructure.',
    enforcedBy: 'constitution',
    mechanism: 'antitrustBreaches() blocks self-dealing and essential-facility capture; marketConcentration() reports the rest.',
  },
  {
    id: 'article-5',
    title: 'Price',
    text: 'Scarce resources carry visible costs.',
    enforcedBy: 'constitution',
    mechanism: 'unpricedConsumption() — a contract settled without a recorded resource price spent the commons for free.',
  },
  {
    id: 'article-6',
    title: 'Profit and loss',
    text: 'Agents retain rewards for value creation and bear consequences for failure.',
    enforcedBy: 'strategy',
    mechanism: 'Settlement pays against verified value net of consumed resources and liabilities — strategies/capitalist/prices.ts.',
  },
  {
    id: 'article-7',
    title: 'Disclosure',
    text: 'Material uncertainty, dependencies, conflicts and risks must be disclosed.',
    enforcedBy: 'constitution',
    mechanism: 'undisclosedRisk(), comparing what a bid declared against what its delivery turned out to carry.',
  },
  {
    id: 'article-8',
    title: 'Externalities',
    text: 'Agents bear reasonably attributable downstream costs.',
    enforcedBy: 'constitution',
    mechanism: 'unpricedExternalities() — a deferred finding with no owner and no priced obligation is a cost pushed onto the repository.',
  },
  {
    id: 'article-9',
    title: 'Public goods',
    text: 'Shared infrastructure may be financed collectively where private contracting would underprovide it.',
    enforcedBy: 'constitution',
    mechanism: 'publicGoodsUnderfunded(), against the levy the treasury collected on settled contracts.',
  },
  {
    id: 'article-10',
    title: 'Rule of law',
    text: 'The regulator acts only under stable, published and reviewable rules.',
    enforcedBy: 'constitution',
    mechanism: 'REGULATOR_GROUNDS is the published list; regulatorOverreach() rejects a block that cites anything else.',
  },
  {
    id: 'article-11',
    title: 'Safety floor',
    text: 'No contract may waive non-negotiable safety, security, privacy or human-control requirements.',
    enforcedBy: 'constitution',
    mechanism: 'markNonWaivableFindings() (strategies/floors.ts) marks what the assessors find on a non-waivable ground; the regulator refuses escrow release over an open one.',
  },
  {
    id: 'article-12',
    title: 'Human sovereignty',
    text: 'Human project owners may halt the market, alter the constitution or reject any outcome.',
    enforcedBy: 'human',
    mechanism: 'ctx.openApproval() gates; no commercial party — buyer, contractor or regulator — can substitute for a human decision.',
  },
];

export function articleById(id: string): Article | undefined {
  return ARTICLES.find((a) => a.id === id);
}

/** The charter as a single inspectable string. Section 6: agents must be able to plan around it. */
export function charterDigest(): string {
  return ARTICLES.map((a) => `${a.id}. ${a.title}: ${a.text}`).join('\n');
}

// --------------------------------------------------------- articles 11 and 9

/**
 * Article 11's floor and article 7's preservation of disclosed dissent.
 *
 * All three doctrines reach the same two prohibitions by different routes — the Westminster charter
 * calls them articles 10 and 8, the socialist constitution articles 12 and 9, and this one gets
 * there through the regulatory safety floor and the disclosure duty. The ground table therefore
 * lives in strategies/floors.ts. What belongs here is only which article each one answers to under
 * this doctrine.
 */
export {
  NON_WAIVABLE_GROUNDS,
  droppedMinorityReports,
  markNonWaivableFindings,
  nonWaivableGround,
  type NonWaivableGround,
} from '../floors.js';

// ------------------------------------------------------------------ article 3

export interface DeliveredWork {
  taskId: string;
  personaId: string;
  /** Repository-relative paths the delivery actually touched. */
  paths: readonly string[];
  /** The globs the awarded statement of work declared. */
  declaredGlobs: readonly string[];
}

export interface ScopeBreach {
  taskId: string;
  personaId: string;
  /** The paths touched that nobody contracted for. */
  paths: string[];
  article: string;
  remedy: string;
}

/**
 * Article 3, checked: "No agent may claim payment or authority beyond an agreed mandate."
 *
 * A file changed outside the listing's declared globs is authority the contractor took rather than
 * won, and section 6 treats a bid that misstates its scope as misrepresentation — which "should
 * trigger loss of payment, warranty claims and market penalties". So this blocks: it is not a
 * matter of taste which files a contract covers.
 *
 * An empty glob list means the statement of work declared nothing, which cannot silently mean
 * "everything". The listing originator writes generous globs precisely so this check has something
 * to bite on (see PLANNER_SYSTEM_PROMPT); nothing declared is treated as nothing contracted.
 */
export function scopeBreaches(delivered: readonly DeliveredWork[]): ScopeBreach[] {
  const breaches: ScopeBreach[] = [];

  for (const work of delivered) {
    const globs = [...work.declaredGlobs];
    const outside = globs.length === 0 ? [...work.paths] : work.paths.filter((p) => !matchesAnyGlob(p, globs));
    if (outside.length === 0) continue;

    breaches.push({
      taskId: work.taskId,
      personaId: work.personaId,
      paths: outside,
      article: 'article-3',
      remedy:
        `Article 3: the awarded statement of work covers [${globs.join(', ') || 'nothing declared'}], but the delivery ` +
        `touched ${outside.join(', ')}. That is authority beyond the mandate — withhold payment and treat the bid as misrepresented.`,
    });
  }
  return breaches;
}

// ------------------------------------------------------------------ article 4

/**
 * Who held which office on this run. A firm appears under its lead contractor, since section 6
 * makes the lead the party that "bears responsibility for delivery".
 */
export interface MarketRegister {
  /** taskId -> the lead contractor paid for it. */
  contractors: Record<string, string>;
  /** taskId -> the reviewer who assessed it. */
  assessors: Record<string, string>;
  integratorId?: string;
  verifierId?: string;
  /** Lead contractor -> the subcontractors it engaged, so a firm cannot review its own subcontract. */
  subcontractors?: Record<string, readonly string[]>;
}

export interface AntitrustBreach {
  personaId: string;
  taskId: string;
  holdings: [string, string];
  article: string;
  remedy: string;
}

/**
 * Article 4, the part that blocks.
 *
 * Section 6's antitrust rules prohibit "self-dealing" and "exclusive control of essential
 * infrastructure", and section 10 requires an assessor "who did not author, subcontract, or hold a
 * success fee in the relevant change". Both reduce to the same inspectable thing: one party
 * standing on both sides of a transaction it is paid for.
 *
 * Three ways that happens here, and all three block. Unlike a concentration of awards (below),
 * none of these is ever an artefact of a short plan — a contractor assessing its own contract is
 * self-dealing on a one-node run exactly as much as on a fifty-node one.
 */
export function antitrustBreaches(register: MarketRegister): AntitrustBreach[] {
  const breaches: AntitrustBreach[] = [];
  const subcontractors = register.subcontractors ?? {};

  for (const [taskId, contractor] of Object.entries(register.contractors)) {
    const assessor = register.assessors[taskId];
    if (!assessor || !contractor) continue;

    if (assessor === contractor) {
      breaches.push({
        personaId: contractor,
        taskId,
        holdings: ['contractor', 'assessor'],
        article: 'article-4',
        remedy:
          'Article 4: self-dealing. The firm paid for this contract also certified it. ' +
          'Procure the assessment from a party with no success fee in the delivery.',
      });
      continue;
    }

    // Section 10's "did not author, subcontract" — a lead reviewing the work of a firm it engaged is
    // certifying its own delivery through one more layer, and is paid for the delivery either way.
    const engaged = subcontractors[assessor] ?? [];
    if (engaged.includes(contractor)) {
      breaches.push({
        personaId: assessor,
        taskId,
        holdings: ['prime contractor', 'assessor'],
        article: 'article-4',
        remedy:
          `Article 4: self-dealing through a subcontract. ${assessor} engaged ${contractor} and then assessed its work. ` +
          'Draw the assessor from outside the firm.',
      });
    }
  }

  // Section 6's essential facilities: integration and final verification together are exclusive
  // control of the only route to market. The engine refuses this manifest too, so the market's own
  // law and the engine floor agree rather than one relying on the other.
  if (register.integratorId && register.verifierId && register.integratorId === register.verifierId) {
    breaches.push({
      personaId: register.integratorId,
      taskId: '(delivery)',
      holdings: ['integration assessor', 'contractual assessor'],
      article: 'article-4',
      remedy:
        'Article 4: integration and final verification are essential facilities. One party holding both controls the only ' +
        'route to acceptance. Procure them separately.',
    });
  }

  return breaches;
}

export interface Concentration {
  personaId: string;
  awards: string[];
  share: number;
  remedy: string;
}

/**
 * One firm holding a majority of the run's awards.
 *
 * Reported, never blocking, and the distinction is the whole point. Section 6's remedies for
 * monopoly are structural — "break up monopolistic control", "preserve market entry" — and none of
 * them is "throw the delivered work away". On a three-listing plan with three bidders, one firm
 * winning two is arithmetic: it means it bid better twice, which is what the exchange is for.
 * Refusing a sound delivery over that would fail a good run for the shape of its plan.
 *
 * What it is worth doing is saying so out loud, where the market report and a human reader can see
 * it, and where a future run with cross-run history could act on it.
 */
export function marketConcentration(contractors: Record<string, string>, threshold = 0.5): Concentration[] {
  const taskIds = Object.keys(contractors);
  if (taskIds.length <= 1) return [];

  const awards = new Map<string, string[]>();
  for (const [taskId, persona] of Object.entries(contractors)) {
    if (!persona) continue;
    awards.set(persona, [...(awards.get(persona) ?? []), taskId]);
  }

  const concentrated: Concentration[] = [];
  for (const [persona, held] of awards) {
    const share = held.length / taskIds.length;
    if (share > threshold) {
      concentrated.push({
        personaId: persona,
        awards: held,
        share,
        remedy:
          `Article 4: ${persona} won ${held.length} of ${taskIds.length} listings (${Math.round(share * 100)}%). ` +
          'On a plan this short that may be competence rather than capture, but sustained it is how an incumbent ' +
          'closes a market. Preserve entry on the next listing.',
      });
    }
  }
  return concentrated;
}

// ------------------------------------------------------------------ article 5

export interface SettledContract {
  taskId: string;
  personaId: string;
  /** What the contract was paid. */
  price: number;
  /** What the contract actually consumed, priced. Undefined means nobody priced it. */
  resourceCost?: number;
}

/**
 * Article 5: "Scarce resources carry visible costs."
 *
 * Section 6 puts the whole doctrine on this: "Agents that consume scarce resources without
 * producing verified value lose capital", which is unenforceable if consumption was never measured.
 * Mises's calculation problem is the doc's own citation — "without meaningful prices, planners
 * cannot allocate scarce capital rationally" — and a contract settled with no recorded resource
 * cost has spent the commons for free.
 *
 * Reported rather than blocking: the missing number is an accounting gap, and refusing a delivery
 * whose code is sound because the bookkeeping was incomplete would be its own kind of waste. The
 * market report carries it.
 */
export function unpricedConsumption(settled: readonly SettledContract[]): string[] {
  return settled
    .filter((c) => c.resourceCost === undefined || !Number.isFinite(c.resourceCost))
    .map((c) => c.taskId);
}

// ------------------------------------------------------------------ article 7

export interface BidRecord {
  taskId: string;
  personaId: string;
  /** Risks the bid disclosed at tender. */
  declaredRisks: readonly string[];
  /** What the bid said it would cost. */
  quotedPrice: number;
  /** What it actually consumed, priced. */
  actualCost?: number;
}

export interface DisclosureBreach {
  taskId: string;
  personaId: string;
  kind: 'undisclosed-risk' | 'misleading-estimate';
  article: string;
  remedy: string;
}

/**
 * Article 7, checked two ways.
 *
 * Section 6: "Agents must disclose material uncertainty, prior failures, dependencies, conflicts of
 * interest and likely maintenance cost. Misrepresentation should trigger loss of payment, warranty
 * claims and market penalties." Section 14 names the failure mode as information asymmetry, whose
 * safeguard is "mandatory disclosure".
 *
 * The first check is the sharper one: a bid that declared no risks at all, on work that then
 * produced findings, either did not look or did not say. Note what it deliberately does *not* do —
 * it does not penalise a bid that disclosed risks and then hit some. Disclosing a risk that
 * materialises is the system working; the penalty falls on silence, or the incentive runs the wrong
 * way and every bidder learns to declare nothing.
 *
 * The second is estimate calibration, which section 6 lists under both capital earned ("accurate
 * estimation") and capital lost ("misleading bids"). Tolerance is a ratio because absolute
 * overruns scale with contract size.
 */
export function undisclosedRisk(
  bids: readonly BidRecord[],
  findingsByTask: Readonly<Record<string, number>>,
  overrunTolerance = 2,
): DisclosureBreach[] {
  const breaches: DisclosureBreach[] = [];

  for (const bid of bids) {
    const findings = findingsByTask[bid.taskId] ?? 0;
    if (bid.declaredRisks.length === 0 && findings > 0) {
      breaches.push({
        taskId: bid.taskId,
        personaId: bid.personaId,
        kind: 'undisclosed-risk',
        article: 'article-7',
        remedy:
          `Article 7: ${bid.personaId} tendered for "${bid.taskId}" declaring no known risks, and the delivery drew ` +
          `${findings} finding(s). Silence at tender is not the same as a clean bid — price the disclosure gap against the contract.`,
      });
    }

    if (
      bid.actualCost !== undefined &&
      Number.isFinite(bid.actualCost) &&
      bid.quotedPrice > 0 &&
      bid.actualCost > bid.quotedPrice * overrunTolerance
    ) {
      breaches.push({
        taskId: bid.taskId,
        personaId: bid.personaId,
        kind: 'misleading-estimate',
        article: 'article-7',
        remedy:
          `Article 7: the winning bid on "${bid.taskId}" quoted ${bid.quotedPrice.toFixed(2)} and consumed ` +
          `${bid.actualCost.toFixed(2)} — over ${overrunTolerance}x. Estimate calibration is part of the bidder's record.`,
      });
    }
  }
  return breaches;
}

// ------------------------------------------------------------------ article 8

export interface CarriedObligation {
  findingId: string;
  summary: string;
  owner?: string;
  returnCondition?: string;
  /** The priced obligation the deferral was accepted against. */
  pricedAt?: number;
}

/**
 * Article 8: "Agents bear reasonably attributable downstream costs."
 *
 * Section 6's externalities list is exactly what a deferred finding is — technical debt, future
 * maintenance, documentation gaps — and its remedies are all prices: "taxes, reserves, insurance
 * premiums, defect chargebacks, maintenance obligations". Section 6's own summary of the failure:
 * "A cheap implementation is not cheap when another module pays the long-term cost."
 *
 * So a deferral with nobody named and nothing priced is not a decision, it is a cost transferred to
 * whoever opens the repository next. The engine already refuses a deferred finding with no owner or
 * return condition; what this adds is the price, which is this doctrine's own requirement rather
 * than a shared one.
 */
export function unpricedExternalities(carried: readonly CarriedObligation[]): CarriedObligation[] {
  return carried.filter(
    (o) => !o.owner?.trim() || !o.returnCondition?.trim() || o.pricedAt === undefined || !Number.isFinite(o.pricedAt),
  );
}

// ------------------------------------------------------------------ article 9

/**
 * Article 9: shared infrastructure "may be financed collectively where private contracting would
 * underprovide it."
 *
 * Olson is the doc's citation and section 6 spells out the mechanism: "A levy on profitable
 * contracts may fund these services." Section 14 lists underfunded public goods as a failure mode
 * whose safeguard is "levies, grants and constitutional funding". A settled contract that paid no
 * levy free-rode on the tests, build tooling and security baselines it was delivered against.
 *
 * Reported, not blocking, for the same reason as article 5: this is an accounting gap, and the
 * remedy is to collect, not to refuse the work.
 */
export function publicGoodsUnderfunded(settled: readonly SettledContract[], leviedTaskIds: readonly string[]): string[] {
  const levied = new Set(leviedTaskIds);
  return settled.filter((c) => !levied.has(c.taskId)).map((c) => c.taskId);
}

// ----------------------------------------------------------------- article 10

/**
 * The published list article 10 requires the regulator to act under.
 *
 * Section 6 bounds the regulator to enforcement, competition, disclosure, safety and systemic risk,
 * and closes with "The regulator must itself be limited by published rules." Section 14's
 * regulatory-capture safeguard is "transparent rules … and separation between participation and
 * enforcement". Exported as data so the list is inspectable, and so a ground cannot be invented at
 * the moment it is convenient to block something.
 */
export const REGULATOR_GROUNDS = [
  'contract-breach', // enforce contracts
  'fraud', // punish fraud
  'collusion', // prevent collusion
  'market-entry', // preserve entry, break up monopolistic control
  'nondisclosure', // require disclosure
  'safety-floor', // enforce safety floors
  'externality', // price externalities
  'public-goods', // protect public goods
  'systemic-risk', // halt systemic risk
] as const;

export type RegulatorGround = (typeof REGULATOR_GROUNDS)[number];

export interface RegulatorAction {
  taskId: string;
  ground: string;
  rationale: string;
}

/**
 * Article 10, checked against the regulator rather than against the market.
 *
 * This is the one predicate here that polices the enforcer, which is the point: a constitution that
 * only binds the participants is not the rule of law, it is just management. A block citing a ground
 * that is not on the published list is the regulator legislating for itself, and section 6's own
 * warning applies — "The regulator should not plan ordinary work."
 */
export function regulatorOverreach(actions: readonly RegulatorAction[]): RegulatorAction[] {
  const published = new Set<string>(REGULATOR_GROUNDS);
  return actions.filter((a) => !published.has(a.ground));
}
