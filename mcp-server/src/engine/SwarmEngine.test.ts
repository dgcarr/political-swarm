import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenRouterClient } from './OpenRouterClient.js';
import { BudgetExceededError, BudgetGuard } from './BudgetGuard.js';
import { GovernanceHaltError, recordGovernanceDecision } from './governance.js';
import {
  approvalDecisionContext,
  fallbackContextPaths,
  MAX_TRAILING_TRANSIENT_ATTEMPTS,
  abandonedTaskEvidence,
  barrierSeverity,
  checkCommandPaths,
  keepsTestsForOwners,
  preserveExhaustedNodes,
  reconcileAcceptanceFloorFindings,
  refusalForeignOwnerIds,
  regressionFloorDecision,
  waitsOn,
  restoreAttemptCeilings,
  signOffCheckContext,
  SwarmEngine,
  withoutCheckOutput,
  type EngineDeps,
} from './SwarmEngine.js';
import type { RunState } from './RunStore.js';
import type { EngineContext, SwarmStrategy } from './SwarmStrategy.js';
import type { CheckRunRecord, EvidenceItem, Finding, RemediationFinding } from './packets.js';
import type {
  Assignment,
  Decision,
  FileOp,
  ReviewResult,
  TaskGraph,
  TaskNode,
  TaskSpec,
  TestResult,
  WorkProduct,
} from './types.js';
import { allApproved, latestVerdict, readyNodes } from './TaskGraph.js';
import { normalizeChecksConfig } from '../util/config.js';
import { constitutionFor } from '../constitution/articles.js';
import { verifyRun } from './verifyRun.js';
import {
  stubAccept,
  stubDeclareOwnership,
  stubDisposeFindings,
  stubIntegrate,
  stubRemediate,
  stubVerifyDelivery,
} from './barrierStubs.js';

type FakeStrategyOptions = {
  graph?: TaskGraph;
  plan?: (ctx: EngineContext, task: TaskSpec) => Promise<TaskGraph>;
  assign?: (ctx: EngineContext, graph: TaskGraph) => Promise<Assignment[]>;
  execute?: (ctx: EngineContext, assignment: Assignment) => Promise<WorkProduct>;
  decide?: (ctx: EngineContext, product: WorkProduct, review: ReviewResult) => Promise<Decision>;
  recordOutcome?: (ctx: EngineContext, decision: Decision, test: TestResult) => Promise<void>;
  recover?: NonNullable<SwarmStrategy['recover']>;
  requiresHumanApproval?: (ctx: EngineContext, decision: Decision) => boolean;
  evidence?: EvidenceItem[];
  integrate?: SwarmStrategy['integrate'];
  accept?: SwarmStrategy['accept'];
  remediate?: SwarmStrategy['remediate'];
  disposeFindings?: SwarmStrategy['disposeFindings'];
};

describe('fallbackContextPaths', () => {
  it('includes the task and all transitive dependency files', () => {
    const state = {
      graph: {
        order: ['foundation', 'service', 'tests'],
        nodes: {
          foundation: { dependsOn: [] },
          service: { dependsOn: ['foundation'] },
          tests: { dependsOn: ['service'] },
        },
      },
      ownership: {
        entries: {
          foundation: { paths: ['src/foundation.ts'], interfaces: [], generated: [], tests: [] },
          service: { paths: ['src/service.ts'], interfaces: ['src/types.ts'], generated: [], tests: [] },
          tests: { paths: ['tests/service.test.ts'], interfaces: [], generated: [], tests: [] },
        },
      },
    } as unknown as RunState;

    expect(fallbackContextPaths(state, 'tests')).toEqual([
      'tests/service.test.ts',
      'src/service.ts',
      'src/types.ts',
      'src/foundation.ts',
    ]);
  });
});

describe('reconcileAcceptanceFloorFindings', () => {
  const finding = (overrides: Partial<Finding>): Finding => ({
    id: 'finding-1',
    source: 'engine:evidence',
    summary: 'Acceptance criterion has no satisfying evidence: "CLI works"',
    evidenceRefs: [],
    disposition: 'unresolved',
    dispositionRationale: 'Awaiting repair.',
    nonWaivable: true,
    ...overrides,
  });

  it('closes a stale engine finding when fresh evidence satisfies its exact criterion', () => {
    const result = reconcileAcceptanceFloorFindings([finding({})], [], []);

    expect(result.findings[0]).toMatchObject({
      disposition: 'accepted',
      nonWaivable: true,
    });
    expect(result.missingCriteria).toEqual([]);
  });

  it('keeps one active blocker and closes duplicate findings from earlier cycles', () => {
    const gap: EvidenceItem = {
      criterion: 'CLI works',
      command: 'python -m app',
      expectedResult: 'exit 0',
      status: 'unsatisfied',
    };
    const result = reconcileAcceptanceFloorFindings([
      finding({ id: 'old-1' }),
      finding({ id: 'old-2' }),
    ], [gap], []);

    expect(result.findings.map((item) => item.disposition)).toEqual(['unresolved', 'accepted']);
    expect(result.findings[0].evidenceRefs).toEqual(['criterion:CLI works']);
    expect(result.missingCriteria).toEqual([]);
  });

  it('reactivates the same check finding if a repaired check regresses again', () => {
    const check: CheckRunRecord = {
      categoryId: 'benchmark-cli',
      command: 'python',
      args: ['-m', 'app'],
      ran: true,
      passed: false,
    };
    const result = reconcileAcceptanceFloorFindings([
      finding({
        source: 'engine:checks',
        summary: 'Required check "benchmark-cli" fails on the integrated tree.',
        evidenceRefs: ['benchmark-cli'],
        disposition: 'accepted',
      }),
    ], [], [check]);

    expect(result.findings[0].disposition).toBe('unresolved');
    expect(result.missingChecks).toEqual([]);
  });
});

describe('regressionFloorDecision', () => {
  /**
   * Regression: a real v25 socialist run repeated a bare "Restore the previously passing required
   * checks: unit" directive across 5 straight attempts on the same task with no progress, because
   * `testResult.output` — the actual pytest assertion text — was computed but never included in
   * the forced-rework directive, unlike a doctrine's own native rework path.
   */
  const approvedDecision: Decision = { taskId: 't1', outcome: 'approved', rationale: 'looks fine', evidenceRefs: [] };

  it('leaves the doctrine\'s decision untouched when no regression was introduced', () => {
    const result = regressionFloorDecision('t1', approvedDecision, { ran: true, passed: true, introducedRegression: false });
    expect(result).toBe(approvedDecision);
  });

  // The output reaches the implementer through the repair brief, clipped; the directive names the checks.
  it('overrides approval into rework naming the failing checks without pasting their output', () => {
    const testResult = {
      ran: true,
      passed: false,
      introducedRegression: true,
      newFailures: ['unit'],
      output: '[unit]\nAssertionError: sigma_total does not match expected NaN propagation at E=25 MeV',
    };
    const result = regressionFloorDecision('t1', approvedDecision, testResult);

    assert.equal(result.outcome, 'rework');
    assert.equal(result.taskId, 't1');
    assert.deepEqual(result.evidenceRefs, ['unit']);
    assert.equal((result as Extract<Decision, { outcome: 'rework' }>).meta?.doctrineDecision, approvedDecision);
    const requiredChanges = (result as Extract<Decision, { outcome: 'rework' }>).rework.requiredChanges;
    assert.match(requiredChanges.join('\n'), /Make these required checks pass; they fail with this change: unit/);
    assert.doesNotMatch(requiredChanges.join('\n'), /sigma_total does not match expected NaN propagation/);
  });

  it('overrides a needs_human verdict the same way', () => {
    const needsHuman: Decision = { taskId: 't1', outcome: 'needs_human', rationale: 'unsure', evidenceRefs: [] };
    const result = regressionFloorDecision('t1', needsHuman, {
      ran: true,
      passed: false,
      introducedRegression: true,
      newFailures: ['unit'],
      output: 'boom',
    });
    assert.equal(result.outcome, 'rework');
  });

  it('does not override a rejected or already-rework decision', () => {
    const rejected: Decision = { taskId: 't1', outcome: 'rejected', rationale: 'no', evidenceRefs: [] };
    const result = regressionFloorDecision('t1', rejected, { ran: true, passed: false, introducedRegression: true, newFailures: ['unit'] });
    assert.equal(result, rejected);
  });
});

describe('refusalForeignOwnerIds', () => {
  it('identifies a defect in another task-owned file without treating the current task as foreign', () => {
    const state = {
      ownership: {
        entries: {
          tests: { taskId: 'tests', paths: ['tests/test_suite.py'], interfaces: [], generated: [], tests: [] },
          nuclear: {
            taskId: 'nuclear',
            paths: ['alloydamage/nuclear_data.py'],
            interfaces: [],
            generated: [],
            tests: [],
          },
        },
      },
    } as unknown as RunState;

    expect(refusalForeignOwnerIds(
      state,
      'tests',
      'tests/test_suite.py cannot import because alloydamage/nuclear_data.py has an IndentationError',
    )).toEqual(['nuclear']);
  });

  it('ignores unrelated paths that appear only in appended independent-check output', () => {
    const state = {
      ownership: {
        entries: {
          nuclear: { taskId: 'nuclear', paths: ['alloydamage/nuclear_data.py'], interfaces: [], generated: [], tests: [] },
          composition: {
            taskId: 'composition',
            paths: ['tests/test_composition.py'],
            interfaces: [],
            generated: [],
            tests: [],
          },
        },
      },
    } as unknown as RunState;
    const description = 'Reviewer found alloydamage/nuclear_data.py parses provenance incorrectly.\n' +
      'Independent check output:\ntests/test_composition.py .. [40%]';

    expect(refusalForeignOwnerIds(
      state,
      'nuclear',
      approvalDecisionContext(description),
    )).toEqual([]);

    // democratic-mus4a0px: a rationale quoting its own pytest session, ahead of the appended output.
    const quoted = 'Task "tests" needs human sign-off: tests failed: ' +
      '=========== test session starts ===========\ntests/test_composition.py ...... [ 25%]\n' +
      '=========== 1 failed, 6 passed in 0.40s ===========\nIndependent check output:\nrest';
    expect(refusalForeignOwnerIds(state, 'nuclear', approvalDecisionContext(quoted))).toEqual([]);
  });

  // From democratic-muqvvqtl-b333c0: the sovereign quoted the CLI acceptance command, and every
  // cli.py defect was handed to docs-example because it owns the example YAML that command reads.
  it('does not treat an input of a configured check command as defect ownership', () => {
    const state = {
      ownership: {
        entries: {
          'cli-plot': { taskId: 'cli-plot', paths: ['alloydamage/cli.py'], interfaces: [], generated: [], tests: [] },
          'docs-example': {
            taskId: 'docs-example',
            paths: ['README.md', 'examples/304L.yaml'],
            interfaces: [],
            generated: [],
            tests: [],
          },
        },
      },
    } as unknown as RunState;
    const refusal = 'In alloydamage/cli.py, _calculate calls load_yaml without importing it. ' +
      "'python -m alloydamage calculate examples/304L.yaml' will therefore stop with a NameError.";
    const ignore = checkCommandPaths([{ args: ['-m', 'alloydamage', 'calculate', 'examples/304L.yaml'] }]);

    expect(refusalForeignOwnerIds(state, 'cli-plot', refusal)).toEqual(['docs-example']);
    expect(refusalForeignOwnerIds(state, 'cli-plot', refusal, ignore)).toEqual([]);
  });
});

describe('checkCommandPaths', () => {
  it('keeps command arguments and drops flags', () => {
    expect(checkCommandPaths([
      { args: ['-m', 'pytest'] },
      { args: ['-m', 'alloydamage', 'calculate', 'examples/304L.yaml'] },
    ])).toEqual(['pytest', 'alloydamage', 'calculate', 'examples/304L.yaml']);
  });
});

describe('barrierSeverity', () => {
  it('splits the severity prefix a barrier puts on a finding', () => {
    expect(barrierSeverity('[low] Interpolation is centralized in damage.py and not duplicated.')).toEqual({
      severity: 'low',
      summary: 'Interpolation is centralized in damage.py and not duplicated.',
    });
    expect(barrierSeverity('[medium] CSV units disagree.')).toEqual({ severity: 'medium', summary: 'CSV units disagree.' });
  });

  it('treats an unprefixed summary as high', () => {
    expect(barrierSeverity('cli.py crashes')).toEqual({ severity: 'high', summary: 'cli.py crashes' });
  });
});

describe('withoutCheckOutput', () => {
  it('drops appended check output but keeps the evaluator decision after it', () => {
    const refusal = 'Task needs sign-off: core.py is wrong.\nIndependent check output:\ntests/test_x.py .. [40%]\n' +
      'Evaluator decision: damage.py clamps energies.';
    expect(withoutCheckOutput(refusal)).toBe(
      'Task needs sign-off: core.py is wrong.\nEvaluator decision: damage.py clamps energies.',
    );
  });

  it('drops a pytest session quoted inside a rationale, keeping what follows it', () => {
    const rationale = 'Contract failed settlement (reviewer verdict: reject; tests failed: ' +
      '============================= test session starts ==============================\n' +
      'tests/test_composition.py ......   [ 25%]\ntests/test_damage.py ..F..F..F   [ 62%]\n' +
      '\n…[2000 chars omitted]…\n' +
      '========================= 3 failed, 21 passed in 1.23s =========================). damage.py ignores the grid.';
    expect(withoutCheckOutput(rationale)).toBe(
      'Contract failed settlement (reviewer verdict: reject; tests failed: [check output omitted]). damage.py ignores the grid.',
    );
  });
});

