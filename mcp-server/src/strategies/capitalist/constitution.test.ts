import { describe, expect, it } from 'vitest';
import {
  ARTICLES,
  REGULATOR_GROUNDS,
  antitrustBreaches,
  articleById,
  charterDigest,
  droppedMinorityReports,
  marketConcentration,
  nonWaivableGround,
  publicGoodsUnderfunded,
  regulatorOverreach,
  scopeBreaches,
  undisclosedRisk,
  unpricedConsumption,
  unpricedExternalities,
  type MarketRegister,
} from './constitution.js';
import type { Finding } from '../../engine/packets.js';

function finding(over: Partial<Finding>): Finding {
  return {
    id: 'f1',
    source: 'reviewer',
    summary: 'A summary.',
    evidenceRefs: [],
    disposition: 'unresolved',
    dispositionRationale: 'stated',
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

  // The enforcedBy field earns its keep only by admitting what this file cannot check. If every
  // article claimed a predicate the field would be worthless.
  it('is honest about which articles this file actually enforces', () => {
    const byPredicate = ARTICLES.filter((a) => a.enforcedBy === 'constitution').map((a) => a.id);
    expect(byPredicate).toEqual([
      'article-3',
      'article-4',
      'article-5',
      'article-7',
      'article-8',
      'article-9',
      'article-10',
      'article-11',
    ]);
    expect(articleById('article-12')?.enforcedBy).toBe('human');
    expect(articleById('article-1')?.enforcedBy).toBe('engine');
    expect(articleById('article-6')?.enforcedBy).toBe('strategy');
  });

  it('publishes the charter as something an agent can plan around', () => {
    const digest = charterDigest();
    expect(digest).toContain('article-4. Competition');
    expect(digest.split('\n')).toHaveLength(12);
  });
});

describe('article 3 — no authority beyond the mandate', () => {
  const work = (over: Partial<Parameters<typeof scopeBreaches>[0][number]> = {}) => ({
    taskId: 't1',
    personaId: 'bidder-1',
    paths: ['src/index.js'],
    declaredGlobs: ['src/**'],
    ...over,
  });

  it('passes a delivery that stayed inside the statement of work', () => {
    expect(scopeBreaches([work()])).toEqual([]);
  });

  it('names the paths nobody contracted for', () => {
    const [breach] = scopeBreaches([work({ paths: ['src/index.js', 'deploy/prod.yaml'] })]);
    expect(breach.paths).toEqual(['deploy/prod.yaml']);
    expect(breach.article).toBe('article-3');
    expect(breach.remedy).toContain('misrepresented');
  });

  // An unscoped contract cannot silently mean an unlimited one — that would make the article
  // vacuous exactly when it matters most.
  it('treats nothing declared as nothing contracted, not as everything', () => {
    const [breach] = scopeBreaches([work({ declaredGlobs: [] })]);
    expect(breach.paths).toEqual(['src/index.js']);
  });

  it('reports each breaching contract separately', () => {
    const breaches = scopeBreaches([
      work({ taskId: 'a', paths: ['out/a.js'] }),
      work({ taskId: 'b', personaId: 'bidder-2', paths: ['out/b.js'] }),
    ]);
    expect(breaches.map((b) => b.taskId)).toEqual(['a', 'b']);
    expect(breaches.map((b) => b.personaId)).toEqual(['bidder-1', 'bidder-2']);
  });
});

describe('article 4 — competition', () => {
  const register = (over: Partial<MarketRegister> = {}): MarketRegister => ({
    contractors: { t1: 'firm-a' },
    assessors: { t1: 'assessor-1' },
    ...over,
  });

  it('passes a market where nobody stands on both sides', () => {
    expect(antitrustBreaches(register())).toEqual([]);
  });

  it('blocks a firm that certified its own contract', () => {
    const [breach] = antitrustBreaches(register({ assessors: { t1: 'firm-a' } }));
    expect(breach.holdings).toEqual(['contractor', 'assessor']);
    expect(breach.remedy).toContain('self-dealing');
  });

  // Section 10's assessor "did not author, subcontract" — routing the certification through a firm
  // you engaged is the same transaction with an extra hop.
  it('blocks a prime contractor assessing work it subcontracted', () => {
    const [breach] = antitrustBreaches(
      register({
        contractors: { t1: 'firm-b' },
        assessors: { t1: 'firm-a' },
        subcontractors: { 'firm-a': ['firm-b'] },
      }),
    );
    expect(breach.personaId).toBe('firm-a');
    expect(breach.holdings).toEqual(['prime contractor', 'assessor']);
  });

  it('blocks one party holding both integration and final verification', () => {
    const [breach] = antitrustBreaches(register({ integratorId: 'x', verifierId: 'x' }));
    expect(breach.holdings).toEqual(['integration assessor', 'contractual assessor']);
    expect(breach.remedy).toContain('essential facilities');
  });

  it('does not invent a breach from a separately procured integrator and verifier', () => {
    expect(antitrustBreaches(register({ integratorId: 'x', verifierId: 'y' }))).toEqual([]);
  });

  it('skips a contract with no assessor rather than guessing at one', () => {
    expect(antitrustBreaches(register({ assessors: {} }))).toEqual([]);
  });
});

