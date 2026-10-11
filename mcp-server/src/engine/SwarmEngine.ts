import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { OpenRouterClient } from './OpenRouterClient.js';
import { WorkerDispatcher } from './WorkerDispatcher.js';
import { RepoWorktree } from './RepoWorktree.js';
import { Ledger } from './Ledger.js';
import { KnowledgeStore } from './KnowledgeStore.js';
import { BudgetGuard, BudgetExceededError } from './BudgetGuard.js';
import { constitutionFor } from '../constitution/articles.js';
import { deliveryGovernanceDigest, requireAssignmentAuthority, requireGovernanceAction, restoreGovernanceFromLedger, GovernanceHaltError, RevokedMandateError } from './governance.js';
import { RunStore, type RunState } from './RunStore.js';
import type { EventBus } from './EventBus.js';
import {
  readyNodes,
  allApproved,
  countedAttempts,
  trailingTransientAttempts,
  hasBlockedNodes,
  rejectedNodeIds,
  approvedNodeIds,
  releaseOrphanedDependents,
  latestVerdict,
  recordAttempt,
} from './TaskGraph.js';
import type { SwarmStrategy, EngineContext } from './SwarmStrategy.js';
import type { Decision, PendingApproval, TaskSpec, StrategyId, FileOp, TaskNode, TaskGraph, TestResult, ReviewResult } from './types.js';
import type {
  DeliveryPacket,
  EvidenceItem,
  ExternalEvaluationRecord,
  Finding,
  CheckRunRecord,
  CheckArtifact,
  RemediationFinding,
  RemediationPacket,
  SynchronizationPacket,
} from './packets.js';
import { emptyOwnershipMap } from './packets.js';
import { assembleDelivery, deliveryPacketErrors, newFinding, buildRequirementMatrix, unevidencedCriteria } from './delivery.js';
import { rejectionRequiredChanges } from './rejectionDirective.js';
import { buildRepairBrief, failureSignature, failureSummary, trailingRepeatCount } from './repairBrief.js';
import { runAllChecks, runCheckCategories, attributeAgainstBaseline, toTaskTestResult, strictBlockingFailures } from './checks.js';
import {
  applyOrphanTransfers,
  batchByOwnership,
  mergeOwnership,
  orphanedPathTransfers,
  ownedTaskIdsForText,
  ownershipFromGraph,
  undeclaredPaths,
  isTestSupportFile,
} from './ownership.js';
import { detectTestIntegrityViolations, describeViolations, isTestPath } from './testIntegrity.js';
import { fingerprintAttempt } from './attemptFingerprint.js';
import { resolveEvidenceStatus } from '../strategies/evidenceMandate.js';
import type { ModelsConfig, BudgetConfig, StrategiesConfig, ChecksConfig, CheckCategory } from '../util/config.js';
import { resolveModelsConfig, loadChecksConfig } from '../util/config.js';
import { logger } from '../util/logger.js';
import { matchesAnyGlob } from '../util/glob.js';

/** How many times a doctrine may be handed back its own refused delivery before the run ends.
 * Bounded separately from the budget so a doctrine refusing on grounds its procedure cannot cure
 * stops early rather than spending the whole allowance finding that out. */
const MAX_SELF_REMEDIATION_CYCLES = 2;
/** How many times the graph as a whole may be sent back for remediation of abandoned/rejected
 * tasks before the run terminates incomplete. Separate from maxTaskAttempts (per-task rework) and
 * from MAX_SELF_REMEDIATION_CYCLES (post-delivery self-refusal) — this bounds how many times the
 * doctrine gets to re-plan around tasks that used up their own attempts.
 *
 * Tried raising this from 2 to 3 once, on the theory that a doctrine only needed one more pass to
 * finish reconciling a stuck task. A real Democratic benchmark run showed the opposite: cycles 1
 * and 2 named the exact same four tasks with no progress between them (`cli` blocked by
 * `pkg-structure`, `pkg-structure` blocked by `cli` — a genuine circular ownership deadlock, not a
 * task converging). The 2-cycle cap correctly stopped there before; with a 3rd cycle allowed, that
 * extra pass rewrote the graph again and deleted `alloydamage/cli.py` outright, cascading into 6 of
 * 8 tasks failing where only the same 2 had been stuck before. A repeated cycle with an unchanged
 * affected-task set is a deadlock this mechanism cannot break, and giving it another attempt made
 * the outcome worse, not better — reverted to 2. Breaking an actual circular-ownership deadlock
 * needs a real detector for "no progress since the last cycle", not a higher retry ceiling.
 *
 * That detector now exists (see the `stalled` check in attemptGraphRemediation, guarding on
 * `lastGraphRemediationTaskIds`), so a repeated cycle with an unchanged affected-task set now
 * stops on its own regardless of this ceiling. Raised back to 4 on that basis: a later real run
 * showed cycle 2 narrowing to a genuinely smaller, different affected-task set than cycle 1 (6
 * tasks down to 4) — real convergence the 2-cycle cap cut off before it finished, not a deadlock.
 * With the stall detector as a backstop, letting a converging remediation run longer is safe; a
 * true deadlock is caught on its very next repeated cycle regardless of how high this is set. */
const MAX_GRAPH_REMEDIATION_CYCLES = 4;
const ENGINE_LEASE_STALE_MS = 10 * 60_000;

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
const SIGN_OFF_CHECK_CONTEXT_CHARS = 12_000;

/**
 * The engine may compel another attempt but never an approval (see returnDeliveryForRepair's
 * comment on the same invariant): if a task's changes regress a required check that was
 * previously passing, the doctrine's `approved`/`needs_human` verdict is overridden into `rework`
 * regardless of what it decided. `testResult.newFailures` is category IDs only (e.g. "unit") — the
 * actual assertion/diff text lives in `testResult.output` (already truncated by toTaskTestResult)
 * and must reach the retry directive, the same way a doctrine's own native rework path already
 * includes it (e.g. socialist's reworkRequirements) — a real run repeated a bare "restore unit"
 * directive across 5 straight attempts on the same task with no progress because the implementer
 * was never shown what had actually broken.
 */
export function regressionFloorDecision(
  taskId: string,
  doctrineDecision: Decision,
  testResult: TestResult & { newFailures?: string[] },
): Decision {
  if (!testResult.introducedRegression || (doctrineDecision.outcome !== 'approved' && doctrineDecision.outcome !== 'needs_human')) {
    return doctrineDecision;
  }
  return {
    taskId,
    outcome: 'rework',
    rationale: `Engine verification floor blocked a required regression in: ${testResult.newFailures?.join(', ') || 'required checks'}. ` +
      `The doctrine's ${doctrineDecision.outcome} decision remains in the ledger but cannot settle regressing work.`,
    evidenceRefs: testResult.newFailures ?? [],
    rework: {
      // The failing output reaches the implementer through the repair brief, clipped like every
      // other doctrine's; pasting it here as well put an unclipped copy into bidder prompts.
      requiredChanges: [
        `Make these required checks pass; they fail with this change: ${testResult.newFailures?.join(', ')}`,
      ],
    },
    meta: { doctrineDecision },
  };
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function finalCheckEvidenceRefs(check: CheckRunRecord): string[] {
  const refs = [check.categoryId];
  const moduleFlag = check.args.indexOf('-m');
  const moduleName = moduleFlag >= 0 ? check.args[moduleFlag + 1] : undefined;
  if (moduleName) refs.push(`${moduleName.replaceAll('.', '/')}/__main__.py`);
  return refs;
}

function evidenceCriterionFromFinding(finding: Finding): string | undefined {
  const reference = finding.evidenceRefs.find((item) => item.startsWith('criterion:'));
  if (reference) return reference.slice('criterion:'.length);
  const match = finding.summary.match(/^Acceptance criterion has no satisfying evidence: "([\s\S]+)"$/);
  return match?.[1];
}

function checkCategoryFromFinding(finding: Finding): string | undefined {
  if (finding.evidenceRefs[0]) return finding.evidenceRefs[0];
  return finding.summary.match(/^Required check "([^"]+)" fails on the integrated tree\.$/)?.[1];
}

/**
 * Reconciles the engine's non-waivable acceptance floor with fresh integrated evidence.
 * Doctrine findings retain their full history; only engine-owned findings can be closed here, and
 * only when the exact criterion or check that raised them is no longer failing. Repeated active
 * findings are collapsed so remediation cycles do not manufacture permanent duplicate blockers.
 */
export function reconcileAcceptanceFloorFindings(
  findings: Finding[],
  unevidenced: EvidenceItem[],
  blockingChecks: CheckRunRecord[],
): { findings: Finding[]; missingCriteria: EvidenceItem[]; missingChecks: CheckRunRecord[] } {
  const activeCriteria = new Set(unevidenced.map((item) => item.criterion));
  const activeChecks = new Set(blockingChecks.map((check) => check.categoryId));
  const retainedCriteria = new Set<string>();
  const retainedChecks = new Set<string>();

  const reconciled = findings.map((finding) => {
    if (finding.source === 'engine:evidence') {
      const criterion = evidenceCriterionFromFinding(finding);
      if (!criterion) return finding;
      if (!activeCriteria.has(criterion) || retainedCriteria.has(criterion)) {
        return {
          ...finding,
          disposition: 'accepted' as const,
          dispositionRationale: criterion && !activeCriteria.has(criterion)
            ? 'Resolved by fresh integrated evidence for this exact acceptance criterion.'
            : 'Superseded by the active engine finding for this acceptance criterion.',
        };
      }
      retainedCriteria.add(criterion);
      return {
        ...finding,
        evidenceRefs: [`criterion:${criterion}`],
        disposition: 'unresolved' as const,
        dispositionRationale: 'Fresh integrated evidence still does not satisfy this acceptance criterion.',
      };
    }
    if (finding.source === 'engine:checks') {
      const categoryId = checkCategoryFromFinding(finding);
      if (!categoryId) return finding;
      if (!activeChecks.has(categoryId) || retainedChecks.has(categoryId)) {
        return {
          ...finding,
          disposition: 'accepted' as const,
          dispositionRationale: categoryId && !activeChecks.has(categoryId)
            ? 'Resolved because this exact check now runs and passes on the integrated tree.'
            : 'Superseded by the active engine finding for this check category.',
        };
      }
      retainedChecks.add(categoryId);
      return {
        ...finding,
        disposition: 'unresolved' as const,
        dispositionRationale: 'The exact check still blocks the current integrated tree.',
      };
    }
    return finding;
  });

  return {
    findings: reconciled,
    missingCriteria: unevidenced.filter((item) => !retainedCriteria.has(item.criterion)),
    missingChecks: blockingChecks.filter((check) => !retainedChecks.has(check.categoryId)),
  };
}

export function signOffCheckContext(test: TestResult): string {
  // Stated outright: an empty suite no longer appears in the output, and "passed" alone would let
  // a reviewer think something was tested.
  const empty = test.emptyChecks?.length
    ? `\nNo tests were collected by: ${test.emptyChecks.join(', ')}. Those checks verified nothing for this change.`
    : '';
  const output = test.output?.trim();
  if (!output) return empty;
  const omitted = Math.max(0, output.length - SIGN_OFF_CHECK_CONTEXT_CHARS);
  const tail = output.slice(-SIGN_OFF_CHECK_CONTEXT_CHARS);
  return `${empty}\nIndependent check output${omitted > 0 ? ` (first ${omitted} characters omitted)` : ''}:\n${tail}`;
}

export function fallbackContextPaths(state: RunState, taskId: string | undefined): string[] {
  if (!taskId || !state.graph || !state.ownership) return [];
  const visited = new Set<string>();
  const paths = new Set<string>();

  const collect = (currentTaskId: string): void => {
    if (visited.has(currentTaskId)) return;
    visited.add(currentTaskId);
    const entry = state.ownership?.entries[currentTaskId];
    if (entry) {
      for (const ownedPath of [...entry.paths, ...entry.interfaces, ...entry.generated, ...entry.tests]) {
        paths.add(ownedPath);
      }
    }
    for (const dependencyId of state.graph?.nodes[currentTaskId]?.dependsOn ?? []) collect(dependencyId);
  };

  collect(taskId);
  return [...paths];
}

/** Whether `from` waits, directly or through other blocked tasks, on `target`. */
export function waitsOn(graph: TaskGraph, from: string, target: string): boolean {
  const seen = new Set<string>();
  const pending = [from];
  while (pending.length) {
    const id = pending.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const blocker of graph.nodes[id]?.blockedByForeignTaskIds ?? []) {
      if (blocker === target) return true;
      pending.push(blocker);
    }
  }
  return false;
}

export function refusalForeignOwnerIds(
  state: RunState,
  taskId: string,
  refusal: string,
  ignorePaths: readonly string[] = checkArtifactPaths(state),
): string[] {
  return ownedTaskIdsForText(state.ownership, refusal, ignorePaths)
    .filter((ownerId) => ownerId !== taskId);
}

function checkArtifactPaths(state: Pick<RunState, 'checkArtifacts'>): string[] {
  return (state.checkArtifacts ?? []).map((item) => item.path);
}

/**
 * Arguments of the run's own check commands. Reviewers quote those commands verbatim ("python -m
 * alloydamage calculate examples/304L.yaml crashes"), so a path there names what was run, not where
 * the defect lives: a real democratic run handed every cli.py defect to the task owning the example
 * YAML. Only exact ownership terms are ever ignored, so flags and module names cost nothing.
 */
export function checkCommandPaths(categories: ReadonlyArray<Pick<CheckCategory, 'args'>>): string[] {
  return categories.flatMap((category) => category.args.filter((arg) => !arg.startsWith('-')));
}

/** Stable, short origin for regression-rule findings so prior packets are not recursively embedded. */
export function summarizeRemediationOrigin(remediationOf: string | undefined, taskId: string): string {
  const raw = remediationOf?.trim();
  if (!raw) return taskId;
  const ids = [...raw.matchAll(/\bf-[0-9a-f]{8}\b/g)].map((match) => match[0]);
  if (ids.length > 0) return `${taskId}:${[...new Set(ids)].join(',')}`;
  return `${taskId}:${raw.replace(/\s+/g, ' ').slice(0, 160)}`;
}

export function approvalDecisionContext(description: string): string {
  // The rationale can quote a pytest session of its own, ahead of the appended check output: in
  // recent democratic runs that blamed approved tasks whose passing test files it listed.
  return withoutCheckOutput(description.split('\nIndependent check output', 1)[0]);
}

/**
 * A failure of the provider or the transport, not of the work.
 *
 * Only these are exempt from the rework budget, so the list stays narrow and literal: anything a
 * model actually said, including a refusal or an unparseable answer, is a judgement about the task
 * and must cost an attempt like any other.
 */
export function isTransientProviderFailure(error: unknown): boolean {
  const text = String(error);
  return /exceeded the per-call timeout|\b(?:429|500|502|503|504)\b|rate.?limit|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|network error|timed out/i.test(
    text,
  );
}

/** Consecutive transient failures that still abandon a task, so an unreachable provider cannot loop. */
export const MAX_TRAILING_TRANSIENT_ATTEMPTS = 4;

const TEST_PATH = /(^|\/)tests?\/|(^|\/)spec\/|(^|\/)test_[^/]*$|_test\.[^./]+$|\.test\.[^./]+$|\.spec\.[^./]+$/i;

/** True when this task is the one responsible for the repository's tests. */
export function ownsTestFiles(node: TaskNode, fileOps: ReadonlyArray<{ path: string }> = []): boolean {
  return [...node.targetGlobs, ...fileOps.map((op) => op.path)]
    .some((path) => TEST_PATH.test(path) && !isTestSupportFile(path));
}

