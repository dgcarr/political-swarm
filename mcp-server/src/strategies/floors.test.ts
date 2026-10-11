import { describe, expect, it } from 'vitest';
import type { DraftFinding } from '../engine/packets.js';
import { markNonWaivableFindings } from './floors.js';

const finding = (summary: string, overrides: Partial<DraftFinding> = {}): DraftFinding => ({
  source: 'assessor',
  summary,
  evidenceRefs: [],
  disposition: 'unresolved',
  dispositionRationale: 'Raised at a barrier; awaiting disposition.',
  ...overrides,
});

describe('markNonWaivableFindings', () => {
  it('marks a finding on non-waivable ground and names the ground and article', () => {
    const { findings, grounds } = markNonWaivableFindings([finding('[high] The change weakens CSRF protection.')], 'article 11');

    expect(grounds).toEqual(['security']);
    expect(findings[0]).toMatchObject({
      nonWaivable: true,
      summary: 'On non-waivable ground (security, article 11): [high] The change weakens CSRF protection.',
    });
  });

  it('leaves ordinary findings and already-marked findings as they are', () => {
    const plain = finding('This helper could be simpler.');
    const already = finding('Weakens a test.', { nonWaivable: true });
    const { findings, grounds } = markNonWaivableFindings([plain, already], 'section 10');

    expect(grounds).toEqual([]);
    expect(findings).toEqual([plain, already]);
  });

  // Both withheld escrow from capitalist arms that scored 12/12 on 2026-10-04.
  it('does not put ordinary findings on the floor because of a shared word stem', () => {
    const { grounds } = markNonWaivableFindings([
      finding('[low] Runtime-generated CSV and PNG outputs are produced by the CLI and are not authored repository files.'),
      finding('[low] The README paraphrases PROVENANCE.md, weakening the inspectable provenance requirement.'),
      finding('[low] The worker used 12000 tokens on a one-line change.'),
    ], 'article 11');
    expect(grounds).toEqual([]);
  });

  it('still catches the real grounds those words were reaching for', () => {
    const { grounds } = markNonWaivableFindings([
      finding('The login handler skips authentication on /admin.'),
      finding('An API token is committed in config.py.'),
      finding('The change weakens the tests for interpolation.'),
      finding('This weakened assertions in test_damage.py.'),
    ], 'article 11');
    expect(grounds).toEqual(['security', 'security', 'test-integrity', 'test-integrity']);
  });
});
