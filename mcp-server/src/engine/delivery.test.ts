import { describe, it, expect } from 'vitest';
import {
  assembleDelivery,
  buildRequirementMatrix,
  deliveryPacketErrors,
  newFinding,
  sensitivePaths,
  unevidencedCriteria,
} from './delivery.js';
import { findingDispositionError, type Finding } from './packets.js';
import { normalizeChecksConfig } from '../util/config.js';
import type { RunState } from './RunStore.js';

const checks = normalizeChecksConfig({ command: 'npm', args: ['test'], timeoutMs: 1_000 });

function stateWith(overrides: Partial<RunState> = {}): RunState {
  return {
    runId: 'run-1',
    strategy: 'democratic',
    task: { goal: 'do the thing', acceptanceCriteria: ['it works', 'it is tested'] },
    repoPath: '/repo',
    baseBranch: 'main',
    worktreePath: '/wt',
    branch: 'swarm/run-1',
    status: 'running',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    budgetUsd: 1,
    costUsd: 0,
    tokensUsed: { prompt: 0, completion: 0 },
    workerCalls: 0,
    graph: null,
    pendingApprovals: [],
    findings: [],
    ...overrides,
  };
}

function graphWithEvidence(): RunState['graph'] {
  return {
    order: ['t1'],
    nodes: {
      t1: {
        id: 't1',
        title: 'Do it',
        description: '',
        acceptanceCriteria: ['it works'],
        dependsOn: [],
        targetGlobs: [],
        riskTags: [],
        riskClass: 'low',
        phase: 'settled',
        attempts: [{
          attempt: 1,
          outcome: 'approved',
          rationale: 'approved by test',
          evidenceRefs: [],
          fingerprint: '',
          repeated: false,
          at: '2026-01-01T00:00:00.000Z',
        }],
        evidence: [
          { criterion: 'it works', command: 'npm test', expectedResult: 'exit 0', status: 'satisfied' },
        ],
      },
    },
  };
}

function finding(overrides: Partial<Finding> = {}): Finding {
  return newFinding({
    source: 'reviewer',
    summary: 'something',
    evidenceRefs: [],
    disposition: 'accepted',
    dispositionRationale: 'fixed and rechecked',
    ...overrides,
  });
}

const integration = {
  integratorId: 'integration-committee',
  integrated: true,
  postIntegrationChecks: [],
  findings: [],
  rationale: 'holds together',
};

const verification = {
  verifierId: 'commons-verifier',
  verified: true,
  criteriaTraced: ['it works'],
  findings: [],
  rationale: 'traced',
};

const acceptance = { accepted: true, procedure: 'gate', rationale: 'ok', decidedAt: '2026-01-01T00:00:00.000Z' };

describe('buildRequirementMatrix', () => {
  it('gives every user criterion a row, including ones with no evidence at all', () => {
    const matrix = buildRequirementMatrix(stateWith({ graph: graphWithEvidence() }));

    expect(matrix.map((m) => m.criterion)).toEqual(['it works', 'it is tested']);
    expect(matrix[0].status).toBe('satisfied');
    expect(matrix[1].status).toBe('unavailable');
    expect(matrix[1].note).toContain('No test, command or named manual inspection');
  });
});

describe('unevidencedCriteria', () => {
  it('reports criteria that are unavailable or unsatisfied', () => {
    const matrix = buildRequirementMatrix(stateWith({ graph: graphWithEvidence() }));

    expect(unevidencedCriteria(matrix, ['it works', 'it is tested']).map((m) => m.criterion)).toEqual([
      'it is tested',
    ]);
  });

  it('ignores extra evidence rows that are not user criteria', () => {
    const matrix = [
      { criterion: 'internal detail', command: 'x', expectedResult: 'y', status: 'unavailable' as const },
    ];

    expect(unevidencedCriteria(matrix, ['it works'])).toEqual([]);
  });
});

