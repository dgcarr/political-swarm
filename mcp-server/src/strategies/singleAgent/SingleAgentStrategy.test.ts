import { describe, expect, it, vi } from 'vitest';
import { emptyOwnershipMap, type DeliveryPacket, type Finding, type RemediationPacket } from '../../engine/packets.js';
import type { EngineContext, RecoveryRequest } from '../../engine/SwarmStrategy.js';
import type { Decision, TaskGraph, TestResult, WorkProduct } from '../../engine/types.js';
import type { DispatchOptions, WorkerDispatcher } from '../../engine/WorkerDispatcher.js';
import { normalizeChecksConfig } from '../../util/config.js';
import {
  INTEGRATION_PASS_ID,
  SELF_REVIEW_ID,
  SingleAgentStrategy,
  VERIFICATION_PASS_ID,
} from './SingleAgentStrategy.js';

function dispatchResult<T>(value: T) {
  return { value, raw: JSON.stringify(value), model: 'fake-model', costUsd: 0 };
}

function createDispatcher(...values: unknown[]): WorkerDispatcher {
  const queue = [...values];
  return {
    dispatch: vi.fn(async (options: DispatchOptions) => {
      const value = queue.shift();
      options.validate(value);
      return dispatchResult(value);
    }),
  } as unknown as WorkerDispatcher;
}

function graph(): TaskGraph {
  return {
    nodes: {
      implementation: {
        id: 'implementation',
        title: 'Implement the feature',
        description: 'Build the requested feature.',
        acceptanceCriteria: ['The feature works'],
        dependsOn: [],
        targetGlobs: ['src/feature.ts'],
        riskTags: [],
        riskClass: 'low',
        phase: 'queued',
        attempts: [],
      },
      docs: {
        id: 'docs',
        title: 'Document the feature',
        description: 'Update the guide.',
        acceptanceCriteria: ['The guide is current'],
        dependsOn: ['implementation'],
        targetGlobs: ['docs/guide.md'],
        riskTags: [],
        riskClass: 'low',
        phase: 'settled',
        attempts: [],
      },
    },
    order: ['implementation', 'docs'],
  };
}

