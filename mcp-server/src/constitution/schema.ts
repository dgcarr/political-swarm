// The one schema for config/strategies.yaml, and the one set of defaults.
//
// Every section is `.strict()`: a key the runtime does not read is a typo or a dead tunable, and
// either way a reader of the YAML would believe it governs something. Every key carries its
// default here, so a section left out of the file (or a key left out of a section) runs exactly as
// the checked-in file does. Strategies read these defaults through the *_DEFAULTS exports below
// rather than repeating a literal at each point of use.
//
// The capitalist policy blocks (priceList, listingTerms, contractPolicy, capitalPolicy,
// insurancePolicy, creditPolicy, treasuryPolicy) are the exception: each is an override of the
// published policy constant in its own module (prices.ts, exchange.ts, ...), which stays the
// single home of those defaults. The schema only refuses keys those modules do not have.
import { z } from 'zod';
import { COORDINATING_MANDATE } from '../strategies/socialist/constitution.js';

/** The vote thresholds a democratic motion category can name. */
export const THRESHOLD_LABELS = [
  'simple_majority',
  'three_fifths',
  'two_thirds_plus_security_committee',
  'two_thirds_both_chambers',
  'human_required',
] as const;
export type ThresholdLabel = (typeof THRESHOLD_LABELS)[number];

const SECURITY_PATH_GLOBS = ['**/auth/**', '**/security/**', '**/*secret*', '**/*credential*'];

const count = () => z.number().int().nonnegative();
const positiveCount = () => z.number().int().positive();
const fraction = () => z.number().min(0).max(1);
const riskClass = z.enum(['low', 'medium', 'high']);
const byRiskClass = z.object({ low: z.number(), medium: z.number(), high: z.number() }).strict();
const seed = z.enum(['run-id', 'fixed']);
const globs = () => z.array(z.string()).default(SECURITY_PATH_GLOBS);
const thresholdLabel = z.enum(THRESHOLD_LABELS);

export const democraticConfigSchema = z.object({
  voteThresholds: z.object({
    routine: thresholdLabel.default('simple_majority'),
    cross_module: thresholdLabel.default('three_fifths'),
    security_boundary: thresholdLabel.default('two_thirds_plus_security_committee'),
    constitutional_amendment: thresholdLabel.default('two_thirds_both_chambers'),
    test_waiver: thresholdLabel.default('human_required'),
  }).strict().default({}),
  riskClassification: z.object({
    securityPathGlobs: globs(),
    crossModuleThreshold: positiveCount().default(2),
  }).strict().default({}),
  committee: z.object({
    electedSpecialistCalls: count().default(2),
    sortitionCalls: count().default(1),
    expeditedElectedSpecialistCalls: count().default(1),
    expeditedSortitionCalls: count().default(0),
  }).strict().default({}),
  confidenceVote: z.object({
    consecutiveFailuresBeforeSwap: positiveCount().default(3),
  }).strict().default({}),
  questionTimeEveryNTasks: positiveCount().default(5),
  constituencies: z.array(z.string()).default(
    ['frontend', 'backend', 'data', 'security', 'testing', 'documentation', 'user-experience', 'operations']),
  cabinet: z.object({
    portfolios: z.array(z.string()).default(
      ['architecture', 'implementation', 'verification', 'security', 'integration', 'documentation', 'release-operations']),
    collectiveResponsibility: z.boolean().default(true),
  }).strict().default({}),
  shadowCabinet: z.record(z.string()).default({
    architecture: 'shadow-architecture-reviewer',
    security: 'shadow-security-reviewer',
    verification: 'shadow-verification-lead',
    testing: 'shadow-verification-lead',
    'release-operations': 'shadow-release-reviewer',
    default: 'shadow-general-reviewer',
  }),
  offices: z.object({
    termLengthInTasks: count().default(6),
    candidatesPerOffice: positiveCount().default(3),
    constituentBallots: z.boolean().default(true),
    votersPerConstituency: z.number().int().min(2).max(5).default(2),
    seed: seed.default('run-id'),
  }).strict().default({}),
  speaker: z.object({
    admissibilityRuling: z.boolean().default(true),
    duplicateTitleSimilarity: fraction().default(0.85),
    maxMotionsPerReading: positiveCount().default(12),
  }).strict().default({}),
  debate: z.object({
    governmentReplyOnObjection: z.boolean().default(true),
    // One round is an Opposition objection and the Government's reply. The debate holds at most
    // one, so 0 (no reply) and 1 are the only values that mean what they say.
    maxRoundsPerMotion: z.number().int().min(0).max(1).default(1),
  }).strict().default({}),
  houseOfReview: z.object({
    enabled: z.boolean().default(true),
    minRiskClass: riskClass.default('medium'),
    maxDelays: count().default(1),
  }).strict().default({}),
  confidence: z.object({
    governmentFailuresBeforeMotion: positiveCount().default(3),
    representativeRecallFailures: positiveCount().default(3),
  }).strict().default({}),
  ceremonialHead: z.object({
    emergencyRollbackAfterRemediationCycles: positiveCount().default(2),
  }).strict().default({}),
  accountability: z.object({
    postImplementationReport: z.boolean().default(true),
  }).strict().default({}),
}).strict();

