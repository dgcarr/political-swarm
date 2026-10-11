import { describe, expect, it } from 'vitest';
import { endedWithARecordedReason } from './harness.js';

// Three bugs in a row on this branch were the same shape: a legitimate ending going unrecognised,
// and the smoke test failing a run where the doctrine had behaved correctly. Two of them were only
// caught because a nondeterministic run happened to reach the ending nobody had thought about.
//
// So the rule is tested here rather than left to luck. A smoke run reaches one ending per
// invocation and cannot be made to choose; this covers all of them every time.
describe('which endings count as the run having said why it stopped', () => {
  // Article 12: the human holds spend approval over high-risk work, and a market that stops for
  // them is the doctrine working. This is the ending that broke the first version of the check.
  it('accepts a pause for human approval', () => {
    expect(endedWithARecordedReason('paused_human')).toBe(true);
  });

  // The swarm refusing its own work under its own acceptance rules. This is the ending that broke
  // the second version — it records terminated_incomplete, not any of the events that version
  // looked for.
  it('accepts an incomplete run that carries its reason', () => {
    expect(endedWithARecordedReason('terminated_incomplete', 'The swarm rejected 1 of 1 task(s).')).toBe(true);
  });

  it('accepts an outright failure', () => {
    expect(endedWithARecordedReason('failed')).toBe(true);
  });

  // The teeth. An incomplete run that cannot say why it stopped is exactly the silence the whole
  // doctrine is against — a market that conceals its losses cannot price anything.
  it('refuses an incomplete run that says nothing', () => {
    expect(endedWithARecordedReason('terminated_incomplete')).toBe(false);
    expect(endedWithARecordedReason('terminated_incomplete', '')).toBe(false);
    expect(endedWithARecordedReason('terminated_incomplete', '   ')).toBe(false);
  });

  // A run still going has not ended at all, and a delivered run is judged on its delivery instead.
  // Neither is an excuse for having filed no account.
  it('refuses a run that has not finished, or that finished with a delivery to judge', () => {
    expect(endedWithARecordedReason('running')).toBe(false);
    expect(endedWithARecordedReason('awaiting_acceptance')).toBe(false);
    expect(endedWithARecordedReason('completed')).toBe(false);
  });
});
