import { readFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '../util/durableFile.js';
import { logger } from '../util/logger.js';
import type { PendingApproval, StrategyId, TaskAttempt, TaskGraph, TaskPhase } from './types.js';
import type {
  CheckRunRecord,
  DeliveryPacket,
  EvidenceItem,
  Finding,
  OwnershipMap,
  SynchronizationPacket,
} from './packets.js';
import type { EventBus } from './EventBus.js';
import type { GovernanceDecision, GovernanceMandate } from './governance.js';

/**
 * Section 5 of every philosophy doc defines exactly three ways a run can end, and they are not
 * interchangeable:
 *
 *  - `awaiting_acceptance` — the doctrine reached its own valid acceptance decision and submitted a
 *    delivery packet. Not complete yet: Claude has not checked it.
 *  - `completed` — "complete only when the selected doctrine has reached its own valid acceptance
 *    decision AND submitted a delivery packet that Claude independently accepts."
 *  - `remediation` — Claude rejected the delivery; the same swarm resumes from the remediation
 *    packet under its own rules. Transitional: the loop moves it back to `running`.
 *  - `terminated_incomplete` — user cancellation, resource exhaustion, or the doctrine's own
 *    recorded terminal failure. Claude "must preserve the last synchronization packet and report
 *    the reason rather than representing partial work as accepted."
 */
export type RunStatus =
  | 'running'
  | 'paused_budget'
  | 'paused_human'
  | 'awaiting_acceptance'
  | 'remediation'
  | 'completed'
  | 'terminated_incomplete'
  | 'failed'
  | 'stopped'
  | 'interrupted';

export interface RunState {
  schemaVersion?: 2;
  runId: string;
  /** Seed for the doctrine's lots (sortition, councils, panels, subcontracts); the run id when unset. */
  lotSeed?: string;
  strategy: StrategyId;
  task: { goal: string; acceptanceCriteria: string[] };
  repoPath: string;
  baseBranch: string;
  worktreePath: string;
  branch: string;
  status: RunStatus;
  createdAt: string;
  startedAt?: string;
  deadlineAt?: string;
  heartbeatAt?: string;
  updatedAt: string;
  budgetUsd: number;
  costUsd: number;
  tokensUsed: { prompt: number; completion: number };
  workerCalls: number;
  graph: TaskGraph | null;
  pendingApprovals: PendingApproval[];
  strategyState?: Record<string, unknown>;
  governanceDecisions?: GovernanceDecision[];
  governanceMandates?: GovernanceMandate[];
  resourceReservations?: Record<string, { limitUsd: number; spentUsd: number }>;
  lastError?: string;
  /** Every finding raised in this run, each carrying exactly one disposition (section 10). */
  findings?: Finding[];
  /** Checks run against the untouched worktree before planning, so pre-existing failures are
   * disclosed as limitations rather than charged to the swarm (section 9). */
  baseline?: CheckRunRecord[];
  /** Published before dispatch and re-published at each barrier (section 8). */
  ownership?: OwnershipMap;
  /** The run-level test mandate: one entry per user acceptance criterion, naming the check that
   * demonstrates it. Written at plan time by the doctrine's testing body; its statuses are resolved
   * from the checks that actually ran, never from an agent's report. */
  evidence?: EvidenceItem[];
  /** Assembled once the doctrine accepts; what Claude independently checks. */
  delivery?: DeliveryPacket;
  acceptedTreeId?: string;
  /** The last bounded state captured before the run stopped. Section 5 requires Claude to
   * "preserve the last synchronization packet and report the reason rather than representing
   * partial work as accepted", so a run that ends without a delivery still ends with this. */
  lastSyncPacket?: SynchronizationPacket;
  /** How many times Claude has rejected a delivery and returned it to this same swarm. */
  remediationCycles?: number;
  graphRemediationCycles?: number;
  /** The set of task ids the most recent graph remediation cycle actually submitted, sorted.
   * Compared against the next cycle's own set to detect a stalled cycle — one that names exactly
   * the same tasks again, meaning nothing about the blockage changed — which signals a deadlock
   * (e.g. two tasks each blocked by the other) rather than a doctrine still converging. */
  lastGraphRemediationTaskIds?: string[];
  deliveryRemediationCycles?: number;
  oracleRemediationCycles?: number;
  currentCheckSnapshot?: CheckRunRecord[];
  /** Tasks whose attempt the doctrine is reviewing right now, with that attempt's check output. The
   * dispatcher reads it to tell those reviews where the checks fail and to hold their rejects to
   * the files the task owns. */
  underReview?: Record<string, string>;
  protectedBaselineTests?: string[];
  /** Runtime files final-only checks generated, retained as evidence and stripped from authored diffs. */
  checkArtifacts?: import('./packets.js').CheckArtifact[];
  /**
   * The constitution this run adopted at start: its digest, and the strategy configuration the
   * doctrine reads for the whole run. Holding the configuration here means editing
   * strategies.yaml cannot change the rules of a run already in progress, including on resume.
   */
  constitution?: { digest: string | null; config: Record<string, unknown> };
  /** `pid` and `hostname` let a restart on the same machine tell a dead owner from a live one. */
  engineLease?: { instanceId: string; acquiredAt: string; heartbeatAt: string; pid?: number; hostname?: string };
  institutionalCallsByTask?: Record<string, number>;
  institutionalPlanCache?: Record<string, { raw: string; model: string }>;
  /** Consecutive transient provider failures the run loop itself has crashed on and been
   * requeued from, bounded the same way task-level trailing transient attempts are. */
  loopCrashRetries?: number;
}

type LegacyTaskStatus = 'pending' | 'ready' | 'in_progress' | 'approved' | 'rejected' | 'blocked_on_human';

interface MigratableTaskNode {
  status?: LegacyTaskStatus;
  phase?: TaskPhase;
  attempts?: TaskAttempt[];
}

const LEGACY_PHASES: Record<LegacyTaskStatus, TaskPhase> = {
  pending: 'queued',
  ready: 'queued',
  in_progress: 'queued',
  blocked_on_human: 'blocked',
  approved: 'settled',
  rejected: 'abandoned',
};

export function migrateLegacyTaskNodes(state: RunState): RunState {
  if (!state.graph) return state;

  for (const id of state.graph.order) {
    const node = state.graph.nodes[id] as unknown as MigratableTaskNode;
    if (node.phase || !node.status) continue;

    const legacyStatus = node.status;
    node.phase = LEGACY_PHASES[legacyStatus];
    node.attempts = [];
    if (legacyStatus === 'approved' || legacyStatus === 'rejected') {
      node.attempts.push({
        attempt: 1,
        outcome: legacyStatus,
        rationale: 'migrated from legacy status',
        evidenceRefs: [],
        at: state.updatedAt,
        fingerprint: '',
        repeated: false,
      });
    }
    delete node.status;
  }

  return state;
}

export function migrateRunState(state: RunState): RunState {
  migrateLegacyTaskNodes(state);
  const legacy = state as RunState & Partial<RunState>;
  const startedAt = legacy.startedAt ?? state.createdAt;
  state.schemaVersion = 2;
  state.startedAt = startedAt;
  state.deadlineAt = legacy.deadlineAt ?? new Date(new Date(startedAt).getTime() + 30 * 60_000).toISOString();
  state.heartbeatAt = legacy.heartbeatAt ?? state.updatedAt;
  state.currentCheckSnapshot ??= state.baseline ?? [];
  state.protectedBaselineTests ??= [];
  state.graphRemediationCycles ??= 0;
  state.deliveryRemediationCycles ??= state.remediationCycles ?? 0;
  state.oracleRemediationCycles ??= 0;
  return state;
}

// JSON snapshot per run, rebuilt/overwritten on every mutation. No native DB — this machine
// doesn't need one and avoids native-module build risk. Enables swarm_status to answer fast
// without replaying the ledger, and swarm_list_runs to recover state after a restart.
export class RunStore {
  constructor(private readonly runsRootDir: string, private readonly bus?: EventBus) {
    mkdirSync(runsRootDir, { recursive: true });
  }

  private runDir(runId: string): string {
    return path.join(this.runsRootDir, runId);
  }

  private statePath(runId: string): string {
    return path.join(this.runDir(runId), 'state.json');
  }

  save(state: RunState): void {
    mkdirSync(this.runDir(state.runId), { recursive: true });
    const serialized = JSON.stringify(state, null, 2);
    writeFileAtomic(this.statePath(state.runId), serialized);
    // The engine mutates its RunState in place, so hand subscribers a detached snapshot —
    // otherwise a reader would observe changes that have not been written to disk yet.
    try {
      if (this.bus) {
        this.bus.publish({
          kind: 'state',
          runId: state.runId,
          state: JSON.parse(serialized) as RunState,
          source: 'engine',
        });
      }
    } catch {
      /* ignore */
    }
  }

  load(runId: string): RunState | null {
    const p = this.statePath(runId);
    if (!existsSync(p)) return null;
    let parsed: RunState;
    try {
      parsed = JSON.parse(readFileSync(p, 'utf8')) as RunState;
    } catch (error) {
      throw new Error(`Run state for "${runId}" is unreadable (${p}): ${String(error)}`);
    }
    return migrateRunState(parsed);
  }

  listRunIds(): string[] {
    if (!existsSync(this.runsRootDir)) return [];
    return readdirSync(this.runsRootDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== 'knowledge')
      .map((d) => d.name)
      .filter((id) => existsSync(this.statePath(id)));
  }

  listAll(): RunState[] {
    // One unreadable run must not take every other run down with it: the engine lists all runs
    // at startup, so a throw here used to stop the server from starting at all.
    return this.listRunIds()
      .map((id) => {
        try {
          return this.load(id);
        } catch (error) {
          logger.warn('Skipping unreadable run state', { runId: id, error: String(error) });
          return null;
        }
      })
      .filter((s): s is RunState => s !== null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}
