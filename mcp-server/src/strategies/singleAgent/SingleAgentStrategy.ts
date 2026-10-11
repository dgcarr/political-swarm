import { blockingFailures } from '../../engine/checks.js';
import { unevidencedCriteria } from '../../engine/delivery.js';
import type {
  DeliveryPacket,
  DoctrineAcceptance,
  Finding,
  IntegrationResult,
  OwnershipMap,
  RemediationPacket,
  VerificationResult,
} from '../../engine/packets.js';
import type { EngineContext, RecoveryRequest, SwarmStrategy } from '../../engine/SwarmStrategy.js';
import { addNode, emptyGraph } from '../../engine/TaskGraph.js';
import { classifyRiskByPaths } from '../../engine/risk.js';
import { rejectionRequiredChanges } from '../../engine/rejectionDirective.js';
import { remediationNote } from '../../engine/remediationNote.js';
import type {
  Assignment,
  Decision,
  ReviewResult,
  TaskGraph,
  TaskSpec,
  TestResult,
  WorkProduct,
} from '../../engine/types.js';
import {
  applyDispositions,
  dispositionSchemaDescription,
  validateDispositionReport,
  type WireDispositionReport,
} from '../barriers.js';
import {
  runIntegrationBarrier,
  runOwnershipDeclaration,
  runVerificationBarrier,
} from '../barrierPipeline.js';
import {
  evidenceMandateUserPrompt,
  evidenceSchemaDescription,
  toEvidenceItems,
  evidenceMandateValidator,
  type WireEvidenceMandate,
} from '../evidenceMandate.js';
import {
  buildDispositionUserPrompt,
  buildImplementerUserPrompt,
  buildIntegrationUserPrompt,
  buildPlannerUserPrompt,
  buildSelfReviewUserPrompt,
  buildVerificationUserPrompt,
  DISPOSITION_SYSTEM_PROMPT,
  IMPLEMENTER_SYSTEM_PROMPT,
  INTEGRATION_SYSTEM_PROMPT,
  implementerSchemaDescription,
  PLANNER_SYSTEM_PROMPT,
  plannerSchemaDescription,
  SELF_REVIEW_SYSTEM_PROMPT,
  selfReviewSchemaDescription,
  TEST_MANDATE_SYSTEM_PROMPT,
  validateImplementerOutput,
  validatePlannerOutput,
  validateSelfReviewOutput,
  VERIFICATION_SYSTEM_PROMPT,
  type ImplementerOutput,
  type PlannerOutput,
  type SelfReviewOutput,
} from './prompts.js';
import { IMPLEMENTER_TEMPERATURE } from '../implementerReminders.js';
import { SINGLE_AGENT_DEFAULTS } from '../../constitution/schema.js';

const AGENT_ID = 'the-agent';
export const SELF_REVIEW_ID = 'self-review';
export const INTEGRATION_PASS_ID = 'integration-pass';
export const VERIFICATION_PASS_ID = 'verification-pass';

function configuredStringArray(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : fallback;
}

function riskConfig(ctx: EngineContext): { securityPathGlobs: string[]; crossModuleThreshold: number } {
  const raw = (ctx.config.riskClassification ?? {}) as Record<string, unknown>;
  return {
    securityPathGlobs: configuredStringArray(raw.securityPathGlobs, SINGLE_AGENT_DEFAULTS.riskClassification.securityPathGlobs),
    crossModuleThreshold:
      typeof raw.crossModuleThreshold === 'number' && raw.crossModuleThreshold > 0
        ? raw.crossModuleThreshold : SINGLE_AGENT_DEFAULTS.riskClassification.crossModuleThreshold,
  };
}

function nodeFor(ctx: EngineContext, taskId: string) {
  const node = ctx.runState.graph?.nodes[taskId];
  if (!node) throw new Error(`Task "${taskId}" is not present in the current graph`);
  return node;
}

/**
 * The rework directive recover() was handed, per task, for the next implementer prompt. Without it
 * a retry re-ran the original prompt and regenerated the same defect.
 */
function reworkDirectives(ctx: EngineContext): Record<string, string[]> {
  const state = ctx.strategyState as { reworkDirectives?: Record<string, string[]> };
  return (state.reworkDirectives ??= {});
}