describe('findingDispositionError', () => {
  it('accepts a well-formed deferred finding', () => {
    const f = finding({ disposition: 'deferred', owner: 'backend council', returnCondition: 'next release' });

    expect(findingDispositionError(f)).toBeNull();
  });

  it('rejects a deferred finding with no owner', () => {
    const f = finding({ disposition: 'deferred', returnCondition: 'next release' });

    expect(findingDispositionError(f)).toContain('names no owner');
  });

  it('rejects a deferred finding with no return condition', () => {
    const f = finding({ disposition: 'deferred', owner: 'backend council' });

    expect(findingDispositionError(f)).toContain('names no return condition');
  });

  it('rejects any disposition with an empty rationale', () => {
    const f = finding({ dispositionRationale: '   ' });

    expect(findingDispositionError(f)).toContain('no rationale');
  });
});

describe('assembleDelivery', () => {
  const base = {
    state: stateWith({ graph: graphWithEvidence() }),
    checks,
    baseRevision: 'abc123',
    diffText: 'diff',
    changedFiles: ['src/a.ts'],
    finalChecks: [
      { categoryId: 'unit', command: 'npm', args: ['test'], ran: true, passed: true },
    ],
    findings: [],
    integration,
    verification,
    acceptance,
  };

  it('discloses an unevidenced criterion as a limitation', () => {
    const packet = assembleDelivery(base);

    expect(packet.limitations.some((l) => l.includes('it is tested'))).toBe(true);
  });

  it('carries unresolved and deferred findings into residual risks', () => {
    const packet = assembleDelivery({
      ...base,
      findings: [
        finding({ summary: 'race condition', disposition: 'unresolved', dispositionRationale: 'stands' }),
        finding({
          summary: 'slow query',
          disposition: 'deferred',
          dispositionRationale: 'out of mandate',
          owner: 'data guild',
          returnCondition: 'next run',
        }),
        finding({ summary: 'typo', disposition: 'accepted' }),
      ],
    });

    expect(packet.residualRisks).toHaveLength(2);
    expect(packet.residualRisks.some((r) => r.includes('race condition'))).toBe(true);
    expect(packet.residualRisks.some((r) => r.includes('typo'))).toBe(false);
  });

  it('surfaces minority reports separately without removing them from findings', () => {
    const dissent = finding({ summary: 'the approach is wrong', minority: true, disposition: 'rejected' });
    const packet = assembleDelivery({ ...base, findings: [dissent] });

    expect(packet.minorityReports).toHaveLength(1);
    expect(packet.findings).toHaveLength(1);
  });

  it('always states a rollback path', () => {
    expect(assembleDelivery(base).rollback).toContain('swarm/run-1');
  });

  it('records check artifacts separately from authored changed files', () => {
    const packet = assembleDelivery({
      ...base,
      changedFiles: ['src/a.ts'],
      checkArtifacts: [
        {
          path: 'generated.csv',
          checkCategoryId: 'benchmark-cli',
          capturedAt: '2026-01-01T00:00:00.000Z',
          evidencePath: 'check-artifacts/0/benchmark-cli/generated.csv',
        },
      ],
    });

    expect(packet.changedFiles).toEqual(['src/a.ts']);
    expect(packet.changedFiles).not.toContain('generated.csv');
    expect(packet.checkArtifacts).toEqual([
      expect.objectContaining({ path: 'generated.csv', checkCategoryId: 'benchmark-cli' }),
    ]);
  });

  // The doctrine-neutral notes channel: a doctrine may disclose something that is neither a check
  // result nor a finding — an unmet criterion its own scrutiny recorded, a warranty exclusion, a
  // council's shortfall. Additive only, and it can never remove what the engine found.
  describe('a doctrine’s own disclosures', () => {
    const withNotes = (deliveryNotes: unknown) => ({
      ...base,
      state: stateWith({ graph: graphWithEvidence(), strategyState: { deliveryNotes } }),
    });

    it('appends the doctrine’s limitations and residual risks', () => {
      const packet = assembleDelivery(
        withNotes({ limitations: ['the House recorded this as unmet'], residualRisks: ['a risk with no finding'] }),
      );

      expect(packet.limitations).toContain('the House recorded this as unmet');
      expect(packet.residualRisks).toContain('a risk with no finding');
    });

    it('keeps the engine’s own limitations alongside them', () => {
      const packet = assembleDelivery(withNotes({ limitations: ['doctrine note'] }));
      expect(packet.limitations.some((l) => l.includes('it is tested'))).toBe(true);
    });

    it('adds to the rollback instructions rather than replacing them', () => {
      const packet = assembleDelivery(withNotes({ rollbackNotes: ['Motion m1 must be reverted first.'] }));
      expect(packet.rollback).toContain('swarm/run-1');
      expect(packet.rollback).toContain('Motion m1 must be reverted first.');
    });

    it('ignores malformed notes rather than putting rubbish in the manifest', () => {
      const packet = assembleDelivery(withNotes({ limitations: [42, '', '  ', 'kept'], residualRisks: 'not an array' }));
      expect(packet.limitations).toContain('kept');
      expect(packet.limitations).not.toContain('');
      expect(packet.residualRisks).toEqual([]);
    });

    it('behaves exactly as before when a doctrine files nothing', () => {
      const silent = assembleDelivery(withNotes(undefined));
      const original = assembleDelivery(base);
      // Field by field rather than whole-packet: assembledAt is a wall-clock stamp, and comparing
      // it would make this test pass or fail on which millisecond the two calls landed in.
      expect(silent.limitations).toEqual(original.limitations);
      expect(silent.residualRisks).toEqual(original.residualRisks);
      expect(silent.rollback).toEqual(original.rollback);
    });
  });
});

