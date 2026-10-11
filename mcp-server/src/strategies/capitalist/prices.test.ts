import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PRICE_LIST,
  emptyConsumption,
  priceConsumption,
  profitAndLoss,
  resolvePriceList,
  type ResourceConsumption,
} from './prices.js';

function consumption(over: Partial<ResourceConsumption> = {}): ResourceConsumption {
  return { ...emptyConsumption('t1'), ...over };
}

describe('the published price list', () => {
  // Section 6 names ten scarce things. A price list that quietly dropped one would leave that
  // resource free, which is the calculation problem the doctrine cites Mises about.
  it('prices every item section 6 names', () => {
    const priced = priceConsumption(consumption());
    expect(priced.lines.map((l) => l.item)).toEqual([
      'tokens',
      'context-window capacity',
      'external tool calls',
      'wall-clock latency',
      'reviewer attention',
      'merge risk',
      'security exposure',
      'maintenance burden',
      'future support obligations',
    ]);
  });

  it('costs a contract that consumed nothing at nothing', () => {
    expect(priceConsumption(consumption()).total).toBe(0);
  });

  // Article 5 asks for visible costs. A bare total is a number the market has to take on trust,
  // which is the opposite of a price.
  it('shows the basis of every line, so a settlement can be argued with', () => {
    const priced = priceConsumption(consumption({ promptTokens: 2000, dispatches: 3 }));
    for (const line of priced.lines) {
      expect(line.basis.trim().length, line.item).toBeGreaterThan(0);
    }
    expect(priced.lines.find((l) => l.item === 'tokens')?.basis).toContain('2000 prompt');
  });

  it('totals exactly what the lines add up to', () => {
    const priced = priceConsumption(
      consumption({ promptTokens: 4000, completionTokens: 1000, dispatches: 2, toolCalls: 4, assessorDispatches: 1 }),
    );
    const summed = priced.lines.reduce((s, l) => s + l.amount, 0);
    expect(priced.total).toBeCloseTo(summed, 2);
  });

  it('converts model spend into the unit bids quote in', () => {
    const priced = priceConsumption(consumption({ modelSpendUsd: 0.01 }));
    expect(priced.lines.find((l) => l.item === 'tokens')?.amount).toBeCloseTo(0.01 * DEFAULT_PRICE_LIST.usdToTokens, 2);
  });

  it('prices reviewer attention above an ordinary dispatch, being the scarcer input', () => {
    const reviewed = priceConsumption(consumption({ assessorDispatches: 1 })).total;
    const dispatched = priceConsumption(consumption({ dispatches: 1 })).total;
    expect(reviewed).toBeGreaterThan(dispatched);
  });

  // Merge risk is the doctrine's externality made visible: the same edit costs more where other
  // contracts depend on it, because that is where a defect actually propagates.
  it('charges more for touching a file other contracts depend on', () => {
    const isolated = priceConsumption(consumption({ filesTouched: 2, dependants: 0 })).total;
    const depended = priceConsumption(consumption({ filesTouched: 2, dependants: 3 })).total;
    expect(depended).toBeGreaterThan(isolated);
  });

  it('prices security exposure by risk class, rising', () => {
    const low = priceConsumption(consumption({ riskClass: 'low' })).total;
    const medium = priceConsumption(consumption({ riskClass: 'medium' })).total;
    const high = priceConsumption(consumption({ riskClass: 'high' })).total;
    expect(high).toBeGreaterThan(medium);
    expect(medium).toBeGreaterThan(low);
  });

  it('charges new files, not edits, for maintenance burden', () => {
    const created = priceConsumption(consumption({ filesCreated: 3 }));
    expect(created.lines.find((l) => l.item === 'maintenance burden')?.amount).toBeGreaterThan(0);
    const edited = priceConsumption(consumption({ filesTouched: 3, filesCreated: 0 }));
    expect(edited.lines.find((l) => l.item === 'maintenance burden')?.amount).toBe(0);
  });

  it('never returns a negative line, whatever nonsense it is handed', () => {
    const priced = priceConsumption(consumption({ dispatches: -5, filesTouched: -2, latencyMs: -1000 }));
    for (const line of priced.lines) expect(line.amount).toBeGreaterThanOrEqual(0);
  });

  it('lets config override a rate without losing the rest of the list', () => {
    const list = resolvePriceList({ perReviewerCall: 99 });
    expect(list.perReviewerCall).toBe(99);
    expect(list.perToolCall).toBe(DEFAULT_PRICE_LIST.perToolCall);
    expect(list.securityExposure.high).toBe(DEFAULT_PRICE_LIST.securityExposure.high);
  });

  it('lets config override one risk band without flattening the others', () => {
    const list = resolvePriceList({ securityExposure: { high: 50 } as never });
    expect(list.securityExposure.high).toBe(50);
    expect(list.securityExposure.medium).toBe(DEFAULT_PRICE_LIST.securityExposure.medium);
  });
});

describe('profit and loss', () => {
  const base = {
    taskId: 't1',
    personaId: 'firm-a',
    contractPrice: 100,
    escrowWithheld: 20,
    verified: true,
    resourceCost: 30,
    liabilities: 0,
  };

  it('is verified value less resources and liabilities', () => {
    expect(profitAndLoss(base).profit).toBe(50);
  });

  it('treats escrow as withheld rather than lost — it is earned, not yet drawable', () => {
    expect(profitAndLoss(base).verifiedValue).toBe(80);
  });

  // The word doing the work in section 8 is "verified". Work that failed acceptance produced no
  // value, so what it burned is a straight loss.
  it('gives unverified work no value at all, so its consumption is a loss', () => {
    const result = profitAndLoss({ ...base, verified: false });
    expect(result.verifiedValue).toBe(0);
    expect(result.profit).toBe(-30);
    expect(result.rationale).toContain('no verified value');
  });

  it('subtracts liabilities the firm still carries', () => {
    expect(profitAndLoss({ ...base, liabilities: 25 }).profit).toBe(25);
  });

  it('reports a loss when consumption outran the contract price', () => {
    const result = profitAndLoss({ ...base, resourceCost: 200 });
    expect(result.profit).toBeLessThan(0);
    expect(result.rationale).toContain('a loss');
  });

  it('never turns escrow larger than the price into negative value', () => {
    expect(profitAndLoss({ ...base, escrowWithheld: 500 }).verifiedValue).toBe(0);
  });

  // Section 8 closes by ruling out commits, code volume and task count as measures of profit. The
  // way to hold that is for the arithmetic to have no term any of them could enter through: writing
  // more files can only ever cost more, never earn more.
  it('cannot be increased by producing more code', () => {
    const lean = priceConsumption(consumption({ filesTouched: 1, filesCreated: 1 }));
    const voluminous = priceConsumption(consumption({ filesTouched: 40, filesCreated: 40 }));
    const leanProfit = profitAndLoss({ ...base, resourceCost: lean.total }).profit;
    const voluminousProfit = profitAndLoss({ ...base, resourceCost: voluminous.total }).profit;

    expect(voluminousProfit).toBeLessThan(leanProfit);
  });
});
