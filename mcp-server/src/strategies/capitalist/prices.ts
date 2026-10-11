// Section 6's price list and section 8's profit and loss, as arithmetic over what a contract
// actually consumed.
//
// This is the module the whole doctrine leans on. Mises is the document's own citation for why:
// "without meaningful prices, planners cannot allocate scarce capital rationally", and section 6
// turns that into an operational rule — "Agents that consume scarce resources without producing
// verified value lose capital", which is unenforceable unless somebody measured the consumption.
// Before this existed, `priceTokens` was a number a bidder invented and nothing ever reconciled it
// against the run's real spend, so a firm could win on a cheap quote and burn the commons for free.
//
// Two design commitments worth stating plainly.
//
// Every line is priced in the economy's abstract token unit, the same unit bids quote in, so the
// award price and the settlement cost are commensurable. Model spend arrives in USD and is
// converted at a published rate; nothing else in the swarm needs to know that.
//
// And every line carries the basis it was computed from. Article 5 asks for *visible* costs, and a
// total with no derivation is a number the market has to take on trust — which is the opposite of a
// price. The lines are what the market report prints and what an arbitrator reads when a firm
// disputes its settlement.

import type { RiskClass } from '../../engine/types.js';

/** What one contract consumed. Assembled as the contract runs, not reconstructed afterwards. */
export interface ResourceConsumption {
  taskId: string;
  /** Model spend, in USD, across every dispatch made on this contract's behalf. */
  modelSpendUsd: number;
  promptTokens: number;
  completionTokens: number;
  /** Dispatches made for this contract. Each one occupies a context window for its duration. */
  dispatches: number;
  /** Checks and other tool invocations run against this delivery. */
  toolCalls: number;
  /** Wall-clock milliseconds from award to settlement. */
  latencyMs: number;
  /** Dispatches made by assessors rather than by the contractor — section 6's reviewer attention. */
  assessorDispatches: number;
  /** Files the delivery touched. */
  filesTouched: number;
  /** Files it created rather than edited: new surface somebody maintains from now on. */
  filesCreated: number;
  /** Contracts that depend on this one, so a defect here propagates. */
  dependants: number;
  riskClass: RiskClass;
  /** Warranty obligations the contract leaves running past acceptance. */
  openWarranties: number;
}

export function emptyConsumption(taskId: string, riskClass: RiskClass = 'low'): ResourceConsumption {
  return {
    taskId,
    modelSpendUsd: 0,
    promptTokens: 0,
    completionTokens: 0,
    dispatches: 0,
    toolCalls: 0,
    latencyMs: 0,
    assessorDispatches: 0,
    filesTouched: 0,
    filesCreated: 0,
    dependants: 0,
    riskClass,
    openWarranties: 0,
  };
}

/**
 * The published rates. Section 6 names ten things the swarm may price and this is that list, in its
 * order, with a rate against each.
 *
 * The rates are deliberately of a size that leaves settlement dominated by the contract price rather
 * than by overheads — a price list that swamps the award would make every contract a loss and the
 * exchange pointless. What matters for the doctrine is not the absolute calibration but that
 * consumption is visible, comparable between bidders, and subtracted from what a firm keeps.
 */
export interface PriceList {
  /** Abstract token units per USD of model spend. */
  usdToTokens: number;
  perThousandPromptTokens: number;
  perThousandCompletionTokens: number;
  /** Per dispatch: holding a context window is itself scarce. */
  perContextWindow: number;
  perToolCall: number;
  /** Per minute of wall clock between award and settlement. */
  perLatencyMinute: number;
  /** Per assessor dispatch. Reviewer attention is the scarcest input in the swarm. */
  perReviewerCall: number;
  /** Per file touched, multiplied by (1 + dependants): breaking a depended-on file costs more. */
  perMergeRiskFile: number;
  /** Flat, by risk class. */
  securityExposure: Record<RiskClass, number>;
  /** Per file created — new surface, maintained indefinitely. */
  perMaintainedFile: number;
  /** Per warranty still running at settlement. */
  perOpenWarranty: number;
}

export const DEFAULT_PRICE_LIST: PriceList = {
  usdToTokens: 1000,
  perThousandPromptTokens: 0.5,
  perThousandCompletionTokens: 1.5,
  perContextWindow: 0.5,
  perToolCall: 0.25,
  perLatencyMinute: 0.5,
  perReviewerCall: 3,
  perMergeRiskFile: 0.5,
  securityExposure: { low: 0, medium: 2, high: 8 },
  perMaintainedFile: 1.5,
  perOpenWarranty: 1,
};

export interface PriceLine {
  /** Section 6's own name for the scarce thing. */
  item: string;
  /** How the figure was arrived at, in plain words. Article 5 wants visible costs, not a total. */
  basis: string;
  amount: number;
}

