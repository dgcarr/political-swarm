import { describe, expect, it, vi } from 'vitest';
import { emptyOwnershipMap, type DeliveryPacket, type Finding, type RemediationPacket } from '../../engine/packets.js';
import type { EngineContext, RecoveryRequest } from '../../engine/SwarmStrategy.js';
import type {
  Assignment,
  Decision,
  ReviewResult,
  TaskGraph,
  TaskNode,
  TestResult,
  WorkProduct,
} from '../../engine/types.js';
import type { DispatchOptions, WorkerDispatcher } from '../../engine/WorkerDispatcher.js';
import { normalizeChecksConfig } from '../../util/config.js';
import { ManagerialStrategy } from './ManagerialStrategy.js';

function dispatchResult<T>(value: T) {
  return { value, raw: JSON.stringify(value), model: 'test-model', costUsd: 0.01 };
}

function createDispatcher(responses: unknown[] = []): WorkerDispatcher {
  let index = 0;
  const dispatch = vi.fn(async (options: DispatchOptions) => {
    const value = responses[index];
    index += 1;
    options.validate(value);
    return dispatchResult(value);
  });
  return { dispatch } as unknown as WorkerDispatcher;
}

function node(id: string, path: string, overrides: Partial<TaskNode> = {}): TaskNode {
  return {
    id,
    title: `Task ${id}`,
    description: `Implement ${id}.`,
    acceptanceCriteria: [`${id} works`],
    dependsOn: [],
    targetGlobs: [path],
    riskTags: [],
    riskClass: 'low',
    phase: 'queued',
    attempts: [],
    ...overrides,
  };
}

function graph(nodes: TaskNode[] = [node('task-a', 'src/server.ts')]): TaskGraph {
  return {
    nodes: Object.fromEntries(nodes.map((taskNode) => [taskNode.id, taskNode])),
    order: nodes.map((taskNode) => taskNode.id),
  };
}

function createContext(
  dispatcher: WorkerDispatcher = createDispatcher(),
  taskGraph: TaskGraph = graph(),
  strategyState: Record<string, unknown> = {},
): EngineContext {
  return {
    dispatcher,
    worktree: {} as EngineContext['worktree'],
    ledger: { record: vi.fn() } as unknown as EngineContext['ledger'],
    knowledge: {} as EngineContext['knowledge'],
    budget: {} as EngineContext['budget'],
    config: {},
    checks: normalizeChecksConfig({
      categories: [{ id: 'unit', command: 'npm', args: ['test'], timeoutMs: 1_000, required: true }],
      testPathGlobs: ['**/*.test.ts'],
    }),
    runId: 'test-run',
    runState: {
      runId: 'test-run',
      strategy: 'managerial',
      task: { goal: 'Ship the feature', acceptanceCriteria: ['The feature works'] },
      repoPath: '/repo',
      baseBranch: 'main',
      worktreePath: '/worktree',
      branch: 'swarm/test-run',
      status: 'running',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      budgetUsd: 1,
      costUsd: 0,
      tokensUsed: { prompt: 0, completion: 0 },
      workerCalls: 0,
      graph: taskGraph,
      pendingApprovals: [],
    },
    strategyState,
    openApproval: vi.fn((approval) => ({
      ...approval,
      id: 'approval-1',
      createdAt: '2026-01-01T00:00:00.000Z',
    })),
    getApprovalResolution: vi.fn(),
    syncPacket: async () => ({
      runId: 'test-run',
      baseRevision: 'base',
      decisions: [],
      ownershipMap: emptyOwnershipMap(),
      changedFileManifest: [],
      evidence: [],
      openFindings: [],
      capturedAt: '2026-01-01T00:00:00.000Z',
    }),
    addFinding: vi.fn((finding) => ({ ...finding, id: finding.id ?? 'finding-1' })),
    findings: () => [],
  };
}

function assignment(taskId = 'task-a', assigneeId = 'application-engineer'): Assignment {
  return { taskId, assigneeId, role: 'implementer', meta: { domainTag: 'backend' } };
}