function context(dispatcher: WorkerDispatcher = createDispatcher(), taskGraph: TaskGraph = graph()): EngineContext {
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
    runId: 'run-1',
    runState: {
      runId: 'run-1',
      strategy: 'single_agent',
      task: { goal: 'Ship the feature', acceptanceCriteria: ['The feature works'] },
      repoPath: '/repo',
      baseBranch: 'main',
      worktreePath: '/worktree',
      branch: 'swarm/run-1',
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
    strategyState: {},
    openApproval: vi.fn((approval) => ({ ...approval, id: 'approval-1', createdAt: '2026-01-01T00:00:00.000Z' })),
    getApprovalResolution: vi.fn(),
    syncPacket: async () => ({
      runId: 'run-1',
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

const passingTest: TestResult = { ran: true, passed: true, command: 'npm test' };

function product(): WorkProduct {
  return {
    taskId: 'implementation',
    assignment: { taskId: 'implementation', assigneeId: 'the-agent', role: 'implementer' },
    fileOps: [{ op: 'write', path: 'src/feature.ts', content: 'export const feature = true;\n' }],
    rationale: 'Implemented the feature.',
  };
}

function deliveryDraft(): DeliveryPacket {
  return {
    runId: 'run-1',
    strategy: 'single_agent',
    baseRevision: 'base',
    branch: 'swarm/run-1',
    goal: 'Ship the feature',
    acceptanceCriteria: ['The feature works'],
    changedFiles: ['src/feature.ts'],
    diffText: 'diff --git a/src/feature.ts b/src/feature.ts',
    requirementMatrix: [
      {
        criterion: 'The feature works',
        command: 'npm test',
        expectedResult: 'Tests pass',
        status: 'satisfied',
      },
    ],
    baseline: [],
    finalChecks: [{ categoryId: 'unit', command: 'npm', args: ['test'], ran: true, passed: true }],
    decisions: [],
    findings: [],
    minorityReports: [],
    limitations: [],
    residualRisks: [],
    rollback: 'Revert the change.',
    integrationEvidence: {
      integratorId: INTEGRATION_PASS_ID,
      integrated: true,
      postIntegrationChecks: [],
      findings: [],
      rationale: 'The diff is coherent.',
    },
    independentVerification: {
      verifierId: VERIFICATION_PASS_ID,
      verified: true,
      criteriaTraced: ['The feature works'],
      findings: [],
      rationale: 'The criterion is supported.',
    },
    doctrineAcceptance: {
      accepted: false,
      procedure: 'pending',
      rationale: 'Pending.',
      decidedAt: '2026-01-01T00:00:00.000Z',
    },
    assembledAt: '2026-01-01T00:00:00.000Z',
    remediationCycles: 0,
  };
}

function finding(): Finding {
  return {
    id: 'finding-1',
    source: SELF_REVIEW_ID,
    summary: 'A minor issue needs tracking.',
    evidenceRefs: ['src/feature.ts'],
    disposition: 'unresolved',
    dispositionRationale: 'Awaiting disposition.',
  };
}

describe('SingleAgentStrategy', () => {
  it('plans a small graph and records a real evidence mandate', async () => {
    const dispatcher = createDispatcher(
      {
        evidence: [
          { criterion: 'The feature works', checkCategoryId: 'unit', expectedResult: 'The tests pass.' },
        ],
      },
      {
        tasks: [
          {
            id: 'implementation',
            title: 'Implement the feature',
            description: 'Build it.',
            acceptanceCriteria: ['The feature works'],
            targetGlobs: ['src/feature.ts'],
            dependsOn: [],
          },
        ],
      },
    );
    const ctx = context(dispatcher);

    const result = await new SingleAgentStrategy().plan(ctx, {
      goal: 'Ship the feature',
      acceptanceCriteria: ['The feature works'],
      repoPath: '/repo',
      baseBranch: 'main',
    });

    expect(result.order).toEqual(['implementation']);
    expect(result.nodes.implementation.phase).toBe('queued');
    expect(ctx.runState.evidence).toEqual([
      expect.objectContaining({ criterion: 'The feature works', command: 'npm test', note: 'check:unit' }),
    ]);
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(dispatcher.dispatch).mock.calls.map(([options]) => options.role)).toEqual(['reviewer', 'planner']);
  });

  it('assigns every queued node to the same fixed agent', async () => {
    const assignments = await new SingleAgentStrategy().assign(context(), graph());
    expect(assignments).toEqual([{ taskId: 'implementation', assigneeId: 'the-agent', role: 'implementer' }]);
  });

  it('dispatches implementation and returns file operations', async () => {
    const dispatcher = createDispatcher({
      fileOps: [{ op: 'write', path: 'src/feature.ts', content: 'export const feature = true;\n' }],
      rationale: 'Implemented the feature.',
    });
    const result = await new SingleAgentStrategy().execute(context(dispatcher), product().assignment);

    expect(result.fileOps).toEqual(product().fileOps);
    expect(dispatcher.dispatch).toHaveBeenCalledWith(expect.objectContaining({ role: 'implementer', personaId: 'the-agent' }));
  });

  it('performs dispatcher-backed self-review using the actual changes and test result', async () => {
    const dispatcher = createDispatcher({
      verdict: 'reject',
      rationale: 'The implementation misses an edge case.',
      evidenceRefs: ['src/feature.ts'],
      requiredChanges: ['Handle the edge case.'],
      requiresHumanJudgment: false,
    });
    const result = await new SingleAgentStrategy().review(context(dispatcher), product(), passingTest);

    expect(result.findings).toEqual([
      expect.objectContaining({ reviewerId: SELF_REVIEW_ID, verdict: 'reject', rationale: expect.stringContaining('edge case') }),
    ]);
    const options = vi.mocked(dispatcher.dispatch).mock.calls[0][0];
    expect(options.userPrompt).toContain('src/feature.ts');
    expect(options.userPrompt).toContain('"passed":true');
  });

  it.each([
    ['approval', passingTest, 'approve', false, 'approved'],
    ['failed test', { ran: true, passed: false }, 'approve', false, 'rework'],
    ['rejected review', passingTest, 'reject', false, 'rework'],
    ['ordinary flag', passingTest, 'flag', false, 'rework'],
    ['human-only flag', passingTest, 'flag', true, 'needs_human'],
  ] as const)('maps %s mechanically to %s', async (_label, test, verdict, requiresHumanJudgment, expected) => {
    const review = {
      taskId: 'implementation',
      findings: [{ reviewerId: SELF_REVIEW_ID, verdict, rationale: 'Review rationale.' }],
      testResult: test,
      meta: { requiredChanges: ['Fix it.'], requiresHumanJudgment },
    };
    const decision = await new SingleAgentStrategy().decide(context(), product(), review);
    expect(decision.outcome).toBe(expected);
  });

  it('rejects a repeated failure instead of requesting unbounded rework', async () => {
    const ctx = context();
    ctx.runState.graph!.nodes.implementation.attempts.push({
      attempt: 1,
      outcome: 'rework',
      rationale: 'First failure.',
      evidenceRefs: [],
      at: '2026-01-01T00:00:00.000Z',
      fingerprint: 'one',
      repeated: false,
    });
    const decision = await new SingleAgentStrategy().decide(ctx, product(), {
      taskId: 'implementation',
      findings: [{ reviewerId: SELF_REVIEW_ID, verdict: 'reject', rationale: 'Still broken.' }],
      testResult: { ran: true, passed: false },
    });
    expect(decision.outcome).toBe('rejected');
  });

  function priorAttempt(attempt: number, outcome: Decision['outcome'], transient = false) {
    return {
      attempt,
      outcome,
      rationale: `Attempt ${attempt}.`,
      evidenceRefs: [],
      at: '2026-01-01T00:00:00.000Z',
      fingerprint: String(attempt),
      repeated: false,
      ...(transient ? { transient: true } : {}),
    };
  }

  const rejectingReview = {
    taskId: 'implementation',
    findings: [{ reviewerId: SELF_REVIEW_ID, verdict: 'reject' as const, rationale: 'Still broken.' }],
    testResult: { ran: true, passed: false },
  };

  it('does not spend the retry on provider failures or on an earlier, approved round', async () => {
    const ctx = context();
    ctx.runState.graph!.nodes.implementation.attempts.push(
      priorAttempt(1, 'rework'),
      priorAttempt(2, 'approved'),
      priorAttempt(3, 'rework', true),
    );
    const decision = await new SingleAgentStrategy().decide(ctx, product(), rejectingReview);
    expect(decision.outcome).toBe('rework');
  });

  it('gives a task reopened by remediation its own retry', async () => {
    const taskGraph = graph();
    taskGraph.nodes.implementation.phase = 'abandoned';
    taskGraph.nodes.implementation.attempts.push(priorAttempt(1, 'rework'), priorAttempt(2, 'rejected'));
    const ctx = context(createDispatcher(), taskGraph);
    const strategy = new SingleAgentStrategy();
    await strategy.remediate(ctx, {
      runId: 'run-1',
      submittedAt: '2026-01-01T00:00:00.000Z',
      findings: [{ summary: 'Edge case missing.', evidence: 'src/feature.ts', affectedTaskIds: ['implementation'], severity: 'high' }],
      preservedDelivery: deliveryDraft(),
      cycle: 1,
    });
    expect((await strategy.decide(ctx, product(), rejectingReview)).outcome).toBe('rework');

    taskGraph.nodes.implementation.attempts.push(priorAttempt(3, 'rework'));
    expect((await strategy.decide(ctx, product(), rejectingReview)).outcome).toBe('rejected');
  });

  it('explains a failed test by the failure, not by the self-review that approved it', async () => {
    const review = {
      taskId: 'implementation',
      findings: [{ reviewerId: SELF_REVIEW_ID, verdict: 'approve' as const, rationale: 'Satisfies all criteria.' }],
      testResult: { ran: true, passed: false },
    };
    const first = await new SingleAgentStrategy().decide(context(), product(), review);
    expect(first.rationale).toBe('The tests did not pass.');
    if (first.outcome !== 'rework') throw new Error('Expected rework');
    expect(first.rework.requiredChanges.join('\n')).not.toContain('Satisfies all criteria.');

    const ctx = context();
    ctx.runState.graph!.nodes.implementation.attempts.push(priorAttempt(1, 'rework'));
    const second = await new SingleAgentStrategy().decide(ctx, product(), review);
    expect(second).toMatchObject({ outcome: 'rejected', rationale: 'The bounded retry also failed: the tests did not pass.' });
  });

  // The engine's repair brief already shows the implementer the self-review's findings and its
  // requiredChanges; the directive repeating them put each into the prompt twice.
  it('leaves the self-review rationale and requested changes to the repair brief', async () => {
    const decision = await new SingleAgentStrategy().decide(context(), product(), {
      ...rejectingReview,
      meta: { requiredChanges: ['Handle the empty list.'], requiresHumanJudgment: false },
    });
    if (decision.outcome !== 'rework') throw new Error('Expected rework');
    expect(decision.rationale).toBe('Still broken.');
    expect(decision.rework.requiredChanges).toEqual(['The self-review rejected this attempt; resolve its findings.']);
  });

  // The output itself reaches the implementer through the engine's repair brief.
  it('names the failing check in a failed-test rework directive', async () => {
    const output = `${'collected 3 items\n'.repeat(400)}E   ValueError: empty input\nFAILED tests/test_feature.py::test_empty`;
    const decision = await new SingleAgentStrategy().decide(context(), product(), {
      taskId: 'implementation',
      findings: [{ reviewerId: SELF_REVIEW_ID, verdict: 'approve', rationale: 'Looks right.' }],
      testResult: { ran: true, passed: false, newFailures: ['unit'], output, checks: [{ categoryId: 'unit', status: 'new', output }] },
      meta: { requiredChanges: [], requiresHumanJudgment: false },
    });
    expect(decision.outcome).toBe('rework');
    const changes = decision.outcome === 'rework' ? decision.rework.requiredChanges : [];
    expect(changes).toContain('Failing check: unit (passed before this change)');
  });

  it('carries the rework directive into the next implementer prompt and drops it once approved', async () => {
    const implemented = {
      fileOps: [{ op: 'write', path: 'src/feature.ts', content: 'export const feature = true;\n' }],
      rationale: 'Implemented the feature.',
    };
    const dispatcher = createDispatcher(implemented, implemented);
    const ctx = context(dispatcher);
    const strategy = new SingleAgentStrategy();
    const failing: TestResult = { ran: true, passed: false, newFailures: ['unit'], output: 'E   ValueError: empty input' };
    await strategy.recover(ctx, {
      product: product(),
      review: { taskId: 'implementation', findings: [], testResult: failing },
      decision: {
        taskId: 'implementation',
        outcome: 'rework',
        rationale: 'Empty input crashes.',
        evidenceRefs: [],
        rework: { requiredChanges: ['Handle empty input.', 'Check output:\nE   ValueError: empty input'] },
      },
      test: failing,
      attemptNumber: 1,
      maxAttempts: 3,
      repeated: false,
    });

    await strategy.execute(ctx, product().assignment);
    const retryPrompt = vi.mocked(dispatcher.dispatch).mock.calls[0][0].userPrompt;
    expect(retryPrompt).toContain('Handle empty input.');
    expect(retryPrompt).toContain('E   ValueError: empty input');

    await strategy.recordOutcome(ctx, {
      taskId: 'implementation',
      outcome: 'approved',
      rationale: 'Fixed.',
      evidenceRefs: [],
    }, passingTest);
    await strategy.execute(ctx, product().assignment);
    expect(vi.mocked(dispatcher.dispatch).mock.calls[1][0].userPrompt).not.toContain('Handle empty input.');
  });

  it('records outcomes, detects human approval, and logs recovery without reassignment', async () => {
    const ctx = context();
    const strategy = new SingleAgentStrategy();
    const humanDecision: Decision = {
      taskId: 'implementation',
      outcome: 'needs_human',
      rationale: 'Human judgment required.',
      evidenceRefs: [],
    };
    await strategy.recordOutcome(ctx, humanDecision, passingTest);
    expect(strategy.requiresHumanApproval(ctx, humanDecision)).toBe(true);
    expect(strategy.requiresHumanApproval(ctx, { ...humanDecision, outcome: 'approved' })).toBe(false);

    const reworkDecision: Extract<Decision, { outcome: 'rework' }> = {
      taskId: 'implementation',
      outcome: 'rework',
      rationale: 'Fix it.',
      evidenceRefs: [],
      rework: { requiredChanges: ['Fix it.'] },
    };
    const request: RecoveryRequest = {
      product: product(),
      review: { taskId: 'implementation', findings: [], testResult: passingTest },
      decision: reworkDecision,
      test: passingTest,
      attemptNumber: 1,
      maxAttempts: 2,
      repeated: false,
    };
    await strategy.recover(ctx, request);
    expect(ctx.ledger.record).toHaveBeenCalledWith('remediation_returned', expect.objectContaining({
      cycle: 1,
      findings: ['Fix it.'],
    }));
  });

  it('declares ownership without invented interfaces', async () => {
    const ownership = await new SingleAgentStrategy().declareOwnership(context(), graph());
    expect(ownership.entries.implementation.interfaces).toEqual([]);
    expect(ownership.entries.docs.interfaces).toEqual([]);
  });

  it('uses distinct self-review, integration, and verification persona ids', async () => {
    const dispatcher = createDispatcher(
      {
        verdict: 'approve',
        rationale: 'The change meets the criterion.',
        evidenceRefs: ['npm test'],
        requiredChanges: [],
        requiresHumanJudgment: false,
      },
      { integrated: true, rationale: 'The diff is coherent.', findings: [] },
      { verified: true, rationale: 'The evidence supports delivery.', criteriaTraced: ['The feature works'], findings: [] },
    );
    const ctx = context(dispatcher);
    const strategy = new SingleAgentStrategy();
    await strategy.review(ctx, product(), passingTest);
    await strategy.integrate(ctx, ['implementation'], 'diff');
    await strategy.verifyDelivery(ctx, deliveryDraft());

    const personas = vi.mocked(dispatcher.dispatch).mock.calls.map(([options]) => options.personaId);
    expect(personas).toEqual([SELF_REVIEW_ID, INTEGRATION_PASS_ID, VERIFICATION_PASS_ID]);
    expect(new Set(personas).size).toBe(3);
  });

  it('disposes every finding through a real reviewer dispatch and skips dispatch for an empty list', async () => {
    const dispatcher = createDispatcher({
      dispositions: [
        { id: 'finding-1', disposition: 'accepted', rationale: 'The issue is real and recorded.' },
      ],
    });
    const ctx = context(dispatcher);
    const strategy = new SingleAgentStrategy();
    const disposed = await strategy.disposeFindings(ctx, [finding()]);
    expect(disposed[0].disposition).toBe('accepted');
    expect(dispatcher.dispatch).toHaveBeenCalledWith(expect.objectContaining({ role: 'reviewer', personaId: 'disposition-pass' }));

    const emptyDispatcher = createDispatcher();
    expect(await strategy.disposeFindings(context(emptyDispatcher), [])).toEqual([]);
    expect(emptyDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('accepts only when checks, evidence, and verification all succeed', async () => {
    const result = await new SingleAgentStrategy().accept(context(), deliveryDraft());
    expect(result.accepted).toBe(true);
  });

  it('refuses acceptance for a required check failure with the failing category in its rationale', async () => {
    const draft = deliveryDraft();
    draft.finalChecks[0].passed = false;
    const result = await new SingleAgentStrategy().accept(context(), draft);
    expect(result).toEqual(expect.objectContaining({ accepted: false, rationale: expect.stringContaining('unit') }));
  });

  it('refuses acceptance for an unevidenced criterion with the criterion in its rationale', async () => {
    const draft = deliveryDraft();
    draft.requirementMatrix[0].status = 'unavailable';
    const result = await new SingleAgentStrategy().accept(context(), draft);
    expect(result).toEqual(expect.objectContaining({ accepted: false, rationale: expect.stringContaining('The feature works') }));
  });

  it('refuses acceptance when verification fails with a specific rationale', async () => {
    const draft = deliveryDraft();
    draft.independentVerification.verified = false;
    const result = await new SingleAgentStrategy().accept(context(), draft);
    expect(result).toEqual(expect.objectContaining({ accepted: false, rationale: expect.stringContaining('verification pass') }));
  });

  it('reopens affected tasks for remediation and records the finding', async () => {
    const ctx = context();
    const draft = deliveryDraft();
    const packet: RemediationPacket = {
      runId: 'run-1',
      submittedAt: '2026-01-01T00:00:00.000Z',
      cycle: 1,
      preservedDelivery: draft,
      findings: [
        {
          summary: 'The implementation misses an edge case.',
          evidence: 'src/feature.ts',
          affectedTaskIds: ['implementation'],
          severity: 'medium',
        },
      ],
    };
    const remediated = await new SingleAgentStrategy().remediate(ctx, packet);
    expect(remediated.nodes.implementation).toEqual(expect.objectContaining({
      phase: 'queued',
      remediationOf: expect.stringContaining('The implementation misses an edge case.'),
    }));
    expect(remediated.nodes.docs.phase).toBe('settled');
  });

  it('gives each reopened task its own findings with their evidence', async () => {
    const ctx = context();
    const packet: RemediationPacket = {
      runId: 'run-1',
      submittedAt: '2026-01-01T00:00:00.000Z',
      cycle: 1,
      preservedDelivery: deliveryDraft(),
      findings: [
        {
          summary: 'Required final check unit failed.',
          evidence: 'E   AssertionError: feature() returned None',
          affectedTaskIds: ['implementation'],
          severity: 'high',
        },
        {
          summary: 'The guide omits the new flag.',
          evidence: 'docs/guide.md has no --feature entry',
          affectedTaskIds: ['docs'],
          severity: 'low',
        },
      ],
    };
    const remediated = await new SingleAgentStrategy().remediate(ctx, packet);
    expect(remediated.nodes.implementation.remediationOf).toContain('E   AssertionError: feature() returned None');
    expect(remediated.nodes.implementation.remediationOf).not.toContain('The guide omits the new flag.');
    expect(remediated.nodes.docs.remediationOf).toContain('docs/guide.md has no --feature entry');
  });
});