describe('ordinary review ownership handoff', () => {
  it('does not treat a run-wide command path in reviewer prose as defect ownership evidence', async () => {
    let executions = 0;
    const strategy = new FakeStrategy({
      graph: graphFor(['package', 'documentation']),
      execute: async (_ctx, assignment) => {
        executions += assignment.taskId === 'package' ? 1 : 0;
        return productFor(assignment);
      },
      decide: async (_ctx, product) => {
        if (product.taskId !== 'package' || executions > 1) return decisionFor(product.taskId, 'approved');
        return {
          taskId: product.taskId,
          outcome: 'rework',
          rationale: 'The command using documentation.txt does not yet produce the final result.',
          evidenceRefs: ['package.txt'],
          rework: { requiredChanges: ['Complete this narrow package task.'] },
        };
      },
      recover: async () => undefined,
    });
    const engine = createEngine(strategy);

    const started = await start(engine);
    const state = await waitForStatus(engine, started.runId, 'awaiting_acceptance');

    expect(executions).toBe(2);
    expect(state.graph?.nodes.package.blockedByForeignTaskIds).toBeUndefined();
    expect(state.graphRemediationCycles).toBe(0);
  });
});

describe('remediation attempt ceilings', () => {
  it('restores an approved exhausted node that persisted as queued during interruption', () => {
    const graph = graphFor(['tests']);
    graph.nodes.tests.attempts = Array.from({ length: 3 }, (_, index) => ({
      outcome: 'approved' as const,
      rationale: 'passed',
      evidenceRefs: [],
      at: new Date(index).toISOString(),
      attempt: index + 1,
      fingerprint: `approved-${index}`,
      repeated: false,
    }));
    graph.nodes.tests.phase = 'queued';

    restoreAttemptCeilings(graph, 3);

    expect(graph.nodes.tests.phase).toBe('settled');
  });

  it('does not let remediation reopen a node whose attempt allowance is exhausted', () => {
    const previous = graphFor(['tests', 'implementation']);
    previous.nodes.tests.attempts = Array.from({ length: 2 }, (_, index) => ({
      outcome: 'approved' as const,
      rationale: 'passed',
      evidenceRefs: [],
      at: new Date(index).toISOString(),
      attempt: index + 1,
      fingerprint: `approved-${index}`,
      repeated: false,
    }));
    previous.nodes.tests.phase = 'settled';
    const remediated = structuredClone(previous);
    remediated.nodes.tests.phase = 'queued';
    remediated.nodes.implementation.phase = 'queued';

    preserveExhaustedNodes(previous, remediated, 2);

    expect(remediated.nodes.tests.phase).toBe('settled');
    expect(remediated.nodes.implementation.phase).toBe('queued');
  });

  it('marks every node one remediation reopens with the same round, whatever its own note says', () => {
    const previous = graphFor(['tests', 'implementation', 'docs']);
    for (const node of Object.values(previous.nodes)) node.phase = 'settled';
    const remediated = structuredClone(previous);
    remediated.nodes.tests.phase = 'queued';
    remediated.nodes.tests.remediationOf = '1. [high] tests fail on DATA_DIR';
    remediated.nodes.implementation.phase = 'queued';
    remediated.nodes.implementation.remediationOf = '1. [high] DATA_DIR points at the package';

    preserveExhaustedNodes(previous, remediated, 3, 'graph:1');

    expect(remediated.nodes.tests.remediationRound).toBe('graph:1');
    expect(remediated.nodes.implementation.remediationRound).toBe('graph:1');
    expect(remediated.nodes.docs.remediationRound).toBeUndefined();
  });
});

describe('preserveExhaustedNodes released dependents', () => {
  const failedAttempts = (count: number) => Array.from({ length: count }, (_, index) => ({
    outcome: 'rework' as const, rationale: 'imports a module that is not in the tree', evidenceRefs: [],
    at: new Date(index).toISOString(), attempt: index + 1, fingerprint: `f-${index}`, repeated: false,
  }));

  it('reopens an exhausted node released past a dependency that remediation brings back', () => {
    const previous = graphFor(['core', 'tests', 'docs']);
    previous.nodes.core.phase = 'abandoned';
    previous.nodes.tests.dependsOn = ['core'];
    previous.nodes.tests.abandonedDependencies = ['core'];
    previous.nodes.tests.attempts = failedAttempts(3);
    previous.nodes.tests.phase = 'abandoned';
    previous.nodes.docs.dependsOn = ['core'];
    previous.nodes.docs.abandonedDependencies = ['core'];
    previous.nodes.docs.attempts = [{ ...failedAttempts(1)[0], outcome: 'approved' as const }];
    previous.nodes.docs.phase = 'settled';
    const remediated = structuredClone(previous);
    remediated.nodes.core.phase = 'queued';
    remediated.nodes.core.remediationOf = '1. [high] no test suite';

    preserveExhaustedNodes(previous, remediated, 3, 'delivery:1');

    const tests = remediated.nodes.tests;
    expect(tests.phase).toBe('queued');
    expect(tests.abandonedDependencies).toBeUndefined();
    expect(tests.attempts.every((attempt) => attempt.withoutDependency)).toBe(true);
    expect(tests.remediationOf).toContain('core');
    expect(tests.remediationRound).toBe('delivery:1');
    // Waits for the dependency again rather than running past it a second time.
    expect(readyNodes(remediated).map((node) => node.id)).toEqual(['core']);
    // An approved dependent keeps its result.
    expect(remediated.nodes.docs.phase).toBe('settled');
  });

  it('leaves a released node alone when its dependency stays abandoned', () => {
    const previous = graphFor(['core', 'tests']);
    previous.nodes.core.phase = 'abandoned';
    previous.nodes.tests.dependsOn = ['core'];
    previous.nodes.tests.abandonedDependencies = ['core'];
    previous.nodes.tests.attempts = failedAttempts(3);
    previous.nodes.tests.phase = 'abandoned';
    const remediated = structuredClone(previous);

    preserveExhaustedNodes(previous, remediated, 3);

    expect(remediated.nodes.tests.phase).toBe('abandoned');
    expect(remediated.nodes.tests.attempts.some((attempt) => attempt.withoutDependency)).toBe(false);
  });
});

describe('waitsOn', () => {
  it('follows blocked tasks transitively and stops on cycles', () => {
    const graph = graphFor(['a', 'b', 'c', 'd']);
    graph.nodes.a.blockedByForeignTaskIds = ['b'];
    graph.nodes.b.blockedByForeignTaskIds = ['c'];
    graph.nodes.c.blockedByForeignTaskIds = ['a'];

    expect(waitsOn(graph, 'a', 'c')).toBe(true);
    expect(waitsOn(graph, 'b', 'a')).toBe(true);
    expect(waitsOn(graph, 'd', 'a')).toBe(false);
    expect(waitsOn(graph, 'a', 'd')).toBe(false);
  });
});

describe('preserveExhaustedNodes clearing', () => {
  it('drops the old repair brief and sign-off refusals from a node remediation reopens', () => {
    const previous = graphFor(['implementation', 'docs']);
    for (const node of Object.values(previous.nodes)) node.phase = 'settled';
    previous.nodes.docs.signOffRefusals = ['kept: docs is not reopened'];
    const remediated = structuredClone(previous);
    const reopened = remediated.nodes.implementation;
    reopened.phase = 'queued';
    reopened.remediationOf = '1. [high] DATA_DIR points at the package';
    reopened.signOffRefusals = ['stale refusal'];
    reopened.repairBrief = {
      attempt: 1, maxAttempts: 8, checks: [], advisoryFailures: [], findings: [], reviewRequiredChanges: [],
      priorAttempt: 'stale', history: [], repeatCount: 1,
    };

    preserveExhaustedNodes(previous, remediated, 3);

    expect(reopened.repairBrief).toBeUndefined();
    expect(reopened.signOffRefusals).toBeUndefined();
    expect(remediated.nodes.docs.signOffRefusals).toEqual(['kept: docs is not reopened']);
  });
});

describe('signOffCheckContext', () => {
  it('tells the reviewer which required checks collected no tests', () => {
    expect(signOffCheckContext({ ran: true, passed: true, emptyChecks: ['unit'] }))
      .toContain('No tests were collected by: unit.');
  });

  it('carries exact independent-check failures into a refused sign-off retry', () => {
    expect(signOffCheckContext({
      ran: true,
      passed: true,
      suitePassed: false,
      output: 'FAILED tests/test_composition.py::test_atomic_fraction - expected 0.71386, got 0.713952',
    })).toContain('expected 0.71386, got 0.713952');
  });

  it('bounds large check output while retaining the failure tail', () => {
    const context = signOffCheckContext({
      ran: true,
      passed: true,
      output: `${'x'.repeat(20_000)}\nFINAL ASSERTION`,
    });

    expect(context).toContain('characters omitted');
    expect(context).toContain('FINAL ASSERTION');
    expect(context.length).toBeLessThan(12_200);
  });
});

class FakeStrategy implements SwarmStrategy {
  declareOwnership = stubDeclareOwnership;
  integrationCalls = 0;
  verificationCalls = 0;
  acceptanceCalls = 0;
  integrate: SwarmStrategy['integrate'] = async (...args) => {
    this.integrationCalls += 1;
    return (this.options.integrate ?? stubIntegrate)(...args);
  };
  verifyDelivery: SwarmStrategy['verifyDelivery'] = async (...args) => {
    this.verificationCalls += 1;
    return stubVerifyDelivery(...args);
  };
  disposeFindings: SwarmStrategy['disposeFindings'] = async (...args) =>
    (this.options.disposeFindings ?? stubDisposeFindings)(...args);
  accept: SwarmStrategy['accept'] = async (...args) => {
    this.acceptanceCalls += 1;
    return (this.options.accept ?? stubAccept)(...args);
  };
  remediate: SwarmStrategy['remediate'] = async (...args) => (this.options.remediate ?? stubRemediate)(...args);
  recover?: SwarmStrategy['recover'];

  readonly id = 'noop' as const;

  constructor(private readonly options: FakeStrategyOptions = {}) {
    this.recover = options.recover;
  }

  async plan(ctx: EngineContext, task: TaskSpec): Promise<TaskGraph> {
    if (this.options.plan) return this.options.plan(ctx, task);
    ctx.runState.evidence = (this.options.evidence ?? task.acceptanceCriteria.map((criterion) => ({
      criterion,
      command: 'git status --short',
      expectedResult: 'The repository status check exits successfully.',
      status: 'unavailable' as const,
      note: 'check:unit',
    }))).map((item) => ({ ...item }));
    return this.options.graph ?? graphFor(['task-1']);
  }

  async assign(ctx: EngineContext, graph: TaskGraph): Promise<Assignment[]> {
    if (this.options.assign) return this.options.assign(ctx, graph);
    return graph.order
      .filter((taskId) => graph.nodes[taskId].phase === 'queued')
      .map((taskId) => ({ taskId, assigneeId: 'fake-worker', role: 'implementer' }));
  }

  async execute(ctx: EngineContext, assignment: Assignment): Promise<WorkProduct> {
    if (this.options.execute) return this.options.execute(ctx, assignment);
    return productFor(assignment);
  }

  async review(_ctx: EngineContext, product: WorkProduct, test: TestResult): Promise<ReviewResult> {
    return { taskId: product.taskId, findings: [], testResult: test };
  }

  async decide(ctx: EngineContext, product: WorkProduct, review: ReviewResult): Promise<Decision> {
    if (this.options.decide) return this.options.decide(ctx, product, review);
    return { taskId: product.taskId, outcome: 'approved', rationale: 'accepted', evidenceRefs: [] };
  }

  async recordOutcome(ctx: EngineContext, decision: Decision, test: TestResult): Promise<void> {
    await this.options.recordOutcome?.(ctx, decision, test);
  }

  requiresHumanApproval(ctx: EngineContext, decision: Decision): boolean {
    return this.options.requiresHumanApproval?.(ctx, decision) ?? false;
  }
}

