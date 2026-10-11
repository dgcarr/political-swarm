import { describe, expect, it } from 'vitest';
import { CONFIGURED_STRATEGIES } from '../constitution/articles.js';
import { swarmStartInputShape } from '../tools/swarmStart.js';
import { BENCHMARK_STRATEGIES, buildStrategies, STARTABLE_STRATEGIES, STRATEGY_REGISTRY } from './registry.js';

describe('strategy registry', () => {
  it('builds every registered strategy under its own id', () => {
    const built = buildStrategies();
    for (const id of Object.keys(STRATEGY_REGISTRY)) expect(built[id as keyof typeof built].id).toBe(id);
  });

  it('gives every doctrine and control a constitution, and nothing else one', () => {
    const governed = Object.entries(STRATEGY_REGISTRY).filter(([, r]) => r.kind !== 'test').map(([id]) => id);
    expect(governed.sort()).toEqual([...CONFIGURED_STRATEGIES].sort());
  });

  it('offers users exactly the doctrines, and benchmarks doctrines against the controls', () => {
    expect(STARTABLE_STRATEGIES).toEqual(['democratic', 'socialist', 'capitalist']);
    expect(swarmStartInputShape.strategy.options).toEqual(STARTABLE_STRATEGIES);
    expect(BENCHMARK_STRATEGIES).toEqual(['democratic', 'socialist', 'capitalist', 'managerial', 'single_agent']);
  });
});