/** Per task, how many attempts it had when remediation last reopened it. */
function reopenedAtAttempt(ctx: EngineContext): Record<string, number> {
  const state = ctx.strategyState as { reopenedAtAttempt?: Record<string, number> };
  return (state.reopenedAtAttempt ??= {});
}

/**
 * Judged attempts in the current round of work: since the last approval or remediation reopen,
 * leaving out provider failures. A timeout says nothing about the work, and an approved attempt
 * or an earlier round's failure is not this round's retry.
 */
function judgedAttemptsThisRound(ctx: EngineContext, taskId: string): number {
  const attempts = nodeFor(ctx, taskId).attempts;
  let start = reopenedAtAttempt(ctx)[taskId] ?? 0;
  for (let index = attempts.length - 1; index >= start; index -= 1) {
    if (attempts[index].outcome === 'approved') {
      start = index + 1;
      break;
    }
  }
  return attempts.slice(start).filter((attempt) => !attempt.transient).length;
}

export class SingleAgentStrategy implements SwarmStrategy {
  readonly id = 'single_agent' as const;

  private async recordTestMandate(ctx: EngineContext, task: TaskSpec): Promise<void> {
    const categories = ctx.checks.categories;
    try {
      const result = await ctx.dispatcher.dispatch<WireEvidenceMandate>({
        role: 'reviewer',
        personaId: 'evidence-pass',
        systemPrompt: TEST_MANDATE_SYSTEM_PROMPT,
        userPrompt: evidenceMandateUserPrompt(task.goal, task.acceptanceCriteria, ctx.checks),
        schemaDescription: evidenceSchemaDescription(categories.map((category) => category.id)),
        validate: evidenceMandateValidator(ctx.checks),
        temperature: 0.1,
      });
      ctx.runState.evidence = toEvidenceItems(result.value, task.acceptanceCriteria, categories);
    } catch (error) {
      ctx.runState.evidence = task.acceptanceCriteria.map((criterion) => ({
        criterion,
        command: '(none)',
        expectedResult: '(none recorded)',
        status: 'unavailable' as const,
        note: `The evidence pass failed: ${String(error)}`,
      }));
    }
    ctx.ledger.record('test_mandate_recorded', {
      criteria: ctx.runState.evidence.length,
      mapped: ctx.runState.evidence.filter((item) => item.note?.startsWith('check:')).length,
      manual: ctx.runState.evidence.filter((item) => item.status === 'manual').length,
    });
  }

  async plan(ctx: EngineContext, task: TaskSpec): Promise<TaskGraph> {
    await this.recordTestMandate(ctx, task);
    const result = await ctx.dispatcher.dispatch<PlannerOutput>({
      role: 'planner',
      personaId: AGENT_ID,
      systemPrompt: PLANNER_SYSTEM_PROMPT,
      userPrompt: buildPlannerUserPrompt(task),
      schemaDescription: plannerSchemaDescription,
      validate: validatePlannerOutput,
      temperature: 0.1,
    });

    const graph = emptyGraph();
    const ids = new Set(result.value.tasks.map((planned) => planned.id));
    const risk = riskConfig(ctx);
    for (const planned of result.value.tasks) {
      const riskClass = classifyRiskByPaths(planned.targetGlobs, risk);
      addNode(graph, {
        id: planned.id,
        title: planned.title,
        description: planned.description,
        acceptanceCriteria: planned.acceptanceCriteria.length ? planned.acceptanceCriteria : task.acceptanceCriteria,
        dependsOn: planned.dependsOn.filter((dependency) => ids.has(dependency) && dependency !== planned.id),
        targetGlobs: planned.targetGlobs,
        riskTags: riskClass === 'high' ? ['security-boundary'] : riskClass === 'medium' ? ['cross-module'] : [],
        riskClass,
        phase: 'queued',
        attempts: [],
      });
    }
    ctx.ledger.record('plan_created', { nodeCount: graph.order.length });
    return graph;
  }

  async assign(_ctx: EngineContext, graph: TaskGraph): Promise<Assignment[]> {
    return graph.order
      .filter((id) => graph.nodes[id].phase === 'queued')
      .map((taskId) => ({ taskId, assigneeId: AGENT_ID, role: 'implementer' }));
  }