function product(taskId = 'task-a', assigneeId = 'application-engineer'): WorkProduct {
  return {
    taskId,
    assignment: assignment(taskId, assigneeId),
    fileOps: [{ op: 'write', path: 'src/server.ts', content: 'export const ready = true;\n' }],
    rationale: 'Implemented the requested behavior.',
  };
}

function testResult(overrides: Partial<TestResult> = {}): TestResult {
  return { ran: true, passed: true, command: 'npm test', ...overrides };
}

function reviewResult(
  verdict: 'approve' | 'reject' | 'flag',
  test: TestResult = testResult(),
  rationale = `${verdict} rationale`,
): ReviewResult {
  return {
    taskId: 'task-a',
    findings: [{ reviewerId: 'reviewer-task-a', verdict, rationale, evidenceRefs: ['src/server.ts'] }],
    testResult: test,
  };
}

function deliveryDraft(): DeliveryPacket {
  return {
    runId: 'test-run',
    strategy: 'managerial',
    baseRevision: 'base',
    branch: 'swarm/test-run',
    goal: 'Ship the feature',
    acceptanceCriteria: ['The feature works'],
    changedFiles: ['src/server.ts'],
    diffText: 'diff --git a/src/server.ts b/src/server.ts',
    requirementMatrix: [
      {
        criterion: 'The feature works',
        command: 'npm test',
        expectedResult: 'Tests pass',
        status: 'satisfied',
      },
    ],
    baseline: [],
    finalChecks: [
      {
        categoryId: 'unit',
        command: 'npm',
        args: ['test'],
        ran: true,
        passed: true,
      },
    ],
    decisions: [],
    findings: [],
    minorityReports: [],
    limitations: [],
    residualRisks: [],
    rollback: 'Revert the change.',
    integrationEvidence: {
      integratorId: 'integration-reviewer',
      integrated: true,
      postIntegrationChecks: [],
      findings: [],
      rationale: 'The combined change is coherent.',
    },
    independentVerification: {
      verifierId: 'delivery-verifier',
      verified: true,
      criteriaTraced: ['The feature works'],
      findings: [],
      rationale: 'The criterion is traced.',
    },
    doctrineAcceptance: {
      accepted: true,
      procedure: 'fixture',
      rationale: 'fixture',
      decidedAt: '2026-01-01T00:00:00.000Z',
    },
    assembledAt: '2026-01-01T00:00:00.000Z',
    remediationCycles: 0,
  };
}

describe('ManagerialStrategy planning and assignment', () => {
  it('builds a risk-classified task graph and records the evidence mandate through real dispatches', async () => {
    const evidence = {
      evidence: [
        { criterion: 'The feature works', checkCategoryId: 'unit', expectedResult: 'The unit suite passes' },
      ],
    };
    const plan = {
      tasks: [
        {
          id: 'Secure API',
          title: 'Secure the API',
          description: 'Update authentication handling.',
          acceptanceCriteria: ['The feature works'],
          dependsOn: [],
          targetGlobs: ['src/auth/session.ts'],
          riskTags: ['authentication'],
        },
      ],
    };
    const dispatcher = createDispatcher([evidence, plan]);
    const ctx = createContext(dispatcher);
    ctx.config = { riskClassification: { securityPathGlobs: ['src/auth/**'] } };

    const result = await new ManagerialStrategy().plan(ctx, {
      goal: 'Ship the feature',
      acceptanceCriteria: ['The feature works'],
      repoPath: '/repo',
      baseBranch: 'main',
    });

    expect(result.order).toEqual(['secure-api']);
    expect(result.nodes['secure-api']).toMatchObject({
      riskClass: 'high',
      riskTags: ['authentication'],
      phase: 'queued',
      attempts: [],
    });
    expect(ctx.runState.evidence).toEqual([
      expect.objectContaining({ criterion: 'The feature works', command: 'npm test', status: 'unavailable' }),
    ]);
    expect(dispatcher.dispatch).toHaveBeenNthCalledWith(1, expect.objectContaining({ role: 'reviewer', personaId: 'test-lead' }));
    expect(dispatcher.dispatch).toHaveBeenNthCalledWith(2, expect.objectContaining({ role: 'planner', personaId: 'planner' }));
  });

  it('falls back to one whole-goal task when the planner returns no tasks', async () => {
    const dispatcher = createDispatcher([{ evidence: [] }, { tasks: [] }]);
    const ctx = createContext(dispatcher);

    const result = await new ManagerialStrategy().plan(ctx, {
      goal: 'Make one coherent change',
      acceptanceCriteria: [],
      repoPath: '/repo',
      baseBranch: 'main',
    });

    expect(result.order).toEqual(['main']);
    expect(result.nodes.main).toMatchObject({ description: 'Make one coherent change', targetGlobs: ['**/*'] });
  });

  it('matches capabilities and uses live load to distribute work across the roster', async () => {
    const taskGraph = graph([
      node('docs', 'docs/guide.md'),
      node('tests', 'src/server.test.ts'),
      node('infra', '.github/workflows/ci.yml'),
      node('backend', 'src/server/api.ts'),
    ]);
    const ctx = createContext(createDispatcher(), taskGraph);

    const result = await new ManagerialStrategy().assign(ctx, taskGraph);

    expect(result.map(({ taskId, assigneeId }) => [taskId, assigneeId])).toEqual([
      ['docs', 'documentation-engineer'],
      ['tests', 'quality-engineer'],
      ['infra', 'platform-engineer'],
      ['backend', 'application-engineer'],
    ]);
    expect(new Set(result.map((item) => item.assigneeId))).toHaveLength(4);
    expect(result.every((item) => item.role === 'implementer')).toBe(true);
  });
});

