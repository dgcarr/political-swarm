import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Ledger } from './Ledger.js';
import { RunStore, type RunState } from './RunStore.js';
import { recordGovernanceDecision, type GovernanceDecision } from './governance.js';
import { verifyRun } from './verifyRun.js';

let root: string | undefined;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

const decision: GovernanceDecision = {
  id: 'division-1',
  body: 'commons',
  subject: 'motion-1',
  artifactDigest: 'abc',
  rule: 'simple_majority',
  eligible: ['a', 'b', 'c'],
  positions: [{ actor: 'a', choice: 'aye' }, { actor: 'b', choice: 'aye' }, { actor: 'c', choice: 'no' }],
  evidenceRefs: [],
  result: 'approved',
  nextAction: 'implement',
};

function finishedRun(): { store: RunStore; state: RunState; ledger: Ledger; runDir: string } {
  root = mkdtempSync(path.join(os.tmpdir(), 'verify-run-'));
  const store = new RunStore(root);
  const runDir = path.join(root, 'run-v');
  const ledger = new Ledger(runDir, 'run-v', 'democratic');
  const state = {
    runId: 'run-v', strategy: 'democratic', status: 'awaiting_acceptance', createdAt: '2026-10-06T00:00:00.000Z',
    costUsd: 0.25, graph: null, pendingApprovals: [], governanceDecisions: [], governanceMandates: [],
  } as unknown as RunState;
  ledger.record('worker_call', { role: 'implementer', costUsd: 0.25 });
  recordGovernanceDecision(state, ledger, decision);
  store.save(state);
  return { store, state, ledger, runDir };
}

describe('verifyRun', () => {
  it('verifies a run whose state, ledger and spend agree', () => {
    finishedRun();
    const report = verifyRun(root!, 'run-v');
    expect(report).toMatchObject({ ok: true, problems: [], warnings: [], governance: { decisions: 1 } });
    expect(report.spend).toEqual({ ledgerUsd: 0.25, stateUsd: 0.25 });
  });

  it('fails a run whose acted-on decision was rewritten after the vote', () => {
    const { store, state } = finishedRun();
    state.governanceDecisions![0] = { ...decision, result: 'defeated' };
    store.save(state);
    expect(verifyRun(root!, 'run-v').problems).toEqual(['governance: decision division-1 differs between state.json and the ledger']);
  });

  it('fails a run whose ledger was edited', () => {
    const { runDir, ledger } = finishedRun();
    ledger.record('task_decided', {});
    const file = path.join(runDir, 'ledger.jsonl');
    writeFileSync(file, readFileSync(file, 'utf8').replace('"costUsd":0.25', '"costUsd":0.15'));
    const report = verifyRun(root!, 'run-v');
    expect(report.ok).toBe(false);
    expect(report.problems).toContain('ledger: line 2: prevHash does not match line 1');
  });

  it('fails a ledger that claims more spend than the run recorded', () => {
    const { ledger } = finishedRun();
    ledger.record('decision_call', { costUsd: 1 });
    expect(verifyRun(root!, 'run-v').problems[0]).toMatch(/^spend: ledger calls total \$1\.250000/);
  });

  it('applies a supplied rule check to every replayed decision', () => {
    finishedRun();
    const report = verifyRun(root!, 'run-v', { checkDecision: (d) => (d.result === 'approved' ? 'two ayes of three do not carry' : null) });
    expect(report.problems).toEqual(['governance: decision division-1: two ayes of three do not carry']);
  });
});

describe('verifyRun constitutional re-check', () => {
  it('re-counts a decision written around the engine and names the miscount', () => {
    const { store, state, ledger } = finishedRun();
    // Bypasses recordGovernanceDecision, as an edited ledger or a buggy doctrine would.
    const forged = { ...decision, id: 'division-2', positions: [{ actor: 'a', choice: 'aye' }, { actor: 'b', choice: 'no' }, { actor: 'c', choice: 'no' }] };
    ledger.record('governance_decision', forged as unknown as Record<string, unknown>);
    state.governanceDecisions!.push(forged);
    store.save(state);
    const [problem] = verifyRun(root!, 'run-v').problems;
    expect(problem).toMatch(/^governance: decision division-2: records "approved", but the ballots \(1 for, 2 against/);
  });
});