/** An attempt made only of test files, which stay in place when their failures are handed to
 * the owners of the code under test. */
export function keepsTestsForOwners(fileOps: ReadonlyArray<{ op: string; path: string }>): boolean {
  return fileOps.length > 0 && fileOps.every((op) => op.op !== 'delete' && TEST_PATH.test(op.path));
}

/**
 * Judge the task that owns the tests on whether the suite is actually green.
 *
 * `toTaskTestResult().passed` means "introduced no regression", where a regression is a required
 * check that passed before and fails now. A check that has never passed is classed pre-existing, so
 * the task that creates the first test suite can never register one: `passed` stayed true however
 * broken its tests were, and the whole decision fell to the reviewer's judgement. Across two sweeps
 * that produced 79 attempts rejected while the engine recorded the tests as passing, and abandoned
 * the test task in most runs. For that task, and only that task, the strict whole-suite status is
 * the one that counts.
 */
/** Why an abandoned task stopped, for the graph-remediation finding that reopens its owner. The
 * evaluator's sign-off refusal is the precise diagnosis when there is one; the doctrine's own last
 * rationale often records only the procedure that ended it. */
export function abandonedTaskEvidence(node: TaskNode): string {
  return [node.signOffRefusals?.at(-1), node.attempts.at(-1)?.rationale]
    .filter(Boolean)
    .join('\n') || 'Task graph phase is abandoned.';
}

/**
 * A pytest session, from its header to its "N failed, M passed in 1.2s" line. Its progress lines
 * name every test file, passing ones included, and capitalist quotes the session in a failed
 * contract's rationale: an abandoned damage task reopened the approved composition and nuclear-data
 * tasks because their passing test files were listed there.
 */
const PYTEST_SESSION = /=+ test session starts =+[\s\S]*?(?:=+ [^=\n]*\bin [\d.]+s[^=\n]*=+|$)/g;

/** A refusal or rationale minus the check output in it, whose test paths locate nothing. */
export function withoutCheckOutput(refusal: string): string {
  return refusal
    .replace(/\nIndependent check output[\s\S]*?(?=\nEvaluator decision:|$)/g, '')
    .replace(PYTEST_SESSION, '[check output omitted]');
}

/** Splits the "[severity] " prefix barriers put on a finding summary; unprefixed counts as high. */
export function barrierSeverity(summary: string): { severity: RemediationFinding['severity']; summary: string } {
  const match = /^\[(low|medium|high)\]\s*/.exec(summary);
  return match
    ? { severity: match[1] as RemediationFinding['severity'], summary: summary.slice(match[0].length) }
    : { severity: 'high', summary };
}

export function suiteBoundTestResult<T extends { passed: boolean; suitePassed?: boolean }>(result: T): T {
  return result.suitePassed === false ? { ...result, passed: false } : result;
}

/**
 * No loop is running when one starts, so a node still marked `running` was cut off: put back any
 * change it had applied but not had judged, and queue it to run again.
 */
export function recoverInterruptedTasks(
  graph: TaskGraph,
  ctx: { worktree: { revertFileOps(snapshot: NonNullable<TaskNode['inFlightFileSnapshots']>): void }; ledger: { record(type: string, data: Record<string, unknown>): unknown } },
): void {
  for (const node of Object.values(graph.nodes)) {
    const snapshot = node.inFlightFileSnapshots;
    if (snapshot) {
      ctx.worktree.revertFileOps(snapshot);
      delete node.inFlightFileSnapshots;
    }
    if (node.phase !== 'running' && !snapshot) continue;
    const previousPhase = node.phase;
    if (node.phase === 'running') node.phase = 'queued';
    ctx.ledger.record('task_recovered_after_interrupt', {
      taskId: node.id,
      previousPhase,
      phase: node.phase,
      revertedPaths: snapshot?.map((entry) => entry.path) ?? [],
    });
  }
}

export function restoreAttemptCeilings(graph: TaskGraph, maxAttempts: number): void {
  for (const node of Object.values(graph.nodes)) {
    if (countedAttempts(node) < maxAttempts && trailingTransientAttempts(node) < MAX_TRAILING_TRANSIENT_ATTEMPTS) continue;
    if (node.phase !== 'queued' && node.phase !== 'running' && node.phase !== 'blocked') continue;
    node.phase = latestVerdict(node) === 'approved' ? 'settled' : 'abandoned';
  }
}

/** A retained attempt as the operations that put it back: each file written as it stood, or deleted. */
export function retainedFileOps(retained: NonNullable<TaskNode['retainedAttempt']>): FileOp[] {
  return retained.map((file) => file.existed
    ? { op: 'write', path: file.path, content: file.content ?? '' }
    : { op: 'delete', path: file.path });
}

export function preserveExhaustedNodes(
  previous: TaskGraph,
  remediated: TaskGraph,
  maxAttempts: number,
  round?: string,
): TaskGraph {
  for (const taskId of previous.order) {
    const previousNode = previous.nodes[taskId];
    if (countedAttempts(previousNode) < maxAttempts) continue;
    remediated.nodes[taskId] = previousNode;
  }
  const reopenedIds = new Set<string>();
  for (const node of Object.values(remediated.nodes)) {
    const before = previous.nodes[node.id];
    const reopened = node.phase === 'queued' && node.remediationOf &&
      (before?.phase !== 'queued' || before.remediationOf !== node.remediationOf);
    if (!reopened) continue;
    reopenedIds.add(node.id);
    if (round) node.remediationRound = round;
    clearForReopening(node);
  }
  reopenReleasedDependents(remediated, reopenedIds, round);
  return remediated;
}

/** A reopened node starts from the remediation finding. The last attempt's brief described a tree
 * that has moved on since, and its sign-off refusals were answered or superseded. */
function clearForReopening(node: TaskNode): void {
  delete node.repairBrief;
  delete node.signOffRefusals;
  delete node.retainedAttempt;
}

/**
 * Reopens the work the engine released past a dependency that this remediation brings back.
 *
 * releaseOrphanedDependents lets a node run without an abandoned dependency rather than leave it
 * waiting forever. Its attempts were then judged against a tree that lacked code it needed: in the
 * 2026-10-08 democratic cycle-1 arm the tests task spent all eight attempts testing a package whose
 * core had been reverted. Remediation later rebuilt the core, but the tests task stayed exhausted,
 * and the delivery shipped with no tests. A released node that never passed now waits for the
 * dependency again, and its attempts against the gap stop counting against its allowance.
 * The doctrine still judges every new attempt in its own way. This only restores the chance the
 * release took away.
 */
function reopenReleasedDependents(graph: TaskGraph, reopenedIds: ReadonlySet<string>, round?: string): void {
  if (reopenedIds.size === 0) return;
  for (const node of Object.values(graph.nodes)) {
    const returning = node.abandonedDependencies?.filter((id) => reopenedIds.has(id)) ?? [];
    if (returning.length === 0 || latestVerdict(node) === 'approved') continue;
    const stillMissing = node.abandonedDependencies!.filter((id) => !reopenedIds.has(id));
    if (stillMissing.length > 0) node.abandonedDependencies = stillMissing;
    else delete node.abandonedDependencies;
    for (const attempt of node.attempts) attempt.withoutDependency = true;
    node.phase = 'queued';
    node.remediationOf =
      `Reopened together with ${returning.join(', ')}, which this task depends on: its earlier attempts ` +
      'were made while that dependency was missing from the tree. Build against it once it is accepted.';
    if (round) node.remediationRound = round;
    clearForReopening(node);
  }
}


const ORACLE_OWNERSHIP_PATHS: Record<number, string[]> = {
  1: ['alloydamage/nuclear_data.py', 'alloydamage/damage.py'],
  2: ['alloydamage/damage.py'],
  3: ['alloydamage/composition.py'],
  4: ['alloydamage/composition.py'],
  // Checks 5 and 7 judge the process's exit status as well as the message, so the entry point owns
  // them too: socialist cycle 3b raised the right error in composition.py, printed it in cli.py,
  // and exited 0 from a __main__.py that called main() without passing its return on. Repair went
  // only to composition and nuclear data, twice, and the check never moved.
  5: ['alloydamage/composition.py', 'alloydamage/nuclear_data.py', 'alloydamage/cli.py', 'alloydamage/__main__.py'],
  6: ['alloydamage/nuclear_data.py', 'alloydamage/damage.py'],
  7: ['alloydamage/nuclear_data.py', 'alloydamage/damage.py', 'alloydamage/cli.py', 'alloydamage/__main__.py'],
  8: ['alloydamage/damage.py', 'alloydamage/cli.py'],
  9: ['alloydamage/plotting.py'],
  10: ['alloydamage/plotting.py'],
  11: ['alloydamage/cli.py', 'alloydamage/__main__.py', 'README.md'],
};

export function oracleAffectedTaskIds(state: RunState, checkId: string | number): string[] {
  const requiredPaths = ORACLE_OWNERSHIP_PATHS[Number(checkId)] ?? [];
  if (!state.graph || requiredPaths.length === 0) return [];
  return state.graph.order.filter((taskId) => {
    const declaredPaths = state.ownership?.entries[taskId]?.paths ?? state.graph!.nodes[taskId].targetGlobs;
    return requiredPaths.some((requiredPath) =>
      declaredPaths.some((declaredPath) =>
        declaredPath.toLowerCase() === requiredPath.toLowerCase() || matchesAnyGlob(requiredPath, [declaredPath]),
      ),
    );
  });
}

export const ORACLE_WITHHELD_EVIDENCE =
  'The independent oracle reports which requirement failed but withholds its inputs and expected ' +
  'values. Re-read that requirement in the task statement and verify it with your own tests.';

/**
 * What a failed oracle check tells the swarm: which property failed, and which tasks own it.
 *
 * Never the oracle's detail. That text carries its independently expected values and its probe
 * inputs, and repairing toward them turns a hidden evaluation into a target: on 2026-10-05 a
 * managerial arm was sent "got 381.176690219, independently expected one of [380.917775401..]",
 * and its sovereign then rejected correct code by quoting those numbers back. The detail stays in
 * the delivery's externalEvaluations, which only scoring reads.
 */
export function oracleRemediationFindings(
  state: RunState,
  failed: readonly ExternalEvaluationRecord[],
): RemediationFinding[] {
  return failed.map((evaluation) => ({
    summary: `External oracle check ${evaluation.id} failed: ${evaluation.description}`,
    evidence: ORACLE_WITHHELD_EVIDENCE,
    affectedTaskIds: oracleAffectedTaskIds(state, evaluation.id),
    severity: 'high',
  }));
}

export interface EngineDeps {
  client: OpenRouterClient;
  modelsConfig: ModelsConfig;
  configDir: string;
  budgetConfig: BudgetConfig;
  strategiesConfig: StrategiesConfig;
  runsRootDir: string;
  strategies: Record<StrategyId, SwarmStrategy>;
  /** Overrides config/checks.yaml in-memory only (e.g. a target repo that isn't Node/npm). Falls
   * back to loadChecksConfig(configDir), re-read fresh per run, when omitted. */
  checksConfig?: ChecksConfig;
  externalEvaluator?: (worktreePath: string) => Promise<import('./packets.js').ExternalEvaluationRecord[]>;
  requiredExternalEvaluationCount?: number;
  finalOnlyChecks?: import('../util/config.js').CheckCategory[];
  /** Optional observer for live readers (the dashboard). The engine never depends on it. */
  bus?: EventBus;
  /**
   * Each run reads only the knowledge it wrote itself. The benchmark sets this: only some doctrines
   * consult the store, so memory carried over from earlier runs would help those arms alone and
   * make repeated trials depend on one another.
   */
  isolateKnowledgePerRun?: boolean;
  /** Which bounded decisions consult a decision model before the chat model. Defaults to 'pure'. */
  decisionModels?: import('./WorkerDispatcher.js').DecisionMode;
  /** How long to wait before requeuing the nth transient loop crash. Tests pass () => 0. */
  outageBackoffMs?: (attempt: number) => number;
}

/** 30s, 60s, 120s, 240s: 7.5 minutes across MAX_TRAILING_TRANSIENT_ATTEMPTS requeues. A network
 * outage on 2026-10-04 lasted about four minutes; requeuing at once spent every retry inside it. */
export const defaultOutageBackoffMs = (attempt: number): number => 30_000 * 2 ** Math.max(0, attempt - 1);

export interface StartRunOptions {
  task: TaskSpec;
  strategy: StrategyId;
  budgetUsd?: number;
  /** Seeds the doctrine's lots instead of the run id; the benchmark passes one per trial. */
  lotSeed?: string;
}

/**
 * Drives the lifecycle every doctrine in docs/philosophy/ shares:
 *
 *   baseline -> plan -> declareOwnership
 *     -> loop( assign -> execute* -> apply -> checks -> review -> decide -> recordOutcome )
 *     -> integrate -> verifyDelivery -> disposeFindings -> accept
 *     -> awaiting_acceptance   (Claude performs its independent check here)
 *     -> completed | remediation
 *
 * The engine's authority stops at sequencing. Section 5 of each doctrine, reproduced verbatim in
 * all three: Claude "may sequence execution phases, create multiple OpenRouter model instances
 * within the selected political swarm, pass repository context and artefacts between those
 * instances, enforce resource limits, and resolve runtime failures. It must not replace, shortcut
 * or overrule the doctrine's internal decision procedure." So every judgment below — what to
 * implement, whether it is good, whether it is accepted — is delegated to the strategy. What the
 * engine does enforce is the shape of the process and two floors no doctrine may lower: test
 * integrity, and the rule that partial work is never reported as accepted.
 *
 * Runs are async and detached from the calling MCP tool — swarm_start returns immediately and
 * swarm_status polls this same in-memory/on-disk state.
 */
export class SwarmEngine {
  private readonly runStore: RunStore;
  private readonly knowledge: KnowledgeStore;
  private readonly budget: BudgetGuard;
  private readonly activeLoops = new Set<string>();
  /** Stop reasons for runs whose loop is still live. The loop holds its own copy of the state, so a
   * stop written only to the store was overwritten by the loop's next save and the run kept going. */
  private readonly stopRequests = new Map<string, string>();
  private readonly instanceId = randomUUID();

  constructor(private readonly deps: EngineDeps) {
    this.runStore = new RunStore(deps.runsRootDir, deps.bus);
    this.knowledge = new KnowledgeStore(deps.runsRootDir);
    this.budget = new BudgetGuard(deps.budgetConfig);
    this.recoverStaleRuns();
  }

  getRunStore(): RunStore {
    return this.runStore;
  }

  async resumeRun(runId: string): Promise<RunState> {
    const state = this.mustLoad(runId);
    const worktree = new RepoWorktree(state.repoPath, path.join(this.deps.runsRootDir, runId), runId);
    return worktree.withResumeLock(() => this.resumeLockedRun(runId));
  }