let tmpRoot: string;
let repoPath: string;
let runsRootDir: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'swarm-engine-test-'));
  repoPath = path.join(tmpRoot, 'repo');
  runsRootDir = path.join(tmpRoot, 'runs');
  mkdirSync(repoPath, { recursive: true });
  git(repoPath, ['init', '-q']);
  git(repoPath, ['config', 'user.email', 'test@example.com']);
  git(repoPath, ['config', 'user.name', 'Test']);
  writeFileSync(path.join(repoPath, 'initial.txt'), 'initial\n', 'utf8');
  git(repoPath, ['add', '-A']);
  git(repoPath, ['commit', '-q', '-m', 'initial']);
  git(repoPath, ['branch', '-M', 'main']);
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('SwarmEngine runLoop', () => {
  it('allows only one engine to resume the same interrupted run concurrently', async () => {
    const original = createEngine(new FakeStrategy({}));
    const started = await start(original);
    const state = await waitForStatus(original, started.runId, 'awaiting_acceptance');
    state.status = 'interrupted';
    delete state.engineLease;
    original.getRunStore().save(state);
    const first = createEngine(new FakeStrategy({}));
    const second = createEngine(new FakeStrategy({}));
    const outcomes = await Promise.allSettled([first.resumeRun(started.runId), second.resumeRun(started.runId)]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    await waitForStatus(first, started.runId, 'awaiting_acceptance');
  });
  it('releases its lease when a clean signal interruption persists the run', async () => {
    let executionStarted!: () => void;
    const startedExecuting = new Promise<void>((resolve) => { executionStarted = resolve; });
    const neverCompletes = new Promise<void>(() => undefined);
    const strategy = new FakeStrategy({
      execute: async (_ctx, assignment) => {
        executionStarted();
        await neverCompletes;
        return productFor(assignment);
      },
    });
    const engine = createEngine(strategy);

    const started = await start(engine);
    await startedExecuting;
    const [interrupted] = await engine.interruptOwnedRuns('test signal');

    expect(interrupted.status).toBe('interrupted');
    expect(interrupted.engineLease).toBeUndefined();
    expect(engine.getRunStore().load(started.runId)?.engineLease).toBeUndefined();
  });

  it('resumes a run cut off mid-task by running that task again', async () => {
    // Two independent tasks executed in one batch, then settled one by one. The process dies while
    // the first awaits its verdict: it holds an applied, unjudged change, and the second is still
    // marked running with its product lost.
    let decideReached!: () => void;
    const reachedDecide = new Promise<void>((resolve) => { decideReached = resolve; });
    const graph = graphFor(['first', 'second']);
    const hung = createEngine(new FakeStrategy({
      graph,
      execute: async (_ctx, assignment) => productFor(assignment),
      decide: async () => {
        decideReached();
        return new Promise<never>(() => undefined);
      },
    }));
    const started = await start(hung);
    await reachedDecide;
    await hung.interruptOwnedRuns('test signal');
    const onDisk = hung.getRunStore().load(started.runId)!.graph!.nodes;
    expect(onDisk.first.inFlightFileSnapshots).toBeDefined();
    expect(onDisk.second.phase).toBe('running');

    const executed: string[] = [];
    const resumed = createEngine(new FakeStrategy({
      graph,
      execute: async (_ctx, assignment) => {
        executed.push(assignment.taskId);
        return productFor(assignment);
      },
    }));
    await resumed.resumeRun(started.runId);
    const finished = await waitForStatus(resumed, started.runId, 'awaiting_acceptance');

    expect(executed.sort()).toEqual(['first', 'second']);
    expect(finished.graph!.nodes.first.phase).toBe('settled');
    expect(finished.graph!.nodes.second.phase).toBe('settled');
    const ledger = readFileSync(path.join(runsRootDir, started.runId, 'ledger.jsonl'), 'utf8');
    expect(ledger).toContain('"task_recovered_after_interrupt"');
  });

  it('adopts its constitution at start, and a verifier holds the finished run to it', async () => {
    const engine = createEngine(new FakeStrategy({}));
    const started = await engine.startRun({
      task: { goal: 'constitutional run', acceptanceCriteria: ['done'], repoPath, baseBranch: 'main' },
      strategy: 'democratic',
      budgetUsd: 100,
    });
    await waitForStatus(engine, started.runId, 'awaiting_acceptance');

    const adopted = engine.getRunStore().load(started.runId)!.constitution!;
    expect(adopted.digest).toBe(constitutionFor('democratic', {})!.digest);
    const report = verifyRun(runsRootDir, started.runId);
    expect(report).toMatchObject({ ok: true, constitution: { strategy: 'democratic', digest: adopted.digest } });

    // Loosen the recorded constitution's threshold after the fact: the digest no longer matches.
    const ledgerFile = path.join(runsRootDir, started.runId, 'ledger.jsonl');
    writeFileSync(ledgerFile, readFileSync(ledgerFile, 'utf8').replace('"routine":"simple_majority"', '"routine":"three_fifths"'));
    expect(verifyRun(runsRootDir, started.runId).problems).toContain(
      'governance: the adopted constitution does not match its own digest',
    );
  });

  describe('against a strategy that behaves like a hostile model', () => {
    const hostileTargets = [
      ['a git hook in the shared .git', '.git/hooks/pre-commit'],
      ['a path climbing out of the worktree', '../../escaped-by-model.txt'],
      ['an absolute path', path.join(os.tmpdir(), `escaped-by-model-${process.pid}.txt`)],
    ] as const;

    for (const [label, target] of hostileTargets) {
      it(`never writes ${label}`, async () => {
        const engine = createEngine(new FakeStrategy({
          execute: async (_ctx, assignment) => ({
            ...productFor(assignment),
            fileOps: [{ op: 'write', path: target, content: '#!/bin/sh\necho owned\n' }],
          }),
        }));
        const started = await start(engine);
        const ended = await waitForEnd(engine, started.runId);

        const worktree = ended.worktreePath;
        for (const candidate of [path.resolve(worktree, target), path.join(repoPath, '.git', 'hooks', 'pre-commit')]) {
          expect(existsSync(candidate), candidate).toBe(false);
        }
        expect(ended.status).not.toBe('completed');
        expect(readFileSync(path.join(runsRootDir, started.runId, 'ledger.jsonl'), 'utf8')).toMatch(/\.git|outside|absolute|escape/i);
      });
    }

    it('cannot record a tally its own ballots do not carry', async () => {
      const engine = createEngine(new FakeStrategy({
        decide: async (ctx, product) => {
          recordGovernanceDecision(ctx.runState, ctx.ledger, {
            id: 'forged-1', body: 'house', subject: product.taskId, artifactDigest: 'x',
            rule: 'two-thirds-of-all-seated-members', eligible: ['a', 'b', 'c'],
            positions: [{ actor: 'a', choice: 'aye' }, { actor: 'b', choice: 'no' }, { actor: 'c', choice: 'no' }],
            evidenceRefs: [], result: 'carried', nextAction: 'proceed',
          });
          return decisionFor(product.taskId, 'approved');
        },
      }));
      const started = await start(engine);
      const ended = await waitForEnd(engine, started.runId);

      expect(ended.status).not.toBe('awaiting_acceptance');
      expect(ended.governanceDecisions ?? []).toEqual([]);
      expect(readFileSync(path.join(runsRootDir, started.runId, 'ledger.jsonl'), 'utf8')).not.toContain('"forged-1"');
    });
  });

  it('marks a run interrupted at startup when its owning process on this machine is gone', async () => {
    const engine = createEngine(new FakeStrategy({ execute: async () => new Promise<never>(() => undefined) }));
    const started = await start(engine);
    await engine.interruptOwnedRuns('test signal');
    const store = engine.getRunStore();
    const orphaned = store.load(started.runId)!;
    const now = new Date().toISOString();
    orphaned.status = 'running';
    orphaned.heartbeatAt = now;
    // Pid 2^22 + 1 is above Linux's pid_max, so no process can hold it.
    orphaned.engineLease = { instanceId: 'gone', acquiredAt: now, heartbeatAt: now, pid: 4_194_305, hostname: os.hostname() };
    store.save(orphaned);

    createEngine(new FakeStrategy({}));

    const recovered = store.load(started.runId)!;
    expect(recovered.status).toBe('interrupted');
    expect(recovered.lastError).toContain('pid 4194305');
  });

  it('approves a dependency-ordered two-node graph and offers the delivery for acceptance', async () => {
    const calls: string[] = [];
    const graph = graphFor(['first', 'second'], { second: ['first'] });
    const strategy = new FakeStrategy({
      graph,
      execute: async (_ctx, assignment) => {
        calls.push(`execute:${assignment.taskId}`);
        return productFor(assignment);
      },
      decide: async (_ctx, product) => {
        calls.push(`decide:${product.taskId}`);
        return decisionFor(product.taskId, 'approved');
      },
    });
    const engine = createEngine(strategy);

    const started = await start(engine);
    // A fully approved graph reaches the acceptance barriers and stops at awaiting_acceptance —
    // never `completed`, which section 5 reserves for a delivery Claude has independently accepted.
    const state = withLegacyTaskStatuses(await waitForStatus(engine, started.runId, 'awaiting_acceptance'));

    expect(calls).toEqual(['execute:first', 'decide:first', 'execute:second', 'decide:second']);
    expect(state.graph?.nodes.first.status).toBe('approved');
    expect(state.graph?.nodes.second.status).toBe('approved');
    expect(state.delivery?.doctrineAcceptance.accepted).toBe(true);
    assert.equal(state.status, 'awaiting_acceptance');
    assert.deepEqual(state.findings, []);

    const accepted = engine.acceptDelivery(started.runId, 'checked');
    expect(accepted.status).toBe('completed');
  });

  it('keeps a lot seed given at start, and leaves runs without one on their run id', async () => {
    const engine = createEngine(new FakeStrategy({ evidence: [] }));
    const seeded = await engine.startRun({
      task: { goal: 'characterize run loop', acceptanceCriteria: ['done'], repoPath, baseBranch: 'main' },
      strategy: 'noop',
      budgetUsd: 100,
      lotSeed: 'benchmark-trial-1',
    });
    const unseeded = await start(engine);
    expect(seeded.lotSeed).toBe('benchmark-trial-1');
    expect(unseeded.lotSeed).toBeUndefined();
    // Let both runs settle so neither loop outlives the test's temp directory.
    expect((await waitForStatus(engine, seeded.runId, 'terminated_incomplete')).lotSeed).toBe('benchmark-trial-1');
    await waitForStatus(engine, unseeded.runId, 'terminated_incomplete');
  });

  it('blocks doctrine acceptance while a non-waivable evidence finding remains unresolved', async () => {
    const strategy = new FakeStrategy({ evidence: [] });
    const engine = createEngine(strategy);

    const started = await start(engine);
    const state = await waitForStatus(engine, started.runId, 'terminated_incomplete');
    const evidenceFinding = state.findings?.find((finding) => finding.source === 'engine:evidence');

    assert.equal(strategy.acceptanceCalls, 1);
    assert.equal(state.delivery?.doctrineAcceptance.accepted, true);
    assert.equal(evidenceFinding?.nonWaivable, true);
    assert.equal(evidenceFinding?.disposition, 'unresolved');
    assert.equal(evidenceFinding?.summary, 'Acceptance criterion has no satisfying evidence: "done"');
    assert.notEqual(state.status, 'awaiting_acceptance');
    assert.match(state.lastError ?? '', /Acceptance criterion has no satisfying evidence: "done"/);
  });

  it('reverts rejected file operations and terminates the run incomplete rather than complete', async () => {
    const strategy = new FakeStrategy({
      decide: async (_ctx, product) => decisionFor(product.taskId, 'rejected'),
    });
    const engine = createEngine(strategy);

    const started = await start(engine);
    // Section 5 forbids representing partial work as accepted, so a graph whose only task was
    // rejected never reaches the acceptance barriers and never reports completion.
    const state = withLegacyTaskStatuses(await waitForStatus(engine, started.runId, 'terminated_incomplete'));

    expect(state.graph?.nodes['task-1'].status).toBe('rejected');
    expect(existsSync(path.join(state.worktreePath, 'task-1.txt'))).toBe(false);
    expect(state.delivery).toBeUndefined();
    expect(state.lastError).toContain('rejected');
  });

  it('resolves check-backed evidence against the current worktree before the run ends', async () => {
    const strategy = new FakeStrategy({
      graph: graphFor(['approved-task', 'rejected-task']),
      evidence: [{
        criterion: 'done',
        command: 'git status --short',
        expectedResult: 'The repository status check exits successfully.',
        status: 'unavailable',
        note: 'check:unit',
      }],
      decide: async (_ctx, product) => decisionFor(
        product.taskId,
        product.taskId === 'approved-task' ? 'approved' : 'rejected',
      ),
    });
    const engine = createEngine(strategy);

    const started = await start(engine);
    const state = await waitForSettled(engine, started.runId);

    assert.equal(existsSync(path.join(state.worktreePath, 'approved-task.txt')), true);
    assert.equal(state.evidence?.[0].criterion, 'done');
    assert.equal(state.evidence?.[0].status, 'satisfied');
    assert.equal(state.evidence?.[0].note, 'Check "unit" passed on the integrated tree.');
  });

  it('preserves the synchronization packet when nothing was approved to deliver', async () => {
    // Section 5's requirement applies to the ending that submits nothing: with no approved task
    // there is no delivery packet to carry the evidence, so the sync packet must.
    const strategy = new FakeStrategy({
      graph: graphFor(['rejected-task']),
      evidence: [{
        criterion: 'done',
        command: 'git status --short',
        expectedResult: 'The repository status check exits successfully.',
        status: 'unavailable',
        note: 'check:unit',
      }],
      decide: async (_ctx, product) => decisionFor(product.taskId, 'rejected'),
    });
    const engine = createEngine(strategy);

    const started = await start(engine);
    const state = await waitForStatus(engine, started.runId, 'terminated_incomplete');

    assert.equal(state.lastSyncPacket?.evidence[0].criterion, 'done');
    assert.equal(state.lastSyncPacket?.evidence[0].status, 'satisfied');
  });

  it('delivers what was approved and declares the task it abandoned', async () => {
    const strategy = new FakeStrategy({
      graph: graphFor(['approved-task', 'rejected-task']),
      decide: async (_ctx, product) => decisionFor(
        product.taskId,
        product.taskId === 'approved-task' ? 'approved' : 'rejected',
      ),
    });
    const engine = createEngine(strategy);

    const started = await start(engine);
    const state = await waitForSettled(engine, started.runId);

    assert.notEqual(state.status, 'terminated_incomplete');
    assert.equal(existsSync(path.join(state.worktreePath, 'approved-task.txt')), true);
    const limitations = state.delivery?.limitations ?? [];
    assert.ok(
      limitations.some((line) => line.includes('rejected-task') && line.includes('abandoned')),
      `abandonment not declared in the delivery: ${JSON.stringify(limitations)}`,
    );
    assert.ok(readLedger(started.runId).some((entry) => entry.type === 'partial_delivery_submitted'));
  });

  it('opens a final-diff approval and pauses for human review', async () => {
    const strategy = new FakeStrategy({
      decide: async (_ctx, product) => decisionFor(product.taskId, 'needs_human'),
      requiresHumanApproval: () => true,
    });
    const engine = createEngine(strategy);

    const started = await start(engine);
    const state = withLegacyTaskStatuses(await waitForStatus(engine, started.runId, 'paused_human'));

    expect(state.graph?.nodes['task-1'].status).toBe('blocked_on_human');
    expect(state.pendingApprovals).toEqual([
      expect.objectContaining({ kind: 'final_diff', taskId: 'task-1' }),
    ]);
    expect(state.pendingApprovals[0].resolvedAt).toBeUndefined();
  });

  it('opens a resolvable test-waiver approval for a test-integrity violation', async () => {
    writeFileSync(path.join(repoPath, 'existing.test.ts'), "it('keeps coverage', () => {});\n", 'utf8');
    git(repoPath, ['add', '-A']);
    git(repoPath, ['commit', '-q', '-m', 'add existing test']);
    let executionCount = 0;
    const strategy = new FakeStrategy({
      execute: async (_ctx, assignment) => {
        executionCount += 1;
        if (executionCount === 1) {
          return { ...productFor(assignment), fileOps: [{ op: 'delete', path: 'existing.test.ts' }] };
        }
        return productFor(assignment);
      },
    });
    strategy.disposeFindings = async (_ctx, open) => open.map((finding) => ({
      ...finding,
      disposition: 'rejected',
      dispositionRationale: 'The violating proposal was withdrawn and the retried task preserved the existing test.',
    }));
    const engine = createEngine(strategy);

    const started = await start(engine);
    const paused = await waitForStatus(engine, started.runId, 'paused_human');

    assert.equal(paused.pendingApprovals.length, 1);
    assert.equal(paused.pendingApprovals[0].kind, 'test_waiver');
    assert.equal(paused.pendingApprovals[0].taskId, 'task-1');

    const resolving = engine.resolveApproval(started.runId, paused.pendingApprovals[0].id, 'approve');

    assert.equal(resolving.graph?.nodes['task-1'].phase, 'queued');
    assert.equal(resolving.status, 'running');
    await waitForStatus(engine, started.runId, 'awaiting_acceptance');
  });

  it('records the first test-integrity violation and still blocks for a test-waiver approval', async () => {
    writeFileSync(path.join(repoPath, 'existing.test.ts'), "it('keeps coverage', () => {});\n", 'utf8');
    git(repoPath, ['add', '-A']);
    git(repoPath, ['commit', '-q', '-m', 'add existing test']);
    const strategy = new FakeStrategy({
      execute: async (_ctx, assignment) => ({
        ...productFor(assignment),
        fileOps: [{ op: 'delete', path: 'existing.test.ts' }],
      }),
    });
    const engine = createEngine(strategy, { maxTaskAttempts: 3 });

    const started = await start(engine);
    const paused = await waitForStatus(engine, started.runId, 'paused_human');
    const node = paused.graph!.nodes['task-1'];

    assert.equal(node.phase, 'blocked');
    assert.equal(node.attempts.length, 1);
    assert.equal(node.attempts[0].outcome, 'needs_human');
    assert.equal(paused.pendingApprovals.length, 1);
    assert.equal(paused.pendingApprovals[0].kind, 'test_waiver');
    assert.equal(paused.pendingApprovals[0].taskId, 'task-1');
    assert.equal(paused.pendingApprovals[0].resolvedAt, undefined);
  });

  it('abandons repeated test-integrity violations at maxTaskAttempts without opening another waiver', async () => {
    writeFileSync(path.join(repoPath, 'existing.test.ts'), "it('keeps coverage', () => {});\n", 'utf8');
    git(repoPath, ['add', '-A']);
    git(repoPath, ['commit', '-q', '-m', 'add existing test']);
    const maxAttempts = 3;
    let executions = 0;
    const strategy = new FakeStrategy({
      execute: async (_ctx, assignment) => {
        executions += 1;
        return {
          ...productFor(assignment),
          fileOps: [{ op: 'delete', path: 'existing.test.ts' }],
        };
      },
    });
    const engine = createEngine(strategy, { maxTaskAttempts: maxAttempts });

    const started = await start(engine);
    for (let attempt = 1; attempt < maxAttempts; attempt += 1) {
      const paused = await waitForStatus(engine, started.runId, 'paused_human');
      const approval = paused.pendingApprovals.find((candidate) => !candidate.resolvedAt);

      assert.equal(approval?.kind, 'test_waiver');
      engine.resolveApproval(started.runId, approval!.id, 'approve');
    }

    const terminated = await waitForStatus(engine, started.runId, 'terminated_incomplete');
    const node = terminated.graph!.nodes['task-1'];
    const testWaivers = terminated.pendingApprovals.filter((approval) => approval.kind === 'test_waiver');
    const exhausted = readLedger(started.runId).find((entry) => entry.type === 'rework_budget_exhausted');

    assert.equal(executions, maxAttempts);
    assert.equal(node.phase, 'abandoned');
    assert.equal(node.attempts.length, maxAttempts);
    assert.deepEqual(node.attempts.map((attempt) => attempt.outcome), [
      'needs_human',
      'needs_human',
      'needs_human',
    ]);
    assert.equal(testWaivers.length, maxAttempts - 1);
    assert.equal(testWaivers.some((approval) => !approval.resolvedAt), false);
    assert.equal(exhausted?.data.taskId, 'task-1');
    assert.equal(exhausted?.data.attemptNumber, maxAttempts);
    assert.equal(exhausted?.data.maxAttempts, maxAttempts);
    assert.equal(exhausted?.data.reason, 'test_integrity_violation');
  });

  it('continues an independent sibling after abandoning a test-integrity violator', async () => {
    writeFileSync(path.join(repoPath, 'existing.test.ts'), "it('keeps coverage', () => {});\n", 'utf8');
    git(repoPath, ['add', '-A']);
    git(repoPath, ['commit', '-q', '-m', 'add existing test']);
    const graph = graphFor(['violating-task', 'sibling-task']);
    graph.nodes['violating-task'].targetGlobs = ['existing.test.ts', 'shared-interface.ts'];
    graph.nodes['sibling-task'].targetGlobs = ['sibling-task.txt', 'shared-interface.ts'];
    const executions: string[] = [];
    const strategy = new FakeStrategy({
      graph,
      execute: async (_ctx, assignment) => {
        executions.push(assignment.taskId);
        if (assignment.taskId === 'violating-task') {
          return {
            ...productFor(assignment),
            fileOps: [{ op: 'delete', path: 'existing.test.ts' }],
          };
        }
        return productFor(assignment);
      },
    });
    const engine = createEngine(strategy, { maxTaskAttempts: 2 });

    const started = await start(engine);
    const paused = await waitForStatus(engine, started.runId, 'paused_human');
    engine.resolveApproval(started.runId, paused.pendingApprovals[0].id, 'approve');

    const terminated = await waitForStatus(engine, started.runId, 'terminated_incomplete');
    const violatingNode = terminated.graph!.nodes['violating-task'];
    const siblingNode = terminated.graph!.nodes['sibling-task'];

    assert.deepEqual(violatingNode.dependsOn, []);
    assert.deepEqual(siblingNode.dependsOn, []);
    assert.deepEqual(executions, ['violating-task', 'violating-task', 'sibling-task']);
    assert.equal(violatingNode.phase, 'abandoned');
    assert.equal(siblingNode.phase, 'settled');
    assert.equal(latestVerdict(siblingNode), 'approved');
    assert.equal(terminated.status, 'terminated_incomplete');
    assert.equal(terminated.pendingApprovals.filter((approval) => approval.kind === 'test_waiver').length, 1);
  });

  // A refused sign-off used to abandon the node on the spot, short-circuiting maxTaskAttempts the
  // same way a bare `rejected` did: socialist lost both foundation modules on attempt 2 of an
  // allowed 6, and every task downstream with them.
  it('reverts the reviewed diff and returns a node when final-diff approval is rejected', async () => {
    const strategy = new FakeStrategy({
      decide: async (_ctx, product) => decisionFor(product.taskId, 'needs_human'),
      requiresHumanApproval: () => true,
    });
    const engine = createEngine(strategy, { maxTaskAttempts: 3 });

    const started = await start(engine);
    const paused = await waitForStatus(engine, started.runId, 'paused_human');
    const resolving = engine.resolveApproval(started.runId, paused.pendingApprovals[0].id, 'reject');

    assert.equal(resolving.graph?.nodes['task-1'].phase, 'queued');
    assert.equal(resolving.status, 'running');
    assert.equal(existsSync(path.join(resolving.worktreePath, 'task-1.txt')), false);
    // resolveApproval schedules the next attempt asynchronously. Let it park at the next
    // approval before afterEach removes the git worktree beneath that loop.
    await waitForStatus(engine, started.runId, 'paused_human');
  });

  it('abandons the node once rejected sign-offs have spent the attempt budget', async () => {
    const maxAttempts = 3;
    const strategy = new FakeStrategy({
      decide: async (_ctx, product) => decisionFor(product.taskId, 'needs_human'),
      requiresHumanApproval: () => true,
    });
    const engine = createEngine(strategy, { maxTaskAttempts: maxAttempts });

    const started = await start(engine);
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const paused = await waitForStatus(engine, started.runId, 'paused_human');
      const pending = paused.pendingApprovals.find((candidate) => !candidate.resolvedAt);
      engine.resolveApproval(started.runId, pending!.id, 'reject');
    }

    const terminated = await waitForStatus(engine, started.runId, 'terminated_incomplete');
    const node = terminated.graph!.nodes['task-1'];
    assert.equal(node.phase, 'abandoned');
    assert.equal(node.attempts.length, maxAttempts);
    // The reviewer's verdict is preserved on every attempt — the engine compelled retries, never consent.
    assert.deepEqual(node.attempts.map((a) => a.outcome), ['needs_human', 'needs_human', 'needs_human']);
  });

  it('pauses and records the ledger event when wall-clock time is exceeded', async () => {
    const engine = createEngine(new FakeStrategy(), { maxWallClockMinutes: -1 });

    const started = await start(engine);
    const state = withLegacyTaskStatuses(await waitForStatus(engine, started.runId, 'paused_budget'));
    const ledger = readLedger(started.runId);

    expect(state.graph?.nodes['task-1'].status).toBe('ready');
    expect(ledger).toContainEqual(expect.objectContaining({ type: 'wall_clock_exceeded' }));
    expect(ledger.find((entry) => entry.type === 'wall_clock_exceeded')?.data.elapsedMin).toEqual(expect.any(Number));
  });

  it('opens a resolvable wall-clock extension approval and resumes the run', async () => {
    const engine = createEngine(new FakeStrategy(), { maxWallClockMinutes: -1 });

    const started = await start(engine);
    const paused = await waitForStatus(engine, started.runId, 'paused_budget');

    assert.equal(paused.pendingApprovals.length, 1);
    assert.equal(paused.pendingApprovals[0].kind, 'wall_clock_extension');
    assert.equal(paused.pendingApprovals[0].resolvedAt, undefined);

    const wallClockLimit = vi.spyOn(BudgetGuard.prototype, 'maxWallClockMinutes').mockReturnValue(10);
    try {
      const resolving = engine.resolveApproval(started.runId, paused.pendingApprovals[0].id, 'approve');

      assert.equal(resolving.status, 'running');
      await waitForStatus(engine, started.runId, 'awaiting_acceptance');
    } finally {
      wallClockLimit.mockRestore();
    }
  });

  it('terminalizes a run when its wall-clock extension is rejected', async () => {
    const engine = createEngine(new FakeStrategy(), { maxWallClockMinutes: -1 });
    const started = await start(engine);
    const paused = await waitForStatus(engine, started.runId, 'paused_budget');

    const resolved = engine.resolveApproval(
      started.runId,
      paused.pendingApprovals[0].id,
      'reject',
      'Persisted deadline is too stale to extend.',
    );

    expect(resolved.status).toBe('terminated_incomplete');
    expect(resolved.lastError).toBe('Persisted deadline is too stale to extend.');
    expect(resolved.lastSyncPacket).toBeDefined();
  });

  it('opens a budget-increase approval for an ordinary per-run budget error from assign', async () => {
    const strategy = new FakeStrategy({
      assign: async () => {
        throw new BudgetExceededError('ordinary per-run limit reached', 'per_run');
      },
    });
    const engine = createEngine(strategy);

    const started = await start(engine);
    const state = withLegacyTaskStatuses(await waitForStatus(engine, started.runId, 'paused_budget'));

    expect(state.pendingApprovals).toEqual([
      expect.objectContaining({ kind: 'budget_increase', description: 'ordinary per-run limit reached' }),
    ]);
    expect(state.graph?.nodes['task-1'].status).toBe('ready');
  });

  it('settles the exact reviewed change after a final-diff approval', async () => {
    let executionCount = 0;
    const strategy = new FakeStrategy({
      execute: async (_ctx, assignment) => {
        executionCount += 1;
        return productFor(assignment);
      },
      decide: async (_ctx, product) => decisionFor(product.taskId, 'needs_human'),
      requiresHumanApproval: () => true,
    });
    const engine = createEngine(strategy);
    const started = await start(engine);
    const paused = await waitForStatus(engine, started.runId, 'paused_human');
    const approval = paused.pendingApprovals[0];

    const resolving = engine.resolveApproval(started.runId, approval.id, 'approve');
    expect(resolving.status).toBe('running');
    const resumed = withLegacyTaskStatuses(await waitForStatus(engine, started.runId, 'awaiting_acceptance'));

    expect(resumed.pendingApprovals[0]).toEqual(expect.objectContaining({ resolution: 'approve' }));
    expect(resumed.graph?.nodes['task-1'].status).toBe('approved');
    expect(resumed.graph?.nodes['task-1'].attempts[0]).toEqual(expect.objectContaining({
      outcome: 'approved',
      doctrineOutcome: 'needs_human',
    }));
    expect(executionCount).toBe(1);
    expect(readFileSync(path.join(resumed.worktreePath, 'task-1.txt'), 'utf8')).toBe('task-1\n');
  });

  it('reverts a rework attempt, calls recordOutcome before recover, then executes a second attempt', async () => {
    const calls: string[] = [];
    let executions = 0;
    const strategy = new FakeStrategy({
      execute: async (ctx, assignment) => {
        executions += 1;
        const attemptPath = path.join(ctx.worktree.worktreePath, 'task-1.txt');
        calls.push(executions === 1 ? 'execute:1' : `execute:2:${existsSync(attemptPath) ? 'dirty' : 'clean'}`);
        return {
          ...productFor(assignment),
          fileOps: [{ op: 'write', path: 'task-1.txt', content: `attempt ${executions}\n` }],
        };
      },
      decide: async (_ctx, product) => executions === 1
        ? decisionFor(product.taskId, 'rework', ['replace the first implementation'])
        : decisionFor(product.taskId, 'approved'),
      recordOutcome: async (_ctx, decision) => {
        calls.push(`recordOutcome:${decision.outcome}`);
      },
      recover: async (ctx) => {
        const attemptPath = path.join(ctx.worktree.worktreePath, 'task-1.txt');
        calls.push(`recover:${existsSync(attemptPath) ? 'dirty' : 'clean'}`);
      },
    });
    const engine = createEngine(strategy);

    const started = await start(engine);
    const state = await waitForStatus(engine, started.runId, 'awaiting_acceptance');
    const node = state.graph!.nodes['task-1'];

    assert.deepEqual(calls, [
      'execute:1',
      'recordOutcome:rework',
      'recover:clean',
      'execute:2:clean',
      'recordOutcome:approved',
    ]);
    assert.deepEqual(node.attempts.map((attempt) => attempt.outcome), ['rework', 'approved']);
    assert.equal(node.attempts.length, 2);
    assert.equal(node.phase, 'settled');
    assert.equal(latestVerdict(node), 'approved');
    assert.equal(readFileSync(path.join(state.worktreePath, 'task-1.txt'), 'utf8'), 'attempt 2\n');
    assert.deepEqual(state.delivery?.decisions.map((decision) => decision.outcome), ['approved']);
    assert.deepEqual(state.delivery?.changedFiles, ['task-1.txt']);
  });

  it('hands recover() and the next attempt a repair brief holding the reverted code, and drops it on approval', async () => {
    let executions = 0;
    const briefs: Array<string | undefined> = [];
    const strategy = new FakeStrategy({
      execute: async (ctx, assignment) => {
        executions += 1;
        if (executions === 2) briefs.push(ctx.runState.graph!.nodes['task-1'].repairBrief?.priorAttempt);
        return { ...productFor(assignment), fileOps: [{ op: 'write', path: 'task-1.txt', content: `attempt ${executions}\n` }] };
      },
      decide: async (_ctx, product) => executions === 1
        ? decisionFor(product.taskId, 'rework', ['replace the first implementation'])
        : decisionFor(product.taskId, 'approved'),
      recover: async (_ctx, request) => {
        briefs.push(request.brief?.priorAttempt);
      },
    });
    const engine = createEngine(strategy);

    const started = await start(engine);
    const state = await waitForStatus(engine, started.runId, 'awaiting_acceptance');

    assert.equal(briefs.length, 2);
    for (const prior of briefs) assert.match(prior ?? '', /write task-1\.txt[\s\S]*attempt 1/);
    assert.equal(state.graph!.nodes['task-1'].repairBrief, undefined);
  });

  it('marks a task as under review, with its check output, only while the doctrine judges it', async () => {
    const seen: Array<string | undefined> = [];
    const strategy = new FakeStrategy({
      decide: async (ctx, product) => {
        seen.push(ctx.runState.underReview?.[product.taskId]);
        return decisionFor(product.taskId, 'approved');
      },
    });
    const engine = createEngine(strategy);

    const started = await start(engine);
    const state = await waitForStatus(engine, started.runId, 'awaiting_acceptance');

    expect(seen).toHaveLength(1);
    expect(typeof seen[0]).toBe('string');
    expect(state.underReview?.['task-1']).toBeUndefined();
  });

  it('leads a compelled rework with the doctrine\'s repair directive instead of its ledger rationale', async () => {
    let executions = 0;
    const directives: string[][] = [];
    const strategy = new FakeStrategy({
      execute: async (_ctx, assignment) => {
        executions += 1;
        return { ...productFor(assignment), fileOps: [{ op: 'write', path: 'task-1.txt', content: `attempt ${executions}\n` }] };
      },
      decide: async (_ctx, product) => executions === 1
        ? {
          taskId: product.taskId,
          outcome: 'rejected',
          rationale: 'Contract failed settlement. Forfeited retention of 20 tokens. Loss of 31.40.',
          evidenceRefs: [],
          repairDirective: ['Return dpa-barns, not barns.'],
        }
        : decisionFor(product.taskId, 'approved'),
      recover: async (_ctx, request) => {
        directives.push(request.decision.rework.requiredChanges);
      },
    });
    const engine = createEngine(strategy);

    const started = await start(engine);
    await waitForStatus(engine, started.runId, 'awaiting_acceptance');

    assert.deepEqual(directives, [['Return dpa-barns, not barns.']]);
  });

  it('abandons a node once maxTaskAttempts is exhausted, without ever calling recover for the last attempt', async () => {
    let executions = 0;
    let recoveries = 0;
    const strategy = new FakeStrategy({
      execute: async (_ctx, assignment) => {
        executions += 1;
        return {
          ...productFor(assignment),
          fileOps: [{ op: 'write', path: 'task-1.txt', content: `attempt ${executions}\n` }],
        };
      },
      decide: async (_ctx, product) => decisionFor(product.taskId, 'rework', ['try another implementation']),
      recover: async () => {
        recoveries += 1;
      },
    });
    const engine = createEngine(strategy, { maxTaskAttempts: 3 });

    const started = await start(engine);
    const state = await waitForStatus(engine, started.runId, 'terminated_incomplete');
    const node = state.graph!.nodes['task-1'];

    assert.equal(executions, 3);
    assert.equal(recoveries, 2);
    assert.equal(node.attempts.length, 3);
    assert.deepEqual(node.attempts.map((attempt) => attempt.outcome), ['rework', 'rework', 'rework']);
    assert.equal(node.phase, 'abandoned');
    assert.equal(existsSync(path.join(state.worktreePath, 'task-1.txt')), false);
    // Incomplete graphs still receive one doctrine-owned integration assessment before bounded
    // remediation is judged actionable; they never reach verification or acceptance.
    assert.equal(strategy.integrationCalls, 1);
    assert.equal(strategy.verificationCalls, 0);
    assert.equal(strategy.acceptanceCalls, 0);
    assert.equal(state.delivery, undefined);
    assert.ok(readLedger(started.runId).some((entry) => entry.type === 'rework_budget_exhausted'));
  });

  it('never lets a doctrine-mutated phase or attempt outcome override the engine\'s own phase decision', async () => {
    let mutationAttempted = false;
    const strategy = new FakeStrategy({
      assign: async (_ctx, graph) => graph.nodes['task-1'].attempts.length === 0
        ? [{ taskId: 'task-1', assigneeId: 'fake-worker', role: 'implementer' }]
        : [],
      decide: async (_ctx, product) => decisionFor(product.taskId, 'rework', ['repair the rejected work']),
      recover: async (ctx) => {
        const node = ctx.runState.graph!.nodes['task-1'];
        node.phase = 'settled';
        node.attempts.at(-1)!.outcome = 'approved';
        mutationAttempted = true;
      },
    });
    const engine = createEngine(strategy);

    const started = await start(engine);
    const state = await waitForStatus(engine, started.runId, 'terminated_incomplete');
    const node = state.graph!.nodes['task-1'];

    assert.equal(mutationAttempted, true);
    assert.equal(node.phase, 'queued');
    assert.equal(latestVerdict(node), 'rework');
    assert.equal(allApproved(state.graph!), false);
    assert.notEqual(state.status, 'completed');
    assert.notEqual(state.status, 'awaiting_acceptance');
    assert.equal(state.delivery, undefined);
  });

  it('leaves a bare rejected decision terminal exactly as before rework existed', async () => {
    let executions = 0;
    const strategy = new FakeStrategy({
      execute: async (_ctx, assignment) => {
        executions += 1;
        return productFor(assignment);
      },
      decide: async (_ctx, product) => decisionFor(product.taskId, 'rejected'),
    });
    const engine = createEngine(strategy);

    const started = await start(engine);
    const state = await waitForStatus(engine, started.runId, 'terminated_incomplete');
    const node = state.graph!.nodes['task-1'];

    assert.equal(executions, 1);
    assert.equal(node.phase, 'abandoned');
    assert.equal(latestVerdict(node), 'rejected');
    assert.equal(existsSync(path.join(state.worktreePath, 'task-1.txt')), false);
    assert.equal(state.delivery, undefined);
  });

  // The defect this pins: a doctrine's first `rejected` abandoned the task outright, stranding every
  // dependent task at zero attempts and failing allApproved() — so a benchmark run with five of six
  // tasks settled delivered nothing. The engine may compel another attempt; it may never compel an
  // approval, so the recorded verdict must stay `rejected` on every one of them.
  it('spends the attempt budget on a bare rejection when the doctrine can recover, without recording consent', async () => {
    const maxAttempts = 3;
    let executions = 0;
    let recoveries = 0;
    const strategy = new FakeStrategy({
      execute: async (_ctx, assignment) => {
        executions += 1;
        return productFor(assignment);
      },
      decide: async (_ctx, product) => decisionFor(product.taskId, 'rejected'),
      recover: async () => {
        recoveries += 1;
      },
    });
    const engine = createEngine(strategy, { maxTaskAttempts: maxAttempts });

    const started = await start(engine);
    const state = await waitForStatus(engine, started.runId, 'terminated_incomplete');
    const node = state.graph!.nodes['task-1'];

    assert.equal(executions, maxAttempts);
    assert.equal(recoveries, maxAttempts - 1);
    assert.equal(node.attempts.length, maxAttempts);
    assert.deepEqual(node.attempts.map((attempt) => attempt.outcome), ['rejected', 'rejected', 'rejected']);
    assert.equal(node.phase, 'abandoned');
    assert.equal(state.delivery, undefined);
  });

  it('blocks the run instead of silently repeating when a strategy returns rework without implementing recover', async () => {
    let executions = 0;
    const strategy = new FakeStrategy({
      execute: async (_ctx, assignment) => {
        executions += 1;
        return productFor(assignment);
      },
      decide: async (_ctx, product) => decisionFor(product.taskId, 'rework', ['make a real repair']),
    });
    const engine = createEngine(strategy);

    const started = await start(engine);
    const state = await waitForStatus(engine, started.runId, 'paused_human');
    const node = state.graph!.nodes['task-1'];
    const pendingApproval = state.pendingApprovals.find((approval) => !approval.resolvedAt);

    assert.equal(executions, 1);
    assert.equal(node.phase, 'blocked');
    assert.equal(latestVerdict(node), 'rework');
    assert.equal(pendingApproval?.kind, 'final_diff');
    assert.match(pendingApproval?.description ?? '', /recover\(\) hook/i);
    assert.equal(state.delivery, undefined);
  });

  it('resumes each rework from its own last attempt, kept out of the shared tree in between', async () => {
    let executions = 0;
    const seenBetweenAttempts: Array<{ onDisk: boolean; retained?: string }> = [];
    const strategy = new FakeStrategy({
      execute: async (ctx, assignment) => {
        executions += 1;
        if (executions > 1) {
          seenBetweenAttempts.push({
            onDisk: existsSync(path.join(ctx.worktree.worktreePath, 'task-1.txt')),
            retained: ctx.runState.graph!.nodes['task-1'].retainedAttempt?.[0]?.content,
          });
        }
        // Only the first attempt writes the file; each retry is a one-line edit of what came before.
        const fileOps: FileOp[] = executions === 1
          ? [{ op: 'write', path: 'task-1.txt', content: 'draft\n' }]
          : [{ op: 'edit', path: 'task-1.txt', find: executions === 2 ? 'draft' : 'second', replace: executions === 2 ? 'second' : 'final' }];
        return { ...productFor(assignment), fileOps };
      },
      decide: async (_ctx, product) => executions < 3
        ? decisionFor(product.taskId, 'rework', ['change the wording'])
        : decisionFor(product.taskId, 'approved'),
      recover: async () => {},
    });
    const engine = createEngine(strategy, { maxTaskAttempts: 3 });

    const started = await start(engine);
    const state = await waitForStatus(engine, started.runId, 'awaiting_acceptance');
    const node = state.graph!.nodes['task-1'];

    // Between attempts the shared tree is clean; the task alone holds its last attempt.
    assert.deepEqual(seenBetweenAttempts, [
      { onDisk: false, retained: 'draft\n' },
      { onDisk: false, retained: 'second\n' },
    ]);
    assert.deepEqual(node.attempts.map((attempt) => attempt.outcome), ['rework', 'rework', 'approved']);
    assert.equal(node.retainedAttempt, undefined);
    assert.equal(readFileSync(path.join(state.worktreePath, 'task-1.txt'), 'utf8'), 'final\n');
  });

  it('marks a byte-identical repeated failure as repeated without treating repetition as approval', async () => {
    let executions = 0;
    let recoveries = 0;
    const strategy = new FakeStrategy({
      execute: async (_ctx, assignment) => {
        executions += 1;
        return productFor(assignment);
      },
      decide: async (_ctx, product) => executions < 3
        ? decisionFor(product.taskId, 'rework', ['apply the same required repair'])
        : decisionFor(product.taskId, 'approved'),
      recover: async () => {
        recoveries += 1;
      },
    });
    const engine = createEngine(strategy, { maxTaskAttempts: 3 });

    const started = await start(engine);
    const state = await waitForStatus(engine, started.runId, 'awaiting_acceptance');
    const node = state.graph!.nodes['task-1'];

    assert.equal(executions, 3);
    assert.equal(recoveries, 2);
    assert.deepEqual(node.attempts.map((attempt) => attempt.outcome), ['rework', 'rework', 'approved']);
    assert.equal(node.attempts[0].repeated, false);
    assert.equal(node.attempts[1].repeated, true);
    assert.equal(node.phase, 'settled');
    assert.equal(latestVerdict(node), 'approved');
    assert.deepEqual(state.delivery?.decisions.map((decision) => decision.outcome), ['approved']);
  });
});

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