describe('ManagerialStrategy task lifecycle', () => {
  it('executes an assignment with the assigned implementer and returns dispatcher file operations', async () => {
    const output = {
      fileOps: [{ op: 'edit' as const, path: 'src/server.ts', find: 'false', replace: 'true' }],
      rationale: 'Corrected the response.',
      unresolvedUncertainty: '',
    };
    const dispatcher = createDispatcher([output]);
    const ctx = createContext(dispatcher);

    const result = await new ManagerialStrategy().execute(ctx, assignment());

    expect(dispatcher.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'implementer', personaId: 'application-engineer' }),
    );
    expect(result.fileOps).toEqual(output.fileOps);
    expect(result.rationale).toBe(output.rationale);
  });

  it('uses an independent reviewer persona and preserves the test result', async () => {
    const dispatcher = createDispatcher([
      { verdict: 'approve', rationale: 'The implementation and evidence agree.', evidenceRefs: ['npm test'] },
    ]);
    const ctx = createContext(dispatcher);
    const work = product('task-a', 'reviewer-task-a');
    const test = testResult();

    const result = await new ManagerialStrategy().review(ctx, work, test);

    const call = vi.mocked(dispatcher.dispatch).mock.calls[0][0];
    expect(call.role).toBe('reviewer');
    expect(call.personaId).toBe('independent-reviewer-task-a');
    expect(call.personaId).not.toBe(work.assignment.assigneeId);
    expect(result.testResult).toBe(test);
    expect(result.findings[0].verdict).toBe('approve');
  });

  // The decide-then-explain fast path was removed (2026-10-04): it approved 0 of 61 real reviews.
  it('always has the chat reviewer write the verdict, even with decision models on', async () => {
    const dispatcher = createDispatcher([
      { verdict: 'approve', rationale: 'Meets every criterion.', evidenceRefs: [] },
    ]);
    const decide = vi.fn();
    Object.assign(dispatcher, { decidesFirst: () => true, decide });
    const result = await new ManagerialStrategy().review(createContext(dispatcher), product('task-a', 'reviewer-task-a'), testResult());
    expect(decide).not.toHaveBeenCalled();
    expect(result.findings[0]).toMatchObject({ verdict: 'approve', rationale: 'Meets every criterion.' });
  });

  it('approves only when tests pass and review approves', async () => {
    const decision = await new ManagerialStrategy().decide(createContext(), product(), reviewResult('approve'));
    expect(decision).toMatchObject({ outcome: 'approved', taskId: 'task-a' });
  });

  it('returns concrete rework for a failed test or reviewer rejection', async () => {
    const decision = await new ManagerialStrategy().decide(
      createContext(),
      product(),
      reviewResult('reject', testResult({ passed: false, newFailures: ['unit'] }), 'The error path is incomplete.'),
    );
    expect(decision.outcome).toBe('rework');
    if (decision.outcome !== 'rework') throw new Error('Expected rework');
    expect(decision.rework.requiredChanges).toEqual([
      'The error path is incomplete. (evidence: src/server.ts)',
      'Fix failing verification checks: unit',
    ]);
  });

  // The check output reaches the implementer through the engine's repair brief, not the directive.
  it('hands the next attempt the reviewer evidence but leaves check output to the repair brief', async () => {
    const output = `${'session header and source listing\n'.repeat(200)}E   ValueError: rate must be positive\nFAILED tests/test_rate.py::test_zero`;
    const decision = await new ManagerialStrategy().decide(
      createContext(),
      product(),
      reviewResult('reject', testResult({ passed: false, newFailures: ['unit'], output }), 'Zero rate is not rejected.'),
    );
    if (decision.outcome !== 'rework') throw new Error('Expected rework');
    const changes = decision.rework.requiredChanges.join('\n');
    expect(changes).toContain('Zero rate is not rejected. (evidence: src/server.ts)');
    expect(changes).not.toContain('ValueError');
    expect(decision.rationale).not.toContain('session header');
  });

  it('carries a flagged concern into the rework directive alongside a failed check', async () => {
    const decision = await new ManagerialStrategy().decide(
      createContext(),
      product(),
      reviewResult('flag', testResult({ passed: false, newFailures: ['unit'] }), 'The retry path may double-charge.'),
    );
    if (decision.outcome !== 'rework') throw new Error('Expected rework');
    expect(decision.rework.requiredChanges).toEqual([
      'The retry path may double-charge. (evidence: src/server.ts)',
      'Fix failing verification checks: unit',
    ]);
  });

  it('shows the reviewer the corrections the attempt under review was directed to make', async () => {
    const dispatcher = createDispatcher([{ verdict: 'approve', rationale: 'Corrected.', evidenceRefs: [] }]);
    const ctx = createContext(dispatcher, graph(), { reworkDirectives: { 'task-a': ['Reject a zero rate.'] } });
    await new ManagerialStrategy().review(ctx, product('task-a', 'application-engineer'), testResult());
    const prompt = vi.mocked(dispatcher.dispatch).mock.calls[0][0].userPrompt;
    expect(prompt).toContain('Corrections this attempt was directed to make');
    expect(prompt).toContain('- Reject a zero rate.');
  });

  it('keeps a rework directive until the task is approved, not just until it is dispatched', async () => {
    const output = { fileOps: [{ op: 'write' as const, path: 'src/server.ts', content: 'x' }], rationale: 'Retried.' };
    const dispatcher = createDispatcher([output, output]);
    const ctx = createContext(dispatcher, graph(), { reworkDirectives: { 'task-a': ['Reject a zero rate.'] } });
    const strategy = new ManagerialStrategy();

    // The first retry fails outside decide() (execution failure, ownership handoff), so nothing
    // replaces the directive before the task is dispatched again.
    await strategy.execute(ctx, assignment());
    await strategy.execute(ctx, assignment());
    expect(vi.mocked(dispatcher.dispatch).mock.calls[1][0].userPrompt).toContain('Reject a zero rate.');

    await strategy.recordOutcome(ctx, { taskId: 'task-a', outcome: 'approved', rationale: 'Passed.', evidenceRefs: [] }, testResult());
    expect((ctx.strategyState.reworkDirectives as Record<string, string[]>)['task-a']).toBeUndefined();
  });

  it('rejects a gate failure that follows an already repeated failure', async () => {
    const repeatedNode = node('task-a', 'src/server.ts', {
      attempts: [
        {
          attempt: 1,
          outcome: 'rework',
          rationale: 'Try again.',
          evidenceRefs: [],
          testsPassed: false,
          at: '2026-01-01T00:00:00.000Z',
          fingerprint: 'same',
          repeated: true,
        },
      ],
    });
    const ctx = createContext(createDispatcher(), graph([repeatedNode]));

    const decision = await new ManagerialStrategy().decide(
      ctx,
      product(),
      reviewResult('reject', testResult({ passed: false }), 'The same defect remains.'),
    );

    expect(decision).toMatchObject({ outcome: 'rejected', taskId: 'task-a' });
    // The engine turns the rejection into a directive and the repair brief carries the findings;
    // listing them in the rationale as well repeated each one in the next prompt.
    expect(decision.rationale).toBe('The normal verification gate failed again after the bounded retry allowance.');
  });

  it('requires human judgment for a flagged review when tests pass', async () => {
    const decision = await new ManagerialStrategy().decide(
      createContext(),
      product(),
      reviewResult('flag', testResult(), 'The migration risk needs an owner decision.'),
    );
    expect(decision).toMatchObject({ outcome: 'needs_human' });
  });

  it('records completed load and releases in-flight load', async () => {
    const strategyState = {
      memberLoads: { 'application-engineer': { inFlight: 1, completed: 2 } },
      taskAssignees: { 'task-a': 'application-engineer' },
    };
    const ctx = createContext(createDispatcher(), graph(), strategyState);
    const decision: Decision = {
      taskId: 'task-a',
      outcome: 'approved',
      rationale: 'Passed.',
      evidenceRefs: [],
    };

    await new ManagerialStrategy().recordOutcome(ctx, decision, testResult());

    expect((ctx.strategyState.memberLoads as Record<string, unknown>)['application-engineer']).toEqual({
      inFlight: 0,
      completed: 3,
    });
    expect(ctx.ledger.record).toHaveBeenCalledWith('outcome_recorded', expect.objectContaining({ outcome: 'approved' }));
  });

  it('requires approval exactly for needs_human decisions', () => {
    const strategy = new ManagerialStrategy();
    const ctx = createContext();
    const base = { taskId: 'task-a', rationale: 'Reason.', evidenceRefs: [] };
    expect(strategy.requiresHumanApproval(ctx, { ...base, outcome: 'needs_human' })).toBe(true);
    expect(strategy.requiresHumanApproval(ctx, { ...base, outcome: 'approved' })).toBe(false);
  });

  // The persona changes the accountable assignee only; the dispatcher picks the model by role.
  it('routes a repeated backend failure to a different capable engineer', async () => {
    const ctx = createContext();
    const strategy = new ManagerialStrategy();
    const reworkDecision: Extract<Decision, { outcome: 'rework' }> = {
      taskId: 'task-a',
      outcome: 'rework',
      rationale: 'Correct the defect.',
      evidenceRefs: [],
      rework: { requiredChanges: ['Handle the missing case.'] },
    };
    const request: RecoveryRequest = {
      product: product(),
      review: reviewResult('reject'),
      decision: reworkDecision,
      test: testResult({ passed: false }),
      attemptNumber: 2,
      maxAttempts: 3,
      repeated: true,
    };

    await strategy.recover(ctx, request);
    const retryAssignees = ctx.strategyState.retryAssignees as Record<string, string>;
    expect(retryAssignees['task-a']).toBe('quality-engineer');
    expect(retryAssignees['task-a']).not.toBe('application-engineer');
    expect((ctx.strategyState.reworkDirectives as Record<string, string[]>)['task-a']).toEqual([
      'Handle the missing case.',
    ]);
  });
});

