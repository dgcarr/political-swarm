import { EventEmitter } from 'node:events';
import type { LedgerEntry } from './Ledger.js';
import type { RunState } from './RunStore.js';

// In-process notification layer over the writes that already happen on disk. The ledger and
// state files remain the source of truth; this only saves readers from polling them. Nothing
// in the engine depends on a subscriber existing, so the bus is optional everywhere.

/**
 * Where an event came from.
 *
 * 'engine' is this process writing the record. 'watch' is a tailer noticing another process's
 * write — the benchmark harness runs out-of-process, so its runs are only visible that way.
 * A run written by this process produces both, so consumers must prefer 'engine' and ignore
 * 'watch' for runs they already hear about directly.
 */
export type EventSource = 'engine' | 'watch';

export interface LedgerEvent {
  kind: 'ledger';
  runId: string;
  entry: LedgerEntry;
  source?: EventSource;
}

export interface StateEvent {
  kind: 'state';
  runId: string;
  state: RunState;
  source?: EventSource;
}

export type SwarmEvent = LedgerEvent | StateEvent;

export type SwarmEventListener = (event: SwarmEvent) => void;

const CHANNEL = 'swarm';

export class EventBus {
  private readonly emitter = new EventEmitter();
  private readonly wrappers = new Map<SwarmEventListener, SwarmEventListener>();

  constructor() {
    // Above any plausible number of concurrent dashboard tabs, but finite: the warning at 64 is
    // the cheapest detector we have for a subscriber that never unsubscribes on a long-lived
    // MCP server.
    this.emitter.setMaxListeners(64);
  }

  /**
   * Never throws and never lets one subscriber's failure reach another. Producers call this from
   * inside the engine's hot path, where an exception would abort a swarm run over a dead browser
   * tab.
   */
  publish(event: SwarmEvent): void {
    this.emitter.emit(CHANNEL, event);
  }

  /**
   * Returns an unsubscribe function. Calling it twice is harmless, and subscribing the same
   * listener twice is a no-op rather than a silent double-delivery-and-half-leak.
   */
  subscribe(listener: SwarmEventListener): () => void {
    if (this.wrappers.has(listener)) return () => this.unsubscribe(listener);

    const wrapped: SwarmEventListener = (event) => {
      try {
        listener(event);
      } catch (err) {
        // Swallowed deliberately — see publish(). Logged, not rethrown.
        process.stderr.write(
          JSON.stringify({
            ts: new Date().toISOString(),
            level: 'warn',
            msg: 'EventBus subscriber threw',
            error: err instanceof Error ? err.message : String(err),
          }) + '\n',
        );
      }
    };
    this.wrappers.set(listener, wrapped);
    this.emitter.on(CHANNEL, wrapped);
    return () => this.unsubscribe(listener);
  }

  unsubscribe(listener: SwarmEventListener): void {
    const wrapped = this.wrappers.get(listener);
    if (!wrapped) return;
    this.emitter.off(CHANNEL, wrapped);
    this.wrappers.delete(listener);
  }

  /** Diagnostic for the leak gate — see Phase 2 of the dashboard TODO. */
  listenerCount(): number {
    return this.emitter.listenerCount(CHANNEL);
  }
}