export const socialistConfigSchema = z.object({
  guilds: z.array(z.string()).default(['frontend', 'backend', 'testing', 'security', 'docs', 'architecture']),
  initialCapabilityScore: fraction().default(0.5),
  councils: z.object({
    membersPerGuild: positiveCount().default(2),
    requirePlanRatification: z.boolean().default(true),
    memberBallots: z.boolean().default(true),
    seed: seed.default('run-id'),
  }).strict().default({}),
  coordinating: z.object({
    termLengthInTasks: count().default(6),
    mandate: z.array(z.enum(COORDINATING_MANDATE)).default([...COORDINATING_MANDATE]),
    requireProductiveDuty: z.boolean().default(true),
  }).strict().default({}),
  reconnaissance: z.object({
    maxCouncils: count().default(2),
    requireProposedTests: z.boolean().default(true),
  }).strict().default({}),
  allocation: z.object({
    resourceEnvelopes: z.boolean().default(true),
    needsWeighting: z.object({
      riskClass: z.number().default(2),
      breadth: z.number().default(1),
      dependencies: z.number().default(1),
      priorRejections: z.number().default(2),
    }).strict().default({}),
    lessonBudget: z.object({
      min: count().default(3),
      max: count().default(8),
    }).strict().default({}),
    returnsBeforeReplan: count().default(2),
  }).strict().default({}),
  mutualAid: z.object({
    enabled: z.boolean().default(true),
    rejectionsBeforeAid: count().default(1),
  }).strict().default({}),
  recovery: z.object({
    failuresBeforeDiagnosis: positiveCount().default(2),
    maxAttemptsPerNode: positiveCount().default(3),
    appealOnScopeChange: z.boolean().default(true),
  }).strict().default({}),
  recall: z.object({
    consecutivePlannerFailuresBeforeSwap: positiveCount().default(3),
    delegateMisallocations: positiveCount().default(3),
  }).strict().default({}),
  escalateToHuman: z.object({
    securityPathGlobs: globs(),
  }).strict().default({}),
}).strict();

export const capitalistConfigSchema = z.object({
  bidCount: positiveCount().default(3),
  lowRiskBidCount: positiveCount().default(2),
  escrowFraction: fraction().default(0.2),
  escrowReleaseAfterCleanTasks: count().default(3),
  capitalFloorForHighRisk: z.number().default(0),
  initialCapital: z.number().positive().default(500),
  riskClassification: z.object({
    securityPathGlobs: globs(),
    highRiskRequiresSpendApproval: z.boolean().default(true),
  }).strict().default({}),
  bankruptcyThreshold: z.number().default(0),
  listingTerms: z.object({
    baseBudget: z.number().positive(),
    baseDeadlineMinutes: z.number().positive(),
    baseWarrantyTasks: count(),
  }).strict().optional(),
  specialisations: z.record(z.array(z.string())).optional(),
  arbitration: z.object({
    maxPerRun: count().default(2),
  }).strict().default({}),
  treasuryPolicy: z.object({
    levyFraction: fraction(),
    publicGoodsShare: fraction(),
    maxBailoutsPerRun: count(),
    bailoutFraction: fraction(),
    maxGrantFraction: fraction(),
  }).strict().partial().optional(),
  creditPolicy: z.object({
    baseLimitFraction: z.number().nonnegative(),
    minSettlementsForCredit: count(),
    riskDiscount: byRiskClass,
    maxSystemLeverage: z.number().nonnegative(),
  }).strict().partial().optional(),
  insurancePolicy: z.object({
    basePremiumFraction: fraction(),
    riskMultiplier: byRiskClass,
    deductibleFraction: fraction(),
    requiredAtRisk: z.array(riskClass),
    maxPremiumFraction: fraction(),
  }).strict().partial().optional(),
  capitalPolicy: z.object({
    initialCapital: z.number().positive(),
    neutralReputation: fraction(),
    reputationDecayPerSettlement: fraction(),
    consecutiveFailuresForInsolvency: positiveCount(),
    capitalFloorForHighRisk: z.number(),
    retentionReleaseAfterCleanTasks: count(),
  }).strict().partial().optional(),
  contractPolicy: z.object({
    baseRetention: fraction(),
    warrantyRetention: fraction(),
    timeAndMaterialsCapMultiple: z.number().positive(),
    outcomeContractsEnabled: z.boolean(),
    tournamentSuppliers: positiveCount(),
    tournamentsEnabled: z.boolean(),
  }).strict().partial().optional(),
  firms: z.object({
    maxSubcontractors: count().default(1),
    integrationThreshold: fraction().default(0.6),
  }).strict().default({}),
  priceList: z.object({
    usdToTokens: z.number().positive(),
    perThousandPromptTokens: z.number().nonnegative(),
    perThousandCompletionTokens: z.number().nonnegative(),
    perContextWindow: z.number().nonnegative(),
    perToolCall: z.number().nonnegative(),
    perLatencyMinute: z.number().nonnegative(),
    perReviewerCall: z.number().nonnegative(),
    perMergeRiskFile: z.number().nonnegative(),
    securityExposure: byRiskClass,
    perMaintainedFile: z.number().nonnegative(),
    perOpenWarranty: z.number().nonnegative(),
  }).strict().partial().optional(),
}).strict();

