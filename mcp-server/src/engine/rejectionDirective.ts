import type { TestResult } from './types.js';

/**
 * Turns a doctrine's rejection into a rework directive the next attempt can act on.
 *
 * A decision rationale frequently records the procedure rather than the defect — "Opposition raised
 * a high-severity reject. Blocks approval regardless of the vote (the division 0.50)" names no file,
 * no test and no fix. The concrete evidence — failing check output, every blocking review finding,
 * the reverted attempt itself — reaches the implementer through the engine's repair brief
 * (engine/repairBrief.ts), identically for every doctrine, so it is not pasted here a second time.
 * The directive keeps the doctrine's verdict — its repairDirective when it supplied one, else its
 * rationale — and names the checks it must turn green.
 */
export function rejectionRequiredChanges(lead: string | readonly string[], test: TestResult): string[] {
  const changes = (typeof lead === 'string' ? [lead] : [...lead]).map((line) => line.trim());
  for (const check of test.checks ?? []) {
    changes.push(check.status === 'new'
      ? `Failing check: ${check.categoryId} (passed before this change)`
      : `Failing check: ${check.categoryId} (required, still failing)`);
  }
  return [...new Set(changes.filter((change) => change.length > 0))];
}