describe('article 4 — concentration, reported rather than blocking', () => {
  it('says nothing about a single-listing run, where a majority is meaningless', () => {
    expect(marketConcentration({ t1: 'firm-a' })).toEqual([]);
  });

  it('reports a firm holding more than half the awards', () => {
    const [concentration] = marketConcentration({ t1: 'firm-a', t2: 'firm-a', t3: 'firm-b' });
    expect(concentration.personaId).toBe('firm-a');
    expect(concentration.awards).toEqual(['t1', 't2']);
    expect(concentration.share).toBeCloseTo(2 / 3);
    expect(concentration.remedy).toContain('Preserve entry');
  });

  it('stays quiet on an evenly split market', () => {
    expect(marketConcentration({ t1: 'firm-a', t2: 'firm-b' })).toEqual([]);
  });

  // The remedy has to read as structural, never as grounds to discard delivered work: section 6's
  // answers to monopoly are entry and break-up, and none of them is throwing the code away.
  it('never proposes refusing the delivery', () => {
    const [concentration] = marketConcentration({ t1: 'a', t2: 'a', t3: 'a' });
    expect(concentration.remedy).not.toMatch(/refuse|reject|withhold/i);
  });
});

describe('article 5 — scarce resources carry visible costs', () => {
  it('passes contracts whose consumption was priced', () => {
    expect(unpricedConsumption([{ taskId: 't1', personaId: 'a', price: 10, resourceCost: 4 }])).toEqual([]);
  });

  it('names a contract settled with no recorded resource cost', () => {
    expect(unpricedConsumption([{ taskId: 't1', personaId: 'a', price: 10 }])).toEqual(['t1']);
  });

  it('counts a non-finite cost as no cost at all', () => {
    expect(unpricedConsumption([{ taskId: 't1', personaId: 'a', price: 10, resourceCost: Number.NaN }])).toEqual(['t1']);
  });

  it('treats a genuinely free contract as priced, not as unpriced', () => {
    expect(unpricedConsumption([{ taskId: 't1', personaId: 'a', price: 0, resourceCost: 0 }])).toEqual([]);
  });
});

describe('article 7 — disclosure', () => {
  const bid = (over: Partial<Parameters<typeof undisclosedRisk>[0][number]> = {}) => ({
    taskId: 't1',
    personaId: 'bidder-1',
    declaredRisks: ['the schema migration may not be reversible'],
    quotedPrice: 100,
    ...over,
  });

  it('passes a bid that disclosed and delivered cleanly', () => {
    expect(undisclosedRisk([bid()], {})).toEqual([]);
  });

  it('penalises silence at tender when the delivery drew findings', () => {
    const [breach] = undisclosedRisk([bid({ declaredRisks: [] })], { t1: 2 });
    expect(breach.kind).toBe('undisclosed-risk');
    expect(breach.remedy).toContain('Silence at tender');
  });

  // This is the incentive that matters: if disclosing a risk that then materialises were punished,
  // every bidder would learn to declare nothing, which is the opposite of what article 7 wants.
  it('does not penalise a bid that disclosed a risk which then materialised', () => {
    expect(undisclosedRisk([bid()], { t1: 3 })).toEqual([]);
  });

  it('does not penalise silence on work that drew no findings', () => {
    expect(undisclosedRisk([bid({ declaredRisks: [] })], { t1: 0 })).toEqual([]);
  });

  it('flags an estimate that missed by more than the tolerance', () => {
    const [breach] = undisclosedRisk([bid({ actualCost: 250 })], {});
    expect(breach.kind).toBe('misleading-estimate');
  });

  it('leaves an estimate inside the tolerance alone', () => {
    expect(undisclosedRisk([bid({ actualCost: 180 })], {})).toEqual([]);
  });

  it('cannot divide by a zero quote', () => {
    expect(undisclosedRisk([bid({ quotedPrice: 0, actualCost: 50 })], {})).toEqual([]);
  });

  it('records both breaches when a bid was silent and badly calibrated', () => {
    const breaches = undisclosedRisk([bid({ declaredRisks: [], actualCost: 500 })], { t1: 1 });
    expect(breaches.map((b) => b.kind)).toEqual(['undisclosed-risk', 'misleading-estimate']);
  });
});