  private async resumeLockedRun(runId: string): Promise<RunState> {
    const state = this.mustLoad(runId);
    if (state.status !== 'interrupted') {
      throw new Error(`Run "${runId}" is "${state.status}", not recoverably interrupted.`);
    }
    const lease = state.engineLease;
    const leaseAge = lease ? Date.now() - new Date(lease.heartbeatAt).getTime() : Number.POSITIVE_INFINITY;
    if (lease && lease.instanceId !== this.instanceId && leaseAge < ENGINE_LEASE_STALE_MS) {
      throw new Error(`Run "${runId}" is owned by live engine lease ${lease.instanceId}.`);
    }
    const strategy = this.deps.strategies[state.strategy];
    const { worktree } = this.buildContext(runId, state, strategy);
    const validation = await worktree.validateForResume(state.lastSyncPacket?.baseRevision);
    if (!validation.valid) {
      state.status = 'terminated_incomplete';
      state.lastError = `Interrupted run cannot resume: ${validation.reason}`;
      state.updatedAt = new Date().toISOString();
      this.runStore.save(state);
      return state;
    }
    if (state.graph) restoreAttemptCeilings(state.graph, this.budget.maxTaskAttempts());
    // The run keeps the constitution it adopted; a strategies.yaml edited since is disclosed, not obeyed.
    const current = constitutionFor(state.strategy, this.deps.strategiesConfig)?.digest ?? null;
    if (state.constitution && current !== state.constitution.digest) {
      const ledger = new Ledger(path.join(this.deps.runsRootDir, runId), runId, state.strategy, this.deps.bus);
      ledger.record('constitution_drift_on_resume', { adopted: state.constitution.digest, current });
    }
    const now = new Date().toISOString();
    state.status = 'running';
    state.engineLease = this.newLease(now);
    state.heartbeatAt = now;
    state.updatedAt = now;
    this.runStore.save(state);
    const task: TaskSpec = {
      goal: state.task.goal,
      acceptanceCriteria: state.task.acceptanceCriteria,
      repoPath: state.repoPath,
      baseBranch: state.baseBranch,
    };
    this.launchLoop(runId, task);
    return state;
  }

  async interruptOwnedRuns(reason = 'Engine interrupted'): Promise<RunState[]> {
    const interrupted: RunState[] = [];
    for (const runId of this.activeLoops) {
      const state = this.runStore.load(runId);
      if (!state || state.engineLease?.instanceId !== this.instanceId) continue;
      try {
        const strategy = this.deps.strategies[state.strategy];
        const { ctx } = this.buildContext(runId, state, strategy);
        state.lastSyncPacket = await ctx.syncPacket();
      } catch (error) {
        logger.warn('Could not capture synchronization while interrupting run', { runId, error: String(error) });
      }
      state.status = 'interrupted';
      state.lastError = reason;
      state.updatedAt = new Date().toISOString();
      state.heartbeatAt = state.updatedAt;
      // This engine is exiting cleanly, so it no longer owns the run. Keeping the lease until its
      // stale timeout makes an immediate `--resume` look like a competing live process even though
      // the signal handler has already stopped the owner.
      delete state.engineLease;
      this.runStore.save(state);
      interrupted.push(state);
    }
    return interrupted;
  }

  private launchLoop(runId: string, task: TaskSpec): void {
    void this.runLoop(runId, task, true).catch((error) => this.handleLoopCrash(runId, error));
  }

  private async handleLoopCrash(runId: string, error: unknown): Promise<void> {
    logger.error('Run loop crashed', { runId, error: String(error) });
    const state = this.runStore.load(runId);
    if (!state) return;
    try {
      const strategy = this.deps.strategies[state.strategy];
      const { ctx } = this.buildContext(runId, state, strategy);
      state.lastSyncPacket = await ctx.syncPacket();
    } catch (syncError) {
      logger.warn('Could not capture synchronization after run crash', { runId, error: String(syncError) });
    }
    // handleTaskError already exempts a provider timeout from the rework budget and requeues the
    // task; a doctrine's own ceremony (speaker rulings, opposition findings, review) runs outside
    // any task, so the identical failure reaching here instead of there used to be terminal for no
    // reason related to governance. Democratic, which does the most work outside tasks, died on a
    // single reviewer timeout while socialist and capitalist absorbed the same event and ran on.
    // Bounded by the same trailing-transient ceiling task attempts use, so a genuinely unreachable
    // provider still fails the run instead of looping forever.
    const transient = isTransientProviderFailure(error);
    if (transient) state.loopCrashRetries = (state.loopCrashRetries ?? 0) + 1;
    if (transient && (state.loopCrashRetries ?? 0) <= MAX_TRAILING_TRANSIENT_ATTEMPTS) {
      state.lastError = String(error);
      state.updatedAt = new Date().toISOString();
      state.heartbeatAt = state.updatedAt;
      this.runStore.save(state);
      const waitMs = (this.deps.outageBackoffMs ?? defaultOutageBackoffMs)(state.loopCrashRetries!);
      logger.warn('Requeuing run after transient loop crash', {
        runId,
        attempt: state.loopCrashRetries,
        waitMs,
        error: String(error),
      });
      if (waitMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        // A stop or interruption during the wait wins over the requeue.
        if (this.runStore.load(runId)?.status !== state.status) return;
      }
      this.launchLoop(runId, {
        goal: state.task.goal,
        acceptanceCriteria: state.task.acceptanceCriteria,
        repoPath: state.repoPath,
        baseBranch: state.baseBranch,
      });
      return;
    }
    // Checked after the transient requeue, so a halt that only wraps a provider outage is retried.
    if (error instanceof GovernanceHaltError) {
      try {
        const { ctx } = this.buildContext(runId, state, this.deps.strategies[state.strategy]);
        await this.terminateIncomplete(ctx, state, error.message);
        state.updatedAt = new Date().toISOString();
        state.heartbeatAt = state.updatedAt;
        this.runStore.save(state);
        return;
      } catch (terminateError) {
        logger.warn('Could not end a governance halt as incomplete', { runId, error: String(terminateError) });
      }
    }
    state.status = 'failed';
    state.lastError = String(error);
    state.updatedAt = new Date().toISOString();
    state.heartbeatAt = state.updatedAt;
    this.runStore.save(state);
  }

  private newLease(now: string): NonNullable<RunState['engineLease']> {
    return { instanceId: this.instanceId, acquiredAt: now, heartbeatAt: now, pid: process.pid, hostname: os.hostname() };
  }

  private recoverStaleRuns(): void {
    const now = Date.now();
    for (const state of this.runStore.listAll()) {
      if (state.status !== 'running' && state.status !== 'remediation') continue;
      const lease = state.engineLease;
      // An owner on this machine whose process is gone cannot come back, so its run need not wait
      // out the stale timeout; that timeout is only for owners this engine cannot see.
      const ownerGone = lease?.pid !== undefined && lease.hostname === os.hostname() && !processAlive(lease.pid);
      const heartbeat = lease?.heartbeatAt ?? state.heartbeatAt ?? state.updatedAt;
      if (!ownerGone && now - new Date(heartbeat).getTime() < ENGINE_LEASE_STALE_MS) continue;
      state.status = 'interrupted';
      state.lastError = ownerGone
        ? `Recovered active state whose engine (pid ${lease!.pid}) is no longer running.`
        : 'Recovered stale active state after engine restart.';
      state.updatedAt = new Date().toISOString();
      this.runStore.save(state);
    }
  }

