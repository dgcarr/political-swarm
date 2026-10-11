import { describe, expect, it, vi } from 'vitest';
import { emptyOwnershipMap, type DeliveryPacket } from '../engine/packets.js';
import type { EngineContext } from '../engine/SwarmStrategy.js';
import type { TaskGraph } from '../engine/types.js';
import type { DispatchOptions, WorkerDispatcher } from '../engine/WorkerDispatcher.js';
import { normalizeChecksConfig } from '../util/config.js';
import {
  integrationSchemaDescription,
  renderCheckSummary,
  truncateDiff,
  validateIntegrationReport,
  validateVerificationReport,
  verificationSchemaDescription,
} from './barriers.js';
import {
  runIntegrationBarrier,
  runOwnershipDeclaration,
  runVerificationBarrier,
} from './barrierPipeline.js';

function graph(): TaskGraph {
  return {
    nodes: {
      'task-a': {
        id: 'task-a',
        title: 'Build the API',
        description: 'Build the API.',
        acceptanceCriteria: ['The API works'],
        dependsOn: [],
        targetGlobs: ['src/shared.ts', 'src/api.ts'],
        riskTags: [],
        riskClass: 'low',
        phase: 'queued',
        attempts: [],
      },
      'task-b': {
        id: 'task-b',
        title: 'Build the client',
        description: 'Build the client.',
        acceptanceCriteria: ['The client works'],
        dependsOn: ['task-a'],
        targetGlobs: ['src/shared.ts', 'src/client.ts'],
        riskTags: [],
        riskClass: 'low',
        phase: 'queued',
        attempts: [],
      },
      'task-c': {
        id: 'task-c',
        title: 'Write documentation',
        description: 'Write documentation.',
        acceptanceCriteria: ['The documentation is current'],
        dependsOn: [],
        targetGlobs: ['docs/guide.md'],
        riskTags: [],
        riskClass: 'low',
        phase: 'queued',
        attempts: [],
      },
    },
    order: ['task-a', 'task-b', 'task-c'],
  };
}

function dispatchResult<T>(value: T) {
  return { value, raw: JSON.stringify(value), model: 'fake-model', costUsd: 0 };
}

function createDispatcher(value: unknown): WorkerDispatcher {
  const dispatch = vi.fn(async (options: DispatchOptions) => {
    options.validate(value);
    return dispatchResult(value);
  });
  return { dispatch } as unknown as WorkerDispatcher;
}

