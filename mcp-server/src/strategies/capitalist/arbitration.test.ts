import { describe, expect, it } from 'vitest';
import {
  applyRuling,
  detectDisputes,
  rulingIsGrounded,
  supplierPrevailed,
  validateRuling,
  type Dispute,
  type DisputeInput,
  type WireRuling,
} from './arbitration.js';

function input(over: Partial<DisputeInput> = {}): DisputeInput {
  return {
    taskId: 't1',
    personaId: 'firm-a',
    reviewerVerdict: 'approve',
    scopeFlagged: false,
    scopePaths: [],
    testRan: true,
    testPassed: true,
    looksLikeInfraFailure: false,
    ...over,
  };
}

function ruling(over: Partial<WireRuling> = {}): WireRuling {
  return {
    ruling: 'supplier',
    rationale: 'The output shows the runner never started.',
    liableParty: 'buyer',
    evidenceCited: ['test.js', 'npm test output'],
    ...over,
  };
}

function dispute(over: Partial<Dispute> = {}): Dispute {
  return {
    matter: 'regression-cause',
    taskId: 't1',
    buyerPosition: 'b',
    supplierPosition: 's',
    evidence: ['x'],
    ...over,
  };
}

describe('what counts as a dispute', () => {
  it('finds nothing to litigate in a clean settlement', () => {
    expect(detectDisputes(input())).toEqual([]);
  });

  // A delivery both parties agree failed is not a dispute, it is a failure. Sending it to
  // arbitration would spend a model call to confirm what nobody contests.
  it('does not litigate a failure nobody contests', () => {
    expect(detectDisputes(input({ reviewerVerdict: 'reject', testPassed: false }))).toEqual([]);
  });

  // Section 6's "who caused a regression". Both readings are available from the same output, which
  // is what makes it a dispute rather than a fact — and it was previously settled by a regular
  // expression on behalf of the party it favours.
  it('raises the regression-cause dispute when a check fails in a way that may be the environment', () => {
    const [d] = detectDisputes(input({ testPassed: false, looksLikeInfraFailure: true, testOutput: 'spawn npm ENOENT' }));
    expect(d.matter).toBe('regression-cause');
    expect(d.buyerPosition).toContain('unproven');
    expect(d.supplierPosition).toContain('environment');
    expect(d.evidence.join(' ')).toContain('ENOENT');
  });

  it('keeps the end of a long check output as evidence, where the runner reports why it stopped', () => {
    const testOutput = `${'> npm test\n'.repeat(80)}Error: spawn pytest ENOENT`;
    const [d] = detectDisputes(input({ testPassed: false, looksLikeInfraFailure: true, testOutput }));
    expect(d.evidence.join(' ')).toContain('spawn pytest ENOENT');
  });

  it('does not raise it when the check genuinely failed on its assertions', () => {
    const disputes = detectDisputes(input({ testPassed: false, looksLikeInfraFailure: false }));
    expect(disputes.map((d) => d.matter)).not.toContain('regression-cause');
  });

  it('raises the scope dispute when the reviewer accepted work the regulator flagged', () => {
    const [d] = detectDisputes(input({ scopeFlagged: true, scopePaths: ['deploy/prod.yaml'] }));
    expect(d.matter).toBe('scope-change');
    expect(d.buyerPosition).toContain('deploy/prod.yaml');
  });

  it('leaves an uncontested scope breach to the regulator', () => {
    const disputes = detectDisputes(input({ scopeFlagged: true, scopePaths: ['x'], reviewerVerdict: 'reject' }));
    expect(disputes.map((d) => d.matter)).not.toContain('scope-change');
  });

  it('can raise more than one matter from a single settlement', () => {
    const disputes = detectDisputes(
      input({ testPassed: false, looksLikeInfraFailure: true, scopeFlagged: true, scopePaths: ['x'] }),
    );
    expect(disputes.map((d) => d.matter)).toEqual(['regression-cause', 'scope-change']);
  });
});

describe('validating a ruling', () => {
  it('accepts a well-formed ruling', () => {
    expect(() => validateRuling(ruling())).not.toThrow();
  });

  it('rejects a ruling that decided nothing', () => {
    expect(() => validateRuling({ ...ruling(), ruling: 'maybe' })).toThrow();
  });

  it('rejects a ruling that allocates liability to nobody', () => {
    expect(() => validateRuling({ ...ruling(), liableParty: 'nobody' })).toThrow();
  });

  it('rejects a ruling with no reasoning', () => {
    expect(() => validateRuling({ ...ruling(), rationale: '' })).toThrow();
  });

  it('rejects a shape that is not a ruling at all', () => {
    expect(() => validateRuling(null)).toThrow();
    expect(() => validateRuling({ ...ruling(), evidenceCited: 'test.js' })).toThrow();
  });
});

describe('whether a ruling stands', () => {
  // Section 6: "Judgments rely on repository evidence, tests, logs and signed contracts." An
  // adjudicator that could waive its own evidentiary requirement has none.
  it('stands when it rests on repository evidence', () => {
    expect(rulingIsGrounded(ruling())).toBe(true);
  });

  it('does not stand when it cites nothing', () => {
    expect(rulingIsGrounded(ruling({ evidenceCited: [] }))).toBe(false);
    expect(rulingIsGrounded(ruling({ evidenceCited: ['  '] }))).toBe(false);
  });

  it('applies a grounded ruling as given', () => {
    const result = applyRuling(dispute(), ruling());
    expect(result.stood).toBe(true);
    expect(result.ruling).toBe('supplier');
    expect(supplierPrevailed(result)).toBe(true);
  });

  // Not because the buyer is right, but because the supplier bears the burden of showing the
  // contract was performed — the same rule section 9 applies to acceptance evidence, applied to the
  // adjudication itself.
  it('sets aside an ungrounded ruling against the party carrying the burden', () => {
    const result = applyRuling(dispute(), ruling({ evidenceCited: [] }));
    expect(result.stood).toBe(false);
    expect(result.ruling).toBe('buyer');
    expect(result.liableParty).toBe('supplier');
    expect(supplierPrevailed(result)).toBe(false);
  });

  // The arbitrator's reasoning survives even when set aside: a reader should be able to see what
  // was argued and why it did not count.
  it('preserves the original reasoning when it sets a ruling aside', () => {
    const result = applyRuling(dispute(), ruling({ evidenceCited: [], rationale: 'The supplier seems credible.' }));
    expect(result.rationale).toContain('cited no repository evidence');
    expect(result.rationale).toContain('The supplier seems credible.');
  });

  it('keeps a split ruling as a split', () => {
    const result = applyRuling(dispute(), ruling({ ruling: 'split', liableParty: 'shared' }));
    expect(result.ruling).toBe('split');
    expect(supplierPrevailed(result)).toBe(false);
  });
});
