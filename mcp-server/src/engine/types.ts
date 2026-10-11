// Shared types for the swarm engine. All three governance strategies (democratic, socialist,
// capitalist) operate on these — only the internal logic of each SwarmStrategy method differs.

export type StrategyId = 'democratic' | 'socialist' | 'capitalist' | 'managerial' | 'single_agent' | 'noop';

export interface TaskSpec {
  goal: string;
  acceptanceCriteria: string[];
  repoPath: string;
  baseBranch: string;
  constraints?: string[];
}

export type RiskClass = 'low' | 'medium' | 'high';

export type TaskPhase = 'queued' | 'running' | 'blocked' | 'settled' | 'abandoned';

export type DecisionOutcome = 'approved' | 'rework' | 'rejected' | 'needs_human';

export interface TaskAttempt {
  attempt: number;
  outcome: DecisionOutcome;
  rationale: string;
  evidenceRefs: string[];
  assigneeId?: string;
  testsPassed?: boolean;
  at: string;
  /** Engine-derived, not doctrine-supplied — see engine/attemptFingerprint.ts. */
  fingerprint: string;
  /** True when this attempt's fingerprint matches the immediately preceding attempt's. */
  repeated: boolean;
  /**
   * True when the attempt ended in a provider or transport failure rather than in a judgement
   * about the work. These are recorded for the audit trail but do not consume the task's rework
   * budget: across two benchmark sweeps 37 of 411 attempts died on a per-call timeout, and one
   * task that had already been approved was abandoned because its last two attempts were both
   * the provider timing out.
   */
  transient?: boolean;
  /**
   * True when the attempt was made while a dependency was missing from the tree: the node had been
   * released past an abandoned dependency (TaskNode.abandonedDependencies). Once remediation brings
   * that dependency back, these attempts judged work that could not have passed, so like transient
   * ones they stop counting against the rework budget.
   */
  withoutDependency?: boolean;
  /** Strict whole-suite status when this attempt was judged, alongside the regression-only `testsPassed`. */
  suitePassed?: boolean;
  /** Original institutional verdict when a later human ruling resolves the attempt. */
  doctrineOutcome?: DecisionOutcome;
  /** What failed, independent of the code and of review prose — see engine/repairBrief.ts. */
  failureSignature?: string;
  /** One line for later attempts' history: failing checks and the first error. */
  failureSummary?: string;
}

export interface TaskNode {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  dependsOn: string[];
  targetGlobs: string[];
  riskTags: string[];
  riskClass: RiskClass;
  phase: TaskPhase;
  attempts: TaskAttempt[];
  /** Section 9's requirement-to-test traceability: one entry per acceptance criterion this node
   * carries, naming the command and expected result that demonstrate it. Produced by the
   * doctrine's testing body at plan time, before or alongside implementation. */
  evidence?: import('./packets.js').EvidenceItem[];
  /** Set when this node was reopened by a remediation cycle, naming Claude's defect. */
  remediationOf?: string;
  /** Which remediation round last reopened this node (`origin:cycle`). Doctrines now give each
   * reopened node its own remediationOf, so nodes reopened together are matched by this instead. */
  remediationRound?: string;
  /** Reasons previous attempts were refused human sign-off, newest last. Carried into the next
   * attempt so a requeued task does not begin as blind as the one that just failed. */
  signOffRefusals?: string[];
  /** Task owners that must repair a defect before this node can make another legal attempt. */
  blockedByForeignTaskIds?: string[];
  /** Pre-task content retained while an applied final diff awaits a human ruling. */
  pendingFileSnapshots?: Array<{ path: string; existed: boolean; content?: string }>;
  /** Pre-task content of a change applied but not yet judged; set only while settling. */
  inFlightFileSnapshots?: Array<{ path: string; existed: boolean; content?: string }>;
  /** Checks run against the applied final diff awaiting a human ruling. */
  pendingCheckSnapshot?: import('./packets.js').CheckRunRecord[];
  /** Dependencies the doctrine abandoned, which this node was released to proceed without rather
   * than wait forever for. What it builds is reported against their absence, never as though they
   * had passed. See TaskGraph.releaseOrphanedDependents. */
  abandonedDependencies?: string[];
  /** The files a reworked attempt left, as they stood when it was judged. Reverted from the shared
   * tree like any rejected change, but shown to this task's own repository tools and resubmitted under
   * its next attempt, so a retry edits its work instead of rewriting it from nothing. Cleared once a
   * settle consumes it and when remediation reopens the node. */
  retainedAttempt?: Array<{ path: string; existed: boolean; content?: string }>;
  /** Engineering evidence from the last unaccepted attempt, for the next implementer. Cleared on
   * approval and when remediation reopens the node. */
  repairBrief?: import('./repairBrief.js').RepairBrief;
}

