import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONTRACT_POLICY,
  deliveryMissedDeadline,
  hasMeasurableCriterion,
  overSpendCap,
  payableRevenue,
  resolveContractPolicy,
  retentionFor,
  selectContractType,
  type SelectionInput,
} from './contracts.js';
import { buildListing } from './exchange.js';
import type { TaskNode } from '../../engine/types.js';

function listing(over: Partial<TaskNode> = {}) {
  return buildListing({
    id: 't1',
    title: 'Add an endpoint',
    description: 'Add a backend API route',
    acceptanceCriteria: ['it responds'],
    dependsOn: [],
    targetGlobs: ['src/api/**'],
    riskTags: [],
    riskClass: 'low',
    phase: 'queued',
    attempts: [],
    ...over,
  } as TaskNode);
}

function input(over: Partial<SelectionInput> = {}): SelectionInput {
  return {
    listing: listing(),
    scopeUnderstood: true,
    hasMeasurableCriterion: false,
    tournamentRequested: false,
    ...over,
  };
}

describe('choosing the contract shape', () => {
  it('pays time and materials on verified use within its cap, not the quoted fixed price', () => {
    const terms = selectContractType(input({ scopeUnderstood: false }));
    expect(payableRevenue(terms, 100, 20)).toBe(22);
    expect(payableRevenue(terms, 100, 500)).toBe(200);
    expect(payableRevenue(selectContractType(input()), 100, 20)).toBe(100);
  });
  it('gives a clearly scoped delivery a fixed price', () => {
    const terms = selectContractType(input());
    expect(terms.type).toBe('fixed-price');
    expect(terms.competingSuppliers).toBe(1);
  });

  // Section 8: warranty contracts are best for production changes, migrations and
  // security-sensitive work. It is checked first so nothing can route security work into a lighter
  // shape — the safety floor is not something a cheaper contract may trade away.
  it('puts high-risk work on a warranty contract before considering anything else', () => {
    const terms = selectContractType(
      input({ listing: listing({ riskClass: 'high' }), scopeUnderstood: false, hasMeasurableCriterion: true }),
    );
    expect(terms.type).toBe('warranty');
  });

  it('holds back more, and for longer, on a warranty contract', () => {
    const routine = selectContractType(input());
    const warranted = selectContractType(input({ listing: listing({ riskClass: 'high' }) }));
    expect(warranted.retentionFraction).toBeGreaterThan(routine.retentionFraction);
    expect(warranted.warrantyPeriodTasks).toBeGreaterThan(routine.warrantyPeriodTasks);
  });

  // A fixed price on work nobody can size is a fixed price on a guess, and section 8's warning
  // about quality "reduced to preserve margin" is what happens next.
  it('puts work of unknown scope on time and materials', () => {
    const terms = selectContractType(input({ scopeUnderstood: false }));
    expect(terms.type).toBe('time-and-materials');
  });

  // Section 8's stated risk for this shape is a weak incentive to finish. A cap is the only term
  // that answers it, so the shape is not allowed to exist without one.
  it('never issues time and materials without a cap', () => {
    const terms = selectContractType(input({ scopeUnderstood: false }));
    expect(terms.spendCapMultiple).toBeGreaterThan(0);
  });

  it('puts a measurable criterion on an outcome contract', () => {
    const terms = selectContractType(input({ hasMeasurableCriterion: true }), {
      ...DEFAULT_CONTRACT_POLICY, outcomeContractsEnabled: true,
    });
    expect(terms.type).toBe('outcome');
    expect(terms.risk).toContain('Metric gaming');
  });

  it('does not silently select outcome payment without evaluator-owned baselines', () => {
    expect(selectContractType(input({ hasMeasurableCriterion: true })).type).toBe('fixed-price');
  });

  it('prefers time and materials over an outcome contract when the scope is unknown', () => {
    const terms = selectContractType(input({ scopeUnderstood: false, hasMeasurableCriterion: true }));
    expect(terms.type).toBe('time-and-materials');
  });

  // Duplicate production is a breach unless it was commissioned. A tournament is the commissioning.
  it('commissions competing suppliers only for a tournament, and only when asked', () => {
    const off = selectContractType(input({ tournamentRequested: true }));
    expect(off.type).not.toBe('tournament');

    const on = selectContractType(input({ tournamentRequested: true }), {
      ...DEFAULT_CONTRACT_POLICY,
      tournamentsEnabled: true,
    });
    expect(on.type).toBe('tournament');
    expect(on.competingSuppliers).toBeGreaterThan(1);
  });

  // Section 8 is candid that a tournament's risk is duplicated expenditure, and a metered swarm
  // pays it every time. Off unless a deployment says otherwise.
  it('keeps tournaments off by default', () => {
    expect(DEFAULT_CONTRACT_POLICY.tournamentsEnabled).toBe(false);
  });

  it('states the risk and the reasoning for every shape it can issue', () => {
    const shapes = [
      selectContractType(input()),
      selectContractType(input({ listing: listing({ riskClass: 'high' }) })),
      selectContractType(input({ scopeUnderstood: false })),
      selectContractType(input({ hasMeasurableCriterion: true }), { ...DEFAULT_CONTRACT_POLICY, outcomeContractsEnabled: true }),
      selectContractType(input({ tournamentRequested: true }), { ...DEFAULT_CONTRACT_POLICY, tournamentsEnabled: true }),
    ];
    expect(new Set(shapes.map((s) => s.type)).size).toBe(5);
    for (const shape of shapes) {
      expect(shape.risk.trim().length, shape.type).toBeGreaterThan(0);
      expect(shape.rationale.trim().length, shape.type).toBeGreaterThan(0);
    }
  });
});