type LegacyTaskGraphView = Omit<TaskGraph, 'nodes'> & { nodes: Record<string, TaskNode & { status: string }> };
type LegacyRunStateView = Omit<RunState, 'graph'> & { graph: LegacyTaskGraphView | null };

function withLegacyTaskStatuses(state: RunState): LegacyRunStateView {
  if (!state.graph) return state as LegacyRunStateView;
  const nodes = Object.fromEntries(
    state.graph.order.map((id) => {
      const task = state.graph!.nodes[id];
      const status =
        task.phase === 'running'
          ? 'in_progress'
          : task.phase === 'blocked'
            ? 'blocked_on_human'
            : task.phase === 'queued'
              ? 'ready'
              : latestVerdict(task) ?? (task.phase === 'settled' ? 'approved' : 'rejected');
      return [id, { ...task, status }];
    }),
  );
  return { ...state, graph: { ...state.graph, nodes } };
}

function graphFor(order: string[], dependencies: Record<string, string[]> = {}): TaskGraph {
  return {
    order,
    nodes: Object.fromEntries(order.map((id) => [id, {
      id,
      title: id,
      description: `Implement ${id}`,
      acceptanceCriteria: ['works'],
      dependsOn: dependencies[id] ?? [],
      targetGlobs: [`${id}.txt`],
      riskTags: [],
      riskClass: 'low' as const,
      phase: 'queued' as const,
      attempts: [],
    }])),
  };
}