export interface PricedConsumption {
  taskId: string;
  lines: PriceLine[];
  total: number;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Prices one contract's consumption against the published list.
 *
 * Pure, deterministic and free of model calls: a price the market cannot recompute is not a price,
 * and a settlement figure that depended on a model's opinion could not be arbitrated.
 */
export function priceConsumption(c: ResourceConsumption, list: PriceList = DEFAULT_PRICE_LIST): PricedConsumption {
  const latencyMinutes = c.latencyMs / 60_000;
  const mergeRiskFiles = c.filesTouched * (1 + Math.max(0, c.dependants));

  const lines: PriceLine[] = [
    {
      item: 'tokens',
      basis: `${c.promptTokens} prompt + ${c.completionTokens} completion tokens, and $${c.modelSpendUsd.toFixed(4)} of model spend`,
      amount:
        (c.promptTokens / 1000) * list.perThousandPromptTokens +
        (c.completionTokens / 1000) * list.perThousandCompletionTokens +
        c.modelSpendUsd * list.usdToTokens,
    },
    {
      item: 'context-window capacity',
      basis: `${c.dispatches} dispatch(es), each holding a window for its duration`,
      amount: c.dispatches * list.perContextWindow,
    },
    {
      item: 'external tool calls',
      basis: `${c.toolCalls} check or tool invocation(s)`,
      amount: c.toolCalls * list.perToolCall,
    },
    {
      item: 'wall-clock latency',
      basis: `${latencyMinutes.toFixed(1)} minute(s) from award to settlement`,
      amount: latencyMinutes * list.perLatencyMinute,
    },
    {
      item: 'reviewer attention',
      basis: `${c.assessorDispatches} assessor call(s) — the scarcest input in the swarm`,
      amount: c.assessorDispatches * list.perReviewerCall,
    },
    {
      item: 'merge risk',
      basis: `${c.filesTouched} file(s) touched with ${c.dependants} dependent contract(s)`,
      amount: mergeRiskFiles * list.perMergeRiskFile,
    },
    {
      item: 'security exposure',
      basis: `risk class ${c.riskClass}`,
      amount: list.securityExposure[c.riskClass] ?? 0,
    },
    {
      item: 'maintenance burden',
      basis: `${c.filesCreated} new file(s), maintained from now on`,
      amount: c.filesCreated * list.perMaintainedFile,
    },
    {
      item: 'future support obligations',
      basis: `${c.openWarranties} warranty/warranties still running at settlement`,
      amount: c.openWarranties * list.perOpenWarranty,
    },
  ].map((line) => ({ ...line, amount: round(Math.max(0, line.amount)) }));

  return { taskId: c.taskId, lines, total: round(lines.reduce((sum, l) => sum + l.amount, 0)) };
}

// ------------------------------------------------------------ profit and loss

export interface ProfitAndLossInput {
  taskId: string;
  personaId: string;
  /** What the contract was awarded. */
  contractPrice: number;
  /** Held back against the warranty, so not yet earned. */
  escrowWithheld: number;
  /** Whether the delivery passed acceptance. Section 8: loss occurs when work fails acceptance. */
  verified: boolean;
  resourceCost: number;
  /** Warranty claims, chargebacks and priced obligations the firm still carries. */
  liabilities: number;
}

export interface ProfitAndLoss {
  taskId: string;
  personaId: string;
  verifiedValue: number;
  resourceCost: number;
  liabilities: number;
  profit: number;
  rationale: string;
}

/**
 * Section 8: "Profit is verified value minus consumed resources and liabilities."
 *
 * The word doing the work is *verified*. A contract that failed acceptance produced no value, so its
 * consumption is a straight loss — which is section 6's rule that agents who "consume scarce
 * resources without producing verified value lose capital", and section 8's own list of what causes
 * loss, beginning with "work fails acceptance".
 *
 * Escrow is withheld rather than lost. It is value the firm has earned but cannot draw until the
 * warranty period passes, so it does not count toward this settlement's profit and does not count
 * against it either.
 *
 * Note what cannot appear in this function's inputs: a commit count, a line count, a task count.
 * Section 8 closes by ruling all three out, and the way to hold that is for the arithmetic to have
 * no term they could enter through.
 */
export function profitAndLoss(input: ProfitAndLossInput): ProfitAndLoss {
  const verifiedValue = input.verified ? Math.max(0, input.contractPrice - input.escrowWithheld) : 0;
  const profit = round(verifiedValue - input.resourceCost - input.liabilities);

  const rationale = input.verified
    ? `Verified value ${verifiedValue.toFixed(2)} less resources ${input.resourceCost.toFixed(2)} and liabilities ` +
      `${input.liabilities.toFixed(2)} leaves ${profit >= 0 ? 'a profit' : 'a loss'} of ${Math.abs(profit).toFixed(2)}.`
    : `The contract produced no verified value, so its consumption of ${input.resourceCost.toFixed(2)} and liabilities ` +
      `of ${input.liabilities.toFixed(2)} fall on ${input.personaId} as a loss of ${Math.abs(profit).toFixed(2)}.`;

  return {
    taskId: input.taskId,
    personaId: input.personaId,
    verifiedValue: round(verifiedValue),
    resourceCost: round(input.resourceCost),
    liabilities: round(input.liabilities),
    profit,
    rationale,
  };
}

/** The price list as config allows it to be overridden, falling back line by line. */
export function resolvePriceList(raw: Partial<PriceList> | undefined): PriceList {
  return {
    ...DEFAULT_PRICE_LIST,
    ...(raw ?? {}),
    securityExposure: { ...DEFAULT_PRICE_LIST.securityExposure, ...(raw?.securityExposure ?? {}) },
  };
}
