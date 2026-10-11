import type { CheckRunRecord, DeliveryPacket, EvidenceStatus } from '../engine/packets.js';
import type { PendingApproval, PendingApprovalKind } from '../engine/types.js';

export type ApprovalResolution = 'approve' | 'reject';

export interface BenchmarkAllowanceSnapshot {
  usdCeiling: number;
  usdRemaining: number;
  extensionCountCeiling: number;
  extensionsRemaining: number;
}

export class BenchmarkAllowance {
  private usdGranted = 0;
  private extensionsGranted = 0;

  constructor(
    readonly usdCeiling: number,
    readonly extensionCountCeiling: number,
  ) {
    if (!Number.isFinite(usdCeiling) || usdCeiling < 0) {
      throw new RangeError('Benchmark USD allowance must be a finite, non-negative number.');
    }
    if (!Number.isSafeInteger(extensionCountCeiling) || extensionCountCeiling < 0) {
      throw new RangeError('Benchmark extension allowance must be a non-negative safe integer.');
    }
  }

  get usdRemaining(): number {
    return Math.max(0, this.usdCeiling - this.usdGranted);
  }

  get extensionsRemaining(): number {
    return this.extensionCountCeiling - this.extensionsGranted;
  }

  snapshot(): BenchmarkAllowanceSnapshot {
    return {
      usdCeiling: this.usdCeiling,
      usdRemaining: this.usdRemaining,
      extensionCountCeiling: this.extensionCountCeiling,
      extensionsRemaining: this.extensionsRemaining,
    };
  }

  grantBudgetIncrease(requestedUsd: number): boolean {
    if (!Number.isFinite(requestedUsd) || requestedUsd <= 0) return false;

    const nextGrantedTotal = this.usdGranted + requestedUsd;
    if (!Number.isFinite(nextGrantedTotal)) return false;
    const roundingTolerance = Number.EPSILON * Math.max(1, this.usdCeiling, nextGrantedTotal);
    if (nextGrantedTotal - this.usdCeiling > roundingTolerance) return false;

    this.usdGranted = Math.min(nextGrantedTotal, this.usdCeiling);
    return true;
  }

  grantWallClockExtension(): boolean {
    if (this.extensionsRemaining === 0) return false;
    this.extensionsGranted += 1;
    return true;
  }
}

export interface ApprovalContext {
  allowance: BenchmarkAllowance;
  /** The incremental USD requested, derived by the caller from the run's current and proposed budgets. */
  budgetIncreaseUsd?: number;
  /** The latest required independent checks relevant to a final-diff approval. */
  independentChecks?: readonly CheckRunRecord[];
  /** Persisted run deadline. A stale run must not spend an extension that still leaves it expired. */
  currentDeadlineAt?: string;
}

export interface ApprovalDecision {
  kind: PendingApprovalKind;
  approvalId: string;
  decision: ApprovalResolution;
  note: string;
  allowance: BenchmarkAllowanceSnapshot;
}

interface ApprovalDecisionInput {
  approval: PendingApproval;
  context: ApprovalContext;
  decision: ApprovalResolution;
  note: string;
}

function approvalDecision({ approval, context, decision, note }: ApprovalDecisionInput): ApprovalDecision {
  return {
    kind: approval.kind,
    approvalId: approval.id,
    decision,
    note,
    allowance: context.allowance.snapshot(),
  };
}

function rejectInternalProcessApproval(approval: PendingApproval, context: ApprovalContext): ApprovalDecision {
  return approvalDecision({
    approval,
    context,
    decision: 'reject',
    note: `Rejected ${approval.kind}: the benchmark evaluator does not manufacture an outcome when a doctrine's own process did not reach its threshold.`,
  });
}

function decideBudgetIncrease(approval: PendingApproval, context: ApprovalContext): ApprovalDecision {
  const requestedUsd = context.budgetIncreaseUsd;
  if (requestedUsd === undefined || !Number.isFinite(requestedUsd) || requestedUsd <= 0) {
    return approvalDecision({
      approval,
      context,
      decision: 'reject',
      note: 'Rejected budget_increase: no valid positive incremental USD request was supplied to the benchmark evaluator.',
    });
  }

  if (!context.allowance.grantBudgetIncrease(requestedUsd)) {
    return approvalDecision({
      approval,
      context,
      decision: 'reject',
      note: `Rejected budget_increase of $${requestedUsd}: it exceeds the benchmark-wide remaining allowance of $${context.allowance.usdRemaining}.`,
    });
  }

  return approvalDecision({
    approval,
    context,
    decision: 'approve',
    note: `Approved budget_increase of $${requestedUsd}: $${context.allowance.usdRemaining} remains in the fixed benchmark-wide allowance.`,
  });
}

function decideWallClockExtension(approval: PendingApproval, context: ApprovalContext): ApprovalDecision {
  const deadlineMs = context.currentDeadlineAt ? Date.parse(context.currentDeadlineAt) : Number.NaN;
  if (Number.isFinite(deadlineMs) && deadlineMs + 15 * 60_000 <= Date.now()) {
    return approvalDecision({
      approval,
      context,
      decision: 'reject',
      note: 'Rejected wall_clock_extension: adding 15 minutes to the persisted deadline would still leave the run expired.',
    });
  }
  if (!context.allowance.grantWallClockExtension()) {
    return approvalDecision({
      approval,
      context,
      decision: 'reject',
      note: 'Rejected wall_clock_extension: the benchmark-wide extension allowance is exhausted.',
    });
  }

  return approvalDecision({
    approval,
    context,
    decision: 'approve',
    note: `Approved wall_clock_extension: ${context.allowance.extensionsRemaining} extension(s) remain in the fixed benchmark-wide allowance.`,
  });
}