function productFor(assignment: Assignment): WorkProduct {
  return {
    taskId: assignment.taskId,
    assignment,
    fileOps: [{ op: 'write', path: `${assignment.taskId}.txt`, content: `${assignment.taskId}\n` }],
    rationale: 'fake implementation',
  };
}

function decisionFor(taskId: string, outcome: Decision['outcome'], requiredChanges: string[] = []): Decision {
  const base = { taskId, rationale: `${outcome} by fake strategy`, evidenceRefs: [] };
  // `outcome` is a widened runtime parameter here, not a literal, so it cannot narrow against
  // Decision's discriminated union the way a real strategy's own literal-typed return does.
  // This assertion is deliberately confined to this synthetic test helper.
  return (
    outcome === 'rework' ? { ...base, outcome, rework: { requiredChanges } } : { ...base, outcome }
  ) as Decision;
}

function createEngine(
  strategy: SwarmStrategy,
  overrides: {
    maxWallClockMinutes?: number;
    maxTaskAttempts?: number;
    finalOnlyChecks?: EngineDeps['finalOnlyChecks'];
  } = {},
): SwarmEngine {
  const deps: EngineDeps = {
    outageBackoffMs: () => 0,
    client: new OpenRouterClient('test-key'),
    modelsConfig: { roles: {}, models: {} },
    configDir: tmpRoot,
    budgetConfig: {
      defaults: {
        perRunUsd: 100,
        perTaskUsd: 100,
        maxWorkerCalls: 100,
        maxWallClockMinutes: overrides.maxWallClockMinutes ?? 10,
        maxTaskAttempts: overrides.maxTaskAttempts ?? 3,
        perCallTimeoutMs: 1_000,
        warnAtFractionOfPerRun: 0.8,
      },
      hardCeilingUsd: 1_000,
    },
    strategiesConfig: {},
    runsRootDir,
    strategies: {
      noop: strategy,
      democratic: strategy,
      socialist: strategy,
      capitalist: strategy,
      managerial: strategy,
      single_agent: strategy,
    },
    checksConfig: normalizeChecksConfig({ command: 'git', args: ['status', '--short'], timeoutMs: 1_000 }),
    finalOnlyChecks: overrides.finalOnlyChecks,
  };
  return new SwarmEngine(deps);
}

