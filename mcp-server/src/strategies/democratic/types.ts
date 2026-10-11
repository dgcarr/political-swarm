import type { RiskClass } from '../../engine/types.js';
import { DEMOCRATIC_DEFAULTS, type ThresholdLabel } from '../../constitution/schema.js';

// The `democratic:` section of config/strategies.yaml, as constitution/schema.ts validates it and
// fills its defaults. The engine hands the slice over untyped; the strategy casts it to this.
export type { DemocraticConfig } from '../../constitution/schema.js';

/** Section 6's constituency list, used when config names none. */
export const DEFAULT_CONSTITUENCIES: readonly string[] = DEMOCRATIC_DEFAULTS.constituencies;

/** Section 6's Cabinet of Maintainers, used when config names no portfolios. */
export const DEFAULT_PORTFOLIOS: readonly string[] = DEMOCRATIC_DEFAULTS.cabinet.portfolios;

/** First-reading classification of a motion. Drives how much committee scrutiny it gets. */
export type MotionClass = 'routine' | 'committee' | 'emergency';

/**
 * The five vote-threshold buckets named in config/strategies.yaml. These don't map 1:1 onto the
 * three-value RiskClass ('low' | 'medium' | 'high'); see DemocraticStrategy.classifyThresholdCategory
 * for the (documented, deterministic) mapping this strategy uses.
 */
export type ThresholdCategory =
  | 'routine'
  | 'cross_module'
  | 'security_boundary'
  | 'constitutional_amendment'
  | 'test_waiver';

/**
 * One motion drafted by the planner dispatch — becomes one TaskNode.
 *
 * The last three fields are section 7 stage 1's petition requirements: a proposal must state its
 * estimated cost, foreseeable risks and rollback conditions. They exist so stage 9 can hold the
 * government to what it said when it asked for authority; without them, "actual versus expected"
 * has no expected. They are optional on the wire because a planner that omits them should produce a
 * motion recorded as having promised nothing, not a crashed run.
 */
export interface Motion {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  targetGlobs: string[];
  dependsOn: string[];
  /** Loose committee portfolio label, e.g. 'architecture' | 'security' | 'testing' | 'frontend' | 'backend' | 'docs'. */
  portfolioTag: string;
  estimatedCostUsd?: number;
  foreseeableRisks?: string[];
  rollbackConditions?: string;
}

export interface PlannerOutput {
  motions: Motion[];
}

/**
 * A single committee member's (elected specialist or sortition citizen) verdict on a motion.
 *
 * 'abstain' is section 6's protected right, not a fourth opinion: "an agent should not vote on a
 * proposal it cannot inspect. Abstention is preferable to uninformed voting." It is dropped from
 * the committee average rather than scored, so a committee that cannot judge a motion cannot carry
 * it by default either.
 */
export type CommitteeVerdict = 'approve' | 'reject' | 'flag' | 'abstain';

export interface CommitteeFinding {
  personaId: string;
  portfolioTag: string;
  seat: 'elected' | 'sortition';
  verdict: CommitteeVerdict;
  rationale: string;
}

/**
 * Everything the committee stage (assign()) hands forward to review()/decide() via Assignment.meta.
 * Note: thresholdCategory is NOT decided here — it depends on the TestResult (test_waiver) and the
 * actually-touched file paths (constitutional_amendment), neither of which exist until after
 * execute() runs. decide() computes it fresh from riskClass + the review's TestResult.
 */
export interface DemocraticAssignmentMeta {
  motionClass: MotionClass;
  riskClass: RiskClass;
  portfolioTag: string;
  committeeFindings: CommitteeFinding[];
  /** Set when the closure rule carried the first sitting's findings to this retry instead of the
   * committee sitting again: they were judged before any code existed. */
  committeeCarried?: boolean;
  [key: string]: unknown;
}

/** The record a recommitted motion carries into its next committee inquiry and implementation. */
export interface RecommittalDirective {
  requiredChanges: string[];
  attemptNumber: number;
  maxAttempts: number;
  repeated: boolean;
  appealGranted: boolean;
  /** What the defeated attempt actually showed, so a recommitted committee judges evidence rather
   * than the earlier refusal. Absent on directives recorded before it existed. */
  lastAttempt?: {
    checksPassed: boolean;
    oppositionVerdict?: 'approve' | 'reject' | 'flag';
  };
}

/** The opposition's adversarial counter-brief on the actual WorkProduct, produced in review(). */
export interface OppositionFinding {
  verdict: 'approve' | 'reject' | 'flag';
  severity: 'low' | 'medium' | 'high';
  rationale: string;
  counterBrief?: string;
  /** Section 14: the feasible remedy an objection names, where one exists. */
  remedy?: string;
}

/** Structured signals decide()'s pure vote function consumes — no LLM call happens in that function. */
export interface VoteInputs {
  category: ThresholdCategory;
  thresholdLabel: ThresholdLabel;
  committeeApproveScore: number; // 0..1, approve=1/flag=0.5/reject=0 averaged across committee findings
  oppositionVerdict: 'approve' | 'reject' | 'flag';
  oppositionSeverity: 'low' | 'medium' | 'high';
  /**
   * The Commons division: ayes as a fraction of ayes and noes, abstentions excluded. Null when no
   * member was in a position to vote, in which case the committee's own score stands in — the
   * chamber does not get to carry a motion by unanimous silence.
   */
  divisionShare?: number | null;
  /**
   * The Government has already revised this motion once to answer an Opposition reject. Section 7
   * stage 4 obliges it to answer objections; it does not make the Opposition's verdict final. Once
   * answered, the House decides, and a standing objection is recorded as a minority report.
   */
  oppositionAnswered?: boolean;
}