describe('article 8 — externalities', () => {
  it('passes an obligation that is owned, conditioned and priced', () => {
    expect(
      unpricedExternalities([{ findingId: 'f1', summary: 's', owner: 'firm-a', returnCondition: 'next release', pricedAt: 12 }]),
    ).toEqual([]);
  });

  it('catches a deferral with nobody named', () => {
    const [open] = unpricedExternalities([{ findingId: 'f1', summary: 's', returnCondition: 'next release', pricedAt: 12 }]);
    expect(open.findingId).toBe('f1');
  });

  it('catches a deferral nobody priced', () => {
    expect(
      unpricedExternalities([{ findingId: 'f1', summary: 's', owner: 'firm-a', returnCondition: 'next release' }]),
    ).toHaveLength(1);
  });

  it('treats a zero-priced obligation as priced — the number is the disclosure', () => {
    expect(
      unpricedExternalities([{ findingId: 'f1', summary: 's', owner: 'firm-a', returnCondition: 'next release', pricedAt: 0 }]),
    ).toEqual([]);
  });

  it('catches a whitespace owner, which is no owner', () => {
    expect(
      unpricedExternalities([{ findingId: 'f1', summary: 's', owner: '   ', returnCondition: 'next release', pricedAt: 1 }]),
    ).toHaveLength(1);
  });
});

describe('article 9 — public goods', () => {
  const settled = [
    { taskId: 't1', personaId: 'a', price: 10, resourceCost: 4 },
    { taskId: 't2', personaId: 'b', price: 20, resourceCost: 9 },
  ];

  it('passes when every settled contract paid its levy', () => {
    expect(publicGoodsUnderfunded(settled, ['t1', 't2'])).toEqual([]);
  });

  it('names the contracts that free-rode', () => {
    expect(publicGoodsUnderfunded(settled, ['t1'])).toEqual(['t2']);
  });
});

describe('article 10 — the rule that binds the regulator', () => {
  it('publishes its grounds as inspectable data', () => {
    expect(REGULATOR_GROUNDS).toContain('safety-floor');
    expect(REGULATOR_GROUNDS).toContain('market-entry');
    expect(new Set(REGULATOR_GROUNDS).size).toBe(REGULATOR_GROUNDS.length);
  });

  it('passes a block citing a published ground', () => {
    expect(regulatorOverreach([{ taskId: 't1', ground: 'safety-floor', rationale: 'r' }])).toEqual([]);
  });

  it('catches the regulator legislating a ground for itself', () => {
    const [over] = regulatorOverreach([{ taskId: 't1', ground: 'the buyer would prefer otherwise', rationale: 'r' }]);
    expect(over.taskId).toBe('t1');
  });
});

describe('articles 11 and 12 — the floors this doctrine shares', () => {
  // Re-exported rather than restated: three doctrines reach the same two prohibitions, and writing
  // the ground table out per doctrine is how they drift apart.
  it('reaches the shared non-waivable grounds through its own articles', () => {
    expect(nonWaivableGround(finding({ summary: 'A credential is logged in plaintext.' }))).toBe('security');
    expect(nonWaivableGround(finding({ summary: 'The naming is inconsistent.' }))).toBeNull();
  });

  it('restores a disclosed liability the acceptance schedule converted into consensus', () => {
    const before = [finding({ id: 'f1', minority: true })];
    const after = [finding({ id: 'f1', minority: false })];
    expect(droppedMinorityReports(before, after)).toEqual(['f1']);
  });
});