async function start(engine: SwarmEngine): Promise<RunState> {
  return engine.startRun({
    task: { goal: 'characterize run loop', acceptanceCriteria: ['done'], repoPath, baseBranch: 'main' },
    strategy: 'noop',
    budgetUsd: 100,
  });
}

async function waitForStatus(
  engine: SwarmEngine,
  runId: string,
  expected: RunState['status'],
): Promise<RunState> {
  const deadline = Date.now() + 10_000; // returns on first match; generous for a loaded parallel suite with fsynced writes
  while (Date.now() < deadline) {
    const state = engine.getRunStore().load(runId);
    if (state?.status === expected) return state;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Run ${runId} did not reach ${expected}`);
}

/**
 * Waits for the run to stop, whichever ending it takes.
 *
 * For a test whose subject is what happened on the way — how often a task ran, what the graph
 * recorded — the ending is incidental, and naming one couples the test to a policy it is not
 * about. A graph carrying an abandoned task used to end `terminated_incomplete` and now submits
 * what was approved, so those tests would otherwise have to be rewritten every time that policy
 * moves.
 */
async function waitForSettled(engine: SwarmEngine, runId: string): Promise<RunState> {
  const terminal = new Set<RunState['status']>([
    'completed',
    'failed',
    'stopped',
    'terminated_incomplete',
    'awaiting_acceptance',
  ]);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const state = engine.getRunStore().load(runId);
    if (state && terminal.has(state.status)) return state;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Run ${runId} did not settle`);
}