export interface TaskGraph {
  nodes: Record<string, TaskNode>;
  order: string[]; // insertion order, for stable task display
}

export interface Assignment {
  taskId: string;
  assigneeId: string; // strategy-defined persona/agent id (e.g. guild member, bidder, portfolio)
  role: string; // WorkerDispatcher role used for execution (usually 'implementer')
  meta?: Record<string, unknown>; // strategy-specific data (bid info, portfolio, guild, etc.)
}

export type FileOp =
  | { op: 'write'; path: string; content: string }
  | { op: 'edit'; path: string; find: string; replace: string }
  | { op: 'delete'; path: string };

export interface WorkProduct {
  taskId: string;
  assignment: Assignment;
  fileOps: FileOp[];
  rationale: string;
  unresolvedUncertainty?: string;
  meta?: Record<string, unknown>;
}

export interface ReviewFinding {
  reviewerId: string;
  verdict: 'approve' | 'reject' | 'flag';
  rationale: string;
  evidenceRefs?: string[];
}

export interface ReviewResult {
  taskId: string;
  findings: ReviewFinding[];
  testResult?: TestResult;
  meta?: Record<string, unknown>;
}

export interface TestResult {
  ran: boolean;
  suitePassed?: boolean;
  introducedRegression?: boolean;
  incompleteCategories?: string[];
  /** Strategy-compatible task verdict: this task introduced no required regression. */
  passed: boolean;
  newFailures?: string[];
  preExistingFailures?: string[];
  command?: string;
  /** Failing output of the checks charged to this task (new and still-failing required
   * categories); advisory categories are named in advisoryFailures, never pasted here. */
  output?: string;
  /** Per-category status of the checks charged to this task. */
  checks?: import('./repairBrief.js').BriefCheck[];
  advisoryFailures?: string[];
  /** Required categories that collected no tests, before this change and after it. */
  emptyChecks?: string[];
}

export interface ReworkDirective {
  /** Concrete differences required from the next attempt. Must be non-empty when present. */
  requiredChanges: string[];
}

interface DecisionBase {
  taskId: string;
  rationale: string;
  evidenceRefs: string[];
  /**
   * Engineering-only lines the engine leads the rework directive with if it turns this rejection
   * into another attempt. Without it the rationale leads, and a rationale written for the ledger —
   * capitalist's carries settlement, forfeiture and P&L — then reaches the implementer as though
   * it were something to fix.
   */
  repairDirective?: string[];
  meta?: Record<string, unknown>;
}

export type Decision =
  | (DecisionBase & { outcome: 'approved' | 'rejected' | 'needs_human'; rework?: never })
  | (DecisionBase & { outcome: 'rework'; rework: ReworkDirective });

export type PendingApprovalKind =
  | 'vote_threshold'
  | 'spend_approval'
  | 'test_waiver'
  | 'confidence_vote'
  | 'budget_increase'
  | 'wall_clock_extension'
  | 'final_diff';

export interface PendingApproval {
  id: string;
  kind: PendingApprovalKind;
  taskId?: string;
  description: string;
  requiredBy?: string;
  createdAt: string;
  resolvedAt?: string;
  resolution?: 'approve' | 'reject' | 'modify';
  note?: string;
}
