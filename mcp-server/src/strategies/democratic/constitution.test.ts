import { describe, expect, it } from 'vitest';
import {
  AGENT_RIGHTS,
  ARTICLES,
  charterDigest,
  droppedMinorityReports,
  nonWaivableGround,
  separationOfFunctionsBreaches,
  type FunctionHolders,
} from './constitution.js';
import type { Finding } from '../../engine/packets.js';

function holders(overrides: Partial<FunctionHolders> = {}): FunctionHolders {
  return {
    primeCoordinator: 'pm',
    speaker: 'speaker',
    ceremonialHead: 'crown',
    implementers: ['impl-a', 'impl-b'],
    integrator: 'integration-committee',
    verifier: 'commons-verifier',
    ...overrides,
  };
}

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'f1',
    source: 'committee',
    summary: 'Something is wrong.',
    evidenceRefs: [],
    disposition: 'unresolved',
    dispositionRationale: 'raised',
    ...overrides,
  };
}

describe('the charter itself', () => {
  it('carries all twelve articles of section 12, in order', () => {
    expect(ARTICLES).toHaveLength(12);
    expect(ARTICLES.map((a) => a.id)).toEqual(
      Array.from({ length: 12 }, (_, i) => `article-${i + 1}`),
    );
  });

  it('names a mechanism for every article and every right, so none is decoration', () => {
    for (const article of ARTICLES) {
      expect(article.mechanism.trim(), article.id).not.toBe('');
      expect(article.text.trim(), article.id).not.toBe('');
    }
    for (const right of AGENT_RIGHTS) {
      expect(right.mechanism.trim(), right.id).not.toBe('');
    }
  });

  it('digests to an inspectable charter the Ceremonial Head can preserve', () => {
    const digest = charterDigest();
    expect(digest).toContain('article-6. Separation of functions');
    expect(digest.split('\n')).toHaveLength(12);
  });
});

describe('article 6 — separation of functions', () => {
  it('passes a properly separated register', () => {
    expect(separationOfFunctionsBreaches(holders())).toEqual([]);
  });

  it('catches the Speaker also serving as Prime Coordinator', () => {
    const breaches = separationOfFunctionsBreaches(holders({ speaker: 'pm' }));
    expect(breaches).toHaveLength(1);
    expect(breaches[0].personaId).toBe('pm');
    expect(breaches[0].offices).toEqual(['speaker', 'prime-coordinator']);
    expect(breaches[0].remedy).toContain('Article 6');
  });

  it('catches an integrator verifying its own integration', () => {
    const breaches = separationOfFunctionsBreaches(holders({ verifier: 'integration-committee' }));
    expect(breaches.some((b) => b.offices.join('/') === 'integrator/verifier')).toBe(true);
  });

  it('catches an implementer holding a reviewing office over its own change', () => {
    const breaches = separationOfFunctionsBreaches(holders({ verifier: 'impl-a' }));
    expect(breaches.some((b) => b.personaId === 'impl-a' && b.offices.includes('implementer'))).toBe(true);
  });

  it('reports breaches deterministically, so the same register always yields the same message', () => {
    const register = holders({ speaker: 'pm', verifier: 'integration-committee' });
    expect(separationOfFunctionsBreaches(register)).toEqual(separationOfFunctionsBreaches(register));
  });

  it('ignores empty office slots rather than reporting two vacancies as a conflict', () => {
    expect(separationOfFunctionsBreaches(holders({ speaker: '', ceremonialHead: '' }))).toEqual([]);
  });
});

describe('article 10 — non-waivable grounds', () => {
  it('recognises a security finding', () => {
    expect(nonWaivableGround(finding({ summary: 'The change weakens CSRF protection.' }))).toBe('security');
  });

  it('recognises an unevidenced acceptance criterion', () => {
    expect(
      nonWaivableGround(finding({ summary: 'Acceptance criterion has no satisfying evidence: "x".' })),
    ).toBe('acceptance-evidence');
  });

  it('recognises a licensing obligation', () => {
    expect(nonWaivableGround(finding({ summary: 'Adds a GPL dependency to a permissive project.' }))).toBe('licensing');
  });

  it('reads evidence refs as well as the summary', () => {
    expect(nonWaivableGround(finding({ summary: 'Touches a file.', evidenceRefs: ['src/auth/login.ts'] }))).toBe('security');
  });

  it('returns null for an ordinary maintainability finding', () => {
    expect(nonWaivableGround(finding({ summary: 'This helper could be simpler.' }))).toBeNull();
  });

  it('never downgrades a finding the engine already marked non-waivable', () => {
    expect(nonWaivableGround(finding({ summary: 'This helper could be simpler.', nonWaivable: true }))).toBe('human-control');
  });
});

describe('article 8 — minority reports', () => {
  it('reports dissent that lost its mark during disposition', () => {
    const before = [finding({ id: 'f1', minority: true }), finding({ id: 'f2', minority: true })];
    const after = [finding({ id: 'f1', minority: true }), finding({ id: 'f2', minority: false })];
    expect(droppedMinorityReports(before, after)).toEqual(['f2']);
  });

  it('says nothing when every minority report survived', () => {
    const before = [finding({ id: 'f1', minority: true })];
    expect(droppedMinorityReports(before, before)).toEqual([]);
  });

  it('does not object to a finding that was never a minority report', () => {
    const before = [finding({ id: 'f1' })];
    const after = [finding({ id: 'f1' })];
    expect(droppedMinorityReports(before, after)).toEqual([]);
  });
});
