import { describe, expect, it } from 'vitest';
import { applyRevisingReport, shouldConvene, type RevisingReport } from './houseOfReview.js';
import type { DemocraticConfig } from './types.js';

const cfg = {
  voteThresholds: {
    routine: 'simple_majority',
    cross_module: 'three_fifths',
    security_boundary: 'two_thirds_plus_security_committee',
    constitutional_amendment: 'two_thirds_both_chambers',
    test_waiver: 'human_required',
  },
  riskClassification: { securityPathGlobs: [], crossModuleThreshold: 2 },
  committee: { electedSpecialistCalls: 2, sortitionCalls: 1 },
  confidenceVote: { consecutiveFailuresBeforeSwap: 3 },
  questionTimeEveryNTasks: 5,
  houseOfReview: { enabled: true, minRiskClass: 'medium', maxDelays: 1 },
} as unknown as DemocraticConfig;

function report(points: RevisingReport['points']): RevisingReport {
  return { content: points.length === 0, points, rationale: 'The chamber has reported.' };
}

describe('when the second chamber sits', () => {
  it('sits on a programme carrying a medium-risk motion', () => {
    expect(shouldConvene(['low', 'medium'], cfg)).toBe(true);
  });

  it('does not sit on a purely low-risk programme', () => {
    expect(shouldConvene(['low', 'low'], cfg)).toBe(false);
  });

  it('sits on anything when the floor is set to low', () => {
    expect(shouldConvene(['low'], { ...cfg, houseOfReview: { ...cfg.houseOfReview, minRiskClass: 'low' } })).toBe(true);
  });

  it('sits only on security-boundary work when the floor is set to high', () => {
    const strict = { ...cfg, houseOfReview: { ...cfg.houseOfReview, minRiskClass: 'high' as const } };
    expect(shouldConvene(['medium'], strict)).toBe(false);
    expect(shouldConvene(['high'], strict)).toBe(true);
  });

  it('does not sit when the chamber is switched off, or when there is nothing before it', () => {
    expect(shouldConvene(['high'], { ...cfg, houseOfReview: { ...cfg.houseOfReview, enabled: false } })).toBe(false);
    expect(shouldConvene([], cfg)).toBe(false);
  });
});

describe('what the chamber may do about what it finds', () => {
  it('revises without blocking, naming an owner and a return condition', () => {
    const outcome = applyRevisingReport(
      report([{ summary: 'This helper duplicates another.', evidence: 'src/a.ts', power: 'revise' }]),
      'house-of-review',
      0,
      cfg,
    );

    expect(outcome).toMatchObject({ revisions: 1, delayed: 0, vetoes: 0 });
    expect(outcome.findings[0]).toMatchObject({ disposition: 'deferred', owner: 'house-of-review' });
    expect(outcome.findings[0].returnCondition).toBeTruthy();
    expect(outcome.findings[0].nonWaivable).toBeUndefined();
  });

  it('delays within the ceiling', () => {
    const outcome = applyRevisingReport(
      report([{ summary: 'This should be reconsidered.', evidence: 'src/a.ts', power: 'delay' }]),
      'house-of-review',
      0,
      cfg,
    );
    expect(outcome.delayed).toBe(1);
    expect(outcome.findings[0].returnCondition).toContain('returns for remediation');
  });

  // A chamber that could keep asking for time would hold a veto reached by attrition.
  it('downgrades a delay beyond the ceiling to a revision', () => {
    const outcome = applyRevisingReport(
      report([{ summary: 'Once more, with feeling.', evidence: 'src/a.ts', power: 'delay' }]),
      'house-of-review',
      1,
      cfg,
    );
    expect(outcome.delayed).toBe(0);
    expect(outcome.revisions).toBe(1);
  });

  it('vetoes on constitutional safety ground, and blocks the gate', () => {
    const outcome = applyRevisingReport(
      report([{ summary: 'This weakens CSRF protection on the session route.', evidence: 'src/auth/session.ts', power: 'veto' }]),
      'house-of-review',
      0,
      cfg,
    );
    expect(outcome.vetoes).toBe(1);
    expect(outcome.findings[0]).toMatchObject({ nonWaivable: true, disposition: 'unresolved' });
    expect(outcome.findings[0].summary).toContain('constitutional ground (security)');
  });

  // Section 6 gives this chamber delaying and revising powers, not a general veto.
  it('records a veto on a mere design disagreement as a revision instead', () => {
    const outcome = applyRevisingReport(
      report([{ summary: 'I would have structured this differently.', evidence: 'src/a.ts', power: 'veto' }]),
      'house-of-review',
      0,
      cfg,
    );
    expect(outcome.vetoes).toBe(0);
    expect(outcome.revisions).toBe(1);
    expect(outcome.findings[0].nonWaivable).toBeUndefined();
  });

  it('raises nothing when the chamber is content', () => {
    expect(applyRevisingReport(report([]), 'house-of-review', 0, cfg).findings).toEqual([]);
  });

  it('vetoes an acceptance criterion with no evidence, which a division cannot waive', () => {
    const outcome = applyRevisingReport(
      report([{
        summary: 'Acceptance criterion 2 has no evidence: no check exercises the out-of-range path.',
        evidence: 'pkg/cli.py',
        power: 'veto',
      }]),
      'house-of-review',
      0,
      cfg,
    );
    expect(outcome.vetoes).toBe(1);
    expect(outcome.findings[0]).toMatchObject({ nonWaivable: true, disposition: 'unresolved' });
  });

  it('attributes every finding to the chamber', () => {
    const outcome = applyRevisingReport(
      report([
        { summary: 'One.', evidence: 'src/a.ts', power: 'revise' },
        { summary: 'Two.', evidence: 'src/b.ts', power: 'delay' },
      ]),
      'senior-verification-reviewer',
      0,
      cfg,
    );
    expect(outcome.findings.every((f) => f.source === 'senior-verification-reviewer')).toBe(true);
  });
});
