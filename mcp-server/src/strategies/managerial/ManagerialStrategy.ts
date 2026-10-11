import type { EngineContext, RecoveryRequest, SwarmStrategy } from '../../engine/SwarmStrategy.js';
import { addNode, emptyGraph, readyNodes } from '../../engine/TaskGraph.js';
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
import { remediationNote } from '../../engine/remediationNote.js';
import { classifyRiskByPaths } from '../../engine/risk.js';
import type {
  Assignment,
  Decision,
  ReviewResult,
  TaskGraph,
  TaskNode,
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
import { runIntegrationBarrier, runOwnershipDeclaration, runVerificationBarrier } from '../barrierPipeline.js';
import {
  evidenceMandateUserPrompt,
  evidenceSchemaDescription,
  toEvidenceItems,
  evidenceMandateValidator,
  type WireEvidenceMandate,
} from '../evidenceMandate.js';
import {
  DISPOSITION_SYSTEM_PROMPT,
  IMPLEMENTER_SCHEMA_DESCRIPTION,
  IMPLEMENTER_SYSTEM_PROMPT,
  INTEGRATION_SYSTEM_PROMPT,
  PLANNER_SCHEMA_DESCRIPTION,
  PLANNER_SYSTEM_PROMPT,
  REVIEWER_SCHEMA_DESCRIPTION,
  REVIEWER_SYSTEM_PROMPT,
  TEST_MANDATE_SYSTEM_PROMPT,
  VERIFICATION_SYSTEM_PROMPT,
  buildDispositionUserPrompt,
  buildImplementerUserPrompt,
  buildIntegrationUserPrompt,
  buildPlannerUserPrompt,
  buildReviewerUserPrompt,
  buildVerificationUserPrompt,
  validateImplementerOutput,
  validatePlannerOutput,
  validateReviewerOutput,
  type ImplementerOutput,
  type PlannerOutput,
  type ReviewerOutput,
} from './prompts.js';
import {
  MANAGERIAL_ROSTER,
  deriveDomainTag,
  emptyMemberLoad,
  selectAlternativeAssignee,
  selectAssignee,
  type MemberLoad,
} from './roster.js';
import { IMPLEMENTER_TEMPERATURE } from '../implementerReminders.js';
import { MANAGERIAL_DEFAULTS } from '../../constitution/schema.js';

interface ManagerialConfig {
  securityPathGlobs: string[];
  crossModuleThreshold: number;
  maxReviewAttempts: number;
}

interface ManagerialStrategyState {
  memberLoads: Record<string, MemberLoad>;
  taskAssignees: Record<string, string>;
  retryAssignees: Record<string, string>;
  reworkDirectives: Record<string, string[]>;
}

export class ManagerialStrategy implements SwarmStrategy {
  readonly id = 'managerial' as const;

  async plan(ctx: EngineContext, task: TaskSpec): Promise<TaskGraph> {
    await this.recordTestMandate(ctx, task);
    const config = getConfig(ctx);

    try {
      const result = await ctx.dispatcher.dispatch<PlannerOutput>({
        role: 'planner',
        personaId: 'planner',
        systemPrompt: PLANNER_SYSTEM_PROMPT,
        userPrompt: buildPlannerUserPrompt(task),
        schemaDescription: PLANNER_SCHEMA_DESCRIPTION,
        validate: validatePlannerOutput,
        temperature: 0.2,
      });
      if (result.value.tasks.length === 0) throw new Error('Planner returned zero tasks');

      const graph = graphFromPlan(result.value, task, config);
      ctx.ledger.record('plan_source', {
        source: 'managerial-planner',
        nodeCount: graph.order.length,
        plannerPersonaId: 'planner',
        model: result.model,
        costUsd: result.costUsd,
      });
      return graph;
    } catch (error) {
      ctx.ledger.record('plan_fallback', { reason: String(error) });
      return fallbackGraph(task, config);
    }
  }

  async assign(ctx: EngineContext, graph: TaskGraph): Promise<Assignment[]> {
    const state = getState(ctx);
    const assignments: Assignment[] = [];

    for (const node of readyNodes(graph)) {
      const domainTag = deriveDomainTag(node.targetGlobs);
      const retryAssigneeId = state.retryAssignees[node.id];
      const retryAssignee = MANAGERIAL_ROSTER.find(
        (member) => member.id === retryAssigneeId && member.capabilities.includes(domainTag),
      );
      const assignee = retryAssignee ?? selectAssignee(domainTag, state.memberLoads);
      const load = state.memberLoads[assignee.id] ?? emptyMemberLoad();
      state.memberLoads[assignee.id] = { ...load, inFlight: load.inFlight + 1 };
      state.taskAssignees[node.id] = assignee.id;
      delete state.retryAssignees[node.id];

      assignments.push({
        taskId: node.id,
        assigneeId: assignee.id,
        role: 'implementer',
        meta: {
          domainTag,
          capabilities: [...assignee.capabilities],
          loadAtAssignment: load.inFlight + load.completed,
        },
      });
    }

    return assignments;
  }

  async execute(ctx: EngineContext, assignment: Assignment): Promise<WorkProduct> {
    const node = ctx.runState.graph?.nodes[assignment.taskId];
    if (!node) throw new Error(`Task "${assignment.taskId}" is not present in the active graph`);
    const state = getState(ctx);
    const reworkChanges = state.reworkDirectives[assignment.taskId] ?? [];

    const result = await ctx.dispatcher.dispatch<ImplementerOutput>({
      role: 'implementer',
      taskId: assignment.taskId,
      personaId: assignment.assigneeId,
      systemPrompt: IMPLEMENTER_SYSTEM_PROMPT,
      userPrompt: buildImplementerUserPrompt(ctx.runState.task.goal, node, reworkChanges),
      schemaDescription: IMPLEMENTER_SCHEMA_DESCRIPTION,
      validate: validateImplementerOutput,
      temperature: IMPLEMENTER_TEMPERATURE,
    });
    // The directive stays until approval (recordOutcome) or a newer one replaces it (recover,
    // remediate): an attempt that fails outside decide() — execution failure, ownership handoff —
    // records no new directive, and deleting on dispatch sent the next attempt in blind.

    ctx.ledger.record('work_executed', {
      taskId: assignment.taskId,
      personaId: assignment.assigneeId,
      assigneeId: assignment.assigneeId,
      fileOpCount: result.value.fileOps.length,
      riskClass: node.riskClass,
      model: result.model,
      costUsd: result.costUsd,
    });
    return {
      taskId: assignment.taskId,
      assignment,
      fileOps: result.value.fileOps,
      rationale: result.value.rationale,
      unresolvedUncertainty: result.value.unresolvedUncertainty || undefined,
      meta: { model: result.model, costUsd: result.costUsd },
    };
  }

  async review(ctx: EngineContext, product: WorkProduct, test: TestResult): Promise<ReviewResult> {
    const reviewerId = independentReviewerId(product);
    const userPrompt = buildReviewerUserPrompt(
      product,
      ctx.runState.graph?.nodes[product.taskId],
      test,
      getState(ctx).reworkDirectives[product.taskId] ?? [],
    );
    const verdict = (await ctx.dispatcher.dispatch<ReviewerOutput>({
      role: 'reviewer',
      personaId: reviewerId,
      scopeTaskId: product.taskId,
      systemPrompt: REVIEWER_SYSTEM_PROMPT,
      userPrompt,
      schemaDescription: REVIEWER_SCHEMA_DESCRIPTION,
      validate: validateReviewerOutput,
      temperature: 0.1,
    })).value;

    const finding = {
      reviewerId,
      verdict: verdict.verdict,
      rationale: verdict.rationale,
      evidenceRefs: verdict.evidenceRefs,
    };
    ctx.ledger.record('review_completed', { taskId: product.taskId, findings: [finding], test });
    return { taskId: product.taskId, findings: [finding], testResult: test };
  }

  async decide(ctx: EngineContext, product: WorkProduct, review: ReviewResult): Promise<Decision> {
    const test = review.testResult;
    const rejected = review.findings.filter((finding) => finding.verdict === 'reject');
    const flagged = review.findings.filter((finding) => finding.verdict === 'flag');
    const testFailed = test?.ran === true && !test.passed;
    const testMissing = test?.ran !== true;
    const evidenceRefs = review.findings.flatMap((finding) => finding.evidenceRefs ?? []);
    if (test?.command) evidenceRefs.push(test.command);

    if (rejected.length > 0 || testFailed || testMissing) {
      if (reviewAttemptLimitReached(ctx, product.taskId)) {
        // The findings and failing checks reach the next attempt through the engine's directive and
        // repair brief; listing them here as well put each one into the prompt twice.
        return {
          taskId: product.taskId,
          outcome: 'rejected',
          rationale: 'The normal verification gate failed again after the bounded retry allowance.',
          evidenceRefs: unique(evidenceRefs),
        };
      }
      const requiredChanges = buildRequiredChanges([...rejected, ...flagged], test);
      return {
        taskId: product.taskId,
        outcome: 'rework',
        rationale: `The normal verification gate requires another implementation attempt: ${requiredChanges.join('; ')}`,
        evidenceRefs: unique(evidenceRefs),
        // Check output reaches the implementer through the engine's repair brief.
        rework: { requiredChanges },
      };
    }

    if (flagged.length > 0) {
      return {
        taskId: product.taskId,
        outcome: 'needs_human',
        rationale: flagged.map((finding) => finding.rationale).join('; '),
        evidenceRefs: unique(evidenceRefs),
      };
    }

    const approved = review.findings.some((finding) => finding.verdict === 'approve');
    if (approved && test.passed) {
      return {
        taskId: product.taskId,
        outcome: 'approved',
        rationale: 'Configured verification passed and the independent reviewer approved the work.',
        evidenceRefs: unique(evidenceRefs),
      };
    }

    return {
      taskId: product.taskId,
      outcome: 'needs_human',
      rationale: 'Verification passed, but the independent review did not provide an actionable verdict.',
      evidenceRefs: unique(evidenceRefs),
    };
  }

  async recordOutcome(ctx: EngineContext, decision: Decision, test: TestResult): Promise<void> {
    const state = getState(ctx);
    if (decision.outcome === 'approved') delete state.reworkDirectives[decision.taskId];
    const assigneeId = state.taskAssignees[decision.taskId];
    if (assigneeId) {
      const load = state.memberLoads[assigneeId] ?? emptyMemberLoad();
      state.memberLoads[assigneeId] = {
        inFlight: Math.max(0, load.inFlight - 1),
        completed: load.completed + 1,
      };
    }

    ctx.ledger.record('outcome_recorded', {
      taskId: decision.taskId,
      assigneeId,
      outcome: decision.outcome,
      testRan: test.ran,
      testPassed: test.passed,
    });
  }

  requiresHumanApproval(_ctx: EngineContext, decision: Decision): boolean {
    return decision.outcome === 'needs_human';
  }

  async recover(ctx: EngineContext, request: RecoveryRequest): Promise<void> {
    const state = getState(ctx);
    const currentAssigneeId = request.product.assignment.assigneeId;
    const node = ctx.runState.graph?.nodes[request.product.taskId];
    const domainTag = deriveDomainTag(node?.targetGlobs ?? []);
    const alternative = request.repeated
      ? selectAlternativeAssignee(domainTag, currentAssigneeId, state.memberLoads)
      : undefined;
    const nextAssigneeId = alternative?.id ?? currentAssigneeId;
    // Reassignment is the manager's accountability move, not a different engineer in practice: the
    // dispatcher picks the model by role, and the persona id changes neither the model nor the prompt.

    state.retryAssignees[request.product.taskId] = nextAssigneeId;
    state.reworkDirectives[request.product.taskId] = [...request.decision.rework.requiredChanges];
    ctx.ledger.record('outcome_recorded', {
      taskId: request.product.taskId,
      outcome: 'recovery_prepared',
      testRan: request.test.ran,
      testPassed: request.test.passed,
      attemptNumber: request.attemptNumber,
      maxAttempts: request.maxAttempts,
      repeated: request.repeated,
      previousAssigneeId: currentAssigneeId,
      nextAssigneeId,
      requiredChanges: request.decision.rework.requiredChanges,
    });
  }

  async declareOwnership(ctx: EngineContext, graph: TaskGraph): Promise<OwnershipMap> {
    return runOwnershipDeclaration(ctx, graph, {
      interfacesFor: (entry) => [`capability:${deriveDomainTag(entry.paths)}`],
      overlapRationale: 'These tasks expect to modify the same path, so their changes must be sequenced and checked together.',
    });
  }

  async integrate(ctx: EngineContext, approvedTaskIds: string[], diffText: string): Promise<IntegrationResult> {
    return runIntegrationBarrier(ctx, approvedTaskIds, diffText, {
      integratorId: 'integration-reviewer',
      systemPrompt: INTEGRATION_SYSTEM_PROMPT,
      buildUserPrompt: buildIntegrationUserPrompt,
    });
  }

  async verifyDelivery(ctx: EngineContext, draft: DeliveryPacket): Promise<VerificationResult> {
    return runVerificationBarrier(ctx, draft, {
      verifierId: 'delivery-verifier',
      systemPrompt: VERIFICATION_SYSTEM_PROMPT,
      buildUserPrompt: buildVerificationUserPrompt,
    });
  }

  async disposeFindings(ctx: EngineContext, open: Finding[]): Promise<Finding[]> {
    if (open.length === 0) return [];

    const result = await ctx.dispatcher.dispatch<WireDispositionReport>({
      role: 'reviewer',
      personaId: 'finding-reviewer',
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
    const evidenceGaps = unevidencedCriteria(draft.requirementMatrix, draft.acceptanceCriteria);
    const reasons: string[] = [];
    if (failures.length > 0) reasons.push(`required checks failing: ${failures.map((failure) => failure.categoryId).join(', ')}`);
    if (evidenceGaps.length > 0) {
      reasons.push(`acceptance criteria without satisfying evidence: ${evidenceGaps.map((gap) => gap.criterion).join(', ')}`);
    }
    if (!draft.independentVerification.verified) {
      reasons.push(`independent verification not confirmed: ${draft.independentVerification.rationale}`);
    }

    return {
      accepted: reasons.length === 0,
      procedure: 'tests passing, all criteria evidenced, independent verification confirmed',
      rationale: reasons.length === 0 ? 'All mechanical delivery conditions passed.' : `Delivery blocked: ${reasons.join('; ')}.`,
      decidedAt: new Date().toISOString(),
    };
  }

  async remediate(ctx: EngineContext, packet: RemediationPacket): Promise<TaskGraph> {
    const graph = ctx.runState.graph;
    if (!graph) throw new Error('Cannot remediate without an active task graph');

    const namedTaskIds = new Set(packet.findings.flatMap((finding) => finding.affectedTaskIds ?? []));
    const targetIds = namedTaskIds.size > 0 ? [...namedTaskIds].filter((id) => graph.nodes[id]) : graph.order;
    const state = getState(ctx);

    for (const taskId of targetIds) {
      // Per task and with evidence: the summary says that a check failed, the evidence says why.
      // The implementer prompt renders remediationOf on every attempt until approval, so a failed
      // retry's directive no longer overwrites it; an earlier attempt's corrections are superseded.
      graph.nodes[taskId].phase = 'queued';
      graph.nodes[taskId].remediationOf = remediationNote(packet.findings, taskId) || 'Delivery review requested remediation.';
      delete state.reworkDirectives[taskId];
    }
    ctx.ledger.record('remediation_returned', {
      cycle: packet.cycle,
      taskIds: targetIds,
      findings: packet.findings.map((finding) => finding.summary),
    });
    return graph;
  }

  private async recordTestMandate(ctx: EngineContext, task: TaskSpec): Promise<void> {
    const categories = ctx.checks.categories;
    try {
      const result = await ctx.dispatcher.dispatch<WireEvidenceMandate>({
        role: 'reviewer',
        personaId: 'test-lead',
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
        note: `The test mandate could not be produced: ${String(error)}`,
      }));
    }

    ctx.ledger.record('test_mandate_recorded', {
      criteria: ctx.runState.evidence.length,
      mapped: ctx.runState.evidence.filter((item) => item.note?.startsWith('check:')).length,
      manual: ctx.runState.evidence.filter((item) => item.status === 'manual').length,
    });
  }
}

function getConfig(ctx: EngineContext): ManagerialConfig {
  const raw = ctx.config as {
    securityPathGlobs?: unknown;
    crossModuleThreshold?: unknown;
    maxReviewAttempts?: unknown;
    riskClassification?: { securityPathGlobs?: unknown; crossModuleThreshold?: unknown };
  };
  const securityPathGlobs = raw.riskClassification?.securityPathGlobs ?? raw.securityPathGlobs;
  const crossModuleThreshold = raw.riskClassification?.crossModuleThreshold ?? raw.crossModuleThreshold;

  return {
    securityPathGlobs: isStringArray(securityPathGlobs) ? securityPathGlobs : MANAGERIAL_DEFAULTS.riskClassification.securityPathGlobs,
    crossModuleThreshold: positiveInteger(crossModuleThreshold) ?? MANAGERIAL_DEFAULTS.riskClassification.crossModuleThreshold,
    maxReviewAttempts: positiveInteger(raw.maxReviewAttempts) ?? MANAGERIAL_DEFAULTS.maxReviewAttempts,
  };
}

function getState(ctx: EngineContext): ManagerialStrategyState {
  const state = ctx.strategyState as Partial<ManagerialStrategyState>;
  state.memberLoads ??= {};
  state.taskAssignees ??= {};
  state.retryAssignees ??= {};
  state.reworkDirectives ??= {};
  for (const member of MANAGERIAL_ROSTER) state.memberLoads[member.id] ??= emptyMemberLoad();
  return state as ManagerialStrategyState;
}

function graphFromPlan(output: PlannerOutput, task: TaskSpec, config: ManagerialConfig): TaskGraph {
  const graph = emptyGraph();
  const finalIds = deduplicateIds(output.tasks.map((plannedTask, index) => slugify(plannedTask.id) || `task-${index + 1}`));
  const firstFinalIdByRequestedId = new Map<string, string>();
  output.tasks.forEach((plannedTask, index) => {
    const requestedId = slugify(plannedTask.id);
    if (!firstFinalIdByRequestedId.has(requestedId)) firstFinalIdByRequestedId.set(requestedId, finalIds[index]);
  });
  const knownIds = new Set(finalIds);

  output.tasks.forEach((plannedTask, index) => {
    const id = finalIds[index];
    const targetGlobs = plannedTask.targetGlobs.length > 0 ? plannedTask.targetGlobs : ['**/*'];
    const dependsOn = unique(
      plannedTask.dependsOn
        .map((dependency) => firstFinalIdByRequestedId.get(slugify(dependency)) ?? slugify(dependency))
        .filter((dependencyId) => knownIds.has(dependencyId) && dependencyId !== id),
    );
    addNode(graph, {
      id,
      title: plannedTask.title,
      description: plannedTask.description,
      acceptanceCriteria:
        plannedTask.acceptanceCriteria.length > 0 ? plannedTask.acceptanceCriteria : task.acceptanceCriteria,
      dependsOn,
      targetGlobs,
      riskTags: unique(plannedTask.riskTags),
      riskClass: classifyRiskByPaths(targetGlobs, {
        securityPathGlobs: config.securityPathGlobs,
        crossModuleThreshold: config.crossModuleThreshold,
      }),
      phase: 'queued',
      attempts: [],
    });
  });
  return graph;
}

function fallbackGraph(task: TaskSpec, config: ManagerialConfig): TaskGraph {
  const graph = emptyGraph();
  const targetGlobs = ['**/*'];
  addNode(graph, {
    id: 'main',
    title: task.goal.slice(0, 80) || 'Complete the requested change',
    description: task.goal,
    acceptanceCriteria: task.acceptanceCriteria,
    dependsOn: [],
    targetGlobs,
    riskTags: [],
    riskClass: classifyRiskByPaths(targetGlobs, {
      securityPathGlobs: config.securityPathGlobs,
      crossModuleThreshold: config.crossModuleThreshold,
    }),
    phase: 'queued',
    attempts: [],
  });
  return graph;
}

function independentReviewerId(product: WorkProduct): string {
  const standardId = `reviewer-${product.taskId}`;
  return standardId === product.assignment.assigneeId ? `independent-${standardId}` : standardId;
}

function buildRequiredChanges(blocking: ReviewResult['findings'], test: TestResult | undefined): string[] {
  // The reviewer's evidenceRefs are where it located the defect; the rationale alone often is not.
  // Flags count too: alongside a failed gate they are concerns the next attempt must also address.
  const requiredChanges = blocking.map((finding) =>
    finding.evidenceRefs?.length ? `${finding.rationale} (evidence: ${finding.evidenceRefs.join(', ')})` : finding.rationale,
  );
  if (test?.ran && !test.passed) {
    const failedChecks = test.newFailures?.join(', ');
    requiredChanges.push(failedChecks ? `Fix failing verification checks: ${failedChecks}` : 'Make configured verification pass.');
  } else if (!test?.ran) {
    requiredChanges.push('Ensure configured verification runs and passes.');
  }
  return unique(requiredChanges.length > 0 ? requiredChanges : ['Address the failed review gate.']);
}

function reviewAttemptLimitReached(ctx: EngineContext, taskId: string): boolean {
  const attempts = ctx.runState.graph?.nodes[taskId]?.attempts ?? [];
  const latestAttempt = attempts.at(-1);
  const unsuccessfulAttempts = attempts.filter((attempt) => attempt.outcome === 'rework' || attempt.outcome === 'rejected').length;
  return latestAttempt?.repeated === true || unsuccessfulAttempts >= getConfig(ctx).maxReviewAttempts - 1;
}

function deduplicateIds(ids: string[]): string[] {
  const used = new Set<string>();
  return ids.map((baseId) => {
    let candidate = baseId;
    let suffix = 2;
    while (used.has(candidate)) {
      candidate = `${baseId}-${suffix}`;
      suffix += 1;
    }
    used.add(candidate);
    return candidate;
  });
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}