  async startRun(opts: StartRunOptions): Promise<RunState> {
    const runId = `${opts.strategy}-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
    const runDir = path.join(this.deps.runsRootDir, runId);
    const worktree = new RepoWorktree(opts.task.repoPath, runDir, runId);
    await worktree.create(opts.task.baseBranch);

    const now = new Date().toISOString();
    const deadlineAt = new Date(Date.now() + this.budget.maxWallClockMinutes() * 60_000).toISOString();
    const checksConfig = this.deps.checksConfig ?? loadChecksConfig(this.deps.configDir);
    const state: RunState = {
      schemaVersion: 2,
      runId,
      ...(opts.lotSeed ? { lotSeed: opts.lotSeed } : {}),
      strategy: opts.strategy,
      task: { goal: opts.task.goal, acceptanceCriteria: opts.task.acceptanceCriteria },
      repoPath: opts.task.repoPath,
      baseBranch: opts.task.baseBranch,
      worktreePath: worktree.worktreePath,
      branch: worktree.branch,
      status: 'running',
      createdAt: now,
      startedAt: now,
      deadlineAt,
      heartbeatAt: now,
      updatedAt: now,
      budgetUsd: opts.budgetUsd ?? this.deps.budgetConfig.defaults.perRunUsd,
      costUsd: 0,
      tokensUsed: { prompt: 0, completion: 0 },
      workerCalls: 0,
      graph: null,
      pendingApprovals: [],
      strategyState: {},
      findings: [],
      baseline: [],
      ownership: emptyOwnershipMap(),
      remediationCycles: 0,
      graphRemediationCycles: 0,
      deliveryRemediationCycles: 0,
      oracleRemediationCycles: 0,
      currentCheckSnapshot: [],
      protectedBaselineTests: worktree.listFiles(Number.MAX_SAFE_INTEGER).paths.filter((file) =>
        matchesAnyGlob(file, checksConfig.testPathGlobs),
      ),
      engineLease: this.newLease(now),
    };
    const constitution = constitutionFor(opts.strategy, this.deps.strategiesConfig);
    state.constitution = {
      digest: constitution?.digest ?? null,
      config: (this.deps.strategiesConfig[opts.strategy] as Record<string, unknown> | undefined) ?? {},
    };
    this.runStore.save(state);
    if (constitution) {
      // The whole document, not just its digest: the ledger alone must say which rules governed.
      const ledger = new Ledger(runDir, runId, opts.strategy, this.deps.bus);
      ledger.record('constitution_adopted', { strategy: opts.strategy, digest: constitution.digest, document: constitution });
    }

    this.launchLoop(runId, opts.task);

    return state;
  }

  stopRun(runId: string, reason?: string): RunState {
    const state = this.mustLoad(runId);
    state.status = 'stopped';
    state.lastError = reason ? `Stopped: ${reason}` : 'Stopped by user';
    state.updatedAt = new Date().toISOString();
    this.runStore.save(state);
    if (this.activeLoops.has(runId)) this.stopRequests.set(runId, state.lastError);
    return state;
  }

  /**
   * Claude's acceptance of a delivery packet after its own independent check. Section 5: a run is
   * "complete only when the selected doctrine has reached its own valid acceptance decision and
   * submitted a delivery packet that Claude independently accepts."
   */
  acceptDelivery(runId: string, note?: string): RunState {
    const state = this.mustLoad(runId);
    if (state.status !== 'awaiting_acceptance') {
      throw new Error(
        `Run "${runId}" is "${state.status}", not "awaiting_acceptance" — there is no delivery packet to accept.`,
      );
    }
    const requiredExternal = this.deps.requiredExternalEvaluationCount;
    if (requiredExternal !== undefined) {
      const evaluations = state.delivery?.externalEvaluations ?? [];
      if (evaluations.length !== requiredExternal || evaluations.some((evaluation) => !evaluation.passed)) {
        throw new Error(`Run "${runId}" has not passed all ${requiredExternal} required external evaluations.`);
      }
    }
    if (!state.delivery?.treeId) {
      throw new Error('Delivery has no immutable tree. Return it for remediation and submit a new delivery.');
    }
    state.acceptedTreeId = state.delivery.treeId;
    state.status = 'completed';
    state.updatedAt = new Date().toISOString();
    this.runStore.save(state);

    const ledger = new Ledger(path.join(this.deps.runsRootDir, runId), runId, state.strategy, this.deps.bus);
    ledger.record('delivery_accepted', {
      treeId: state.acceptedTreeId,
      note: note ?? '',
      remediationCycles: state.remediationCycles ?? 0,
    });
    return state;
  }

  /**
   * Claude's rejection. The concrete defects go back to the SAME swarm, which resumes under its own
   * rules from a remediation packet that preserves the delivery evidence it is rejecting.
   */
  async submitRemediation(runId: string, findings: RemediationFinding[]): Promise<RunState> {
    const state = this.mustLoad(runId);
    if (state.status !== 'awaiting_acceptance') {
      throw new Error(
        `Run "${runId}" is "${state.status}", not "awaiting_acceptance" — there is no delivery packet to reject.`,
      );
    }
    if (findings.length === 0) {
      throw new Error('A remediation must carry at least one concrete finding — a rejection without defects is not a rejection.');
    }
    if (!state.delivery) throw new Error(`Run "${runId}" has no delivery packet to preserve.`);
    const strategy = this.deps.strategies[state.strategy];
    const { ctx } = this.buildContext(runId, state, strategy);

    const packet: RemediationPacket = {
      runId,
      submittedAt: new Date().toISOString(),
      findings,
      origin: 'delivery',
      preservedDelivery: state.delivery,
      preservedSynchronization: await ctx.syncPacket(),
      cycle: (state.deliveryRemediationCycles ?? 0) + 1,
    };
    if (packet.cycle > 2) throw new Error(`Run "${runId}" exhausted delivery remediation cycles.`);
    state.deliveryRemediationCycles = packet.cycle;
    state.remediationCycles = (state.remediationCycles ?? 0) + 1;
    state.status = 'remediation';
    state.updatedAt = new Date().toISOString();
    this.runStore.save(state);

    const ledger = new Ledger(path.join(this.deps.runsRootDir, runId), runId, state.strategy, this.deps.bus);
    ledger.record('remediation_returned', {
      cycle: packet.cycle,
      findings: findings.map((f) => ({ summary: f.summary, severity: f.severity })),
    });

    // The doctrine decides how to reopen the work — which committee, council or liable firm takes
    // it back, and on what terms. The engine only carries the packet across the boundary.
    const previousGraph = structuredClone(state.graph!);
    state.graph = preserveExhaustedNodes(
      previousGraph,
      await strategy.remediate(ctx, packet),
      this.budget.maxTaskAttempts(),
      `${packet.origin ?? 'delivery'}:${packet.cycle}`,
    );
    state.strategyState = ctx.strategyState;
    state.status = 'running';
    state.updatedAt = new Date().toISOString();
    this.runStore.save(state);

    this.launchLoop(runId, {
      goal: state.task.goal,
      acceptanceCriteria: state.task.acceptanceCriteria,
      repoPath: state.repoPath,
      baseBranch: state.baseBranch,
    });
    return state;
  }

  resolveApproval(
    runId: string,
    approvalId: string,
    decision: 'approve' | 'reject' | 'modify',
    note?: string,
    modifiedBudgetUsd?: number,
  ): RunState {
    const state = this.mustLoad(runId);
    const approval = state.pendingApprovals.find((a) => a.id === approvalId && !a.resolvedAt);
    if (!approval) throw new Error(`No unresolved approval "${approvalId}" on run "${runId}"`);

    approval.resolution = decision;
    approval.note = note;
    approval.resolvedAt = new Date().toISOString();

    if (approval.kind === 'budget_increase' && decision === 'approve') {
      const requested = modifiedBudgetUsd ?? state.budgetUsd + this.deps.budgetConfig.defaults.perRunUsd;
      state.budgetUsd = this.budget.clampBudgetIncrease(requested);
    }
    if (approval.kind === 'wall_clock_extension' && decision === 'approve') {
      state.deadlineAt = new Date(new Date(state.deadlineAt ?? state.updatedAt).getTime() + 15 * 60_000).toISOString();
    }
    if (approval.kind === 'wall_clock_extension' && decision === 'reject') {
      state.status = 'terminated_incomplete';
      state.lastError = note?.trim() || 'The wall-clock extension was rejected.';
      state.lastSyncPacket = this.buildSynchronousSyncPacket(state);
    }

    // final_diff (needs_human / runtime error) and test_waiver (test-integrity guard) both name
    // one blocked node awaiting a single human's yes/no ruling.
    if ((approval.kind === 'final_diff' || approval.kind === 'test_waiver') && approval.taskId) {
      const node = state.graph?.nodes[approval.taskId];
      if (node?.phase === 'blocked') {
        const attemptsRemain = countedAttempts(node) < this.budget.maxTaskAttempts();
        const foreignOwners = decision === 'reject'
          ? refusalForeignOwnerIds(state, node.id, approvalDecisionContext(approval.description), this.incidentalPaths(state))
            // Never to an owner already waiting on this task; see the rework handoff below.
            .filter((ownerId) => !waitsOn(state.graph!, ownerId, node.id))
          : [];
        const requiresOwnershipHandoff = foreignOwners.length > 0;
        const approvedAppliedDiff = approval.kind === 'final_diff' &&
          decision === 'approve' && node.pendingFileSnapshots !== undefined;

        if (approvedAppliedDiff) {
          const latestAttempt = node.attempts.at(-1);
          if (latestAttempt) {
            latestAttempt.doctrineOutcome = latestAttempt.outcome;
            latestAttempt.outcome = 'approved';
          }
          node.phase = 'settled';
          delete node.repairBrief;
          delete node.signOffRefusals;
          state.currentCheckSnapshot = node.pendingCheckSnapshot ?? state.currentCheckSnapshot;
        } else {
          let refusedFiles: TaskNode['retainedAttempt'];
          if (approval.kind === 'final_diff' && node.pendingFileSnapshots) {
            const worktree = new RepoWorktree(state.repoPath, path.dirname(state.worktreePath), state.runId);
            refusedFiles = worktree.snapshotFileOps(
              node.pendingFileSnapshots.map((file) => ({ op: 'delete' as const, path: file.path })),
            );
            worktree.revertFileOps(node.pendingFileSnapshots);
          }
          node.phase = decision === 'reject' && (!attemptsRemain || requiresOwnershipHandoff)
            ? 'abandoned'
            : 'queued';
          // A refused sign-off goes back for another attempt like a rework does, and keeps its work
          // the same way.
          if (node.phase === 'queued' && refusedFiles?.length) node.retainedAttempt = refusedFiles;
          if (requiresOwnershipHandoff) node.blockedByForeignTaskIds = foreignOwners;
        }

        // Send the reason back with the task. A requeued sign-off refusal used to carry nothing at
        // all, so the next attempt began exactly as blind as the one that had just failed:
        // m5-verification-matrix spent all six of its attempts on `needs_human`, each refused for
        // the same failing check, each starting over knowing none of it. `rejected` decisions have
        // carried their defect since rejectionDirective landed; this is the same repair on the path
        // that reaches a reviewer rather than the doctrine. Kept on an abandoned node too: graph
        // remediation reopens its owner later, and the evaluator's note is the precise diagnosis.
        if (decision === 'reject') {
          const approvalContext = approval.description.trim();
          const evaluatorNote = note?.trim() ?? '';
          const reason = evaluatorNote && !approvalContext.includes(evaluatorNote)
            ? `${approvalContext}\nEvaluator decision: ${evaluatorNote}`
            : approvalContext || evaluatorNote;
          const previous = node.signOffRefusals ?? [];
          if (reason && previous.at(-1) !== reason) node.signOffRefusals = [...previous, reason];
        }
        delete node.pendingFileSnapshots;
        delete node.pendingCheckSnapshot;
      }
    }

    const stillBlocked = state.pendingApprovals.some((a) => !a.resolvedAt);
    if (!stillBlocked && state.status === 'paused_human') state.status = 'running';
    if (!stillBlocked && state.status === 'paused_budget' && !this.budget.isOverRunBudget(state)) {
      state.status = 'running';
    }

    state.updatedAt = new Date().toISOString();
    this.runStore.save(state);

    if (state.status === 'running' && !this.activeLoops.has(runId)) {
      // Resume the loop after a resolved approval unblocks it.
      this.launchLoop(runId, {
        goal: state.task.goal,
        acceptanceCriteria: state.task.acceptanceCriteria,
        repoPath: state.repoPath,
        baseBranch: state.baseBranch,
      });
    }
    return state;
  }

  private mustLoad(runId: string): RunState {
    const state = this.runStore.load(runId);
    if (!state) throw new Error(`Unknown run "${runId}"`);
    return state;
  }

  private buildSynchronousSyncPacket(state: RunState): SynchronizationPacket {
    const graph = state.graph;
    const previous = state.lastSyncPacket;
    return {
      runId: state.runId,
      baseRevision: previous?.baseRevision ?? state.delivery?.baseRevision ?? '',
      decisions:
        graph?.order.map((id) => ({
          taskId: id,
          outcome: latestVerdict(graph.nodes[id]) ?? 'pending',
          rationale: graph.nodes[id].title,
        })) ?? [],
      ownershipMap: state.ownership ?? emptyOwnershipMap(),
      changedFileManifest: previous?.changedFileManifest ?? state.delivery?.changedFiles ?? [],
      evidence: buildRequirementMatrix(state),
      openFindings: (state.findings ?? []).filter((finding) => finding.disposition === 'unresolved'),
      capturedAt: new Date().toISOString(),
    };
  }

  private buildContext(runId: string, state: RunState, strategy: SwarmStrategy): { ctx: EngineContext; worktree: RepoWorktree } {
    const runDir = path.join(this.deps.runsRootDir, runId);
    const worktree = new RepoWorktree(state.repoPath, runDir, runId);
    const ledger = new Ledger(runDir, runId, state.strategy, this.deps.bus);
    const modelsConfig = resolveModelsConfig(this.deps.configDir, this.deps.modelsConfig);
    const checksConfig = this.deps.checksConfig ?? loadChecksConfig(this.deps.configDir);
    const dispatcher = new WorkerDispatcher({
      client: this.deps.client,
      reviewCommands: checksConfig.reviewCommands,
      checkSandbox: checksConfig.sandbox,
      testPathGlobs: checksConfig.testPathGlobs,
      modelsConfig,
      decisionMode: this.deps.decisionModels ?? 'pure',
      ledger,
      budget: this.budget,
      runState: state,
      onProgress: (live) => {
        const saved = this.runStore.load(runId);
        if (!saved || saved.engineLease?.instanceId !== this.instanceId) return;
        saved.costUsd = live.costUsd;
        saved.tokensUsed = { ...live.tokensUsed };
        saved.workerCalls = live.workerCalls;
        saved.institutionalCallsByTask = { ...live.institutionalCallsByTask };
        if (live.institutionalPlanCache) saved.institutionalPlanCache = { ...live.institutionalPlanCache };
        saved.resourceReservations = live.resourceReservations
          ? structuredClone(live.resourceReservations) : undefined;
        saved.updatedAt = new Date().toISOString();
        saved.heartbeatAt = saved.updatedAt;
        if (saved.engineLease) saved.engineLease.heartbeatAt = saved.updatedAt;
        this.runStore.save(saved);
      },
      // Lazy: the worktree does not exist yet on the first buildContext call, and the inventory
      // must reflect the repository as it stands at each dispatch, not as it was at construction.
      repoInventory: () => worktree.listFiles(),
      repoInterfaces: () => worktree.publicInterfaces(),
      fileExists: (relPath) => worktree.pathExists(relPath),
      worktree,
      ownership: () => state.ownership,
      fallbackRepositoryContext: (taskId, prompt) => {
        return worktree.fallbackRepositoryBundle(fallbackContextPaths(state, taskId), prompt);
      },
    });
    state.findings ??= [];

    const ctx: EngineContext = {
      dispatcher,
      worktree,
      ledger,
      knowledge: this.deps.isolateKnowledgePerRun ? this.knowledge.scopedTo(state.runId) : this.knowledge,
      budget: this.budget,
      config: state.constitution?.config ?? (this.deps.strategiesConfig[strategy.id] as Record<string, unknown>) ?? {},
      checks: checksConfig,
      runId,
      runState: state,
      strategyState: state.strategyState ?? {},
      openApproval: (approval) => {
        const full: PendingApproval = { ...approval, id: randomUUID().slice(0, 8), createdAt: new Date().toISOString() };
        state.pendingApprovals.push(full);
        ledger.record('approval_opened', { ...full });
        return full;
      },
      getApprovalResolution: (approvalId) => state.pendingApprovals.find((a) => a.id === approvalId),
      syncPacket: () => this.buildSyncPacket(state, worktree),
      addFinding: (finding) => {
        const full = newFinding(finding);
        (state.findings ??= []).push(full);
        ledger.record('finding_raised', { ...full });
        return full;
      },
      findings: () => state.findings ?? [],
    };
    return { ctx, worktree };
  }

  /**
   * The bounded state a newly started or resumed agent instance receives, rather than an assumed
   * shared memory. Rebuilt on demand so a barrier always sees the run as it currently stands.
   */
  private async buildSyncPacket(state: RunState, worktree: RepoWorktree): Promise<SynchronizationPacket> {
    const { filesChanged } = await worktree.diff().catch(() => ({ diffText: '', filesChanged: [] as string[] }));
    const graph = state.graph;
    return {
      runId: state.runId,
      baseRevision: await worktree.baseRevision(),
      decisions:
        graph?.order.map((id) => ({
          taskId: id,
          outcome: latestVerdict(graph.nodes[id]) ?? 'pending',
          rationale: graph.nodes[id].title,
        })) ?? [],
      ownershipMap: state.ownership ?? emptyOwnershipMap(),
      changedFileManifest: filesChanged,
      evidence: buildRequirementMatrix(state),
      openFindings: (state.findings ?? []).filter((f) => f.disposition === 'unresolved'),
      capturedAt: new Date().toISOString(),
    };
  }

  /**
   * Drops files the check command generated as a side effect while it ran against the applied
   * fileOps (pytest's __pycache__, for instance), so a rejected task leaves the worktree exactly
   * as it found it. Strictly best-effort: cleanup is cosmetic, so it must never turn a normally
   * rejected task into a failed one, and it never runs without a trustworthy baseline.
   */
  private async cleanCheckArtifacts(
    ctx: EngineContext,
    taskId: string,
    dirtyBefore: Map<string, string> | null,
    preservePaths: string[] = [],
  ): Promise<void> {
    if (!dirtyBefore) return;
    try {
      const strayPaths = ctx.worktree.removeUntrackedSince(
        dirtyBefore,
        await ctx.worktree.listDirtyPaths(),
        preservePaths,
      );
      if (strayPaths.length > 0) {
        ctx.ledger.record('check_artifacts_cleaned', { taskId, paths: strayPaths });
      }
    } catch (err) {
      logger.warn('Check-artifact cleanup failed; leaving the worktree as-is', { taskId, error: String(err) });
    }
  }

  /**
   * Runs each final-only check against a dirty-path snapshot so generated files become check
   * artifacts (copied into the run directory) rather than authored delivery source. The worktree
   * originals are stripped before the authored diff is recaptured and before the next remediation.
   */
  private async runFinalOnlyChecks(
    ctx: EngineContext,
    state: RunState,
  ): Promise<{ records: CheckRunRecord[]; artifacts: CheckArtifact[] }> {
    const categories = this.deps.finalOnlyChecks ?? [];
    if (categories.length === 0) return { records: [], artifacts: [] };

    const cycle = state.deliveryRemediationCycles ?? 0;
    const runDir = path.dirname(ctx.worktree.worktreePath);
    const artifacts: CheckArtifact[] = [];
    const records: CheckRunRecord[] = [];

    for (const category of categories) {
      let dirtyBefore: Map<string, string> | null = null;
      try {
        dirtyBefore = await ctx.worktree.listDirtyPaths();
      } catch (err) {
        logger.warn('Could not snapshot worktree before a final-only check', {
          categoryId: category.id,
          error: String(err),
        });
      }

      const [record] = await runCheckCategories(ctx.worktree, [category], ctx.checks.sandbox);
      let generated: string[] = [];
      let dirtyAfter: Map<string, string> | null = null;
      if (dirtyBefore) {
        try {
          dirtyAfter = await ctx.worktree.listDirtyPaths();
          generated = ctx.worktree.untrackedAppearingSince(dirtyBefore, dirtyAfter);
        } catch (err) {
          logger.warn('Could not diff worktree after a final-only check', {
            categoryId: category.id,
            error: String(err),
          });
        }
      }

      const capturedAt = new Date().toISOString();
      for (const relPath of generated) {
        const evidenceRel = path.posix.join('check-artifacts', String(cycle), category.id, relPath);
        try {
          ctx.worktree.copyWorktreeFile(relPath, path.join(runDir, evidenceRel));
        } catch (err) {
          logger.warn('Could not retain a final-check artifact copy', { path: relPath, error: String(err) });
        }
        artifacts.push({
          path: relPath,
          checkCategoryId: category.id,
          capturedAt,
          evidencePath: evidenceRel,
        });
      }

      records.push(generated.length ? { ...record, generatedPaths: generated } : record);

      if (dirtyBefore && dirtyAfter && generated.length > 0) {
        try {
          ctx.worktree.removeUntrackedSince(dirtyBefore, dirtyAfter);
        } catch (err) {
          logger.warn('Could not strip final-check artifacts from the worktree', {
            categoryId: category.id,
            error: String(err),
          });
        }
      }
    }

    if (artifacts.length > 0) {
      ctx.ledger.record('final_check_artifacts', {
        cycle,
        artifacts: artifacts.map((item) => ({
          path: item.path,
          checkCategoryId: item.checkCategoryId,
          evidencePath: item.evidencePath,
        })),
      });
    }

    return { records, artifacts };
  }

  /**
   * The non-waivable test-integrity floor. Runs before the fileOps touch the worktree the check
   * command is about to execute in, because the whole point is to stop a change that would make
   * the check pass by removing what it checks. Returns true when the task was halted.
   */
  private guardTestIntegrity(ctx: EngineContext, node: TaskNode, fileOps: FileOp[]): boolean {
    const taskId = node.id;
    const protectedTests = new Set((ctx.runState.protectedBaselineTests ?? []).map((file) => file.replace(/^\.\//, '')));
    const protectedFileOps = fileOps.filter((operation) => protectedTests.has(operation.path.replace(/^\.\//, '')));
    const violations = detectTestIntegrityViolations(protectedFileOps, ctx.checks.testPathGlobs, (p) =>
      ctx.worktree.readFileIfExists(p),
    );
    if (violations.length === 0) return false;

    const detail = describeViolations(violations);
    ctx.ledger.record('test_integrity_violation', { taskId, violations });
    ctx.addFinding({
      source: 'engine:test-integrity',
      taskId,
      summary: `Proposed change weakens existing tests: ${detail}`,
      evidenceRefs: violations.map((v) => v.path),
      disposition: 'unresolved',
      dispositionRationale:
        'Held for human decision. No doctrine may delete, skip or dilute a valid test to obtain a passing result.',
      nonWaivable: true,
    });
    const fingerprint = fingerprintAttempt({ fileOps, failedCategoryIds: [], blockingReviewVerdicts: [] });
    const repeated = node.attempts.at(-1)?.fingerprint === fingerprint;
    const recordedAttempt = recordAttempt(node, {
      outcome: 'needs_human',
      rationale: `Proposed change weakens existing tests: ${detail}`,
      evidenceRefs: violations.map((v) => v.path),
      at: new Date().toISOString(),
      fingerprint,
      repeated,
    });

    const maxAttempts = this.budget.maxTaskAttempts();
    if (recordedAttempt.attempt >= maxAttempts) {
      node.phase = 'abandoned';
      ctx.ledger.record('rework_budget_exhausted', {
        taskId,
        attemptNumber: recordedAttempt.attempt,
        maxAttempts,
        reason: 'test_integrity_violation',
      });
      return true;
    }

    ctx.openApproval({
      kind: 'test_waiver',
      taskId,
      description:
        `Task "${taskId}" proposes weakening existing tests, which no doctrine may authorise on its own: ` +
        `${detail} Either answer sends the task back for a fresh attempt while attempts remain; the guard ` +
        'checks every attempt again, so no answer lets a change that weakens these tests reach the tree.',
    });
    return true;
  }

  private async runLoop(runId: string, task: TaskSpec, resuming = false): Promise<void> {
    this.activeLoops.add(runId);
    try {
      const state = this.mustLoad(runId);
      const strategy = this.deps.strategies[state.strategy];
      const { ctx } = this.buildContext(runId, state, strategy);
      // Every launch, not only resumeRun: a transient-crash requeue reloads state.json, which can
      // lag the ledger, and a counter-keyed decision id would then be reissued with new content.
      restoreGovernanceFromLedger(state, ctx.ledger.readAll());
      if (state.graph) recoverInterruptedTasks(state.graph, ctx);

      // Keyed on what the run actually has, not on whether this is a resume: a run that paused
      // during planning comes back with no graph and must plan before it can do anything, while a
      // run that paused mid-task comes back with one and must not re-plan over it.
      if (!state.graph) {
        // Baseline first: a suite already failing before the swarm touched anything must be
        // disclosed as a limitation, not charged to the change. Section 9 requires the narrowest
        // useful baseline be run or recorded before editing. Re-running it on a resume would
        // measure a tree the swarm has already edited, so it is taken once.
        state.baseline = state.baseline?.length ? state.baseline : await runAllChecks(ctx.worktree, ctx.checks);
        state.currentCheckSnapshot = state.currentCheckSnapshot?.length ? state.currentCheckSnapshot : state.baseline;
        ctx.ledger.record('baseline_recorded', {
          categories: state.baseline.map((b) => ({ id: b.categoryId, ran: b.ran, passed: b.passed, skippedReason: b.skippedReason })),
        });
        this.runStore.save(state);

        // Planning is metered like any other phase. Running out of budget here is a resource
        // limit Claude enforces, not a failure of the doctrine, so it pauses for approval the
        // same way an exhausted budget does mid-task — rather than crashing the run.
        try {
          state.graph = await strategy.plan(ctx, task);
          ctx.ledger.record('plan_created', { nodeCount: state.graph.order.length });

          const declared = await strategy.declareOwnership(ctx, state.graph);
          state.ownership = mergeOwnership(ownershipFromGraph(state.graph, ctx.checks.testPathGlobs), declared);
          ctx.ledger.record('ownership_declared', {
            entries: Object.values(state.ownership.entries).map((e) => ({ taskId: e.taskId, paths: e.paths })),
            declaredOverlaps: state.ownership.declaredOverlaps,
          });
        } catch (err) {
          if (err instanceof BudgetExceededError && err.kind === 'per_run') {
            state.status = 'paused_budget';
            ctx.openApproval({ kind: 'budget_increase', description: err.message });
            this.persist(state, ctx);
            return;
          }
          throw err;
        }

        state.updatedAt = new Date().toISOString();
        this.runStore.save(state);
      }

      while (state.status === 'running' && !this.honourStop(state)) {
        const elapsedMin = (Date.now() - new Date(state.startedAt ?? state.createdAt).getTime()) / 60000;
        if (Date.now() > new Date(state.deadlineAt ?? state.updatedAt).getTime()) {
          state.status = 'paused_budget';
          ctx.ledger.record('wall_clock_exceeded', { elapsedMin });
          ctx.openApproval({
            kind: 'wall_clock_extension',
            description: `Wall-clock budget of ${this.budget.maxWallClockMinutes()} minutes exceeded ` +
              `after ${elapsedMin.toFixed(1)} minutes elapsed.`,
          });
          break;
        }
        if (!state.graph) break;

        if (hasBlockedNodes(state.graph) && readyNodes(state.graph).length === 0) {
          state.status = 'paused_human';
          break;
        }

        let ready = readyNodes(state.graph);
        if (ready.length === 0) {
          // Before giving up, release whatever is waiting only on a task that will never come.
          // A dependency the doctrine abandoned blocks its dependents forever, and that has ended
          // every run in the benchmark: democratic settled four of eight tasks and delivered
          // nothing because the other four sat at zero attempts behind the one that failed, with
          // $7 of its $8 unspent. The choice is not broken code versus working code, it is
          // attempted code versus nothing at all.
          //
          // Deliberately done only once the frontier is empty, never the moment a task is
          // abandoned: every other task finishes first, so a dependent starts knowing exactly what
          // it did and did not get, and normal scheduling is untouched. What these tasks produce is
          // reported against an abandoned dependency, never as though the dependency had passed.
          const released = releaseOrphanedDependents(state.graph);
          if (released.length > 0) {
            ctx.ledger.record('dependents_released', {
              taskIds: released.map((entry: { taskId: string }) => entry.taskId),
              abandonedDependencies: released.flatMap((entry: { missing: string[] }) => entry.missing),
            });
            ready = readyNodes(state.graph);
          }
        }
        if (ready.length === 0) {
          // Nothing left to run. Whether that means "deliver" or "stop and say why" is decided
          // below, by whether the work actually succeeded — never by the loop simply running out.
          break;
        }

        let assignments;
        try {
          assignments = await strategy.assign(ctx, state.graph);
        } catch (err) {
          if (err instanceof BudgetExceededError) {
            if (err.kind === 'per_run') {
              state.status = 'paused_budget';
              ctx.openApproval({ kind: 'budget_increase', description: err.message });
            } else {
              state.status = 'failed';
              state.lastError = err.message;
              ctx.ledger.record('task_error', { error: err.message, budgetKind: err.kind });
            }
            break;
          }
          throw err;
        }

        // Dependency order is the engine's to enforce, not a strategy's to remember: `ready` holds
        // only nodes whose dependencies are all approved, and an assignment outside that set is
        // dropped for this pass rather than dispatched early. This matters more now that execute()
        // calls are batched — under the old strictly serial loop a dependent node merely ran late,
        // whereas a batch would run it alongside the work it depends on.
        const readyIds = new Set(ready.map((n) => n.id));
        const deferred = assignments.filter((a) => !readyIds.has(a.taskId));
        if (deferred.length > 0) {
          ctx.ledger.record('assignment_deferred', {
            taskIds: deferred.map((a) => a.taskId),
            reason: 'dependencies not yet approved',
          });
        }
        const runnable = assignments.filter((a) => readyIds.has(a.taskId));
        if (runnable.length === 0) break;
        // Concurrency is bounded by declared ownership: tasks that claim disjoint paths may have
        // their execute() calls issued together, while anything overlapping waits its turn.
        // Everything after execute — applying files, running checks, review, decision — stays
        // strictly serial. Those are the acceptance barriers, and they share one worktree.
        const batches = batchByOwnership(runnable, state.ownership ?? emptyOwnershipMap(), ctx.checks.maxConcurrentExecutes);

        let interrupted = false;
        for (const batch of batches) {
          if (state.status !== 'running') break;
          if (batch.length > 1) {
            ctx.ledger.record('concurrent_batch', { taskIds: batch.map((a) => a.taskId) });
          }

          for (const assignment of batch) {
            const node = state.graph.nodes[assignment.taskId];
            if (node) node.phase = 'running';
          }

          const products = await Promise.all(
            batch.map(async (assignment) => {
              try {
                requireAssignmentAuthority(state, assignment, state.strategy === 'socialist' &&
                  Boolean((ctx.config as { councils?: { requirePlanRatification?: boolean } })
                    .councils?.requirePlanRatification));
              } catch (err) {
                return { assignment, product: undefined, error: err, authorityFailed: true };
              }
              try {
                return { assignment, product: await strategy.execute(ctx, assignment), error: undefined,
                  authorityFailed: false };
              } catch (err) {
                return { assignment, product: undefined, error: err, authorityFailed: false };
              }
            }),
          );

          for (const { assignment, product, error, authorityFailed } of products) {
            const node = state.graph.nodes[assignment.taskId];
            if (!node) continue;

            if (authorityFailed && error instanceof RevokedMandateError) {
              node.phase = 'queued';
              ctx.ledger.record('assignment_revoked_before_dispatch', {
                taskId: node.id, assigneeId: assignment.assigneeId,
                mandateId: (assignment.meta?.authority as { mandateId?: string } | undefined)?.mandateId,
              });
              this.persist(state, ctx);
              continue;
            }
            if (error) {
              this.handleTaskError(ctx, state, node.id, error);
              if (state.status !== 'running') interrupted = true;
              this.persist(state, ctx);
              if (interrupted) break;
              continue;
            }

            try {
              await this.settleTask(ctx, state, strategy, product!);
            } catch (err) {
              this.handleTaskError(ctx, state, node.id, err);
            }
            // Settled one way or the other inside this process; only a process death leaves it set.
            delete node.inFlightFileSnapshots;

            this.persist(state, ctx);
            if (state.status !== 'running') {
              interrupted = true;
              break;
            }
          }
          if (interrupted) break;

          // A concurrent batch can admit several calls under one budget check; re-test after it.
          if (this.budget.isOverRunBudget(state)) {
            state.status = 'paused_budget';
            ctx.openApproval({ kind: 'budget_increase', description: 'Per-run budget exhausted after a concurrent batch.' });
            this.persist(state, ctx);
            break;
          }
        }
      }

      // Only a fully approved graph earns the acceptance barriers. Section 5 is explicit that
      // Claude "must preserve the last synchronization packet and report the reason rather than
      // representing partial work as accepted" — so a graph carrying rejections, or one that ran
      // out of ready work, terminates incomplete instead of quietly reporting success.
      if (state.status === 'running' && !state.graph) {
        await this.terminateIncomplete(ctx, state, 'The run produced no task graph, so there is nothing to deliver.');
      } else if (state.status === 'running' && state.graph) {
        if (allApproved(state.graph)) {
          try {
            const shouldPersist = await this.runAcceptanceBarriers(ctx, state, strategy);
            if (!shouldPersist) return;
          } catch (err) {
            // A barrier that cannot complete — an unavailable model, an unparseable response after
            // every retry and substitution — is a runtime failure, and section 5 is explicit about
            // what happens then: preserve the last synchronization packet and report the reason.
            // The approved work stays on the branch; what it must not do is claim acceptance the
            // doctrine never gave, or vanish into an unexplained crash. A network outage is not
            // that: handleLoopCrash waits it out and re-enters the barriers. Six of fifteen
            // benchmark arms on 2026-10-04 ended here on one four-minute "fetch failed" outage.
            if (isTransientProviderFailure(err)) throw err;
            await this.terminateIncomplete(
              ctx,
              state,
              `An acceptance barrier could not be completed, so no delivery was submitted: ${String(err)}`,
            );
          }
        } else {
          const rejected = rejectedNodeIds(state.graph);
          let remediating = false;
          try {
            remediating = await this.attemptGraphRemediation(ctx, state, strategy);
          } catch (error) {
            if (isTransientProviderFailure(error)) throw error;
            ctx.ledger.record('graph_remediation_failed', { error: String(error) });
          }
          if (!remediating) {
            // An abandoned task no longer sinks the whole run. Stranding five settled tasks
            // because a sixth could not be agreed threw away work the doctrine had approved, and
            // told us nothing about the doctrine — 15 of 20 benchmark runs ended here. What
            // section 5 forbids is representing partial work as accepted, not submitting it: the
            // abandonment is declared as a limitation in the delivery packet, the doctrine's own
            // acceptance procedure decides on it with that in view, and Claude's independent check
            // still stands behind that. A run with nothing approved has nothing to submit.
            const approved = approvedNodeIds(state.graph);
            if (approved.length) {
              ctx.ledger.record('partial_delivery_submitted', {
                approved: approved.length,
                abandoned: rejected,
                of: state.graph.order.length,
              });
              try {
                const shouldPersist = await this.runAcceptanceBarriers(ctx, state, strategy);
                if (!shouldPersist) return;
              } catch (err) {
                if (isTransientProviderFailure(err)) throw err;
                await this.terminateIncomplete(
                  ctx,
                  state,
                  `An acceptance barrier could not be completed, so no delivery was submitted: ${String(err)}`,
                );
              }
            } else {
              await this.terminateIncomplete(
                ctx,
                state,
                rejected.length
                  ? `The swarm rejected ${rejected.length} of ${state.graph.order.length} task(s) under its own rules, exhausted bounded graph remediation, and approved none: ${rejected.join(', ')}.`
                  : 'No task remained runnable and the graph never reached full approval.',
                rejected,
              );
            }
          }
        }
      }

      this.persist(state, ctx);
    } finally {
      this.activeLoops.delete(runId);
      this.stopRequests.delete(runId);
    }

    // A delivery returned to its own doctrine for repair leaves the run running rather than
    // terminal, but the work loop above has already exited. Pick it straight back up so a
    // self-refusal means "keep working" instead of "stop". Bounded by MAX_SELF_REMEDIATION_CYCLES,
    // which returnDeliveryForRepair enforces before ever setting the status back to running.
    if (this.runStore.load(runId)?.status === 'running' && !this.activeLoops.has(runId)) {
      await this.runLoop(runId, task, true);
    }
  }

  private async attemptGraphRemediation(
    ctx: EngineContext,
    state: RunState,
    strategy: SwarmStrategy,
  ): Promise<boolean> {
    const cycle = (state.graphRemediationCycles ?? 0) + 1;
    if (cycle > MAX_GRAPH_REMEDIATION_CYCLES || !state.graph) return false;
    const abandoned = rejectedNodeIds(state.graph);
    const finalChecks = await runAllChecks(ctx.worktree, ctx.checks);
    const { diffText } = await ctx.worktree.diff();
    const integration = await strategy.integrate(ctx, approvedNodeIds(state.graph), diffText);
    const findings: RemediationFinding[] = abandoned.map((taskId) => {
      const node = state.graph!.nodes[taskId];
      const owners = node.blockedByForeignTaskIds ?? [];
      const evidence = abandonedTaskEvidence(node);
      // A refusal often diagnoses more than the task it refused: a sovereign rejecting cli-plot
      // also found damage.py clamping out-of-range energies, and that defect never reached the
      // task owning damage.py. Reopen every task whose files the diagnosis names.
      const named = this.mapTextToTasks(state, withoutCheckOutput(evidence));
      return {
        summary: owners.length
          ? `Task ${taskId} was blocked by defects owned by: ${owners.join(', ')}.`
          : `Task ${taskId} was abandoned before the graph integrated.`,
        evidence,
        affectedTaskIds: [...new Set([...owners, taskId, ...named])],
        severity: 'high',
      };
    });
    for (const failure of strictBlockingFailures(finalChecks, ctx.checks)) {
      const affectedTaskIds = this.mapTextToTasks(state, `${failure.categoryId}\n${failure.output ?? ''}`);
      findings.push({
        summary: `Required final check ${failure.categoryId} failed on the partial combined tree.`,
        evidence: failure.output ?? failure.skippedReason ?? failure.categoryId,
        affectedTaskIds: affectedTaskIds.length ? affectedTaskIds : abandoned,
        severity: 'high',
      });
    }
    for (const draft of integration.findings) {
      // Barrier findings carry the integrator's own severity as a "[low]" prefix. A low one is
      // usually an observation ("interpolation is centralized"), and promoting it to a high defect
      // reopened a finished task to repair a compliment.
      const { severity, summary } = barrierSeverity(draft.summary);
      if (severity === 'low') continue;
      const defect = { ...draft, summary };
      const mapped = this.mapTextToTasks(
        state,
        `${defect.summary}\n${defect.evidenceRefs.join('\n')}${defect.taskId ? `\n${defect.taskId}` : ''}`,
      );
      const affectedTaskIds = mapped.length
        ? mapped
        : defect.taskId && state.graph.nodes[defect.taskId]
          ? [defect.taskId]
          : abandoned;
      findings.push({
        summary: defect.summary,
        evidence: defect.evidenceRefs.join(', ') || integration.rationale,
        affectedTaskIds: affectedTaskIds.length ? affectedTaskIds : abandoned,
        severity,
      });
    }
    const reopenable = (taskId: string): boolean => {
      const node = state.graph!.nodes[taskId];
      if (!node || countedAttempts(node) >= this.budget.maxTaskAttempts()) return false;
      return node.attempts.at(-1)?.outcome !== 'rejected' || strategy.recover !== undefined;
    };
    const gone = (taskId: string): boolean => state.graph!.nodes[taskId]?.phase === 'abandoned' && !reopenable(taskId);
    const actionable = findings.flatMap((finding) => {
      const requestedTaskIds = new Set(finding.affectedTaskIds ?? []);
      // A path whose only owner is gone could otherwise never be written again: the owner has no
      // attempts left and everyone else is refused as outside ownership. Move it to one live task
      // and reopen that task with this finding.
      if (state.ownership) {
        const transfers = orphanedPathTransfers(
          state.ownership,
          state.graph!,
          `${finding.summary}\n${finding.evidence}`,
          [...requestedTaskIds],
          gone,
          checkArtifactPaths(state),
        );
        applyOrphanTransfers(state.ownership, transfers);
        for (const transfer of transfers) {
          requestedTaskIds.add(transfer.to);
          ctx.ledger.record('ownership_transferred', {
            path: transfer.path,
            from: transfer.from,
            to: transfer.to,
            cycle,
          });
        }
      }
      const requiredOwnerIds = new Set<string>();
      for (const taskId of requestedTaskIds) {
        for (const ownerId of state.graph!.nodes[taskId]?.blockedByForeignTaskIds ?? []) {
          requestedTaskIds.add(ownerId);
          requiredOwnerIds.add(ownerId);
        }
      }
      const affectedTaskIds = [...requestedTaskIds].filter(reopenable);
      if ([...requiredOwnerIds].some((taskId) => !affectedTaskIds.includes(taskId))) return [];
      return affectedTaskIds.length ? [{ ...finding, affectedTaskIds }] : [];
    });
    if (!actionable.length) return false;
    const affectedTaskIdSet = [...new Set(actionable.flatMap((finding) => finding.affectedTaskIds ?? []))].sort();
    const stalled =
      cycle > 1 &&
      affectedTaskIdSet.length > 0 &&
      arraysEqual(affectedTaskIdSet, state.lastGraphRemediationTaskIds ?? []);
    if (stalled) {
      // The same tasks came back with the same blockage after a full remediation round-trip —
      // e.g. two tasks each named as blocked by the other. Another cycle cannot break a deadlock
      // that a full remediation attempt just failed to move; it can only give the doctrine another
      // chance to rewrite the same files, which cost a real run its already-passing cli.py. Stop
      // instead of submitting the same packet again.
      ctx.ledger.record('graph_remediation_stalled', { cycle, affectedTaskIds: affectedTaskIdSet });
      return false;
    }
    const packet: RemediationPacket = {
      runId: state.runId,
      submittedAt: new Date().toISOString(),
      findings: actionable,
      origin: 'graph',
      preservedSynchronization: await ctx.syncPacket(),
      cycle,
    };
    state.graphRemediationCycles = cycle;
    state.lastGraphRemediationTaskIds = affectedTaskIdSet;
    state.remediationCycles = (state.remediationCycles ?? 0) + 1;
    state.status = 'remediation';
    this.persist(state, ctx);
    ctx.ledger.record('graph_remediation_returned', {
      cycle,
      affectedTaskIds: [...new Set(actionable.flatMap((finding) => finding.affectedTaskIds ?? []))],
      findings: actionable.map((finding) => finding.summary),
    });
    const previousGraph = structuredClone(state.graph);
    const remediated = preserveExhaustedNodes(
      previousGraph,
      await strategy.remediate(ctx, packet),
      this.budget.maxTaskAttempts(),
      `${packet.origin ?? 'delivery'}:${packet.cycle}`,
    );
    if (!remediated || !readyNodes(remediated).length) return false;
    state.graph = remediated;
    state.status = 'running';
    this.persist(state, ctx);
    return true;
  }

  private mapTextToTasks(state: RunState, text: string): string[] {
    return ownedTaskIdsForText(state.ownership, text, this.incidentalPaths(state));
  }

  /** Paths prose may name without locating a defect: check artifacts and check-command inputs. */
  private incidentalPaths(state: RunState): string[] {
    const checks = this.deps.checksConfig ?? loadChecksConfig(this.deps.configDir);
    return [
      ...checkArtifactPaths(state),
      ...checkCommandPaths([...checks.categories, ...(this.deps.finalOnlyChecks ?? [])]),
    ];
  }

  /**
   * Ends a run without a delivery, saying why and keeping what was learned.
   *
   * Section 5: "Claude must preserve the last synchronization packet and report the reason rather
   * than representing partial work as accepted." Both halves matter — the reason is recorded in
   * `lastError` and the ledger, and the bounded state is captured so the next run, or the user,
   * starts from what actually happened rather than from nothing.
   */
  private async terminateIncomplete(
    ctx: EngineContext,
    state: RunState,
    reason: string,
    rejected: string[] = [],
  ): Promise<void> {
    state.status = 'terminated_incomplete';
    state.lastError = reason;
    if (state.graph && state.evidence?.length) {
      try {
        const records = attributeAgainstBaseline(await runAllChecks(ctx.worktree, ctx.checks), state.baseline);
        state.evidence = resolveEvidenceStatus(state.evidence, records);
      } catch (err) {
        logger.warn('Could not resolve evidence before incomplete termination', {
          runId: state.runId,
          error: String(err),
        });
      }
    }
    try {
      state.lastSyncPacket = await ctx.syncPacket();
    } catch (err) {
      logger.warn('Could not capture the final synchronization packet', { runId: state.runId, error: String(err) });
    }
    ctx.ledger.record('terminated_incomplete', { reason, rejected });
  }

  /**
   * Hands a self-refused delivery back to the doctrine that refused it, if a cycle remains.
   *
   * Returns true when the run has been put back to work, false when it should terminate. Bounded by
   * MAX_SELF_REMEDIATION_CYCLES rather than by budget alone, so a doctrine that refuses on grounds
   * its own procedure cannot cure stops instead of spending the whole allowance discovering that.
   */
  private async returnDeliveryForRepair(
    ctx: EngineContext,
    state: RunState,
    strategy: SwarmStrategy,
    acceptance: { rationale: string },
  ): Promise<boolean> {
    const cycle = (state.deliveryRemediationCycles ?? 0) + 1;
    if (cycle > MAX_SELF_REMEDIATION_CYCLES || !state.delivery) return false;

    const unresolved = (state.findings ?? []).filter((finding) => finding.disposition === 'unresolved');
    const barrierFindings = [
      ...(state.delivery.integrationEvidence.integrated ? [] : state.delivery.integrationEvidence.findings),
      ...(state.delivery.independentVerification.verified ? [] : state.delivery.independentVerification.findings),
    ];
    const failedFinalChecks = state.delivery.finalChecks
      .filter((check) => !check.ran || !check.passed)
      .map((check) => ({
        summary: `Required final check "${check.categoryId}" failed.`,
        evidenceRefs: finalCheckEvidenceRefs(check),
      }));
    const refusalEvidence = [...unresolved, ...barrierFindings, ...failedFinalChecks];
    const complaint = [
      acceptance.rationale,
      ...refusalEvidence.flatMap((finding) => [finding.summary, ...(finding.evidenceRefs ?? [])]),
    ].join('\n');

    // Scope the reopening to the tasks the complaint actually names, via the ownership map that
    // already records which task owns which path. Omitting affectedTaskIds returns the WHOLE
    // programme: a real run reopened all six of its approved tasks over a CLI argument mismatch,
    // re-ran work that had already passed — composition went approved -> needs_human -> abandoned —
    // and burned into the 300-call ceiling with nothing settled. Repairing two files must not cost
    // the four that were already right.
    const mapComplaint = (text: string): string[] =>
      ownedTaskIdsForText(state.ownership, text, checkArtifactPaths(state));

    const findings: RemediationFinding[] = [
      {
        summary: acceptance.rationale.trim(),
        evidence: 'The doctrine\'s own refusal of the assembled delivery.',
        affectedTaskIds: mapComplaint(complaint),
        severity: 'high' as const,
      },
      ...refusalEvidence.map((finding) => ({
        summary: finding.summary,
        evidence: finding.evidenceRefs?.join(', ') || 'Recorded against the assembled delivery.',
        affectedTaskIds: mapComplaint([finding.summary, ...(finding.evidenceRefs ?? [])].join('\n')),
        severity: 'high' as const,
      })),
    ].filter((finding) => finding.summary.length > 0);

    const affectedTaskIds = [...new Set(findings.flatMap((finding) => finding.affectedTaskIds ?? []))];

    // No identifiable task means no scoped repair is possible, and an unscoped one costs more than
    // it recovers — so the run ends as it did before, saying why.
    if (affectedTaskIds.length === 0) return false;

    const packet: RemediationPacket = {
      runId: state.runId,
      submittedAt: new Date().toISOString(),
      findings,
      origin: 'delivery',
      preservedDelivery: state.delivery,
      preservedSynchronization: await ctx.syncPacket(),
      cycle,
    };
    state.deliveryRemediationCycles = cycle;
    state.remediationCycles = (state.remediationCycles ?? 0) + 1;
    state.status = 'remediation';
    this.persist(state, ctx);
    ctx.ledger.record('delivery_returned_for_repair', {
      cycle,
      maxCycles: MAX_SELF_REMEDIATION_CYCLES,
      findings: findings.map((finding) => finding.summary),
      affectedTaskIds,
    });

    let remediatedGraph: TaskGraph;
    try {
      const previousGraph = structuredClone(state.graph!);
      remediatedGraph = preserveExhaustedNodes(
        previousGraph,
        await strategy.remediate(ctx, packet),
        this.budget.maxTaskAttempts(),
        `${packet.origin ?? 'delivery'}:${packet.cycle}`,
      );
    } catch (err) {
      logger.warn('Doctrine could not reopen its own refused delivery', { runId: state.runId, error: String(err) });
      return false;
    }

    const storedState = this.mustLoad(state.runId);
    if (storedState.status !== 'remediation') {
      logger.warn('Doctrine remediation completed after the run left remediation state', {
        runId: state.runId,
        status: storedState.status,
      });
      return false;
    }

    state.graph = remediatedGraph;
    state.status = 'running';
    this.persist(state, ctx);
    return true;
  }

  /** Applies a pending stop to the loop's own copy of the state; true when the run must stop. */
  private honourStop(state: RunState): boolean {
    const reason = this.stopRequests.get(state.runId);
    if (reason === undefined) return false;
    state.status = 'stopped';
    state.lastError = reason;
    return true;
  }

  private persist(state: RunState, ctx: EngineContext): void {
    this.honourStop(state);
    state.strategyState = ctx.strategyState;
    state.updatedAt = new Date().toISOString();
    state.heartbeatAt = state.updatedAt;
    if (state.engineLease) state.engineLease.heartbeatAt = state.updatedAt;
    this.runStore.save(state);
  }

  /** apply -> checks -> review -> decide -> recordOutcome for one executed product, serially. */
  private async settleTask(
    ctx: EngineContext,
    state: RunState,
    strategy: SwarmStrategy,
    product: import('./types.js').WorkProduct,
  ): Promise<void> {
    const node = state.graph!.nodes[product.taskId];

    // A reworked attempt's files were reverted from the shared tree but kept for this task, which
    // read and edited them through its own repository tools. They go back in under this attempt,
    // ahead of its own operations, so an `edit` lands on the code it was written against and a file
    // the retry left alone is resubmitted as it stood. One change, one snapshot: rejected again, all
    // of it reverts. Consumed here, before any review reads the tree, so the overlay never shadows
    // the applied files.
    if (node.retainedAttempt?.length) {
      const resumed = node.retainedAttempt;
      delete node.retainedAttempt;
      product = { ...product, fileOps: [...retainedFileOps(resumed), ...product.fileOps] };
      ctx.ledger.record('attempt_resumed', { taskId: node.id, paths: resumed.map((file) => file.path) });
    }

    if (this.guardTestIntegrity(ctx, node, product.fileOps)) {
      if (node.phase !== 'abandoned') {
        node.phase = 'blocked';
        state.status = 'paused_human';
      }
      return;
    }

    // Paths this task wrote that its ownership entry never claimed. Every doctrine treats
    // unplanned overlap as a coordination defect rather than implied permission, so it is raised
    // as a finding the doctrine's own decide() and dispose steps must answer for.
    const undeclared = undeclaredPaths(node.id, product.fileOps, state.ownership ?? emptyOwnershipMap());
    if (undeclared.length > 0) {
      ctx.ledger.record('undeclared_overlap', { taskId: node.id, paths: undeclared });
      ctx.addFinding({
        source: 'engine:ownership',
        taskId: node.id,
        summary: `Task "${node.id}" wrote path(s) outside its declared ownership: ${undeclared.join(', ')}.`,
        evidenceRefs: undeclared,
        disposition: 'unresolved',
        dispositionRationale: 'Raised at the barrier; the doctrine must accept, reject, defer or disclose it.',
      });
    }

    // Section 9's regression rule follows the task that owns tests when scope ownership splits
    // source and verification. That test task must still submit test FileOps when it settles.
    if (node.remediationOf && !product.fileOps.some((op) => isTestPath(op.path, ctx.checks.testPathGlobs))) {
      const testOwner = Object.values(state.graph!.nodes).find((other) =>
        other.id !== node.id && ownsTestFiles(other) && (node.remediationRound
          ? other.remediationRound === node.remediationRound
          : other.remediationOf === node.remediationOf));
      if (testOwner) {
        ctx.ledger.record('regression_test_delegated', { sourceTaskId: node.id, testTaskId: testOwner.id });
      } else {
        ctx.addFinding({
          source: 'engine:regression-rule',
          taskId: node.id,
          summary: `Remediation of task "${node.id}" changed no test — a defect fix must add or strengthen a regression test.`,
          evidenceRefs: [
            ...product.fileOps.map((op) => op.path),
            `remediation-origin:${summarizeRemediationOrigin(node.remediationOf, node.id)}`,
          ],
          disposition: 'unresolved',
          dispositionRationale: 'Raised at the barrier; the doctrine must remedy it or disclose it explicitly.',
        });
      }
    }

    // Apply before checking: the point of execution-based verification is that the check runs
    // against the implementer's actual proposed files, not the pristine pre-task worktree.
    // Snapshot first so a rejected task's changes can be undone precisely, without disturbing
    // earlier approved (but still uncommitted) tasks.
    const snapshot = ctx.worktree.snapshotFileOps(product.fileOps);
    // Baseline for artifact cleanup, and deliberately `null` rather than an empty map when
    // unavailable: an empty baseline would make every untracked file in the worktree — including
    // earlier approved tasks' still-uncommitted work — look like it appeared during this task,
    // and therefore be eligible for deletion.
    let dirtyBefore: Map<string, string> | null = null;
    try {
      dirtyBefore = await ctx.worktree.listDirtyPaths();
    } catch (err) {
      logger.warn('Could not snapshot worktree state; skipping check-artifact cleanup', {
        taskId: node.id,
        error: String(err),
      });
    }

    // On disk before the files change: if the process dies between here and the verdict, the next
    // launch can put the worktree back instead of leaving an unjudged change in the tree.
    // A bare save, not persist(): honouring a stop request here would end the run mid-settle.
    node.inFlightFileSnapshots = snapshot;
    state.strategyState = ctx.strategyState;
    this.runStore.save(state);
    ctx.worktree.applyFileOps(product.fileOps);
    // The files as this attempt left them. A resumed attempt carries its retained files as operations
    // too, so its operation list differs from the last attempt's even when the code is the same; what
    // it produced is what repeats, and what a rework keeps.
    const attemptFiles = ctx.worktree.snapshotFileOps(product.fileOps);
    const records = attributeAgainstBaseline(await runAllChecks(ctx.worktree, ctx.checks), state.baseline);
    const testResult = ownsTestFiles(node, product.fileOps)
      ? suiteBoundTestResult(toTaskTestResult(records, state.currentCheckSnapshot ?? state.baseline ?? [], ctx.checks))
      : toTaskTestResult(records, state.currentCheckSnapshot ?? state.baseline ?? [], ctx.checks);
    ctx.ledger.record('verification_result', {
      taskId: node.id,
      ...testResult,
      categories: records.map((r) => ({ id: r.categoryId, ran: r.ran, passed: r.passed, skippedReason: r.skippedReason, failedAtBaseline: r.failedAtBaseline })),
    });

    (state.underReview ??= {})[node.id] = testResult.output ?? '';
    let review: ReviewResult;
    let doctrineDecision: Decision;
    try {
      review = await strategy.review(ctx, product, testResult);
      doctrineDecision = await strategy.decide(ctx, product, review);
    } finally {
      delete state.underReview[node.id];
    }
    const decision: Decision = regressionFloorDecision(node.id, doctrineDecision, testResult);
    if (decision !== doctrineDecision) {
      ctx.ledger.record('regression_floor_applied', {
        taskId: node.id,
        doctrineOutcome: doctrineDecision.outcome,
        failedCategories: testResult.newFailures ?? [],
      });
    }
    // A bare `rejected` says "not this attempt" — it does not say "never again", and the engine must
    // not read it as a life sentence while the attempt budget still holds. Recording the doctrine's
    // no as an abandonment on attempt 1 strands every dependent task at zero attempts and then fails
    // allApproved(), ending a run that had five of its six tasks settled. The engine may compel
    // another attempt; it may never compel an approval, so the verdict recorded below stays
    // `rejected` and the doctrine's own rationale — never guidance of the engine's own — becomes the
    // directive its recover() hook works from. Identical for every doctrine.
    // Gated on recover(): without a doctrine-owned way to prepare a different attempt, repeating
    // would only replay the same failure, so a hook-less doctrine's rejection stays final.
    const reworkFromRejection =
      decision.outcome === 'rejected' && decision.rationale.trim() && strategy.recover
        ? ({
            ...decision,
            outcome: 'rework',
            rework: {
              requiredChanges: rejectionRequiredChanges(
                decision.repairDirective?.some((line) => line.trim()) ? decision.repairDirective : decision.rationale,
                testResult,
              ),
            },
          } as Extract<Decision, { outcome: 'rework' }>)
        : undefined;
    const reworkDecision = decision.outcome === 'rework' && decision.rework?.requiredChanges.length
      ? decision as Extract<Decision, { outcome: 'rework' }>
      : reworkFromRejection;
    const fingerprint = fingerprintAttempt({
      fileOps: retainedFileOps(attemptFiles),
      failedCategoryIds: records.filter((record) => !record.passed).map((record) => record.categoryId),
      blockingReviewVerdicts: review.findings
        .filter((finding) => finding.verdict === 'reject')
        .map((finding) => ({ reviewerId: finding.reviewerId, verdict: finding.verdict })),
      ...(reworkDecision
        ? { reworkDirective: reworkDecision.rework.requiredChanges }
        : {}),
    });
    // Repetition is judged on what failed, not on the code or the prose about it: the code
    // fingerprint folds in reviewer text and test timings, so an identical failure never matched.
    const signature = decision.outcome === 'approved' ? '' : failureSignature(testResult, review);
    const previousJudged = node.attempts.filter((attempt) => !attempt.transient).at(-1);
    const repeated = signature
      ? previousJudged?.failureSignature === signature
      : node.attempts.at(-1)?.fingerprint === fingerprint;

    // Keep each decision's rationale where the delivery manifest can find it later.
    const rationales = ((ctx.strategyState.decisionRationales ??= {}) as Record<string, string>);
    rationales[node.id] = decision.rationale;

    const attemptRecord = {
      rationale: decision.rationale,
      evidenceRefs: decision.evidenceRefs,
      assigneeId: product.assignment.assigneeId,
      testsPassed: testResult.passed,
      suitePassed: testResult.suitePassed,
      at: new Date().toISOString(),
      fingerprint,
      repeated,
      ...(signature ? { failureSignature: signature, failureSummary: failureSummary(testResult, decision.rationale) } : {}),
    };
    const briefFor = (attemptNumber: number, retainedPaths?: string[]) => buildRepairBrief({
      node,
      attemptNumber,
      retainedPaths,
      maxAttempts: this.budget.maxTaskAttempts(),
      test: testResult,
      review,
      fileOps: product.fileOps,
      repeatCount: trailingRepeatCount(node),
    });

    if (decision.outcome === 'needs_human' || strategy.requiresHumanApproval(ctx, decision)) {
      // Leave the applied files in place — a human reviewing "final_diff" needs to see the actual
      // proposed change, not the pre-task state.
      const pendingAttempt = recordAttempt(node, {
        outcome: 'needs_human',
        ...attemptRecord,
      });
      // Ready for the attempt after a refusal; an approval of the sign-off clears it.
      node.repairBrief = briefFor(pendingAttempt.attempt);
      node.pendingFileSnapshots = snapshot;
      node.pendingCheckSnapshot = records;
      node.phase = 'blocked';
      ctx.openApproval({
        kind: 'final_diff',
        taskId: node.id,
        description:
          `Task "${node.title}" needs human sign-off: ${decision.rationale}` +
          signOffCheckContext(testResult),
      });
    } else if (decision.outcome === 'approved') {
      recordAttempt(node, {
        outcome: 'approved',
        ...attemptRecord,
      });
      delete node.repairBrief;
      delete node.signOffRefusals;
      node.phase = 'settled';
      state.currentCheckSnapshot = records;
      for (const dependent of Object.values(state.graph!.nodes)) {
        if (!dependent.blockedByForeignTaskIds?.includes(node.id)) continue;
        dependent.blockedByForeignTaskIds = dependent.blockedByForeignTaskIds.filter((id) => id !== node.id);
      }
    } else if (decision.outcome === 'rejected' && !reworkFromRejection) {
      ctx.worktree.revertFileOps(snapshot);
      recordAttempt(node, {
        outcome: 'rejected',
        ...attemptRecord,
      });
      node.phase = 'abandoned';
    } else if (reworkDecision) {
      ctx.worktree.revertFileOps(snapshot);
      await this.cleanCheckArtifacts(ctx, node.id, dirtyBefore, product.fileOps.map((op) => op.path));

      // The attempt history keeps the verdict the doctrine actually reached, not the scheduling
      // consequence the engine drew from it. Only the phase says "try again".
      const recordedOutcome = decision.outcome === 'rejected' ? 'rejected' : 'rework';
      const recordedAttempt = recordAttempt(node, {
        outcome: recordedOutcome,
        ...attemptRecord,
      });
      node.repairBrief = briefFor(recordedAttempt.attempt, attemptFiles.map((file) => file.path));
      await strategy.recordOutcome(ctx, decision, testResult);
      recordedAttempt.outcome = recordedOutcome;

      // Ownership handoff must rest on structured path evidence. Reviewer prose often repeats the
      // run-wide acceptance command (for example examples/304L.yaml) while judging a narrow early
      // task; treating every path in that prose as the defect owner abandons the correct task and
      // reopens an unrelated one. The decision and finding evidenceRefs are the review protocol's
      // explicit claim about where the observed defect lives.
      const ownershipEvidence = [
        ...decision.evidenceRefs,
        ...review.findings
          .filter((finding) => finding.verdict !== 'approve')
          .flatMap((finding) => finding.evidenceRefs ?? []),
      ].join('\n');
      const namedOwnerIds = refusalForeignOwnerIds(state, node.id, ownershipEvidence, this.incidentalPaths(state));
      // An owner already waiting on this task cannot repair for it: handing off to it closes a cycle
      // in which each task waits for the other, both are abandoned, and graph remediation stalls.
      // repairbrief-r1's single_agent lost data-model and tests that way — source blamed the test
      // files while the tests blamed the source. This task keeps the repair instead.
      const foreignOwnerIds = namedOwnerIds.filter((ownerId) => !waitsOn(state.graph!, ownerId, node.id));
      if (foreignOwnerIds.length < namedOwnerIds.length) {
        ctx.ledger.record('ownership_handoff_declined', {
          taskId: node.id,
          ownerTaskIds: namedOwnerIds.filter((ownerId) => !foreignOwnerIds.includes(ownerId)),
          reason: 'owner is already waiting on this task',
        });
      }
      if (foreignOwnerIds.length) {
        node.blockedByForeignTaskIds = foreignOwnerIds;
        node.phase = 'abandoned';
        // Tests that fail on other tasks' code are the evidence those tasks need. Reverted, the
        // owners were reopened against an empty suite, the defects stayed invisible, and the
        // rewritten tests failed the same way: no arm of one sweep landed a single test file. Kept,
        // the owners' checks and graph remediation run them. The current snapshot moves with
        // them, so an owner is judged on what it changes, not on failures it inherited.
        const keptTestFiles = keepsTestsForOwners(product.fileOps) ? product.fileOps.map((op) => op.path) : [];
        if (keptTestFiles.length) {
          ctx.worktree.applyFileOps(product.fileOps);
          state.currentCheckSnapshot = records;
        }
        ctx.ledger.record('ownership_handoff', {
          taskId: node.id,
          ownerTaskIds: foreignOwnerIds,
          attemptNumber: recordedAttempt.attempt,
          ...(keptTestFiles.length ? { keptTestFiles } : {}),
        });
        ctx.ledger.record('task_decided', { taskId: node.id, outcome: decision.outcome });
        return;
      }
      delete node.blockedByForeignTaskIds;

      const maxAttempts = this.budget.maxTaskAttempts();
      if (recordedAttempt.attempt >= maxAttempts) {
        node.phase = 'abandoned';
        ctx.ledger.record('rework_budget_exhausted', {
          taskId: node.id,
          attemptNumber: recordedAttempt.attempt,
          maxAttempts,
        });
      } else if (!strategy.recover) {
        node.phase = 'blocked';
        state.status = 'paused_human';
        ctx.openApproval({
          kind: 'final_diff',
          taskId: node.id,
          description:
            `Task "${node.title}" returned rework without implementing the required recover() hook. ` +
            'The engine will not repeat the attempt without doctrine-owned recovery.',
        });
      } else {
        node.retainedAttempt = attemptFiles;
        const protectedAttempts = node.attempts.map((attempt) => ({
          ...attempt,
          evidenceRefs: [...attempt.evidenceRefs],
        }));
        try {
          await strategy.recover(ctx, {
            product,
            review,
            decision: reworkDecision,
            test: testResult,
            attemptNumber: recordedAttempt.attempt,
            maxAttempts,
            repeated,
            brief: node.repairBrief,
          });
          node.attempts = protectedAttempts;
          node.phase = 'queued';
          state.graph!.nodes[node.id] = node;
        } catch (err) {
          node.attempts = protectedAttempts;
          node.phase = 'blocked';
          state.graph!.nodes[node.id] = node;
          state.status = 'paused_human';
          ctx.openApproval({
            kind: 'final_diff',
            taskId: node.id,
            description: `Task "${node.title}" recovery failed after a rework decision: ${String(err)}`,
          });
        }
      }

      ctx.ledger.record('task_decided', { taskId: node.id, outcome: decision.outcome });
      return;
    } else {
      ctx.worktree.revertFileOps(snapshot);
      await this.cleanCheckArtifacts(ctx, node.id, dirtyBefore, product.fileOps.map((op) => op.path));
      node.phase = 'blocked';
      state.status = 'paused_human';
      ctx.openApproval({
        kind: 'final_diff',
        taskId: node.id,
        description: `Task "${node.title}" returned rework without a concrete rework directive.`,
      });
      ctx.ledger.record('task_decided', { taskId: node.id, outcome: decision.outcome });
      return;
    }

    // Every path, not just rejection: the checks run against the applied files on approved tasks
    // too, so their side-effect output (bytecode, caches) would otherwise accumulate in the run's
    // final diff as changes attributable to no task at all. The task's own fileOps are preserved —
    // on the rejected path they are already reverted away, making that a no-op there.
    await this.cleanCheckArtifacts(ctx, node.id, dirtyBefore, product.fileOps.map((op) => op.path));

    await strategy.recordOutcome(ctx, decision, testResult);
    ctx.ledger.record('task_decided', { taskId: node.id, outcome: decision.outcome });
  }

  private handleTaskError(ctx: EngineContext, state: RunState, taskId: string, err: unknown): void {
    const node = state.graph?.nodes[taskId];
    if (err instanceof BudgetExceededError) {
      if (err.kind === 'per_task') {
        const added = this.budget.topUpTask(state, taskId, this.budget.defaultTaskEnvelopeUsd());
        if (added > 0) {
          if (node) node.phase = 'queued';
          ctx.ledger.record('resource_envelope_topped_up', { taskId, amountUsd: added });
          return;
        }
      }
      if (err.kind === 'per_run') {
        if (node) node.phase = 'queued'; // retry later once budget is raised
        state.status = 'paused_budget';
        ctx.openApproval({ kind: 'budget_increase', taskId, description: err.message });
      } else if (err.kind === 'per_task') {
        if (node) node.phase = 'queued';
        state.status = 'paused_budget';
        ctx.openApproval({ kind: 'budget_increase', taskId, description: err.message });
      } else {
        if (node) node.phase = 'abandoned';
        state.status = 'failed';
        state.lastError = err.message;
        ctx.ledger.record('task_error', { taskId, error: err.message, budgetKind: err.kind });
      }
      if (err.kind !== 'per_task') this.budget.releaseTask(state, taskId);
      return;
    }
    this.budget.releaseTask(state, taskId);
    // A model that is unavailable or returns an incomplete response is a runtime failure Claude
    // may resolve; it is never grounds for inventing an outcome the doctrine did not reach. The
    // partial state is preserved and the task waits for a human.
    // Recorded as an attempt, because it was one. Errors used to open an approval and record
    // nothing, which was harmless only while a rejected sign-off abandoned the node. Once
    // resolveApproval began requeueing instead, a task that failed the same way every time looped
    // forever: attempts.length never grew, so the budget that was supposed to stop it never
    // applied. One run spent 91 minutes, 160 model calls and $1.15 repeating a single
    // "Cannot edit nonexistent file" seven times with two attempts on the board.
    const transient = isTransientProviderFailure(err);
    if (node) {
      recordAttempt(node, {
        outcome: 'needs_human',
        rationale: `Execution failed: ${String(err)}`,
        evidenceRefs: [],
        at: new Date().toISOString(),
        fingerprint: `error:${String(err)}`,
        repeated: node.attempts.at(-1)?.fingerprint === `error:${String(err)}`,
        ...(transient ? { transient: true } : {}),
      });
      const exhausted =
        countedAttempts(node) >= this.budget.maxTaskAttempts() ||
        trailingTransientAttempts(node) >= MAX_TRAILING_TRANSIENT_ATTEMPTS;
      node.phase = exhausted ? 'abandoned' : 'blocked';
    }
    // A provider that timed out has said nothing about the work, so it needs no human ruling: put
    // the task straight back in the queue and let the loop retry it against a fresh call.
    if (transient && node?.phase === 'blocked') {
      node.phase = 'queued';
      ctx.ledger.record('task_error', { taskId, error: String(err), transient: true, requeued: true });
      return;
    }
    ctx.ledger.record('task_error', { taskId, error: String(err) });
    if (node?.phase === 'abandoned') return;
    state.status = 'paused_human';
    ctx.openApproval({
      kind: 'final_diff',
      taskId,
      description: `Task "${node?.title ?? taskId}" failed unexpectedly: ${String(err)}`,
    });
  }

  /**
   * The serial acceptance barriers: integration on the aggregate tree, independent verification
   * outside the authorship chain, disposition of every open finding, then the doctrine's own
   * acceptance decision. Each is performed by the strategy through its own institutions; the
   * engine sequences them, records their evidence, and refuses to submit a manifest with holes.
   */
  private async runAcceptanceBarriers(ctx: EngineContext, state: RunState, strategy: SwarmStrategy): Promise<boolean> {
    return ctx.dispatcher.outsideTaskCeilings(() => this.reviewDelivery(ctx, state, strategy));
  }

  private async reviewDelivery(ctx: EngineContext, state: RunState, strategy: SwarmStrategy): Promise<boolean> {
    const approved = approvedNodeIds(state.graph!);
    const { diffText, filesChanged, treeId: deliveryTreeId } = await ctx.worktree.diff();

    const integration = await strategy.integrate(ctx, approved, diffText);
    ctx.ledger.record('integration_report', {
      integratorId: integration.integratorId,
      integrated: integration.integrated,
      findingCount: integration.findings.length,
    });
    for (const f of integration.findings) (state.findings ??= []).push(newFinding(f));

    const dirtyBeforeFinalChecks = await ctx.worktree.listDirtyPaths();

    // Post-integration checks on the combined tree. Component-level results never warrant the
    // assembled product.
    const integratedChecks = integration.postIntegrationChecks.length
      ? integration.postIntegrationChecks
      : await runAllChecks(ctx.worktree, ctx.checks);
    const { records: finalOnlyChecks, artifacts } = await this.runFinalOnlyChecks(ctx, state);
    if (artifacts.length > 0) {
      state.checkArtifacts = [...(state.checkArtifacts ?? []), ...artifacts];
    }
    const finalChecks = attributeAgainstBaseline([...integratedChecks, ...finalOnlyChecks], state.baseline);

    // Running checks against the tree can itself dirty it — most visibly the literal CLI final
    // check, which executes the delivered program and lets it write real output (e.g. a results
    // CSV). That output is check evidence, not authored source: the doctrine's own acceptance
    // procedure, its disposal committee, and the next remediation cycle must never see it as an
    // uncommitted file the swarm forgot to explain, the same way a rejected task's check output
    // is cleaned up below. `filesChanged` is everything already known-authored at this point;
    // preserve exactly that and drop anything new the checks themselves created.
    await this.cleanCheckArtifacts(ctx, 'acceptance-barrier', dirtyBeforeFinalChecks, filesChanged);

    // Evidence status is computed here, from the checks that actually ran on the integrated tree —
    // never taken from an agent's report. This is what makes the requirement matrix evidence.
    if (state.evidence?.length) {
      state.evidence = resolveEvidenceStatus(state.evidence, finalChecks);
      ctx.ledger.record('evidence_resolved', {
        satisfied: state.evidence.filter((e) => e.status === 'satisfied').length,
        manual: state.evidence.filter((e) => e.status === 'manual').length,
        unmet: state.evidence.filter((e) => e.status === 'unsatisfied' || e.status === 'unavailable').length,
      });
    }

    const draft = assembleDelivery({
      state,
      checks: ctx.checks,
      baseRevision: await ctx.worktree.baseRevision(),
      diffText,
      changedFiles: filesChanged,
      checkArtifacts: state.checkArtifacts ?? [],
      finalChecks,
      findings: state.findings ?? [],
      integration,
      verification: {
        verifierId: '(pending)',
        verified: false,
        criteriaTraced: [],
        findings: [],
        rationale: 'Independent verification has not run yet.',
      },
      acceptance: { accepted: false, procedure: '(pending)', rationale: '', decidedAt: new Date().toISOString() },
    });

    const verification = await strategy.verifyDelivery(ctx, draft);
    ctx.ledger.record('independent_verification', {
      verifierId: verification.verifierId,
      verified: verification.verified,
      criteriaTraced: verification.criteriaTraced.length,
    });
    for (const f of verification.findings) (state.findings ??= []).push(newFinding(f));

    // Every criterion the user stated must be traceable to evidence, or the run is incomplete
    // rather than accepted — the engine raises the gap so no doctrine can deliver around it.
    const evidenceGaps = unevidencedCriteria(draft.requirementMatrix, state.task.acceptanceCriteria);
    const finalOnlyIds = new Set(finalOnlyChecks.map((check) => check.categoryId));
    const blockingChecks = new Map(
      [
        ...strictBlockingFailures(finalChecks, ctx.checks),
        ...finalChecks.filter((check) => finalOnlyIds.has(check.categoryId) && (!check.ran || !check.passed)),
      ].map((check) => [check.categoryId, check]),
    );
    const reconciledFloor = reconcileAcceptanceFloorFindings(
      state.findings ?? [],
      evidenceGaps,
      [...blockingChecks.values()],
    );
    state.findings = reconciledFloor.findings;

    for (const gap of reconciledFloor.missingCriteria) {
      ctx.addFinding({
        source: 'engine:evidence',
        summary: `Acceptance criterion has no satisfying evidence: "${gap.criterion}"`,
        evidenceRefs: [`criterion:${gap.criterion}`],
        disposition: 'unresolved',
        dispositionRationale: 'Raised at the acceptance barrier; a criterion without evidence cannot be reported as met.',
        nonWaivable: true,
      });
    }
    for (const failure of reconciledFloor.missingChecks) {
      ctx.addFinding({
        source: 'engine:checks',
        summary: `Required check "${failure.categoryId}" fails on the integrated tree.`,
        evidenceRefs: finalCheckEvidenceRefs(failure),
        disposition: 'unresolved',
        dispositionRationale: 'Raised at the acceptance barrier; a failing required check blocks delivery.',
        nonWaivable: true,
      });
    }

    const open = (state.findings ?? []).filter((f) => f.disposition === 'unresolved');
    const disposed = await strategy.disposeFindings(ctx, open);
    ctx.ledger.record('findings_disposed', {
      count: disposed.length,
      dispositions: disposed.map((f) => ({ id: f.id, disposition: f.disposition })),
    });
    // Merge dispositions back by id, and never let a doctrine downgrade a non-waivable finding to
    // `accepted` without remedying it: the safety floor sits above every doctrine's own procedure.
    const byId = new Map(disposed.map((f) => [f.id, f]));
    state.findings = (state.findings ?? []).map((f) => {
      const update = byId.get(f.id);
      if (!update) return f;
      if (f.nonWaivable && update.disposition === 'accepted') {
        return {
          ...f,
          disposition: 'unresolved',
          dispositionRationale:
            `${update.dispositionRationale} (Recorded as unresolved: this finding sits on a non-waivable floor ` +
            `and cannot be dispositioned away without being remedied.)`,
        };
      }
      return { ...f, ...update, id: f.id, nonWaivable: f.nonWaivable };
    });

    const packet: DeliveryPacket = assembleDelivery({
      state,
      checks: ctx.checks,
      baseRevision: draft.baseRevision,
      diffText,
      changedFiles: filesChanged,
      checkArtifacts: state.checkArtifacts ?? [],
      finalChecks,
      findings: state.findings ?? [],
      integration,
      verification,
      acceptance: { accepted: false, procedure: '(pending)', rationale: '', decidedAt: new Date().toISOString() },
    });

    const acceptance = await strategy.accept(ctx, packet);
    packet.doctrineAcceptance = acceptance;
    packet.treeId = deliveryTreeId;
    state.delivery = packet;
    ctx.ledger.record('delivery_assembled', {
      accepted: acceptance.accepted,
      procedure: acceptance.procedure,
      changedFiles: filesChanged.length,
      findings: packet.findings.length,
      unresolved: packet.findings.filter((f: Finding) => f.disposition === 'unresolved').length,
    });

    const structuralErrors = deliveryPacketErrors(packet);
    if (acceptance.accepted) {
      const councilRatificationRequired = strategy.id === 'socialist' &&
        (ctx.config as { councils?: { requirePlanRatification?: boolean } }).councils?.requirePlanRatification === true;
      if (councilRatificationRequired || acceptance.authorityProof) {
        try {
          requireGovernanceAction(state, acceptance.authorityProof, deliveryGovernanceDigest(packet),
            'accept-delivery', councilRatificationRequired ? state.graph?.order : undefined);
        } catch (error) {
          structuralErrors.push(String(error));
        }
      }
    }
    if (!acceptance.accepted) {
      // A doctrine refusing its own delivery is judging that delivery, not closing the run. Ending
      // here punished exactly the doctrines whose gates worked: democratic settled all six tasks,
      // built every module for real, and was refused over a CLI calling a function that did not
      // exist and a README documenting the wrong mixture rule — two named, fixable defects — then
      // stopped with $0.42 of its $8 unspent and no repair attempted. Meanwhile a doctrine whose
      // gate missed such a defect reached awaiting_acceptance and got a remediation cycle from the
      // evaluator, so better self-assessment bought a worse outcome.
      //
      // The findings returned are the doctrine's own words about its own delivery, and
      // strategy.remediate() decides how its committees, councils or firms take the work back. The
      // engine compels another cycle; it never compels acceptance.
      if (await this.returnDeliveryForRepair(ctx, state, strategy, acceptance)) return true;
      if (state.status === 'remediation' && this.mustLoad(state.runId).status !== 'remediation') return false;
      await this.terminateIncomplete(
        ctx,
        state,
        `The swarm did not accept its own delivery under its own rules: ${acceptance.rationale}`,
      );
      return true;
    }
    const unresolvedNonWaivable = (state.findings ?? []).filter(
      (f) => f.nonWaivable && f.disposition === 'unresolved',
    );
    if (unresolvedNonWaivable.length > 0) {
      await this.terminateIncomplete(
        ctx,
        state,
        `The doctrine accepted its own delivery, but ${unresolvedNonWaivable.length} non-waivable ` +
          `finding(s) remain unresolved and no doctrine may accept around them: ` +
          `${unresolvedNonWaivable.map((f) => f.summary).join('; ')}`,
      );
      return true;
    }
    if (structuralErrors.length > 0) {
      await this.terminateIncomplete(
        ctx,
        state,
        `Delivery manifest is incomplete and cannot be submitted: ${structuralErrors.join(' ')}`,
      );
      return true;
    }

    if (this.deps.externalEvaluator) {
      const evaluations = await this.deps.externalEvaluator(ctx.worktree.worktreePath);
      packet.externalEvaluations = evaluations;
      const cliCheck = finalChecks.find((check) => check.categoryId === 'benchmark-cli');
      if (state.evidence && cliCheck) {
        state.evidence = state.evidence.map((item) => {
          if (!/alloydamage\s+calculate/i.test(item.criterion)) return item;
          const oraclePassed = evaluations.length === (this.deps.requiredExternalEvaluationCount ?? evaluations.length) &&
            evaluations.every((evaluation) => evaluation.passed);
          return {
            ...item,
            command: [cliCheck.command, ...cliCheck.args].join(' '),
            status: cliCheck.ran && cliCheck.passed && oraclePassed ? 'satisfied' : 'unsatisfied',
            note: `Exact final CLI check ${cliCheck.passed ? 'passed' : 'failed'}; external oracle ` +
              `${evaluations.filter((evaluation) => evaluation.passed).length}/${evaluations.length} passed.`,
          };
        });
        packet.requirementMatrix = state.evidence;
      }
      state.delivery = packet;
      ctx.ledger.record('external_evaluation', {
        passed: evaluations.filter((evaluation) => evaluation.passed).length,
        total: evaluations.length,
        results: evaluations.map((evaluation) => ({ id: evaluation.id, passed: evaluation.passed })),
      });
      const requiredCount = this.deps.requiredExternalEvaluationCount;
      const failed = evaluations.filter((evaluation) => !evaluation.passed);
      if ((requiredCount !== undefined && evaluations.length !== requiredCount) || failed.length) {
        const findings = oracleRemediationFindings(state, failed);
        if (requiredCount !== undefined && evaluations.length !== requiredCount) {
          findings.push({
            summary: `External oracle returned ${evaluations.length} checks; exactly ${requiredCount} are required.`,
            evidence: 'Incomplete external evaluation record.',
            affectedTaskIds: [],
            severity: 'high',
          });
        }
        if (await this.returnOracleForRepair(ctx, state, strategy, findings)) return true;
        await this.terminateIncomplete(ctx, state, 'External oracle failures exhausted bounded remediation.');
        return true;
      }
    }

    if (await ctx.worktree.snapshotTree() !== deliveryTreeId) {
      throw new Error('Worktree changed during delivery verification; a new delivery is required.');
    }
    // Not `completed`: the doctrine has accepted, Claude has not. Section 5 reserves completion for
    // a delivery packet Claude independently accepts.
    state.status = 'awaiting_acceptance';
    ctx.ledger.record('awaiting_claude_acceptance', { runId: state.runId });
    return true;
  }

  private async returnOracleForRepair(
    ctx: EngineContext,
    state: RunState,
    strategy: SwarmStrategy,
    findings: RemediationFinding[],
  ): Promise<boolean> {
    const cycle = (state.oracleRemediationCycles ?? 0) + 1;
    const actionable = findings.filter((finding) => (finding.affectedTaskIds?.length ?? 0) > 0);
    if (cycle > 2 || !state.delivery || !actionable.length) return false;
    const packet: RemediationPacket = {
      runId: state.runId,
      submittedAt: new Date().toISOString(),
      findings: actionable,
      origin: 'oracle',
      preservedDelivery: state.delivery,
      preservedSynchronization: await ctx.syncPacket(),
      cycle,
    };
    state.oracleRemediationCycles = cycle;
    state.remediationCycles = (state.remediationCycles ?? 0) + 1;
    state.status = 'remediation';
    this.persist(state, ctx);
    const previousGraph = structuredClone(state.graph!);
    const graph = preserveExhaustedNodes(
      previousGraph,
      await strategy.remediate(ctx, packet),
      this.budget.maxTaskAttempts(),
      `${packet.origin ?? 'delivery'}:${packet.cycle}`,
    );
    if (!readyNodes(graph).length) return false;
    state.graph = graph;
    state.status = 'running';
    this.persist(state, ctx);
    return true;
  }
}