const controlRiskClassification = z.object({
  securityPathGlobs: globs(),
  crossModuleThreshold: positiveCount().default(2),
}).strict().default({});

export const managerialConfigSchema = z.object({
  riskClassification: controlRiskClassification,
  maxReviewAttempts: positiveCount().default(3),
}).strict();

export const singleAgentConfigSchema = z.object({
  riskClassification: controlRiskClassification,
}).strict();

export const strategiesConfigSchema = z.object({
  democratic: democraticConfigSchema.default({}),
  socialist: socialistConfigSchema.default({}),
  capitalist: capitalistConfigSchema.default({}),
  managerial: managerialConfigSchema.default({}),
  single_agent: singleAgentConfigSchema.default({}),
}).strict();

export type DemocraticConfig = z.infer<typeof democraticConfigSchema>;
export type SocialistConfig = z.infer<typeof socialistConfigSchema>;
export type CapitalistConfig = z.infer<typeof capitalistConfigSchema>;
export type ManagerialConfigSection = z.infer<typeof managerialConfigSchema>;
export type SingleAgentConfigSection = z.infer<typeof singleAgentConfigSchema>;
export type ValidatedStrategiesConfig = z.infer<typeof strategiesConfigSchema>;
export type ConfiguredStrategyId = keyof ValidatedStrategiesConfig;

export const DEMOCRATIC_DEFAULTS: DemocraticConfig = democraticConfigSchema.parse({});
export const SOCIALIST_DEFAULTS: SocialistConfig = socialistConfigSchema.parse({});
export const CAPITALIST_DEFAULTS: CapitalistConfig = capitalistConfigSchema.parse({});
export const MANAGERIAL_DEFAULTS: ManagerialConfigSection = managerialConfigSchema.parse({});
export const SINGLE_AGENT_DEFAULTS: SingleAgentConfigSection = singleAgentConfigSchema.parse({});

/** One line per problem, each naming the full key path, e.g. `democratic.voteThresholds.routine`. */
export function describeConfigIssues(error: z.ZodError): string[] {
  return error.issues.flatMap((issue) => {
    const at = issue.path.join('.');
    if (issue.code === 'unrecognized_keys') {
      return issue.keys.map((key) => `${at ? `${at}.` : ''}${key}: unknown key (no strategy reads it)`);
    }
    return [`${at || '(root)'}: ${issue.message}`];
  });
}

/** Parses the whole file. Throws with every bad key path listed, so startup fails loudly. */
export function parseStrategiesConfig(raw: unknown, source = 'config/strategies.yaml'): ValidatedStrategiesConfig {
  const result = strategiesConfigSchema.safeParse(raw ?? {});
  if (result.success) return result.data;
  throw new Error(`${source} is invalid:\n${describeConfigIssues(result.error).map((line) => `  - ${line}`).join('\n')}`);
}