  async execute(ctx: EngineContext, assignment: Assignment): Promise<WorkProduct> {
    const node = nodeFor(ctx, assignment.taskId);
    const result = await ctx.dispatcher.dispatch<ImplementerOutput>({
      role: 'implementer',
      taskId: assignment.taskId,
      personaId: AGENT_ID,
      systemPrompt: IMPLEMENTER_SYSTEM_PROMPT,
      userPrompt: buildImplementerUserPrompt(
        ctx.runState.task.goal,
        node,
        node.remediationOf,
        reworkDirectives(ctx)[assignment.taskId] ?? [],
      ),
      schemaDescription: implementerSchemaDescription,
      validate: validateImplementerOutput,
      temperature: IMPLEMENTER_TEMPERATURE,
    });
    ctx.ledger.record('file_ops_proposed', {
      taskId: assignment.taskId,
      ops: result.value.fileOps.map((operation) => ({ op: operation.op, path: operation.path })),
    });
    return {
      taskId: assignment.taskId,
      assignment,
      fileOps: result.value.fileOps,
      rationale: result.value.rationale,
      unresolvedUncertainty: result.value.unresolvedUncertainty,
    };
  }

  async review(ctx: EngineContext, product: WorkProduct, test: TestResult): Promise<ReviewResult> {
    const node = nodeFor(ctx, product.taskId);
    const result = await ctx.dispatcher.dispatch<SelfReviewOutput>({
      role: 'reviewer',
      personaId: SELF_REVIEW_ID,
      scopeTaskId: product.taskId,
      systemPrompt: SELF_REVIEW_SYSTEM_PROMPT,
      userPrompt: buildSelfReviewUserPrompt(node, product, test),
      schemaDescription: selfReviewSchemaDescription,
      validate: validateSelfReviewOutput,
      temperature: 0.1,
    });
    ctx.ledger.record('review_completed', {
      taskId: product.taskId,
      findings: [{ reviewerId: SELF_REVIEW_ID, verdict: result.value.verdict }],
    });
    return {
      taskId: product.taskId,
      findings: [
        {
          reviewerId: SELF_REVIEW_ID,
          verdict: result.value.verdict,
          rationale: result.value.rationale,
          evidenceRefs: result.value.evidenceRefs,
        },
      ],
      testResult: test,
      meta: {
        requiredChanges: result.value.requiredChanges,
        requiresHumanJudgment: result.value.requiresHumanJudgment,
      },
    };
  }

  async decide(ctx: EngineContext, product: WorkProduct, review: ReviewResult): Promise<Decision> {
    const finding = review.findings[0];
    const testPassed = review.testResult?.passed === true;
    const requiresHuman = finding?.verdict === 'flag' && review.meta?.requiresHumanJudgment === true;
    const evidenceRefs = finding?.evidenceRefs ?? [];

    if (requiresHuman) {
      return {
        taskId: product.taskId,
        outcome: 'needs_human',
        rationale: finding.rationale,
        evidenceRefs,
      };
    }

    // An approving self-review does not explain a failure; only a reject or flag does.
    const selfReviewFailed = finding?.verdict === 'reject' || finding?.verdict === 'flag';
    if (testPassed && !selfReviewFailed) {
      return {
        taskId: product.taskId,
        outcome: 'approved',
        rationale: finding?.rationale ?? 'The self-review and tests support approval.',
        evidenceRefs,
      };
    }

    const verdictWord = finding?.verdict === 'reject' ? 'rejected' : 'flagged';
    const failure = selfReviewFailed ? `the self-review ${verdictWord} it` : 'the tests did not pass';

    if (judgedAttemptsThisRound(ctx, product.taskId) > 0) {
      return {
        taskId: product.taskId,
        outcome: 'rejected',
        rationale: `The bounded retry also failed: ${failure}.`,
        evidenceRefs,
      };
    }

    // The self-review's findings and requiredChanges, and the failing checks' output, reach the
    // implementer through the engine's repair brief; the directive only names what must change.
    const requiredChanges = rejectionRequiredChanges(
      selfReviewFailed ? `The self-review ${verdictWord} this attempt; resolve its findings.` : 'Make the failing checks pass.',
      review.testResult ?? { ran: false, passed: false },
    );
    return {
      taskId: product.taskId,
      outcome: 'rework',
      rationale: selfReviewFailed ? finding.rationale : 'The tests did not pass.',
      evidenceRefs,
      rework: { requiredChanges },
    };
  }