describe('spotting a measurable criterion', () => {
  it('recognises a stated improvement', () => {
    expect(hasMeasurableCriterion(['reduces latency by 20%'])).toBe(true);
    expect(hasMeasurableCriterion(['completes in under 200ms'])).toBe(true);
    expect(hasMeasurableCriterion(['fewer than 3 allocations per call'])).toBe(true);
  });

  // The narrowness is the point. "Returns 200" contains a number and is a behaviour; paying against
  // it would put the contract on a metric nobody chose as a target, which is how gaming starts.
  it('does not mistake a number in a behaviour for a target', () => {
    expect(hasMeasurableCriterion(['the endpoint returns 200 on success'])).toBe(false);
    expect(hasMeasurableCriterion(['isEven(2) returns true'])).toBe(false);
  });

  it('says no to criteria with no quantity at all', () => {
    expect(hasMeasurableCriterion(['it works', 'the README documents it'])).toBe(false);
    expect(hasMeasurableCriterion([])).toBe(false);
  });

  it('needs the quantity to belong to the comparison, not merely appear somewhere', () => {
    expect(hasMeasurableCriterion(['improves the wording'])).toBe(false);
  });
});

describe('what settlement actually withholds', () => {
  it('withholds the shape’s retention, not the run’s default', () => {
    const warranted = selectContractType(input({ listing: listing({ riskClass: 'high' }) }));
    const routine = selectContractType(input());
    expect(retentionFor(warranted, 100)).toBeGreaterThan(retentionFor(routine, 100));
  });

  it('withholds nothing from a price of nothing', () => {
    expect(retentionFor(selectContractType(input()), 0)).toBe(0);
  });

  it('cannot withhold more than the price', () => {
    const terms = { ...selectContractType(input()), retentionFraction: 5 };
    expect(retentionFor(terms, 100)).toBe(100);
  });
});

describe('the time-and-materials cap', () => {
  const tAndM = selectContractType(input({ scopeUnderstood: false }));

  it('is not breached inside the cap', () => {
    expect(overSpendCap(tAndM, 100, 150)).toBe(false);
  });

  it('is breached past it', () => {
    expect(overSpendCap(tAndM, 100, 250)).toBe(true);
  });

  // A shape without a cap should say so rather than imply a limit it does not have.
  it('never reports a breach for a shape that has no cap', () => {
    expect(overSpendCap(selectContractType(input()), 100, 10_000)).toBe(false);
  });

  it('does not divide by a zero price', () => {
    expect(overSpendCap(tAndM, 0, 10)).toBe(false);
  });
});

describe('contract delivery deadline', () => {
  it('uses the delivery time, not the later buyer review time', () => {
    const awarded = 1_000_000;
    expect(deliveryMissedDeadline(awarded, awarded + 10 * 60_000, 10)).toBe(false);
    expect(deliveryMissedDeadline(awarded, awarded + 10 * 60_000 + 1, 10)).toBe(true);
  });

  it('does not invent a breach for old snapshots missing the delivery timestamp', () => {
    expect(deliveryMissedDeadline(1_000_000, undefined, 10)).toBe(false);
  });
});

describe('policy overrides', () => {
  it('takes an override without losing the rest of the policy', () => {
    const policy = resolveContractPolicy({ warrantyRetention: 0.9 });
    expect(policy.warrantyRetention).toBe(0.9);
    expect(policy.baseRetention).toBe(DEFAULT_CONTRACT_POLICY.baseRetention);
  });

  it('refuses unsupported outcome and tournament mechanisms at runtime', () => {
    expect(() => resolveContractPolicy({ outcomeContractsEnabled: true })).toThrow('unavailable');
    expect(() => resolveContractPolicy({ tournamentsEnabled: true })).toThrow('unavailable');
  });
});