function createContext(
  dispatcher: WorkerDispatcher = createDispatcher({}),
  strategyState: Record<string, unknown> = {},
): EngineContext {
  const taskGraph = graph();
  return {
    dispatcher,
    worktree: {} as EngineContext['worktree'],
    ledger: {} as EngineContext['ledger'],
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
      strategy: 'democratic',
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
      baseRevision: 'test-base',
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

function deliveryDraft(): DeliveryPacket {
  return {
    runId: 'test-run',
    strategy: 'democratic',
    baseRevision: 'test-base',
    branch: 'swarm/test-run',
    goal: 'Ship the feature',
    acceptanceCriteria: ['The feature works'],
    changedFiles: ['src/shared.ts'],
    diffText: 'diff --git a/src/shared.ts b/src/shared.ts',
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
      integratorId: 'integrator',
      integrated: true,
      postIntegrationChecks: [],
      findings: [],
      rationale: 'The combined tree works.',
    },
    independentVerification: {
      verifierId: 'verifier',
      verified: true,
      criteriaTraced: ['The feature works'],
      findings: [],
      rationale: 'The evidence supports the criterion.',
    },
    doctrineAcceptance: {
      accepted: true,
      procedure: 'test fixture',
      rationale: 'Accepted for testing.',
      decidedAt: '2026-01-01T00:00:00.000Z',
    },
    assembledAt: '2026-01-01T00:00:00.000Z',
    remediationCycles: 0,
  };
}

describe('runOwnershipDeclaration', () => {
  it('assigns supplied interfaces and declares only shared paths', async () => {
    const ctx = createContext();
    const taskGraph = graph();
    const interfacesFor = vi.fn((entry: { taskId: string }) => [`surface:${entry.taskId}`]);

    const result = await runOwnershipDeclaration(ctx, taskGraph, {
      interfacesFor,
      overlapRationale: 'Shared surface declared by the caller.',
    });

    expect(result.entries['task-a'].interfaces).toEqual(['surface:task-a']);
    expect(result.entries['task-b'].interfaces).toEqual(['surface:task-b']);
    expect(result.entries['task-c'].interfaces).toEqual(['surface:task-c']);
    expect(interfacesFor).toHaveBeenCalledTimes(3);
    expect(interfacesFor).toHaveBeenCalledWith(result.entries['task-a'], taskGraph);
    expect(result.declaredOverlaps).toEqual([
      {
        taskIds: ['task-a', 'task-b'],
        path: 'src/shared.ts',
        rationale: 'Shared surface declared by the caller.',
      },
    ]);
    expect(result.declaredOverlaps).not.toContainEqual(expect.objectContaining({ path: 'docs/guide.md' }));
  });
});

describe('runIntegrationBarrier', () => {
  it('dispatches the shared integration contract and assembles engine findings', async () => {
    const wireResult = {
      integrated: false,
      rationale: 'The combined tree has a defect.',
      findings: [{ summary: 'The API and client disagree', severity: 'high' as const, evidence: 'src/shared.ts' }],
    };
    const dispatcher = createDispatcher(wireResult);
    const ctx = createContext(dispatcher);
    const buildUserPrompt = vi.fn(
      (goal: string, acceptanceCriteria: string[], titles: string[], truncatedDiff: string) =>
        [goal, ...acceptanceCriteria, ...titles, truncatedDiff].join('\n'),
    );
    const diffText = 'x'.repeat(12_001);
    const expectedUserPrompt = buildUserPrompt(
      ctx.runState.task.goal,
      ctx.runState.task.acceptanceCriteria,
      ['Build the API', 'missing-task'],
      truncateDiff(diffText),
    );
    buildUserPrompt.mockClear();

    const result = await runIntegrationBarrier(ctx, ['task-a', 'missing-task'], diffText, {
      integratorId: 'test-integrator',
      systemPrompt: 'Integration system prompt',
      buildUserPrompt,
    });

    expect(buildUserPrompt).toHaveBeenCalledWith(
      'Ship the feature',
      ['The feature works'],
      ['Build the API', 'missing-task'],
      truncateDiff(diffText),
    );
    expect(dispatcher.dispatch).toHaveBeenCalledWith({
      role: 'integrator',
      personaId: 'test-integrator',
      systemPrompt: 'Integration system prompt',
      userPrompt: expectedUserPrompt,
      schemaDescription: integrationSchemaDescription,
      validate: validateIntegrationReport,
      temperature: 0.2,
    });
    expect(result).toEqual({
      integratorId: 'test-integrator',
      integrated: false,
      postIntegrationChecks: [],
      findings: [
        {
          source: 'test-integrator',
          summary: '[high] The API and client disagree',
          evidenceRefs: ['src/shared.ts'],
          disposition: 'unresolved',
          dispositionRationale: 'Raised at a barrier; awaiting disposition.',
        },
      ],
      rationale: 'The combined tree has a defect.',
    });
  });
});

describe('runVerificationBarrier', () => {
  it('dispatches the shared verification contract without mutating strategy state', async () => {
    const wireResult = {
      verified: true,
      rationale: 'The criterion is traced.',
      criteriaTraced: ['The feature works'],
      findings: [{ summary: 'Evidence is narrow', severity: 'low' as const, evidence: 'npm test' }],
    };
    const dispatcher = createDispatcher(wireResult);
    const strategyState = { marker: 'unchanged' };
    const ctx = createContext(dispatcher, strategyState);
    const draft = deliveryDraft();
    const buildUserPrompt = vi.fn(
      (
        goal: string,
        acceptanceCriteria: string[],
        requirementMatrix: DeliveryPacket['requirementMatrix'],
        checkSummary: string,
        truncatedDiff: string,
      ) => [goal, ...acceptanceCriteria, requirementMatrix.length, checkSummary, truncatedDiff].join('\n'),
    );
    const expectedUserPrompt = buildUserPrompt(
      draft.goal,
      draft.acceptanceCriteria,
      draft.requirementMatrix,
      renderCheckSummary(draft.finalChecks, ctx.checks),
      truncateDiff(draft.diffText),
    );
    buildUserPrompt.mockClear();

    const result = await runVerificationBarrier(ctx, draft, {
      verifierId: 'test-verifier',
      systemPrompt: 'Verification system prompt',
      buildUserPrompt,
    });

    expect(buildUserPrompt).toHaveBeenCalledWith(
      draft.goal,
      draft.acceptanceCriteria,
      draft.requirementMatrix,
      renderCheckSummary(draft.finalChecks, ctx.checks),
      truncateDiff(draft.diffText),
    );
    expect(dispatcher.dispatch).toHaveBeenCalledWith({
      role: 'verifier',
      personaId: 'test-verifier',
      systemPrompt: 'Verification system prompt',
      userPrompt: expectedUserPrompt,
      schemaDescription: verificationSchemaDescription,
      validate: validateVerificationReport,
      temperature: 0.2,
    });
    expect(result).toEqual({
      verifierId: 'test-verifier',
      verified: true,
      criteriaTraced: ['The feature works'],
      findings: [
        {
          source: 'test-verifier',
          summary: '[low] Evidence is narrow',
          evidenceRefs: ['npm test'],
          disposition: 'unresolved',
          dispositionRationale: 'Raised at a barrier; awaiting disposition.',
        },
      ],
      rationale: 'The criterion is traced.',
    });
    expect(ctx.strategyState).toEqual({ marker: 'unchanged' });
    expect(ctx.strategyState).toBe(strategyState);
  });

  describe('when the verifier passes but omits a criterion', () => {
    const criteria = ['Tests pass', 'Outputs are not authored files'];
    const draftWith = (): DeliveryPacket => ({ ...deliveryDraft(), acceptanceCriteria: criteria });
    const report = (verified: boolean, criteriaTraced: string[]) =>
      ({ verified, rationale: 'Checked.', criteriaTraced, findings: [] });
    const sequenced = (...answers: unknown[]) => {
      const dispatch = vi.fn(async (options: DispatchOptions) => {
        const value = answers.shift();
        options.validate(value);
        return dispatchResult(value);
      });
      return { dispatch } as unknown as WorkerDispatcher;
    };
    const contextWithLedger = (dispatcher: WorkerDispatcher) => {
      const record = vi.fn();
      return { ctx: { ...createContext(dispatcher), ledger: { record } as unknown as EngineContext['ledger'] }, record };
    };
    const options = { verifierId: 'test-verifier', systemPrompt: 'Verify.', buildUserPrompt: () => 'Evidence.' };

    it('asks once about the omitted criterion and traces it when the verifier can', async () => {
      const dispatcher = sequenced(report(true, ['Tests pass']), report(true, ['outputs are  NOT authored files']));
      const { ctx, record } = contextWithLedger(dispatcher);

      const result = await runVerificationBarrier(ctx, draftWith(), options);

      expect(result.criteriaTraced).toEqual(criteria);
      expect(dispatcher.dispatch).toHaveBeenCalledTimes(2);
      const followUpPrompt = vi.mocked(dispatcher.dispatch).mock.calls[1]![0].userPrompt;
      expect(followUpPrompt).toContain('Evidence.');
      expect(followUpPrompt).toContain('- Outputs are not authored files');
      expect(followUpPrompt).not.toContain('- Tests pass');
      expect(record).toHaveBeenCalledWith('verification_follow_up',
        { verifierId: 'test-verifier', omitted: 1, recovered: 1 });
    });

    it('leaves a criterion untraced when the follow-up still cannot trace it', async () => {
      const dispatcher = sequenced(report(true, ['Tests pass']), report(true, []));
      const { ctx } = contextWithLedger(dispatcher);

      const result = await runVerificationBarrier(ctx, draftWith(), options);

      expect(result.criteriaTraced).toEqual(['Tests pass']);
    });

    it('does not let the follow-up trace a criterion that was never omitted or invented', async () => {
      const dispatcher = sequenced(report(true, ['Tests pass']), report(true, ['Something else entirely']));
      const { ctx } = contextWithLedger(dispatcher);

      expect((await runVerificationBarrier(ctx, draftWith(), options)).criteriaTraced).toEqual(['Tests pass']);
    });

    it('asks nothing more of a verifier that refused the delivery', async () => {
      const dispatcher = sequenced(report(false, ['Tests pass']));
      const { ctx } = contextWithLedger(dispatcher);

      const result = await runVerificationBarrier(ctx, draftWith(), options);

      expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
      expect(result.verified).toBe(false);
      expect(result.criteriaTraced).toEqual(['Tests pass']);
    });
  });
});
