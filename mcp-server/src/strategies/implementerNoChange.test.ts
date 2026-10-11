import { describe, it, expect } from 'vitest';
import { ImplementerOutputSchema } from './capitalist/types.js';
import { validateImplementerOutput as democratic } from './democratic/prompts.js';
import { validateImplementerOutput as managerial } from './managerial/prompts.js';
import { validateImplementerOutput as singleAgent } from './singleAgent/prompts.js';
import { validateImplementerResponse as socialist } from './socialist/types.js';

// A task whose files already meet it, or that only reads inputs, has nothing to write. Requiring
// a file op sent such answers through three corrective retries and the fallback model, or got a
// supplied data file rewritten just to return something. Every doctrine accepts "no change" alike.
describe('implementer "no change" answer', () => {
  const noChange = { fileOps: [], rationale: 'The owned files already meet every criterion.', filesChanged: [], unresolvedUncertainty: 'none' };

  it('is valid in all five doctrines', () => {
    expect(() => democratic(structuredClone(noChange))).not.toThrow();
    expect(() => managerial(structuredClone(noChange))).not.toThrow();
    expect(() => singleAgent(structuredClone(noChange))).not.toThrow();
    expect(() => socialist(structuredClone(noChange))).not.toThrow();
    expect(ImplementerOutputSchema.safeParse(noChange).success).toBe(true);
  });

  it('still requires a fileOps array', () => {
    const missing = { rationale: 'r', filesChanged: [], unresolvedUncertainty: 'none' };
    expect(() => democratic({ ...missing })).toThrow(/fileOps/);
    expect(() => managerial({ ...missing })).toThrow(/fileOps/);
    expect(() => singleAgent({ ...missing })).toThrow(/fileOps/);
    expect(() => socialist({ ...missing })).toThrow(/fileOps/);
    expect(ImplementerOutputSchema.safeParse(missing).success).toBe(false);
  });
});
