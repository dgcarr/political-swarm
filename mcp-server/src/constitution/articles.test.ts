import { describe, expect, it } from 'vitest';
import { CONFIGURED_STRATEGIES, constitutionDocument, constitutionFor, rulesInUse } from './articles.js';
import { DEMOCRATIC_DEFAULTS, SOCIALIST_DEFAULTS, parseStrategiesConfig } from './schema.js';
import { RULE_IDS } from './rules.js';

describe('constitutionDocument', () => {
  it('gives each doctrine its articles, rights, rules in use and validated config', () => {
    const democratic = constitutionDocument('democratic', {});
    expect(democratic.kind).toBe('doctrine');
    expect(democratic.articles.length).toBeGreaterThan(0);
    expect(democratic.rights.length).toBeGreaterThan(0);
    expect(democratic.config).toEqual(DEMOCRATIC_DEFAULTS);
    expect(Object.keys(democratic.decisionRules)).toContain('two_thirds_both_chambers');
    expect(democratic.digest).toMatch(/^[a-f0-9]{64}$/);

    const managerial = constitutionDocument('managerial', {});
    expect(managerial).toMatchObject({ kind: 'control', articles: [], rights: [], decisionRules: {} });
  });

  it('is JSON-serialisable and digests the same content the same way, raw or validated', () => {
    const raw = constitutionDocument('socialist', { councils: { memberBallots: false } });
    const validated = constitutionDocument('socialist', parseStrategiesConfig({ socialist: { councils: { memberBallots: false } } }).socialist);
    expect(JSON.parse(JSON.stringify(raw))).toEqual(raw);
    expect(validated.digest).toBe(raw.digest);
    expect(constitutionDocument('socialist', {}).digest).not.toBe(raw.digest);
  });

  it('lists only the rules the configuration actually puts in use', () => {
    expect(rulesInUse('socialist', { ...SOCIALIST_DEFAULTS, councils: { ...SOCIALIST_DEFAULTS.councils, memberBallots: false } }))
      .toEqual(['delegated-council-ratification-v1', 'delegated-council-unanimous-acceptance-v1']);
    expect(rulesInUse('democratic', { ...DEMOCRATIC_DEFAULTS, offices: { ...DEMOCRATIC_DEFAULTS.offices, constituentBallots: false } }))
      .toEqual(['simple_majority', 'three_fifths', 'two_thirds_plus_security_committee', 'two_thirds_both_chambers', 'human_required']);
  });

  // A rule nobody's configuration can reach is dead law; a doctrine recording under a rule its
  // constitution does not list would be acting outside it.
  it('covers every declared rule across the configurations the doctrines support', () => {
    const inUse = new Set(CONFIGURED_STRATEGIES.flatMap((id) => [true, false].flatMap((ballots) => {
      const config = parseStrategiesConfig({
        democratic: { offices: { constituentBallots: ballots } },
        socialist: { councils: { memberBallots: ballots } },
      });
      return Object.keys(constitutionDocument(id, config[id]).decisionRules);
    })));
    expect([...inUse].sort()).toEqual([...RULE_IDS].sort());
  });

  it('refuses an invalid section rather than describing it', () => {
    expect(() => constitutionDocument('capitalist', { initialCapitol: 500 })).toThrow();
  });
});

describe('constitutionFor', () => {
  it('reads the strategy\'s section out of the whole config', () => {
    expect(constitutionFor('capitalist', {})).toEqual(constitutionDocument('capitalist', {}));
  });

  it('has nothing to say about a strategy without a section', () => {
    expect(constitutionFor('noop', {})).toBeNull();
  });
});
