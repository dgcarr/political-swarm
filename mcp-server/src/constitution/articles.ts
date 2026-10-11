// What every doctrine's charter is made of, and the machine-readable constitution a run adopts.
//
// Each doctrine keeps its own articles in strategies/<doctrine>/constitution.ts; the shapes they
// share live here. constitutionDocument() assembles one doctrine's articles, rights, the decision
// rules its configuration puts in use and the validated configuration itself into a single
// JSON-serialisable record with a digest, so a run can say exactly which constitution it ran under
// and a reader can check the ledger's decisions against it without reading the source.
import { createHash } from 'node:crypto';
import { AGENT_RIGHTS, ARTICLES as DEMOCRATIC_ARTICLES } from '../strategies/democratic/constitution.js';
import { ARTICLES as SOCIALIST_ARTICLES } from '../strategies/socialist/constitution.js';
import { ARTICLES as CAPITALIST_ARTICLES } from '../strategies/capitalist/constitution.js';
import {
  capitalistConfigSchema,
  democraticConfigSchema,
  managerialConfigSchema,
  parseStrategiesConfig,
  singleAgentConfigSchema,
  socialistConfigSchema,
  type ConfiguredStrategyId,
  type DemocraticConfig,
  type SocialistConfig,
} from './schema.js';
import { DECISION_RULES, type DecisionRule, type RuleId } from './rules.js';

/** Where an article is actually held up. Anything marked 'documented' is honest about not being
 * machine-checked — it is a convention the doctrine keeps, not a rule the runtime can enforce. */
export type EnforcementSite =
  | 'constitution' // a predicate in the doctrine's constitution.ts
  | 'engine' // an engine-side floor no doctrine can lower
  | 'strategy' // the doctrine's strategy logic outside its constitution.ts
  | 'human' // reserved to the human project owner
  | 'documented'; // a convention, recorded but not machine-checked

export interface Article {
  id: string;
  title: string;
  text: string;
  enforcedBy: EnforcementSite;
  /** Where to look. A file path, or the body that answers for it. */
  mechanism: string;
}

/** A protected procedural right, and the mechanism that holds it up. */
export interface AgentRight {
  id: string;
  text: string;
  mechanism: string;
}

export interface ConstitutionDocument {
  strategy: ConfiguredStrategyId;
  /** A doctrine governs by its own institutions; a control is a benchmark baseline without them. */
  kind: 'doctrine' | 'control';
  articles: readonly Article[];
  rights: readonly AgentRight[];
  /** Every rule a governance decision may be recorded under in this configuration. */
  decisionRules: Partial<Record<RuleId, DecisionRule>>;
  /** The strategy's section of config/strategies.yaml, validated and with every default filled. */
  config: Record<string, unknown>;
  /** sha256 of the canonical JSON of every field above. */
  digest: string;
}

export const CONFIGURED_STRATEGIES: readonly ConfiguredStrategyId[] = [
  'democratic', 'socialist', 'capitalist', 'managerial', 'single_agent',
];

const SECTION_SCHEMAS = {
  democratic: democraticConfigSchema,
  socialist: socialistConfigSchema,
  capitalist: capitalistConfigSchema,
  managerial: managerialConfigSchema,
  single_agent: singleAgentConfigSchema,
} as const;

function democraticRules(config: DemocraticConfig): RuleId[] {
  const rules: RuleId[] = [...new Set(Object.values(config.voteThresholds))];
  if (config.offices.constituentBallots) {
    rules.push(
      'equal-ballot-plurality-quorum-half-tie-roster-order-v1',
      'equal-representative-ballot-quorum-half-simple-majority-v1',
      'simple-majority-of-engaged-with-quorum',
      'two-thirds-of-all-seated-members',
      'two-thirds-of-seated-security-panel',
    );
  }
  return rules;
}

function socialistRules(config: SocialistConfig): RuleId[] {
  if (!config.councils.requirePlanRatification) return [];
  return config.councils.memberBallots
    ? ['member-council-ratification-v1', 'member-council-majority-acceptance-v1', 'member-initiated-absolute-majority-recall-v1']
    : ['delegated-council-ratification-v1', 'delegated-council-unanimous-acceptance-v1'];
}

/** The rules a strategy records decisions under, given its validated configuration. */
export function rulesInUse(strategyId: ConfiguredStrategyId, config: Record<string, unknown>): RuleId[] {
  switch (strategyId) {
    case 'democratic': return democraticRules(config as DemocraticConfig);
    case 'socialist': return socialistRules(config as SocialistConfig);
    case 'capitalist': return ['published-weighted-bid-score'];
    case 'managerial':
    case 'single_agent': return [];
  }
}

/** JSON with object keys sorted, so the digest depends on content rather than insertion order. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * One strategy's machine-readable constitution under `config`, its section of strategies.yaml
 * (raw or already validated; it is validated here either way, and an invalid section throws).
 */
export function constitutionDocument(strategyId: ConfiguredStrategyId, config: unknown): ConstitutionDocument {
  const validated = SECTION_SCHEMAS[strategyId].parse(config ?? {}) as Record<string, unknown>;
  const articles = strategyId === 'democratic' ? DEMOCRATIC_ARTICLES
    : strategyId === 'socialist' ? SOCIALIST_ARTICLES
      : strategyId === 'capitalist' ? CAPITALIST_ARTICLES : [];
  const body: Omit<ConstitutionDocument, 'digest'> = {
    strategy: strategyId,
    kind: articles.length ? 'doctrine' : 'control',
    articles,
    rights: strategyId === 'democratic' ? AGENT_RIGHTS : [],
    decisionRules: Object.fromEntries(rulesInUse(strategyId, validated).map((rule) => [rule, DECISION_RULES[rule]])),
    config: validated,
  };
  return { ...body, digest: constitutionDigest(body) };
}

/** sha256 of a constitution's canonical JSON, excluding any digest it already carries. */
export function constitutionDigest(document: Omit<ConstitutionDocument, 'digest'> & { digest?: string }): string {
  const { digest: _digest, ...body } = document;
  return createHash('sha256').update(canonicalJson(body)).digest('hex');
}

/**
 * The constitution a run under `strategyId` adopts, from the whole strategies config (as
 * loadStrategiesConfig returns it, or raw). Null for a strategy with no section, such as the
 * engine's test-only noop strategy.
 */
export function constitutionFor(strategyId: string, strategiesConfig: unknown): ConstitutionDocument | null {
  if (!(CONFIGURED_STRATEGIES as readonly string[]).includes(strategyId)) return null;
  const id = strategyId as ConfiguredStrategyId;
  return constitutionDocument(id, parseStrategiesConfig(strategiesConfig)[id]);
}