export interface VoteResult {
  outcome: 'approved' | 'rejected' | 'needs_human';
  voteWouldPass: boolean;
  rationale: string;
}

/**
 * Section 11's Question Time: the ten questions the executive must answer, each derived from the
 * run's own record rather than reported by an agent. Deterministic and free — no dispatch.
 *
 * The field names map to the questions in order: what has changed since the approved plan, which
 * acceptance criteria are unmet, what evidence contradicts the executive's preferred approach,
 * which risks have increased, which modules have not been consulted, what resources have been
 * consumed, which decisions are irreversible, what would cause a change of direction, what the
 * Opposition's strongest objection is, and which claims remain assumptions.
 */
export interface QuestionTimeSummary {
  asOfCompletedTasks: number;
  generatedAt: string;
  whatChanged: string[];
  whatsUnmet: string[];
  contradictingEvidence: string[];
  risksIncreased: string[];
  unconsulted: string[];
  resourcesConsumed: string[];
  irreversible: string[];
  wouldChangeDirection: string[];
  strongestObjection: string[];
  unverifiedAssumptions: string[];
}

export interface DemocraticStrategyState {
  portfolioMinisters?: Record<string, string>;
  portfolioFailures?: Record<string, number>;
  portfolioVersions?: Record<string, number>;
  taskFileOps?: Record<string, { op: string; path: string }[]>;
  taskMeta?: Record<string, { title: string; riskClass: RiskClass; portfolioTag: string; treatment?: MotionClass }>;
  /** The committee findings that authorised a routine motion at its first sitting. Section 14's
   * closure rule carries them to the motion's retries instead of re-convening the committee. */
  committeeAuthorisations?: Record<string, CommitteeFinding[]>;
  completedTaskCount?: number;
  questionTime?: QuestionTimeSummary;
  /** The office register for the current term (section 8). Re-derivable from the ledger. */
  offices?: import('./offices.js').OfficeRegister;
  /** Electorate fixed when offices are first constituted; a config edit cannot shrink a live House. */
  electorate?: string[];
  executiveMandateId?: string;
  executiveMandateDigest?: string;
  representativeMandates?: Record<string, { id: string; digest: string }>;
  /** Per-constituency count of departures a representative could not justify on evidence —
   * section 8's "persistent misrepresentation", which is what recall answers. */
  representativeDepartures?: Record<string, number>;
  /** Motions carried and defeated under the current term, filed to the civil service's cross-run
   * memory when the term ends so the next election has a record to read. */
  termTally?: { carried: number; defeated: number };
  /** The same, per portfolio, so a minister's record follows the minister. */
  portfolioTally?: Record<string, { carried: number; defeated: number }>;
  /** Per motion: whether the responsible minister conceded the Opposition's objection in its reply.
   * Collective responsibility turns on this. */
  ministerConcessions?: Record<string, boolean>;
  /** Consecutive defeats for the government as a whole, which is what holds office by confidence —
   * as distinct from portfolioFailures, which answers for one brief. */
  governmentFailures?: number;
  /** Delays the second chamber has already used, against houseOfReview.maxDelays. A chamber that
   * could keep asking for more time would hold a veto reached by attrition. */
  houseOfReviewDelays?: number;
  /** Motions that have already exercised their one appeal (section 6's right of appeal). */
  appealsHeard?: string[];
  /** The deterministic result of that one appeal, retained across both recovery paths. */
  appealOutcomes?: Record<string, boolean>;
  /** Per-motion instructions placed before the next committee and implementer after recommittal. */
  recommittals?: Record<string, RecommittalDirective>;
  /** Per motion reopened by remediate(): the findings that reopened it, evidence included, for its
   * implementer. Kept across its rework attempts; cleared once the motion carries. */
  remediationDirectives?: Record<string, string>;
  /** How each motion's division actually went, kept so an appeal can be judged on the numbers
   * rather than on the wording of a rationale. */
  divisions?: Record<
    string,
    {
      ayes: number;
      noes: number;
      abstentions: number;
      oppositionVerdict: string;
      oppositionSeverity: string;
      /** The constituencies that actually cast a vote, by constituency name — Question Time reports
       * the ones that never did, and portfolio tags do not share that vocabulary. */
      voted: string[];
    }
  >;
  /** What each motion promised at first reading (section 7 stage 1), so stage 9 has an "expected"
   * to set the actual against. */
  motionEstimates?: Record<string, { estimatedCostUsd: number; foreseeableRisks: string[]; rollbackConditions: string }>;
  /** The integrated tree's check results, stashed at the verification barrier so the second
   * chamber can see them at the next one. */
  finalChecks?: import('../../engine/packets.js').CheckRunRecord[];
  /** The requirement matrix as the checks resolved it, stashed at the same barrier for the same
   * reason. */
  requirementMatrix?: import('../../engine/packets.js').EvidenceItem[];
  /** The doctrine's contributions to the delivery manifest — read by engine/delivery.ts. */
  deliveryNotes?: { limitations: string[]; residualRisks: string[]; rollbackNotes: string[] };
  [key: string]: unknown;
}
