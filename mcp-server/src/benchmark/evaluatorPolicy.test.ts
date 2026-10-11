import { describe, expect, it } from 'vitest';
import type { CheckRunRecord, DeliveryPacket, EvidenceItem } from '../engine/packets.js';
import type { PendingApproval, PendingApprovalKind } from '../engine/types.js';
import {
  BenchmarkAllowance,
  decideApproval,
  decideDelivery,
  evaluatorDecisionLedgerData,
} from './evaluatorPolicy.js';

function approval(kind: PendingApprovalKind, overrides: Partial<PendingApproval> = {}): PendingApproval {
  return {
    id: `${kind}-1`,
    kind,
    description: `Approval request for ${kind}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function check(overrides: Partial<CheckRunRecord> = {}): CheckRunRecord {
  return {
    categoryId: 'unit',
    command: 'npm',
    args: ['test'],
    ran: true,
    passed: true,
    ...overrides,
  };
}

function evidence(overrides: Partial<EvidenceItem> = {}): EvidenceItem {
  return {
    criterion: 'The change works',
    command: 'npm test',
    expectedResult: 'exit 0',
    status: 'satisfied',
    ...overrides,
  };
}

function delivery(overrides: Partial<DeliveryPacket> = {}): DeliveryPacket {
  return {
    runId: 'run-1',
    strategy: 'democratic',
    baseRevision: 'abc123',
    branch: 'swarm/run-1',
    goal: 'Make the change',
    acceptanceCriteria: ['The change works'],
    changedFiles: ['src/change.ts'],
    diffText: 'diff',
    requirementMatrix: [evidence()],
    baseline: [],
    finalChecks: [check()],
    decisions: [],
    findings: [],
    minorityReports: [],
    limitations: [],
    residualRisks: [],
    rollback: 'Revert the commit.',
    integrationEvidence: {
      integratorId: 'integrator',
      integrated: true,
      postIntegrationChecks: [],
      findings: [],
      rationale: 'Integrated cleanly.',
    },
    independentVerification: {
      verifierId: 'independent-verifier',
      verified: true,
      criteriaTraced: ['The change works'],
      findings: [],
      rationale: 'Verified independently.',
    },
    doctrineAcceptance: {
      accepted: true,
      procedure: 'doctrine vote',
      rationale: 'Accepted internally.',
      decidedAt: '2026-01-01T00:00:00.000Z',
    },
    assembledAt: '2026-01-01T00:00:00.000Z',
    remediationCycles: 0,
    ...overrides,
  };
}

describe('BenchmarkAllowance', () => {
  it('rejects invalid fixed ceilings', () => {
    expect(() => new BenchmarkAllowance(Number.POSITIVE_INFINITY, 1)).toThrow(RangeError);
    expect(() => new BenchmarkAllowance(1, -1)).toThrow(RangeError);
    expect(() => new BenchmarkAllowance(1, 1.5)).toThrow(RangeError);
  });
});

describe('decideApproval', () => {
  it.each(['vote_threshold', 'spend_approval', 'confidence_vote'] as const)(
    'rejects the %s internal-process approval by default',
    (kind) => {
      const result = decideApproval(approval(kind), { allowance: new BenchmarkAllowance(10, 1) });

      expect(result.decision).toBe('reject');
      expect(result.kind).toBe(kind);
      expect(result.note).toContain("does not manufacture an outcome");
    },
  );

  it('always rejects test_waiver even with ample allowance and passing checks', () => {
    const result = decideApproval(approval('test_waiver', { taskId: 'task-1' }), {
      allowance: new BenchmarkAllowance(1_000, 100),
      budgetIncreaseUsd: 1,
      independentChecks: [check()],
    });

    expect(result.decision).toBe('reject');
    expect(result.note).toContain('never approves weakening or removal of required tests');
  });

  it('approves budget increases within the shared allowance and decrements it', () => {
    const allowance = new BenchmarkAllowance(10, 1);

    const first = decideApproval(approval('budget_increase'), { allowance, budgetIncreaseUsd: 4 });
    const second = decideApproval(approval('budget_increase', { id: 'budget-2' }), {
      allowance,
      budgetIncreaseUsd: 6,
    });

    expect(first.decision).toBe('approve');
    expect(first.allowance.usdRemaining).toBe(6);
    expect(second.decision).toBe('approve');
    expect(allowance.usdRemaining).toBe(0);
  });

  it('rejects a budget increase that exceeds the remaining allowance without decrementing it', () => {
    const allowance = new BenchmarkAllowance(5, 1);
    decideApproval(approval('budget_increase'), { allowance, budgetIncreaseUsd: 4 });

    const result = decideApproval(approval('budget_increase', { id: 'budget-2' }), {
      allowance,
      budgetIncreaseUsd: 2,
    });

    expect(result.decision).toBe('reject');
    expect(result.note).toContain('remaining allowance of $1');
    expect(allowance.usdRemaining).toBe(1);
  });

  it('rejects a finite request whose cumulative total would overflow', () => {
    const allowance = new BenchmarkAllowance(Number.MAX_VALUE, 0);
    decideApproval(approval('budget_increase'), { allowance, budgetIncreaseUsd: Number.MAX_VALUE });

    const result = decideApproval(approval('budget_increase', { id: 'budget-2' }), {
      allowance,
      budgetIncreaseUsd: Number.MAX_VALUE,
    });

    expect(result.decision).toBe('reject');
    expect(allowance.usdRemaining).toBe(0);
  });

  it.each([undefined, 0, -1, Number.NaN])('rejects an invalid budget increase of %s', (budgetIncreaseUsd) => {
    const allowance = new BenchmarkAllowance(5, 1);

    const result = decideApproval(approval('budget_increase'), { allowance, budgetIncreaseUsd });

    expect(result.decision).toBe('reject');
    expect(allowance.usdRemaining).toBe(5);
  });

  it('approves wall-clock extensions only while the extension allowance remains', () => {
    const allowance = new BenchmarkAllowance(0, 1);

    const approved = decideApproval(approval('wall_clock_extension'), { allowance });
    const rejected = decideApproval(approval('wall_clock_extension', { id: 'extension-2' }), { allowance });

    expect(approved.decision).toBe('approve');
    expect(approved.allowance.extensionsRemaining).toBe(0);
    expect(rejected.decision).toBe('reject');
    expect(rejected.note).toContain('extension allowance is exhausted');
  });

  it('rejects a stale extension when another 15 minutes would still leave the run expired', () => {
    const allowance = new BenchmarkAllowance(0, 2);
    const staleDeadline = new Date(Date.now() - 16 * 60_000).toISOString();

    const result = decideApproval(approval('wall_clock_extension'), {
      allowance,
      currentDeadlineAt: staleDeadline,
    });

    expect(result.decision).toBe('reject');
    expect(result.note).toContain('would still leave the run expired');
    expect(allowance.extensionsRemaining).toBe(2);
  });

  it('approves final_diff only when all supplied independent checks ran and passed', () => {
    const result = decideApproval(approval('final_diff'), {
      allowance: new BenchmarkAllowance(0, 0),
      independentChecks: [check(), check({ categoryId: 'build' })],
    });

    expect(result.decision).toBe('approve');
    expect(result.note).toContain('all 2 supplied required independent check(s) ran and passed');
  });

  it('rejects final_diff when check context is absent or empty', () => {
    const allowance = new BenchmarkAllowance(0, 0);

    expect(decideApproval(approval('final_diff'), { allowance }).decision).toBe('reject');
    expect(decideApproval(approval('final_diff'), { allowance, independentChecks: [] }).note).toContain(
      'failed closed',
    );
  });

  it('rejects final_diff when a required independent check failed or did not run', () => {
    const result = decideApproval(approval('final_diff'), {
      allowance: new BenchmarkAllowance(0, 0),
      independentChecks: [check({ categoryId: 'security', ran: false, passed: false })],
    });

    expect(result.decision).toBe('reject');
    expect(result.note).toContain('security');
  });

  it('does not attribute a baseline-incomplete category to the current task', () => {
    const result = decideApproval(approval('final_diff'), {
      allowance: new BenchmarkAllowance(0, 0),
      independentChecks: [check({ categoryId: 'unit', passed: false, failedAtBaseline: true })],
    });

    expect(result.decision).toBe('approve');
    expect(result.note).toContain('baseline-incomplete');
    expect(result.note).toContain('strict at final delivery');
  });
});

describe('decideDelivery', () => {
  it('rejects a manual-status mandatory criterion and names that criterion', () => {
    const criterion = 'A human visually confirms the generated report';
    const result = decideDelivery(
      delivery({
        acceptanceCriteria: [criterion],
        requirementMatrix: [
          evidence({
            criterion,
            command: 'Open report.html and inspect the chart',
            status: 'manual',
            note: 'Requires human inspection.',
          }),
        ],
      }),
    );

    expect(result.accept).toBe(false);
    expect(result.decision).toBe('remediate');
    expect(result.reasons).toContain(
      `Mandatory acceptance criterion "${criterion}" relies on manual inspection, which cannot satisfy headless benchmark acceptance.`,
    );
  });

  it('accepts when all mandatory evidence and checks pass and verification succeeds', () => {
    const result = decideDelivery(delivery());

    expect(result).toMatchObject({ accept: true, decision: 'accept', reasons: [] });
    expect(result.summary).toContain('Accepted delivery');
  });

  it('rejects failure on independent verification alone with a verification-specific reason', () => {
    const result = decideDelivery(
      delivery({
        independentVerification: {
          verifierId: 'external-reviewer',
          verified: false,
          criteriaTraced: ['The change works'],
          findings: [],
          rationale: 'Could not establish correctness.',
        },
      }),
    );

    expect(result.accept).toBe(false);
    expect(result.reasons).toHaveLength(1);
    expect(result.reasons[0]).toContain('Independent verification by "external-reviewer" did not verify');
  });

  it.each(['unsatisfied', 'unavailable'] as const)('rejects mandatory evidence with %s status', (status) => {
    const result = decideDelivery(delivery({ requirementMatrix: [evidence({ status })] }));

    expect(result.accept).toBe(false);
    expect(result.reasons[0]).toContain(`has ${status} evidence`);
  });

  it('rejects a mandatory criterion missing from the requirement matrix', () => {
    const result = decideDelivery(delivery({ requirementMatrix: [] }));

    expect(result.accept).toBe(false);
    expect(result.reasons[0]).toContain('has no evidence entry');
  });

  it('ignores insufficient evidence for a non-mandatory internal criterion', () => {
    const result = decideDelivery(
      delivery({ requirementMatrix: [evidence(), evidence({ criterion: 'Internal detail', status: 'manual' })] }),
    );

    expect(result.accept).toBe(true);
  });

  it('rejects a failed final check but excuses a failure explicitly attributed to baseline', () => {
    const failed = decideDelivery(delivery({ finalChecks: [check({ categoryId: 'build', passed: false })] }));
    const preExisting = decideDelivery(
      delivery({ finalChecks: [check({ categoryId: 'legacy', passed: false, failedAtBaseline: true })] }),
    );

    expect(failed.reasons[0]).toContain('Required final check "build"');
    expect(preExisting.accept).toBe(true);
  });

  it('rejects a required final check that claims success without having run', () => {
    const result = decideDelivery(delivery({ finalChecks: [check({ ran: false, passed: true })] }));

    expect(result.accept).toBe(false);
    expect(result.reasons[0]).toContain('failed or did not run');
  });

  it('returns a ledger-ready record containing the complete decision', () => {
    const result = decideDelivery(delivery());

    expect(evaluatorDecisionLedgerData(result)).toEqual(result);
  });
});
