import { describe, expect, it } from 'vitest';
import {
  ARTICLES,
  COORDINATING_MANDATE,
  articleById,
  blameWithoutDiagnosis,
  delegateConcentration,
  charterDigest,
  droppedMinorityReports,
  mandateBreaches,
  monopolyBreaches,
  nonWaivableGround,
  selfApprovalBreaches,
  unpublishedKnowledge,
} from './constitution.js';
import type { Finding } from '../../engine/packets.js';

function finding(over: Partial<Finding>): Finding {
  return {
    id: 'f1',
    source: 'reviewer',
    summary: 'A summary.',
    evidenceRefs: [],
    disposition: 'unresolved',
    ...over,
  } as Finding;
}

describe('the articles as data', () => {
  it('records all twelve articles of section 12', () => {
    expect(ARTICLES).toHaveLength(12);
    expect(ARTICLES.map((a) => a.id)).toEqual(Array.from({ length: 12 }, (_, i) => `article-${i + 1}`));
  });

  it('names a mechanism for every article, so none is decoration', () => {
    for (const article of ARTICLES) {
      expect(article.mechanism.trim().length, article.id).toBeGreaterThan(0);
      expect(article.text.trim().length, article.id).toBeGreaterThan(0);
    }
  });

  // The point of the enforcedBy field is to be honest about what the runtime cannot check. If every
  // article claimed a predicate, the field would be worthless.
  it('is honest about which articles this file actually enforces', () => {
    const byPredicate = ARTICLES.filter((a) => a.enforcedBy === 'constitution').map((a) => a.id);
    expect(byPredicate).toEqual(['article-2', 'article-5', 'article-6', 'article-7', 'article-8', 'article-9', 'article-10', 'article-11']);
    expect(articleById('article-12')?.enforcedBy).toBe('human');
    expect(articleById('article-1')?.enforcedBy).toBe('engine');
  });

  it('publishes the charter itself to the commons', () => {
    const digest = charterDigest();
    expect(digest).toContain('article-2. Common ownership');
    expect(digest.split('\n')).toHaveLength(12);
  });
});

describe('articles 5 and 6 — what the coordinating council may decide', () => {
  const decision = (over: Partial<Parameters<typeof mandateBreaches>[0][number]> = {}) => ({
    taskId: 't1',
    subject: 'ordering',
    councilsAffected: 2,
    decidedBy: 'coordinating-council',
    ...over,
  });

  it('permits ordering, interfaces and scarce resources across two or more councils', () => {
    for (const subject of COORDINATING_MANDATE) {
      expect(mandateBreaches([decision({ subject })])).toEqual([]);
    }
  });

  // Section 8: "The coordinating council owns ordering, not technical truth."
  it('rejects a decision on technical truth as an article 5 breach', () => {
    const breaches = mandateBreaches([decision({ subject: 'which-algorithm' })]);
    expect(breaches).toHaveLength(1);
    expect(breaches[0]).toMatchObject({ article: 'article-5', decision: 'which-algorithm' });
    expect(breaches[0].remedy).toContain('return it to the affected council');
  });

  it('rejects federal action on a matter one council could settle alone', () => {
    const breaches = mandateBreaches([decision({ councilsAffected: 1 })]);
    expect(breaches).toHaveLength(1);
    expect(breaches[0].article).toBe('article-6');
  });

  it('reports one breach per decision, not one compounded verdict', () => {
    expect(mandateBreaches([decision({ subject: 'which-algorithm', councilsAffected: 1 })])).toHaveLength(1);
    expect(mandateBreaches([decision(), decision({ councilsAffected: 1 })])).toHaveLength(1);
  });
});

describe('article 8 — no agent approves its own work', () => {
  const record = (over: Partial<Parameters<typeof selfApprovalBreaches>[0][number]> = {}) => ({
    taskId: 't1',
    implementerId: 'backend-1',
    reviewerId: 'frontend-2',
    ...over,
  });

  it('passes a review drawn from outside the authorship chain', () => {
    expect(selfApprovalBreaches([record()], 'integration-council', 'peer-verifier')).toEqual([]);
  });

  it('catches an implementer reviewing itself', () => {
    const breaches = selfApprovalBreaches([record({ reviewerId: 'backend-1' })]);
    expect(breaches).toHaveLength(1);
    expect(breaches[0].roles).toEqual(['implementer', 'reviewer']);
  });

  // Section 6: coordinators "cannot approve their own consequential decisions".
  it('catches a coordinator reviewing the allocation it made', () => {
    const breaches = selfApprovalBreaches([record({ allocatedBy: 'frontend-2' })]);
    expect(breaches).toHaveLength(1);
    expect(breaches[0].roles).toEqual(['coordinator', 'reviewer']);
  });

  it('catches an integrator certifying its own integration', () => {
    const breaches = selfApprovalBreaches([], 'integration-council', 'integration-council');
    expect(breaches).toHaveLength(1);
    expect(breaches[0]).toMatchObject({ taskId: '(delivery)', roles: ['integrator', 'verifier'] });
  });
});