describe('deliveryPacketErrors', () => {
  const packet = () =>
    assembleDelivery({
      state: stateWith({ graph: graphWithEvidence() }),
      checks,
      baseRevision: 'abc123',
      diffText: 'diff',
      changedFiles: [],
      finalChecks: [],
      findings: [],
      integration,
      verification,
      acceptance,
    });

  it('passes a well-formed manifest', () => {
    expect(deliveryPacketErrors(packet())).toEqual([]);
  });

  it('rejects a manifest whose verifier is also its integrator', () => {
    const p = packet();
    p.independentVerification = { ...verification, verifierId: integration.integratorId };

    expect(deliveryPacketErrors(p)[0]).toContain('outside the authorship chain');
  });

  it('rejects a manifest carrying a malformed finding disposition', () => {
    const p = packet();
    p.findings = [finding({ disposition: 'deferred', owner: undefined, returnCondition: undefined })];

    expect(deliveryPacketErrors(p)[0]).toContain('names no owner');
  });

  it('rejects a manifest with no rollback statement', () => {
    const p = packet();
    p.rollback = '';

    expect(deliveryPacketErrors(p).some((e) => e.includes('rollback'))).toBe(true);
  });
});

describe('sensitivePaths', () => {
  it('flags files that run code outside the checks, at any depth and in any case', () => {
    const flagged = [
      '.github/workflows/ci.yml',
      '.gitlab-ci.yml',
      '.husky/pre-commit',
      '.gitattributes',
      '.gitmodules',
      '.envrc',
      '.vscode/tasks.json',
      'packages/web/package.json',
      'pyproject.toml',
      'setup.py',
      'Makefile',
      'tox.ini',
      'noxfile.py',
      '.npmrc',
      'lib/makefile',
    ];
    expect(sensitivePaths(flagged)).toEqual(flagged);
  });

  it('leaves ordinary source, tests, docs and inert git files alone', () => {
    expect(sensitivePaths(['src/index.ts', 'tests/test_x.py', 'README.md', '.gitignore', '.github/CODEOWNERS', 'docs/package.json.md'])).toEqual([]);
  });
});