  async recordOutcome(ctx: EngineContext, decision: Decision, test: TestResult): Promise<void> {
    if (decision.outcome === 'approved') delete reworkDirectives(ctx)[decision.taskId];
    ctx.ledger.record('outcome_recorded', {
      taskId: decision.taskId,
      outcome: decision.outcome,
      testRan: test.ran,
      testPassed: test.passed,
    });
  }

  requiresHumanApproval(_ctx: EngineContext, decision: Decision): boolean {
    return decision.outcome === 'needs_human';
  }

  async recover(ctx: EngineContext, request: RecoveryRequest): Promise<void> {
    reworkDirectives(ctx)[request.product.taskId] = [...request.decision.rework.requiredChanges];
    ctx.ledger.record('remediation_returned', {
      cycle: request.attemptNumber,
      findings: request.decision.rework.requiredChanges,
    });
  }

  async declareOwnership(ctx: EngineContext, graph: TaskGraph): Promise<OwnershipMap> {
    return runOwnershipDeclaration(ctx, graph, {
      interfacesFor: () => [],
      overlapRationale: 'The single agent declared that these small tasks touch the same path.',
    });
  }

  async integrate(ctx: EngineContext, approvedTaskIds: string[], diffText: string): Promise<IntegrationResult> {
    return runIntegrationBarrier(ctx, approvedTaskIds, diffText, {
      integratorId: INTEGRATION_PASS_ID,
      systemPrompt: INTEGRATION_SYSTEM_PROMPT,
      buildUserPrompt: buildIntegrationUserPrompt,
    });
  }

  async verifyDelivery(ctx: EngineContext, draft: DeliveryPacket): Promise<VerificationResult> {
    return runVerificationBarrier(ctx, draft, {
      verifierId: VERIFICATION_PASS_ID,
      systemPrompt: VERIFICATION_SYSTEM_PROMPT,
      buildUserPrompt: buildVerificationUserPrompt,
    });
  }

  async disposeFindings(ctx: EngineContext, open: Finding[]): Promise<Finding[]> {
    if (open.length === 0) return [];
    const result = await ctx.dispatcher.dispatch<WireDispositionReport>({
      role: 'reviewer',
      personaId: 'disposition-pass',
      systemPrompt: DISPOSITION_SYSTEM_PROMPT,
      userPrompt: buildDispositionUserPrompt(open),
      schemaDescription: dispositionSchemaDescription,
      validate: validateDispositionReport,
      temperature: 0.1,
    });
    return applyDispositions(open, result.value.dispositions);
  }

  async accept(ctx: EngineContext, draft: DeliveryPacket): Promise<DoctrineAcceptance> {
    const failures = blockingFailures(draft.finalChecks, ctx.checks);
    const gaps = unevidencedCriteria(draft.requirementMatrix, draft.acceptanceCriteria);
    const reasons: string[] = [];
    if (failures.length) reasons.push(`required checks failing: ${failures.map((failure) => failure.categoryId).join(', ')}`);
    if (gaps.length) reasons.push(`criteria without satisfying evidence: ${gaps.map((gap) => gap.criterion).join('; ')}`);
    if (!draft.independentVerification.verified) reasons.push('the verification pass did not verify the delivery');
    const accepted = reasons.length === 0;
    return {
      accepted,
      procedure: 'mechanical single-agent baseline acceptance gate',
      rationale: accepted ? 'Required checks passed, every criterion has evidence, and verification succeeded.' : reasons.join('; '),
      decidedAt: new Date().toISOString(),
    };
  }

  async remediate(ctx: EngineContext, packet: RemediationPacket): Promise<TaskGraph> {
    const graph = ctx.runState.graph;
    if (!graph) throw new Error('Cannot remediate without a task graph');
    const named = new Set(packet.findings.flatMap((finding) => finding.affectedTaskIds ?? []));
    const targets = named.size ? graph.order.filter((id) => named.has(id)) : graph.order;
    for (const id of targets) {
      graph.nodes[id].phase = 'queued';
      graph.nodes[id].remediationOf = remediationNote(packet.findings, id);
      reopenedAtAttempt(ctx)[id] = graph.nodes[id].attempts.length;
      // Superseded by the remediation findings; an earlier attempt's corrections no longer apply.
      delete reworkDirectives(ctx)[id];
    }
    ctx.ledger.record('remediation_returned', { cycle: packet.cycle, findings: packet.findings });
    return graph;
  }
}