describe('article 10 — no monopoly of information, tools or merge authority', () => {
  const register = (over: Partial<Parameters<typeof monopolyBreaches>[0]> = {}) => ({
    convener: 'backend-1',
    delegates: { 'council-a': 'backend-1', 'council-b': 'frontend-1' },
    integratorId: 'integration-council',
    verifierId: 'peer-verifier',
    ...over,
  });

  it('passes a register with coordination, merge and verification in different hands', () => {
    expect(monopolyBreaches(register())).toEqual([]);
  });

  it('catches the convener also holding merge authority', () => {
    const breaches = monopolyBreaches(register({ integratorId: 'backend-1' }));
    expect(breaches).toHaveLength(1);
    expect(breaches[0].holdings).toEqual(['convener', 'integrator']);
  });

  // Section 14 lists "separation from final verification" among the safeguards against capture.
  it('catches the convener also performing final verification', () => {
    expect(monopolyBreaches(register({ verifierId: 'backend-1' }))[0].holdings).toEqual(['convener', 'verifier']);
  });

  // Blocking is reserved for the pairs that genuinely concentrate authority. A delegate holding
  // several seats is reported by delegateConcentration() instead, so a sound run is not refused
  // over the shape of its plan.
  it('does not block a delivery over how the delegate seats fell', () => {
    expect(monopolyBreaches(register({ delegates: { a: 'backend-1', b: 'backend-1', c: 'frontend-1' }, convener: 'docs-1' }))).toEqual([]);
  });
});

describe('article 10 — concentration of delegate seats, reported not enforced', () => {
  it('names a persona speaking for a majority of the councils', () => {
    const concentrated = delegateConcentration({ a: 'backend-1', b: 'backend-1', c: 'frontend-1' });
    expect(concentrated).toHaveLength(1);
    expect(concentrated[0].holdings).toEqual(['delegate:a', 'delegate:b']);
    expect(concentrated[0].remedy).toContain('next term');
  });

  // A single-council run is not a federation, so holding its one seat concentrates nothing.
  it('says nothing about a sole council', () => {
    expect(delegateConcentration({ a: 'backend-1' })).toEqual([]);
  });

  it('says nothing when the seats are spread', () => {
    expect(delegateConcentration({ a: 'backend-1', b: 'frontend-1' })).toEqual([]);
  });
});

describe('article 11 — blame may not substitute for diagnosis', () => {
  it('accepts a reassignment that records why the work moved', () => {
    expect(blameWithoutDiagnosis([{ taskId: 't1', from: 'a', to: 'b', cause: 'specification' }])).toEqual([]);
  });

  it('names a reassignment made with no diagnosed cause', () => {
    expect(
      blameWithoutDiagnosis([
        { taskId: 't1', from: 'a', to: 'b' },
        { taskId: 't2', from: 'c', to: 'd', cause: '   ' },
      ]),
    ).toEqual(['t1', 't2']);
  });
});

describe('articles 2 and 7 — failure lessons belong to the commons', () => {
  it('is content when every failure was written back', () => {
    expect(unpublishedKnowledge({ failedTaskIds: ['t1', 't2'], publishedTaskIds: ['t1', 't2'] })).toEqual([]);
  });

  it('names a failure that taught the swarm something nobody recorded', () => {
    expect(unpublishedKnowledge({ failedTaskIds: ['t1', 't2', 't1'], publishedTaskIds: ['t2'] })).toEqual(['t1']);
  });
});

describe('article 12 and article 9 come from the shared floor', () => {
  it('reads non-waivable ground the same way every doctrine does', () => {
    expect(nonWaivableGround(finding({ summary: 'This weakens CSRF protection.' }))).toBe('security');
    expect(nonWaivableGround(finding({ summary: 'This helper could be simpler.' }))).toBeNull();
  });

  it('names dissent the disposition step converted into consensus', () => {
    const before = [finding({ id: 'f1', minority: true }), finding({ id: 'f2', minority: true })];
    const after = [finding({ id: 'f1', minority: true }), finding({ id: 'f2' })];
    expect(droppedMinorityReports(before, after)).toEqual(['f2']);
  });
});