describe('ManagerialStrategy delivery barriers', () => {
  it('declares domain capability interfaces and shared path overlaps', async () => {
    const taskGraph = graph([node('docs-a', 'docs/shared.md'), node('docs-b', 'docs/shared.md')]);
    const result = await new ManagerialStrategy().declareOwnership(createContext(), taskGraph);

    expect(result.entries['docs-a'].interfaces).toEqual(['capability:docs']);
    expect(result.entries['docs-b'].interfaces).toEqual(['capability:docs']);
    expect(result.declaredOverlaps).toEqual([
      expect.objectContaining({ taskIds: ['docs-a', 'docs-b'], path: 'docs/shared.md' }),
    ]);
  });

  it('integrates through the shared barrier with the neutral integration reviewer', async () => {
    const dispatcher = createDispatcher([{ integrated: true, rationale: 'The combined tree is coherent.', findings: [] }]);
    const ctx = createContext(dispatcher);

    const result = await new ManagerialStrategy().integrate(ctx, ['task-a'], 'diff text');

    expect(dispatcher.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'integrator', personaId: 'integration-reviewer' }),
    );
    expect(result).toMatchObject({ integratorId: 'integration-reviewer', integrated: true });
  });

  it('verifies through the shared barrier with a persona distinct from the integrator', async () => {
    const dispatcher = createDispatcher([
      { verified: true, rationale: 'Every criterion is traced.', criteriaTraced: ['The feature works'], findings: [] },
    ]);
    const ctx = createContext(dispatcher);

    const result = await new ManagerialStrategy().verifyDelivery(ctx, deliveryDraft());

    expect(dispatcher.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'verifier', personaId: 'delivery-verifier' }),
    );
    expect(result.verifierId).not.toBe('integration-reviewer');
    expect(result.verified).toBe(true);
  });

  it('returns immediately for an empty finding log and dispatches dispositions for open findings', async () => {
    const dispatcher = createDispatcher([
      {
        dispositions: [
          { id: 'finding-1', disposition: 'accepted', rationale: 'The defect will be corrected before delivery.' },
        ],
      },
    ]);
    const ctx = createContext(dispatcher);
    const strategy = new ManagerialStrategy();
    expect(await strategy.disposeFindings(ctx, [])).toEqual([]);
    expect(dispatcher.dispatch).not.toHaveBeenCalled();

    const open: Finding[] = [
      {
        id: 'finding-1',
        source: 'reviewer-task-a',
        taskId: 'task-a',
        summary: 'A boundary case is missing.',
        evidenceRefs: ['src/server.ts'],
        disposition: 'unresolved',
        dispositionRationale: 'Awaiting review.',
      },
    ];
    const result = await strategy.disposeFindings(ctx, open);

    expect(dispatcher.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'reviewer', personaId: 'finding-reviewer' }),
    );
    expect(result[0]).toMatchObject({ id: 'finding-1', disposition: 'accepted' });
  });

  it('accepts when checks pass, criteria are evidenced, and independent verification is confirmed', async () => {
    const result = await new ManagerialStrategy().accept(createContext(), deliveryDraft());
    expect(result).toMatchObject({
      accepted: true,
      procedure: 'tests passing, all criteria evidenced, independent verification confirmed',
    });
  });

  it('rejects a delivery solely for a blocking required check', async () => {
    const draft = deliveryDraft();
    draft.finalChecks[0].passed = false;
    const result = await new ManagerialStrategy().accept(createContext(), draft);
    expect(result.accepted).toBe(false);
    expect(result.rationale).toContain('required checks failing: unit');
    expect(result.rationale).not.toContain('acceptance criteria without satisfying evidence');
  });

  it('rejects a delivery solely for an unevidenced acceptance criterion', async () => {
    const draft = deliveryDraft();
    draft.requirementMatrix[0].status = 'unavailable';
    const result = await new ManagerialStrategy().accept(createContext(), draft);
    expect(result.accepted).toBe(false);
    expect(result.rationale).toContain('acceptance criteria without satisfying evidence: The feature works');
    expect(result.rationale).not.toContain('required checks failing');
  });

  it('rejects a delivery solely when independent verification is not confirmed', async () => {
    const draft = deliveryDraft();
    draft.independentVerification.verified = false;
    draft.independentVerification.rationale = 'A criterion could not be traced.';
    const result = await new ManagerialStrategy().accept(createContext(), draft);
    expect(result.accepted).toBe(false);
    expect(result.rationale).toContain('independent verification not confirmed: A criterion could not be traced.');
    expect(result.rationale).not.toContain('required checks failing');
  });

  it('reopens only task nodes named by remediation findings', async () => {
    const taskGraph = graph([
      node('task-a', 'src/a.ts', { phase: 'settled' }),
      node('task-b', 'src/b.ts', { phase: 'settled' }),
    ]);
    const ctx = createContext(createDispatcher(), taskGraph);
    const packet: RemediationPacket = {
      runId: 'test-run',
      submittedAt: '2026-01-01T00:00:00.000Z',
      findings: [
        { summary: 'Task B misses a boundary case.', evidence: 'src/b.ts', affectedTaskIds: ['task-b'], severity: 'high' },
      ],
      preservedDelivery: deliveryDraft(),
      cycle: 1,
    };

    const result = await new ManagerialStrategy().remediate(ctx, packet);

    expect(result.nodes['task-a'].phase).toBe('settled');
    expect(result.nodes['task-a'].remediationOf).toBeUndefined();
    expect(result.nodes['task-b'].phase).toBe('queued');
    expect(result.nodes['task-b'].remediationOf).toContain('Task B misses a boundary case.');
  });

  it('gives each reopened task the evidence of its own remediation findings', async () => {
    const taskGraph = graph([
      node('task-a', 'src/a.ts', { phase: 'settled' }),
      node('task-b', 'src/b.ts', { phase: 'settled' }),
    ]);
    const ctx = createContext(createDispatcher(), taskGraph);
    const packet: RemediationPacket = {
      runId: 'test-run',
      submittedAt: '2026-01-01T00:00:00.000Z',
      findings: [
        { summary: 'Required final check unit failed.', evidence: 'E   AssertionError: 3 != 4', affectedTaskIds: ['task-b'], severity: 'high' },
        { summary: 'Task A logs secrets.', evidence: 'src/a.ts:10', affectedTaskIds: ['task-a'], severity: 'medium' },
      ],
      preservedDelivery: deliveryDraft(),
      cycle: 1,
    };

    const result = await new ManagerialStrategy().remediate(ctx, packet);

    const noteB = result.nodes['task-b'].remediationOf ?? '';
    expect(noteB).toContain('E   AssertionError: 3 != 4');
    expect(noteB).not.toContain('Task A logs secrets.');
    expect(result.nodes['task-a'].remediationOf).toContain('src/a.ts:10');
  });

  it('keeps the remediation finding in every implementer prompt until the task is approved', async () => {
    const output = { fileOps: [{ op: 'write' as const, path: 'src/b.ts', content: 'x' }], rationale: 'Fixed.' };
    const dispatcher = createDispatcher([output, output]);
    const taskGraph = graph([node('task-b', 'src/b.ts', { phase: 'settled' })]);
    const ctx = createContext(dispatcher, taskGraph, { reworkDirectives: { 'task-b': ['An earlier correction.'] } });
    const strategy = new ManagerialStrategy();
    await strategy.remediate(ctx, {
      runId: 'test-run',
      submittedAt: '2026-01-01T00:00:00.000Z',
      findings: [{ summary: 'Task B misses a boundary case.', evidence: 'src/b.ts', affectedTaskIds: ['task-b'], severity: 'high' }],
      preservedDelivery: deliveryDraft(),
      cycle: 1,
    });
    expect((ctx.strategyState.reworkDirectives as Record<string, string[]>)['task-b']).toBeUndefined();

    await strategy.execute(ctx, assignment('task-b'));
    // A failed retry's directive replaces the previous directive, but not the remediation finding.
    await strategy.recover(ctx, {
      product: product('task-b'),
      review: reviewResult('reject'),
      decision: { taskId: 'task-b', outcome: 'rework', rationale: 'Again.', evidenceRefs: [], rework: { requiredChanges: ['Handle empty input.'] } },
      test: testResult({ passed: false }),
      attemptNumber: 1,
      maxAttempts: 3,
      repeated: false,
    });
    await strategy.execute(ctx, assignment('task-b'));

    const prompts = vi.mocked(dispatcher.dispatch).mock.calls.map((call) => call[0].userPrompt);
    for (const prompt of prompts) expect(prompt).toContain('Remediation required by delivery review: ');
    expect(prompts[0]).not.toContain('An earlier correction.');
    expect(prompts[1]).toContain('- Handle empty input.');
    expect(prompts[1].match(/Task B misses a boundary case\./g)).toHaveLength(1);
  });
});