function readLedger(runId: string): Array<{ type: string; data: Record<string, unknown> }> {
  return readFileSync(path.join(runsRootDir, runId, 'ledger.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { type: string; data: Record<string, unknown> });
}

/**
 * A doctrine refusing its own delivery used to end the run outright. That punished exactly the
 * doctrines whose gates worked: democratic settled all six tasks, built every module for real, and
 * was refused over a CLI calling a function that did not exist and a README documenting the wrong
 * mixture rule — two named, fixable defects — then stopped with $0.42 of its $8 unspent.
 */
describe('SwarmEngine self-refused delivery', () => {
  function refusingStrategy(refusals: number, onRemediate: () => void) {
    let seen = 0;
    return new FakeStrategy({
      accept: async () => {
        seen += 1;
        return {
          accepted: seen > refusals,
          procedure: 'assent',
          // Names task-1.txt, the path productFor writes and ownershipFromGraph records for task-1, so
          // the repair can be scoped to the task that owns it.
          rationale: seen > refusals
            ? 'Assent given.'
            : 'Assent refused: task-1.txt calls a function that does not exist.',
          decidedAt: new Date().toISOString(),
        };
      },
      remediate: async (ctx) => {
        onRemediate();
        // The doctrine decides how the work reopens; here it simply re-queues what it has.
        const graph = ctx.runState.graph!;
        graph.nodes['task-1'].phase = 'queued';
        return graph;
      },
    });
  }

  it('hands the delivery back to the doctrine that refused it, and can then be accepted', async () => {
    let remediations = 0;
    const engine = createEngine(refusingStrategy(1, () => { remediations += 1; }));

    const started = await start(engine);
    const state = await waitForStatus(engine, started.runId, 'awaiting_acceptance');

    assert.equal(remediations, 1);
    assert.equal(state.remediationCycles, 1);
    assert.equal(state.delivery?.doctrineAcceptance.accepted, true);
  });

  it('records the defects the doctrine named against its own delivery', async () => {
    const engine = createEngine(refusingStrategy(1, () => {}));

    const started = await start(engine);
    await waitForStatus(engine, started.runId, 'awaiting_acceptance');
    const returned = readLedger(started.runId).find((entry) => entry.type === 'delivery_returned_for_repair');

    assert.equal(returned?.data.cycle, 1);
    assert.match(String(returned?.data.findings), /function that does not exist/);
  });

  /**
   * Regression: a real socialist benchmark run recorded a regression-rule finding whose summary
   * grew from 2,203 to 13,247 characters in one cycle, because it quoted a task's whole
   * `remediationOf` directive verbatim — and that directive is itself built from prior findings'
   * summaries, so a regression-rule finding from cycle N got quoted in full inside cycle N+1's,
   * compounding every cycle a genuinely unresolved defect (one a real disposal committee would
   * not rubber-stamp away) kept reappearing.
   */
  it('bounds a regression-rule finding\'s quoted remediation text instead of recursively embedding prior cycles', async () => {
    // Long enough that quoting it in full (the pre-fix behavior) is unmistakably visible against
    // a bounded quote after just two cycles — a real disposal committee's rationale runs to
    // paragraphs, not one line.
    const rationale = `Assent refused: task-1.txt still does not add a regression test. ${'Detail. '.repeat(60)}`;
    const strategy = new FakeStrategy({
      accept: async () => ({ accepted: false, procedure: 'assent', rationale, decidedAt: new Date().toISOString() }),
      // A real disposal committee can legitimately leave a genuine, unaddressed defect unresolved
      // rather than dispose it away — exactly the condition under which a regression-rule finding
      // keeps reappearing in the next cycle's complaint.
      disposeFindings: async (_ctx, open) => open,
    });
    const engine = createEngine(strategy, { maxTaskAttempts: 5 });

    const started = await start(engine);
    const state = await waitForStatus(engine, started.runId, 'terminated_incomplete');

    const regressionFindings = (state.findings ?? []).filter((f) => f.source === 'engine:regression-rule');
    expect(regressionFindings.length).toBeGreaterThanOrEqual(2);
    // Bounded: cycle 2's finding should be about the same size as cycle 1's, not compounding
    // toward it (the pre-fix behavior nearly doubled it by re-quoting cycle 1's finding in full).
    expect(regressionFindings[1].summary.length).toBeLessThan(regressionFindings[0].summary.length + 150);
  });

  it('keeps a run stopped when it is stopped during doctrine remediation', async () => {
    let engine: SwarmEngine;
    let executions = 0;
    let acceptances = 0;
    let remediationReturned!: () => void;
    const remediationComplete = new Promise<void>((resolve) => {
      remediationReturned = resolve;
    });
    const strategy = new FakeStrategy({
      execute: async (_ctx, assignment) => {
        executions += 1;
        return productFor(assignment);
      },
      accept: async () => {
        acceptances += 1;
        return {
          accepted: acceptances > 1,
          procedure: 'assent',
          rationale: acceptances > 1
            ? 'Assent given.'
            : 'Assent refused: task-1.txt calls a function that does not exist.',
          decidedAt: new Date().toISOString(),
        };
      },
      remediate: async (ctx) => {
        await Promise.resolve();
        engine.stopRun(ctx.runState.runId, 'cancelled during remediation');
        remediationReturned();
        return graphFor(['task-1']);
      },
    });
    engine = createEngine(strategy);

    const started = await start(engine);
    await remediationComplete;
    await new Promise((resolve) => setTimeout(resolve, 50));
    const state = engine.getRunStore().load(started.runId)!;

    assert.equal(state.status, 'stopped');
    assert.equal(state.graph?.nodes['task-1'].phase, 'settled');
    assert.equal(executions, 1);
  });

  // The loop holds its own copy of the state, so a stop written only to the store was overwritten by
  // the loop's next save and the run carried on (2026-10-03: every --stop-after arm kept working).
  it('stops the live loop when a run is stopped mid-task', async () => {
    let engine: SwarmEngine;
    const executed: string[] = [];
    const strategy = new FakeStrategy({
      plan: async () => graphFor(['task-1', 'task-2'], { 'task-2': ['task-1'] }),
      execute: async (ctx, assignment) => {
        executed.push(assignment.taskId);
        engine.stopRun(ctx.runState.runId, 'enough');
        return productFor(assignment);
      },
    });
    engine = createEngine(strategy);

    const started = await start(engine);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const state = engine.getRunStore().load(started.runId)!;

    assert.equal(state.status, 'stopped');
    assert.equal(state.lastError, 'Stopped: enough');
    assert.deepEqual(executed, ['task-1']);
  });

  // Bounded, so a doctrine refusing on grounds its own procedure cannot cure stops rather than
  // spending the whole allowance discovering that.
  it('stops after the bounded number of repair cycles when the doctrine keeps refusing', async () => {
    let remediations = 0;
    const engine = createEngine(refusingStrategy(Number.MAX_SAFE_INTEGER, () => { remediations += 1; }));

    const started = await start(engine);
    const state = await waitForStatus(engine, started.runId, 'terminated_incomplete');

    assert.equal(remediations, 2);
    assert.equal(state.remediationCycles, 2);
    assert.match(String(state.lastError), /did not accept its own delivery/);
  });
});

/**
 * Reopening the whole programme costs more than it recovers. A real run reopened all six of its
 * approved tasks over a CLI argument mismatch, re-ran work that had already passed — composition
 * went approved -> needs_human -> abandoned — and burned into the 300-call ceiling with nothing
 * settled. The ownership map already knows which task owns which path, so the repair is scoped.
 */
describe('SwarmEngine scopes a delivery repair to the tasks named', () => {
  function ownedGraphEngine(rationale: string, capture: (ids: string[] | undefined) => void) {
    let seen = 0;
    const strategy = new FakeStrategy({
      graph: graphFor(['first', 'second']),
      accept: async () => {
        seen += 1;
        return {
          accepted: seen > 1,
          procedure: 'assent',
          rationale: seen > 1 ? 'Assent given.' : rationale,
          decidedAt: new Date().toISOString(),
        };
      },
      remediate: async (ctx, packet) => {
        capture(packet.findings[0]?.affectedTaskIds);
        return ctx.runState.graph!;
      },
    });
    return createEngine(strategy);
  }

  it('reopens only the task owning the file the refusal names', async () => {
    let affected: string[] | undefined;
    // productFor writes "<taskId>.txt", which ownershipFromGraph records as that task's path.
    const engine = ownedGraphEngine('Assent refused: second.txt calls a function that does not exist.', (ids) => {
      affected = ids;
    });

    const started = await start(engine);
    await waitForStatus(engine, started.runId, 'awaiting_acceptance');

    assert.deepEqual(affected, ['second']);
  });

  it('terminates rather than reopening blindly when the refusal names no task', async () => {
    let remediated = false;
    const engine = ownedGraphEngine('Assent refused on general grounds.', () => { remediated = true; });

    const started = await start(engine);
    const state = await waitForStatus(engine, started.runId, 'terminated_incomplete');

    assert.equal(remediated, false);
    assert.match(String(state.lastError), /did not accept its own delivery/);
  });

  it('reopens exactly the owning tasks for a finding naming two files, and leaves the third untouched', async () => {
    let affected: string[] | undefined;
    let thirdExecutions = 0;
    let seen = 0;
    const strategy = new FakeStrategy({
      graph: graphFor(['first', 'second', 'third']),
      execute: async (ctx, assignment) => {
        if (assignment.taskId === 'third') thirdExecutions += 1;
        return productFor(assignment);
      },
      accept: async () => {
        seen += 1;
        return {
          accepted: seen > 1,
          procedure: 'assent',
          rationale: seen > 1
            ? 'Assent given.'
            : 'Assent refused: first.txt and second.txt both call a function that does not exist.',
          decidedAt: new Date().toISOString(),
        };
      },
      remediate: async (ctx, packet) => {
        affected = packet.findings[0]?.affectedTaskIds;
        // Mirrors how a real doctrine's remediate() honours scoping (e.g. SocialistStrategy):
        // only the tasks the engine actually named get reopened.
        const graph = ctx.runState.graph!;
        for (const id of affected ?? []) graph.nodes[id].phase = 'queued';
        return graph;
      },
    });
    const engine = createEngine(strategy);

    const started = await start(engine);
    const state = await waitForStatus(engine, started.runId, 'awaiting_acceptance');

    assert.deepEqual([...(affected ?? [])].sort(), ['first', 'second']);
    assert.equal(thirdExecutions, 1);
    assert.equal(state.graph?.nodes.third.phase, 'settled');
    assert.equal(state.graph?.nodes.third.attempts.length, 1);
  });

  it('uses path evidence from a failed integration barrier to scope repair', async () => {
    let affected: string[] | undefined;
    let acceptances = 0;
    const strategy = new FakeStrategy({
      graph: graphFor(['first', 'second']),
      integrate: async () => ({
        integratorId: 'integration-council',
        integrated: false,
        postIntegrationChecks: [],
        findings: [{
          source: 'integration-council',
          summary: 'The command entry point is incomplete.',
          evidenceRefs: ['second.txt'],
          disposition: 'unresolved',
          dispositionRationale: 'Awaiting repair.',
        }],
        rationale: 'The common tree is incomplete.',
      }),
      accept: async () => ({
        accepted: ++acceptances > 1,
        procedure: 'assent',
        rationale: acceptances > 1 ? 'Assent given.' : 'The integration barrier did not pass.',
        decidedAt: new Date().toISOString(),
      }),
      remediate: async (ctx, packet) => {
        affected = packet.findings[0]?.affectedTaskIds;
        return ctx.runState.graph!;
      },
    });
    const engine = createEngine(strategy);

    const started = await start(engine);
    await waitForStatus(engine, started.runId, 'awaiting_acceptance');

    assert.deepEqual(affected, ['second']);
  });
});

describe('SwarmEngine hands foreign-owner rework to graph remediation', () => {
  it('reopens the responsible owner before retrying the blocked task', async () => {
    const graph = graphFor(['implementation', 'tests']);
    graph.nodes.tests.dependsOn = ['implementation'];
    const executions: string[] = [];
    let testsRejected = false;
    let affectedTaskIds: string[] | undefined;
    const strategy = new FakeStrategy({
      graph,
      execute: async (_ctx, assignment) => {
        executions.push(assignment.taskId);
        return productFor(assignment);
      },
      decide: async (_ctx, product) => {
        if (product.taskId === 'tests' && !testsRejected) {
          testsRejected = true;
          return {
            taskId: product.taskId,
            outcome: 'rework',
            rationale: 'implementation.txt has a syntax error that prevents the tests from importing it.',
            evidenceRefs: ['implementation.txt'],
            rework: { requiredChanges: ['Repair implementation.txt in its owning task.'] },
          };
        }
        return decisionFor(product.taskId, 'approved');
      },
      recover: async () => undefined,
      remediate: async (ctx, packet) => {
        affectedTaskIds = packet.findings[0]?.affectedTaskIds;
        for (const taskId of affectedTaskIds ?? []) ctx.runState.graph!.nodes[taskId].phase = 'queued';
        return ctx.runState.graph!;
      },
    });
    const engine = createEngine(strategy, { maxTaskAttempts: 3 });

    const started = await start(engine);
    const state = await waitForStatus(engine, started.runId, 'awaiting_acceptance');

    expect(affectedTaskIds).toEqual(['implementation', 'tests']);
    expect(executions).toEqual(['implementation', 'tests', 'implementation', 'tests']);
    expect(state.graph?.nodes.implementation.phase).toBe('settled');
    expect(state.graph?.nodes.tests.phase).toBe('settled');
    expect(readLedger(started.runId)).toContainEqual(expect.objectContaining({
      type: 'ownership_handoff',
      data: expect.objectContaining({ taskId: 'tests', ownerTaskIds: ['implementation'] }),
    }));
  });

  // repairbrief-r1 single_agent: tests blamed the source, the reopened source blamed the tests, and
  // both were abandoned waiting on each other.
  it('does not hand a defect back to an owner that is already waiting on this task', async () => {
    const graph = graphFor(['implementation', 'tests']);
    graph.nodes.tests.dependsOn = ['implementation'];
    const executions: string[] = [];
    let testsBlamed = false;
    let implementationBlamed = false;
    const blame = (taskId: string, path: string): Decision => ({
      taskId, outcome: 'rework', rationale: `${path} is wrong.`, evidenceRefs: [path],
      rework: { requiredChanges: [`Repair ${path}.`] },
    });
    const strategy = new FakeStrategy({
      graph,
      execute: async (_ctx, assignment) => {
        executions.push(assignment.taskId);
        return productFor(assignment);
      },
      decide: async (_ctx, product) => {
        if (product.taskId === 'tests' && !testsBlamed) {
          testsBlamed = true;
          return blame('tests', 'implementation.txt');
        }
        if (product.taskId === 'implementation' && testsBlamed && !implementationBlamed) {
          implementationBlamed = true;
          return blame('implementation', 'tests.txt');
        }
        return decisionFor(product.taskId, 'approved');
      },
      recover: async () => undefined,
      remediate: async (ctx, packet) => {
        for (const taskId of packet.findings[0]?.affectedTaskIds ?? []) ctx.runState.graph!.nodes[taskId].phase = 'queued';
        return ctx.runState.graph!;
      },
    });
    const engine = createEngine(strategy, { maxTaskAttempts: 4 });

    const started = await start(engine);
    const state = await waitForStatus(engine, started.runId, 'awaiting_acceptance');

    expect(state.graph?.nodes.implementation.phase).toBe('settled');
    expect(state.graph?.nodes.tests.phase).toBe('settled');
    expect(executions.filter((id) => id === 'implementation')).toHaveLength(3);
    expect(executions.filter((id) => id === 'tests')).toHaveLength(2);
    expect(readLedger(started.runId)).toContainEqual(expect.objectContaining({
      type: 'ownership_handoff_declined',
      data: expect.objectContaining({ taskId: 'implementation', ownerTaskIds: ['tests'] }),
    }));
  });

  // full-concurrent-explain-4: every arm's tests task failed on code it did not own, was handed
  // off with its tests reverted, and the owners were reopened against an empty suite.
  it('keeps the handed-off tests in place for the owners and the remediation checks', async () => {
    const graph = graphFor(['implementation', 'tests']);
    graph.nodes.tests.dependsOn = ['implementation'];
    let handedOff = false;
    let testFileDuringRemediation: string | null | undefined;
    const strategy = new FakeStrategy({
      graph,
      execute: async (_ctx, assignment) => assignment.taskId === 'tests'
        ? { ...productFor(assignment), fileOps: [{ op: 'write', path: 'tests/test_impl.py', content: 'def test_x(): pass\n' }] }
        : productFor(assignment),
      decide: async (_ctx, product) => {
        if (product.taskId === 'tests' && !handedOff) {
          handedOff = true;
          return {
            taskId: 'tests', outcome: 'rework',
            rationale: 'implementation.txt raises, so the new tests fail.',
            evidenceRefs: ['implementation.txt'],
            rework: { requiredChanges: ['Repair implementation.txt in its owning task.'] },
          };
        }
        return decisionFor(product.taskId, 'approved');
      },
      recover: async () => undefined,
      remediate: async (ctx, packet) => {
        testFileDuringRemediation = ctx.worktree.readFileIfExists('tests/test_impl.py');
        for (const taskId of packet.findings[0]?.affectedTaskIds ?? []) ctx.runState.graph!.nodes[taskId].phase = 'queued';
        return ctx.runState.graph!;
      },
    });
    const engine = createEngine(strategy, { maxTaskAttempts: 3 });

    const started = await start(engine);
    await waitForStatus(engine, started.runId, 'awaiting_acceptance');

    expect(testFileDuringRemediation).toBe('def test_x(): pass\n');
    expect(readLedger(started.runId)).toContainEqual(expect.objectContaining({
      type: 'ownership_handoff',
      data: expect.objectContaining({ taskId: 'tests', keptTestFiles: ['tests/test_impl.py'] }),
    }));
  });

  it('keeps only attempts made purely of test files', () => {
    expect(keepsTestsForOwners([{ op: 'write', path: 'tests/test_a.py' }])).toBe(true);
    expect(keepsTestsForOwners([{ op: 'write', path: 'tests/test_a.py' }, { op: 'edit', path: 'pkg/cli.py' }])).toBe(false);
    expect(keepsTestsForOwners([{ op: 'delete', path: 'tests/test_a.py' }])).toBe(false);
    expect(keepsTestsForOwners([])).toBe(false);
  });

  // From democratic-muqvvqtl-b333c0: the sovereign's refusal of cli-plot also found damage.py
  // clamping energies, but only cli-plot was reopened; meanwhile a "[low]" compliment from the
  // integrator reopened core-modules as a high-severity defect.
  it('reopens every task a refusal names and ignores low integration observations', async () => {
    const graph = graphFor(['core', 'cli'], { cli: ['core'] });
    let packetFindings: RemediationFinding[] | undefined;
    const strategy = new FakeStrategy({
      graph,
      decide: async (_ctx, product) => product.taskId === 'cli'
        ? {
            taskId: 'cli',
            outcome: 'rework',
            rationale: 'cli.txt still crashes, and core.txt clamps out-of-range energies instead of raising.',
            evidenceRefs: ['cli.txt'],
            rework: { requiredChanges: ['Fix the crash.'] },
          }
        : decisionFor(product.taskId, 'approved'),
      recover: async () => undefined,
      integrate: async () => ({
        integratorId: 'stub-integrator',
        integrated: true,
        postIntegrationChecks: [],
        findings: [{
          source: 'stub-integrator',
          summary: '[low] Interpolation in core.txt is centralized.',
          evidenceRefs: ['core.txt'],
          disposition: 'unresolved',
          dispositionRationale: 'raised',
        }],
        rationale: 'integrated',
      }),
      remediate: async (ctx, packet) => {
        packetFindings ??= packet.findings;
        return ctx.runState.graph!;
      },
    });
    const engine = createEngine(strategy, { maxTaskAttempts: 2 });

    const started = await start(engine);
    await waitForSettled(engine, started.runId);

    // cli has no attempts left, so only core can carry the diagnosis; the low observation is gone.
    expect(packetFindings?.map(({ summary, affectedTaskIds }) => ({ summary, affectedTaskIds }))).toEqual([
      { summary: 'Task cli was abandoned before the graph integrated.', affectedTaskIds: ['core'] },
    ]);
    expect(packetFindings?.[0].evidence).toContain('core.txt clamps out-of-range energies');
  });

  it('does not retry the blocked task when its responsible owner is exhausted', async () => {
    const graph = graphFor(['implementation', 'tests']);
    graph.nodes.tests.dependsOn = ['implementation'];
    let testExecutions = 0;
    const strategy = new FakeStrategy({
      graph,
      execute: async (_ctx, assignment) => {
        if (assignment.taskId === 'tests') testExecutions += 1;
        return productFor(assignment);
      },
      decide: async (_ctx, product) => product.taskId === 'tests'
        ? {
            taskId: product.taskId,
            outcome: 'rework',
            rationale: 'implementation.txt is invalid.',
            evidenceRefs: ['implementation.txt'],
            rework: { requiredChanges: ['Repair implementation.txt in its owning task.'] },
          }
        : decisionFor(product.taskId, 'approved'),
      recover: async () => undefined,
    });
    const engine = createEngine(strategy, { maxTaskAttempts: 1 });

    const started = await start(engine);
    const state = await waitForSettled(engine, started.runId);

    expect(testExecutions).toBe(1);
    expect(state.graph?.nodes.tests.blockedByForeignTaskIds).toEqual(['implementation']);
    expect(state.graphRemediationCycles).toBe(0);
  });

  /**
   * Regression for a real Democratic benchmark run: two tasks each blocked the other, so every
   * remediation cycle reopened the exact same two tasks and got the exact same result back — a
   * genuine deadlock, not a doctrine converging. Raising the cycle ceiling to give it "one more
   * try" instead let that extra pass rewrite the graph again and delete an already-correct file.
   * A cycle that resubmits the identical affected-task set as the one before it must stop instead
   * of retrying.
   */
  it('never lets two tasks that blame each other both wait on the other', async () => {
    // 'a' owns a.txt and blames b.txt for its rejection; 'b' owns b.txt and blames a.txt right
    // back, the way a real Democratic run's `cli`/`pkg-structure` motions did. Both used to be
    // abandoned waiting on each other and graph remediation stalled after one round. Now 'b'
    // declines to hand back to a task already waiting on it and spends its own attempts instead.
    const graph = graphFor(['a', 'b']);
    let remediateCalls = 0;
    const strategy = new FakeStrategy({
      graph,
      decide: async (_ctx, product) => ({
        taskId: product.taskId,
        outcome: 'rework',
        rationale: 'blames the other task for this test',
        evidenceRefs: [product.taskId === 'a' ? 'b.txt' : 'a.txt'],
        rework: { requiredChanges: ['Fix the file the other task owns.'] },
      }),
      recover: async () => undefined,
      remediate: async (ctx, packet) => {
        remediateCalls += 1;
        for (const finding of packet.findings) {
          for (const taskId of finding.affectedTaskIds ?? []) {
            ctx.runState.graph!.nodes[taskId].phase = 'queued';
          }
        }
        return ctx.runState.graph!;
      },
    });
    const engine = createEngine(strategy, { maxTaskAttempts: 5 });

    const started = await start(engine);
    const state = await waitForStatus(engine, started.runId, 'terminated_incomplete');

    const waiting = Object.values(state.graph!.nodes).filter((node) => node.blockedByForeignTaskIds?.length);
    expect(waiting).toHaveLength(1);
    const keeper = Object.values(state.graph!.nodes).find((node) => !node.blockedByForeignTaskIds?.length)!;
    expect(keeper.attempts).toHaveLength(5);
    expect(remediateCalls).toBe(0);
    expect(readLedger(started.runId)).toContainEqual(expect.objectContaining({
      type: 'ownership_handoff_declined',
      data: expect.objectContaining({ taskId: keeper.id }),
    }));
  });
});

describe('SwarmEngine graph remediation of an abandoned owner\'s files', () => {
  it('hands a file owned only by an abandoned task to the reopened task that needs it', async () => {
    // 'skel' owns skel.txt and is rejected outright; 'cli' depends on it. Integration then reports
    // skel.txt missing. Before the transfer the finding mapped only to 'skel', which cannot run
    // again, so nothing was reopened and no other task could write the file.
    const graph = graphFor(['skel', 'cli'], { cli: ['skel'] });
    let integrations = 0;
    const packets: string[][] = [];
    const strategy = new FakeStrategy({
      graph,
      decide: async (_ctx, product) => product.taskId === 'skel'
        ? { taskId: 'skel', outcome: 'rejected', rationale: 'refused for this test', evidenceRefs: [] }
        : { taskId: product.taskId, outcome: 'approved', rationale: 'accepted', evidenceRefs: [] },
      execute: async (ctx, assignment) => {
        const product = productFor(assignment);
        if (assignment.taskId === 'cli' && ctx.runState.ownership?.entries.cli?.paths.includes('skel.txt')) {
          product.fileOps.push({ op: 'write', path: 'skel.txt', content: 'repaired\n' });
        }
        return product;
      },
      integrate: async () => {
        integrations += 1;
        return {
          integratorId: 'fake-integrator',
          integrated: integrations > 1,
          postIntegrationChecks: [],
          findings: integrations > 1 ? [] : [{
            source: 'fake-integrator',
            summary: 'skel.txt is missing from the combined tree',
            evidenceRefs: ['skel.txt'],
            disposition: 'unresolved' as const,
            dispositionRationale: 'raised for this test',
          }],
          rationale: 'integration for this test',
        };
      },
      remediate: async (ctx, packet) => {
        packets.push([...new Set(packet.findings.flatMap((f) => f.affectedTaskIds ?? []))]);
        for (const finding of packet.findings) {
          for (const taskId of finding.affectedTaskIds ?? []) ctx.runState.graph!.nodes[taskId].phase = 'queued';
        }
        return ctx.runState.graph!;
      },
    });
    const engine = createEngine(strategy);

    const started = await start(engine);
    await waitForSettled(engine, started.runId);
    const ledger = readLedger(started.runId);

    expect(ledger).toContainEqual(expect.objectContaining({
      type: 'ownership_transferred',
      data: expect.objectContaining({ path: 'skel.txt', from: ['skel'], to: 'cli' }),
    }));
    expect(packets[0]).toContain('cli');
    expect(ledger.some((e) => e.type === 'finding_raised' && String(e.data.summary).includes('outside its declared ownership'))).toBe(false);
    expect(readFileSync(path.join(engine.getRunStore().load(started.runId)!.worktreePath, 'skel.txt'), 'utf8')).toBe('repaired\n');
  });
});

describe('SwarmEngine final-only checks', () => {
  it('raises a non-waivable finding when a required final-only check fails', async () => {
    const engine = createEngine(new FakeStrategy(), {
      finalOnlyChecks: [{
        id: 'benchmark-cli',
        command: 'git',
        args: ['rev-parse', '--verify', 'missing-ref'],
        timeoutMs: 1_000,
        required: true,
      }],
    });

    const started = await start(engine);
    const state = await waitForStatus(engine, started.runId, 'terminated_incomplete');
    const finding = state.findings?.find((item) => item.source === 'engine:checks');

    assert.equal(finding?.nonWaivable, true);
    assert.match(finding?.summary ?? '', /benchmark-cli/);
    assert.notEqual(state.status, 'awaiting_acceptance');
  });

  /**
   * Regression for the v24 socialist benchmark run: the literal CLI final check executes the
   * delivered program, which can write real output into the worktree (e.g. a results CSV) as a
   * side effect of merely being checked. That output must never be mistaken for something the
   * swarm authored and forgot to explain — not in the delivery packet's diff, and not left behind
   * for the next remediation cycle to trip over.
   */
  it('does not attribute a final-only check\'s generated output to the delivery diff', async () => {
    const engine = createEngine(new FakeStrategy(), {
      finalOnlyChecks: [{
        id: 'benchmark-cli',
        command: process.execPath,
        args: ['-e', "require('fs').writeFileSync('generated-output.csv', 'a,b\\n1,2\\n')"],
        timeoutMs: 5_000,
        required: true,
      }],
    });

    const started = await start(engine);
    const state = await waitForStatus(engine, started.runId, 'awaiting_acceptance');

    assert.ok(!state.delivery?.changedFiles.includes('generated-output.csv'));
    assert.doesNotMatch(state.delivery?.diffText ?? '', /generated-output\.csv/);
    // runFinalOnlyChecks captures the generated file as check evidence (final_check_artifacts) and
    // strips it from the worktree itself, before the acceptance barrier's own cleanCheckArtifacts
    // pass runs — so that later pass finds nothing left over to report. final_check_artifacts is
    // the record of what actually happened to this file.
    assert.ok(
      readLedger(started.runId).some(
        (entry) => entry.type === 'final_check_artifacts' &&
          (entry.data.artifacts as Array<{ path: string }>).some((a) => a.path === 'generated-output.csv'),
      ),
    );
    assert.equal(existsSync(path.join(runsRootDir, started.runId, 'wt', 'generated-output.csv')), false);
  });
});

/**
 * A requeued sign-off refusal used to carry nothing back with it, so the next attempt began exactly
 * as blind as the one that had just failed. One task spent all six of its attempts on needs_human,
 * every one refused for the same failing check, every one starting over knowing none of it.
 */
describe('SwarmEngine carries sign-off refusals into the next attempt', () => {
  function refusedTwice() {
    return new FakeStrategy({
      decide: async (_ctx, product) => decisionFor(product.taskId, 'needs_human'),
      requiresHumanApproval: () => true,
    });
  }

  it('records the reason the reviewer gave, on the node it sent back', async () => {
    const engine = createEngine(refusedTwice(), { maxTaskAttempts: 3 });

    const started = await start(engine);
    const paused = await waitForStatus(engine, started.runId, 'paused_human');
    const state = engine.resolveApproval(
      started.runId,
      paused.pendingApprovals[0].id,
      'reject',
      'required independent check(s) did not pass: unit.',
    );

    expect(state.graph!.nodes['task-1'].signOffRefusals).toHaveLength(1);
    expect(state.graph!.nodes['task-1'].signOffRefusals?.[0]).toContain('needs human sign-off');
    expect(state.graph!.nodes['task-1'].signOffRefusals?.[0]).toContain(
      'required independent check(s) did not pass: unit.',
    );
  });

  it('keeps every refusal, so a repeated failure is visible as repeated', async () => {
    const engine = createEngine(refusedTwice(), { maxTaskAttempts: 4 });

    const started = await start(engine);
    for (const reason of ['first refusal', 'second refusal']) {
      const paused = await waitForStatus(engine, started.runId, 'paused_human');
      const pending = paused.pendingApprovals.find((candidate) => !candidate.resolvedAt);
      engine.resolveApproval(started.runId, pending!.id, 'reject', reason);
    }
    const state = engine.getRunStore().load(started.runId)!;

    expect(state.graph!.nodes['task-1'].signOffRefusals).toHaveLength(2);
    expect(state.graph!.nodes['task-1'].signOffRefusals?.[0]).toContain('first refusal');
    expect(state.graph!.nodes['task-1'].signOffRefusals?.[1]).toContain('second refusal');
  });

  it('keeps the refusal on a task it abandons', async () => {
    const engine = createEngine(refusedTwice(), { maxTaskAttempts: 1 });

    const started = await start(engine);
    const paused = await waitForStatus(engine, started.runId, 'paused_human');
    const state = engine.resolveApproval(started.runId, paused.pendingApprovals[0].id, 'reject', 'Fix DATA_DIR.');

    expect(state.graph!.nodes['task-1'].phase).toBe('abandoned');
    expect(abandonedTaskEvidence(state.graph!.nodes['task-1'])).toContain('Fix DATA_DIR.');
  });

  it('records nothing when the sign-off was granted', async () => {
    const engine = createEngine(refusedTwice(), { maxTaskAttempts: 3 });

    const started = await start(engine);
    const paused = await waitForStatus(engine, started.runId, 'paused_human');
    const state = engine.resolveApproval(started.runId, paused.pendingApprovals[0].id, 'approve', 'looks fine');

    expect(state.graph!.nodes['task-1'].signOffRefusals).toBeUndefined();
    await waitForStatus(engine, started.runId, 'awaiting_acceptance');
  });
});

describe('SwarmEngine permits approval of the final allowed attempt', () => {
  it('settles a needs-human diff even when no retry remains', async () => {
    const strategy = new FakeStrategy({
      decide: async (_ctx, product) => decisionFor(product.taskId, 'needs_human'),
      requiresHumanApproval: () => true,
    });
    const engine = createEngine(strategy, { maxTaskAttempts: 1 });

    const started = await start(engine);
    const paused = await waitForStatus(engine, started.runId, 'paused_human');
    const state = engine.resolveApproval(started.runId, paused.pendingApprovals[0].id, 'approve');

    assert.equal(state.graph!.nodes['task-1'].phase, 'settled');
    assert.equal(state.graph!.nodes['task-1'].attempts.length, 1);
    assert.equal(state.graph!.nodes['task-1'].attempts[0].outcome, 'approved');
    assert.equal(state.pendingApprovals[0].resolution, 'approve');
    await waitForStatus(engine, started.runId, 'awaiting_acceptance');
  });

  it('still asks while attempts remain', async () => {
    const strategy = new FakeStrategy({
      decide: async (_ctx, product) => decisionFor(product.taskId, 'needs_human'),
      requiresHumanApproval: () => true,
    });
    const engine = createEngine(strategy, { maxTaskAttempts: 3 });

    const started = await start(engine);
    const paused = await waitForStatus(engine, started.runId, 'paused_human');

    assert.equal(paused.graph!.nodes['task-1'].phase, 'blocked');
    assert.equal(paused.pendingApprovals.filter((a) => a.kind === 'final_diff').length, 1);
  });
});

describe('SwarmEngine handleLoopCrash', () => {
  it('requeues a run that crashes on a transient provider failure, up to the ceiling', async () => {
    let planCalls = 0;
    const strategy = new FakeStrategy({
      plan: async () => {
        planCalls += 1;
        throw new Error('provider exceeded the per-call timeout');
      },
    });
    const engine = createEngine(strategy);

    const started = await start(engine);
    const state = await waitForStatus(engine, started.runId, 'failed');

    assert.equal(planCalls, MAX_TRAILING_TRANSIENT_ATTEMPTS + 1);
    assert.equal(state.loopCrashRetries, MAX_TRAILING_TRANSIENT_ATTEMPTS + 1);
    assert.match(state.lastError!, /exceeded the per-call timeout/);
  });

  it('fails a run immediately on a non-transient loop crash', async () => {
    let planCalls = 0;
    const strategy = new FakeStrategy({
      plan: async () => {
        planCalls += 1;
        throw new Error('doctrine orchestration raised an unexpected exception');
      },
    });
    const engine = createEngine(strategy);

    const started = await start(engine);
    const state = await waitForStatus(engine, started.runId, 'failed');

    assert.equal(planCalls, 1);
    assert.equal(state.loopCrashRetries, undefined);
  });

  // A council that will not ratify any plan is the doctrine refusing, not the engine breaking:
  // socialist pure r2 on 2026-10-04 ended "failed" with nothing recorded as the reason it stopped.
  it('ends a governance halt incomplete with its reason, not failed', async () => {
    const strategy = new FakeStrategy({
      plan: async () => {
        throw new GovernanceHaltError('Council ratification withheld: council-damage: remove the contradiction');
      },
    });
    const engine = createEngine(strategy);

    const started = await start(engine);
    const state = await waitForStatus(engine, started.runId, 'terminated_incomplete');

    assert.match(state.lastError!, /Council ratification withheld/);
    assert.ok(readLedger(started.runId).some((entry) => entry.type === 'terminated_incomplete'));
  });
});

/** Like waitForSettled, but a run parked for a human also counts as having stopped making progress. */
async function waitForEnd(engine: SwarmEngine, runId: string): Promise<RunState> {
  const ended = new Set<RunState['status']>([
    'completed', 'failed', 'stopped', 'terminated_incomplete', 'awaiting_acceptance', 'paused_human', 'paused_budget',
  ]);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const state = engine.getRunStore().load(runId);
    if (state && ended.has(state.status)) return state;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Run ${runId} did not end`);
}