function decideFinalDiff(approval: PendingApproval, context: ApprovalContext): ApprovalDecision {
  const checks = context.independentChecks;
  if (!checks || checks.length === 0) {
    return approvalDecision({
      approval,
      context,
      decision: 'reject',
      note: 'Rejected final_diff: required independent check results were not supplied, so the evaluator failed closed.',
    });
  }

  const failures = checks.filter((check) => (!check.ran || !check.passed) && check.failedAtBaseline !== true);
  if (failures.length > 0) {
    return approvalDecision({
      approval,
      context,
      decision: 'reject',
      note: `Rejected final_diff: required independent check(s) did not pass: ${failures.map((check) => check.categoryId).join(', ')}.`,
    });
  }

  const incomplete = checks.filter((check) => check.failedAtBaseline === true && (!check.ran || !check.passed));
  return approvalDecision({
    approval,
    context,
    decision: 'approve',
    note: incomplete.length > 0
      ? `Approved final_diff: no required check regressed; pre-task/baseline-incomplete categories remain nonblocking ` +
        `for this task (${incomplete.map((check) => check.categoryId).join(', ')}) and remain strict at final delivery.`
      : `Approved final_diff: all ${checks.length} supplied required independent check(s) ran and passed.`,
  });
}

function assertUnreachable(kind: never): never {
  throw new Error(`Unhandled pending approval kind: ${String(kind)}`);
}

export function decideApproval(approval: PendingApproval, context: ApprovalContext): ApprovalDecision {
  switch (approval.kind) {
    case 'test_waiver':
      return approvalDecision({
        approval,
        context,
        decision: 'reject',
        note: 'Rejected test_waiver: benchmark mode never approves weakening or removal of required tests.',
      });
    case 'vote_threshold':
    case 'spend_approval':
    case 'confidence_vote':
      return rejectInternalProcessApproval(approval, context);
    case 'budget_increase':
      return decideBudgetIncrease(approval, context);
    case 'wall_clock_extension':
      return decideWallClockExtension(approval, context);
    case 'final_diff':
      return decideFinalDiff(approval, context);
    default:
      return assertUnreachable(approval.kind);
  }
}

export interface DeliveryDecision {
  kind: 'delivery';
  runId: string;
  accept: boolean;
  decision: 'accept' | 'remediate';
  reasons: string[];
  summary: string;
}

const INSUFFICIENT_HEADLESS_EVIDENCE: ReadonlySet<EvidenceStatus> = new Set([
  'unsatisfied',
  'unavailable',
  'manual',
]);

function evidenceFailureReason(criterion: string, status: EvidenceStatus): string {
  if (status === 'manual') {
    return `Mandatory acceptance criterion "${criterion}" relies on manual inspection, which cannot satisfy headless benchmark acceptance.`;
  }
  return `Mandatory acceptance criterion "${criterion}" has ${status} evidence.`;
}

function mandatoryEvidenceFailures(draft: DeliveryPacket): string[] {
  const mandatoryCriteria = new Set(draft.acceptanceCriteria.map((criterion) => criterion.trim()));
  const representedCriteria = new Set<string>();
  const reasons: string[] = [];

  for (const item of draft.requirementMatrix) {
    const criterion = item.criterion.trim();
    if (!mandatoryCriteria.has(criterion)) continue;
    representedCriteria.add(criterion);
    if (INSUFFICIENT_HEADLESS_EVIDENCE.has(item.status)) {
      reasons.push(evidenceFailureReason(item.criterion, item.status));
    }
  }

  for (const criterion of draft.acceptanceCriteria) {
    if (!representedCriteria.has(criterion.trim())) {
      reasons.push(`Mandatory acceptance criterion "${criterion}" has no evidence entry in the requirement matrix.`);
    }
  }

  return reasons;
}

function finalCheckFailures(finalChecks: readonly CheckRunRecord[]): string[] {
  return finalChecks
    .filter((check) => (!check.ran || !check.passed) && !check.failedAtBaseline)
    .map((check) => `Required final check "${check.categoryId}" failed or did not run and was not pre-existing.`);
}

export function decideDelivery(draft: DeliveryPacket): DeliveryDecision {
  const reasons = [...mandatoryEvidenceFailures(draft), ...finalCheckFailures(draft.finalChecks)];
  if (!draft.independentVerification.verified) {
    reasons.push(
      `Independent verification by "${draft.independentVerification.verifierId}" did not verify the delivery.`,
    );
  }

  const accept = reasons.length === 0;
  return {
    kind: 'delivery',
    runId: draft.runId,
    accept,
    decision: accept ? 'accept' : 'remediate',
    reasons,
    summary: accept
      ? 'Accepted delivery: all mandatory criteria have automated satisfying evidence, all required final checks passed or were pre-existing, and independent verification succeeded.'
      : `Rejected delivery for remediation: ${reasons.length} blocking condition(s) found.`,
  };
}

export type EvaluatorDecision = ApprovalDecision | DeliveryDecision;

/** Pass the result to Ledger.record('external_evaluator_decision', evaluatorDecisionLedgerData(result)). */
export function evaluatorDecisionLedgerData(decision: EvaluatorDecision): Record<string, unknown> {
  return { ...decision };
}
