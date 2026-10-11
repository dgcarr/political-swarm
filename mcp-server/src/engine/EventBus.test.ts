import { describe, expect, it, vi } from 'vitest';
import { EventBus, type SwarmEvent } from './EventBus.js';
import type { LedgerEntry } from './Ledger.js';

function ledgerEvent(type: string): SwarmEvent {
  const entry: LedgerEntry = { ts: '2026-01-01T00:00:00.000Z', runId: 'run-1', strategy: 'democratic', type, data: {} };
  return { kind: 'ledger', runId: 'run-1', entry };
}

describe('EventBus', () => {
  it('delivers events to every subscriber', () => {
    const bus = new EventBus();
    const a = vi.fn();
    const b = vi.fn();
    bus.subscribe(a);
    bus.subscribe(b);

    bus.publish(ledgerEvent('plan_created'));

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(a.mock.calls[0][0]).toMatchObject({ kind: 'ledger', entry: { type: 'plan_created' } });
  });

  it('stops delivering after unsubscribe, via either the returned function or the method', () => {
    const bus = new EventBus();
    const viaReturn = vi.fn();
    const viaMethod = vi.fn();
    const off = bus.subscribe(viaReturn);
    bus.subscribe(viaMethod);

    bus.publish(ledgerEvent('one'));
    off();
    bus.unsubscribe(viaMethod);
    bus.publish(ledgerEvent('two'));

    expect(viaReturn).toHaveBeenCalledTimes(1);
    expect(viaMethod).toHaveBeenCalledTimes(1);
    expect(bus.listenerCount()).toBe(0);
  });

  it('tolerates unsubscribing twice, or unsubscribing something never subscribed', () => {
    const bus = new EventBus();
    const off = bus.subscribe(vi.fn());
    off();
    expect(() => off()).not.toThrow();
    expect(() => bus.unsubscribe(vi.fn())).not.toThrow();
    expect(bus.listenerCount()).toBe(0);
  });

  it('does not let a throwing subscriber reach the publisher or its siblings', () => {
    const bus = new EventBus();
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const after = vi.fn();

    bus.subscribe(() => {
      throw new Error('dead browser tab');
    });
    bus.subscribe(after);

    expect(() => bus.publish(ledgerEvent('worker_call'))).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
    expect(stderr).toHaveBeenCalled();

    stderr.mockRestore();
  });

  it('treats a repeated subscribe of the same listener as a no-op', () => {
    const bus = new EventBus();
    const listener = vi.fn();
    bus.subscribe(listener);
    bus.subscribe(listener);

    expect(bus.listenerCount()).toBe(1);
    bus.publish(ledgerEvent('worker_call'));
    expect(listener).toHaveBeenCalledTimes(1);

    bus.unsubscribe(listener);
    expect(bus.listenerCount()).toBe(0);
  });

  it('publishing with no subscribers is a no-op', () => {
    const bus = new EventBus();
    expect(() => bus.publish(ledgerEvent('worker_call'))).not.toThrow();
    expect(bus.listenerCount()).toBe(0);
  });

  it('keeps the listener count flat across repeated subscribe/unsubscribe cycles', () => {
    const bus = new EventBus();
    for (let i = 0; i < 100; i += 1) {
      const off = bus.subscribe(vi.fn());
      off();
    }
    expect(bus.listenerCount()).toBe(0);
  });
});
