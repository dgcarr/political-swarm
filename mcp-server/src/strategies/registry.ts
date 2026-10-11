// The one place a governance model is registered. Adding a doctrine means: a StrategyId member in
// engine/types.ts, a SwarmStrategy implementation, a section schema in constitution/schema.ts, and
// an entry here — the Record type makes the compiler refuse a StrategyId with no registration.
// The MCP server, swarm_start's accepted strategies and the benchmark all read this table.

import type { SwarmStrategy } from '../engine/SwarmStrategy.js';
import type { StrategyId } from '../engine/types.js';
import { CapitalistStrategy } from './capitalist/CapitalistStrategy.js';
import { DemocraticStrategy } from './democratic/DemocraticStrategy.js';
import { ManagerialStrategy } from './managerial/ManagerialStrategy.js';
import { NoopStrategy } from './noop/NoopStrategy.js';
import { SingleAgentStrategy } from './singleAgent/SingleAgentStrategy.js';
import { SocialistStrategy } from './socialist/SocialistStrategy.js';

export interface StrategyRegistration {
  create(): SwarmStrategy;
  /** A doctrine governs through its own institutions; a control is a benchmark baseline; noop is engine plumbing. */
  kind: 'doctrine' | 'control' | 'test';
  /** Offered to users through swarm_start. */
  startable: boolean;
  /** Run by the benchmark's default sweep. */
  benchmarked: boolean;
  /** Must pass the benchmark's offline release gate. */
  releaseGate: boolean;
}

export const STRATEGY_REGISTRY: Record<StrategyId, StrategyRegistration> = {
  democratic: { create: () => new DemocraticStrategy(), kind: 'doctrine', startable: true, benchmarked: true, releaseGate: true },
  socialist: { create: () => new SocialistStrategy(), kind: 'doctrine', startable: true, benchmarked: true, releaseGate: true },
  capitalist: { create: () => new CapitalistStrategy(), kind: 'doctrine', startable: true, benchmarked: true, releaseGate: true },
  managerial: { create: () => new ManagerialStrategy(), kind: 'control', startable: false, benchmarked: true, releaseGate: true },
  single_agent: { create: () => new SingleAgentStrategy(), kind: 'control', startable: false, benchmarked: true, releaseGate: false },
  noop: { create: () => new NoopStrategy(), kind: 'test', startable: false, benchmarked: false, releaseGate: false },
};

const ids = (keep: (registration: StrategyRegistration) => boolean): StrategyId[] =>
  (Object.keys(STRATEGY_REGISTRY) as StrategyId[]).filter((id) => keep(STRATEGY_REGISTRY[id]));

export const STARTABLE_STRATEGIES = ids((r) => r.startable) as [StrategyId, ...StrategyId[]];
export const BENCHMARK_STRATEGIES = ids((r) => r.benchmarked);
export const RELEASE_GATE_STRATEGIES = ids((r) => r.releaseGate);

/** A fresh instance of every registered strategy. */
export function buildStrategies(): Record<StrategyId, SwarmStrategy> {
  return Object.fromEntries(
    (Object.keys(STRATEGY_REGISTRY) as StrategyId[]).map((id) => [id, STRATEGY_REGISTRY[id].create()]),
  ) as Record<StrategyId, SwarmStrategy>;
}
