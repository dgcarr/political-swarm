import type { WorkerDispatcher } from './WorkerDispatcher.js';
import type { RepoWorktree } from './RepoWorktree.js';
import type { Ledger } from './Ledger.js';
import type { KnowledgeStore } from './KnowledgeStore.js';
import type { BudgetGuard } from './BudgetGuard.js';
import type { RunState } from './RunStore.js';
import type { ChecksConfig } from '../util/config.js';
import type {
  DeliveryPacket,
  DoctrineAcceptance,
  Finding,
  IntegrationResult,
  OwnershipMap,
  RemediationPacket,
  SynchronizationPacket,
  VerificationResult,
} from './packets.js';
import type {
  Assignment,
  Decision,
  PendingApproval,
  ReviewResult,
  StrategyId,
  TaskGraph,
  TaskSpec,
  TestResult,
  WorkProduct,
} from './types.js';

export interface RecoveryRequest {
  product: WorkProduct;
  review: ReviewResult;
  decision: Extract<Decision, { outcome: 'rework' }>;
  test: TestResult;
  /** One-based count of attempts made on this node so far, including the one just recorded. */
  attemptNumber: number;
  /** Engine-owned absolute ceiling for this node (config/budget.yaml: defaults.maxTaskAttempts). */
  maxAttempts: number;
  /** True when this attempt failed the same way as the one before it (engine/repairBrief.ts). */
  repeated: boolean;
  /** The engine's evidence for the next attempt; the dispatcher already shows it to implementers. */
  brief?: import('./repairBrief.js').RepairBrief;
}

export interface EngineContext {
  dispatcher: WorkerDispatcher;
  worktree: RepoWorktree;
  ledger: Ledger;
  knowledge: KnowledgeStore;
  budget: BudgetGuard;
  config: Record<string, unknown>; // this strategy's slice of config/strategies.yaml
  checks: ChecksConfig; // config/checks.yaml — the verification categories run after execute()
  runId: string;
  runState: RunState;
  /** Strategy-private state persisted across the run (e.g. capital accounts, capability scores). */
  strategyState: Record<string, unknown>;
  /** Strategies call this instead of mutating runState.pendingApprovals directly, to keep ids consistent. */
  openApproval: (approval: Omit<PendingApproval, 'id' | 'createdAt'>) => PendingApproval;
  /** Reads a resolved approval's decision, if any, for a given id. */
  getApprovalResolution: (approvalId: string) => PendingApproval | undefined;
  /** The bounded state to hand a newly started or resumed agent instance, per section 5. Rebuilt
   * on demand rather than cached, so a barrier always sees the state as it stands. */
  syncPacket: () => Promise<SynchronizationPacket>;
  /** Records a finding on the run. Every one must carry a disposition before delivery. */
  addFinding: (finding: Omit<Finding, 'id'> & { id?: string }) => Finding;
  /** All findings raised so far in this run. */
  findings: () => Finding[];
}

/**
 * The shared lifecycle every governance strategy implements.
 *
 * SwarmEngine drives the per-task portion in order — assign -> execute -> review -> decide ->
 * recordOutcome — and then the acceptance barriers, which are serial by construction:
 *
 *   baseline -> plan -> declareOwnership
 *     -> loop( assign -> execute* -> apply -> checks -> review -> decide -> recordOutcome )
 *     -> integrate -> verifyDelivery -> disposeFindings -> accept
 *     -> awaiting_acceptance (Claude's independent check)
 *     -> [ remediate, if Claude rejects ]
 *
 * The barriers are required rather than defaulted because each doctrine performs them through
 * different institutions: an Integration Committee answerable to the Commons, an integration
 * council of producers, a separately procured integration assessor paid by contract. The engine
 * fixes only that they happen, in what order, and that their evidence reaches the delivery packet.
 * It never performs them itself, and never substitutes its own judgment for a doctrine's decision.
 */
export interface SwarmStrategy {
  readonly id: StrategyId;
  plan(ctx: EngineContext, task: TaskSpec): Promise<TaskGraph>;
  assign(ctx: EngineContext, graph: TaskGraph): Promise<Assignment[]>;
  execute(ctx: EngineContext, assignment: Assignment): Promise<WorkProduct>;
  review(ctx: EngineContext, product: WorkProduct, test: TestResult): Promise<ReviewResult>;
  decide(ctx: EngineContext, product: WorkProduct, review: ReviewResult): Promise<Decision>;
  recordOutcome(ctx: EngineContext, decision: Decision, test: TestResult): Promise<void>;
  requiresHumanApproval(ctx: EngineContext, decision: Decision): boolean;

  /**
   * Gives a doctrine that requested rework one bounded opportunity to prepare a meaningfully
   * different attempt. Recovery may shape doctrine state and evidence, but it cannot settle the
   * node or stand in for the doctrine's eventual approval.
   */
  recover?(ctx: EngineContext, request: RecoveryRequest): Promise<void>;

  /**
   * Publishes which files, interfaces, generated artefacts and tests each task owns, before any
   * work is dispatched. The engine uses it to decide what may run concurrently and to detect
   * writes nobody claimed.
   */
  declareOwnership(ctx: EngineContext, graph: TaskGraph): Promise<OwnershipMap>;

  /**
   * The integration barrier. Inspects the aggregate diff of every approved task — not the isolated
   * per-task products already reviewed — and reports on the combined tree. Section 10, uniformly:
   * "Passing isolated work streams is insufficient." The integrator must not be an implementer.
   */
  integrate(ctx: EngineContext, approvedTaskIds: string[], diffText: string): Promise<IntegrationResult>;

  /**
   * Independent verification by an agent outside the authorship chain. Traces each user acceptance
   * criterion to implementing code and evidence, and may block delivery.
   */
  verifyDelivery(ctx: EngineContext, draft: DeliveryPacket): Promise<VerificationResult>;

  /**
   * Assigns every open finding exactly one disposition. Returning a finding without one, or a
   * `deferred` finding with no owner and return condition, fails the barrier — no finding may
   * disappear through summary or assertion.
   */
  disposeFindings(ctx: EngineContext, open: Finding[]): Promise<Finding[]>;

  /**
   * The doctrine's own acceptance decision on the assembled delivery, reached under its own rules:
   * a constitutional verification gate, a councils' recorded acceptance, an escrow release bounded
   * by the regulatory safety floor. Claude records this decision. It is not bound by it.
   */
  accept(ctx: EngineContext, draft: DeliveryPacket): Promise<DoctrineAcceptance>;

  /**
   * Resumes the swarm from Claude's rejection under the doctrine's own rules, returning the graph
   * to work from. The preserved delivery travels with the packet and must not be discarded.
   */
  remediate(ctx: EngineContext, packet: RemediationPacket): Promise<TaskGraph>;
}
