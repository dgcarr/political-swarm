import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LedgerEntry } from '../engine/Ledger.js';
import type { StrategyId } from '../engine/types.js';
import { capitalistMilestones } from './capitalist/milestones.js';
import { democraticMilestones } from './democratic/milestones.js';
import { managerialMilestones } from './managerial/milestones.js';
import { commonMilestones, milestoneFor } from './milestones.js';
import { singleAgentMilestones } from './singleAgent/milestones.js';
import { socialistMilestones } from './socialist/milestones.js';

const entry = (strategy: StrategyId, type: string, data: Record<string, unknown>): LedgerEntry =>
  ({ ts: '2026-10-04T10:00:00.000Z', runId: 'r', strategy, type, data });

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [full] : [];
  });
}

describe('governing milestones', () => {
  it('narrates democratic formation and legislation', () => {
    expect(milestoneFor(entry('democratic', 'government_formed', { termId: 2, primeCoordinator: 'pc-2', method: 'constituency election' })))
      .toBe('Government formed (term 2): Prime Coordinator pc-2, by constituency election');
    expect(milestoneFor(entry('democratic', 'task_decided', { taskId: 'cli', outcome: 'approved' }))).toBe('Legislation passed: cli');
    expect(milestoneFor(entry('democratic', 'division_recorded', { taskId: 'cli', ayes: 5, noes: 2, abstentions: 1, outcome: 'rejected' })))
      .toBe('Division on cli: 5 ayes, 2 noes, 1 abstentions; defeated');
    expect(milestoneFor(entry('democratic', 'confidence_motion', { subject: 'pc-1', ayes: 0, noes: 8, outcome: 'lost' })))
      .toContain('the government falls');
  });

  it('gives each doctrine its own wording for a task outcome', () => {
    const approved = { taskId: 't', outcome: 'approved' };
    expect(milestoneFor(entry('socialist', 'task_decided', approved))).toBe('Council accepts the work on t');
    expect(milestoneFor(entry('managerial', 'task_decided', approved))).toBe('Manager signs off t');
    expect(milestoneFor(entry('single_agent', 'task_decided', approved))).toBe('Task t: approved');
    // The market reports the settlement instead, which carries the outcome and the profit.
    expect(milestoneFor(entry('capitalist', 'task_decided', approved))).toBeUndefined();
    expect(milestoneFor(entry('capitalist', 'contract_settled', { taskId: 't', personaId: 'b1', outcome: 'approved', profit: -4 })))
      .toBe('Contract t settled with b1: approved, loss 4.00');
  });

  it('stays silent on bookkeeping and never throws on a malformed entry', () => {
    expect(milestoneFor(entry('democratic', 'worker_call', {}))).toBeUndefined();
    expect(milestoneFor(entry('capitalist', 'bailout_considered', { granted: false }))).toBeUndefined();
    expect(milestoneFor(entry('single_agent', 'file_ops_proposed', { taskId: 't', ops: [] }))).toBe('Agent leaves t unchanged');
    expect(milestoneFor(entry('managerial', 'task_decided', { taskId: 't', outcome: 'needs_human' }))).toBe('Manager escalates t to the sovereign');
    expect(() => milestoneFor(entry('capitalist', 'firm_formed', { members: 'not-a-list' }))).not.toThrow();
    expect(milestoneFor({ ...entry('socialist', 'peer_review', {}), data: undefined as never })).toContain('Peer review');
  });

  it('only names events some strategy or the engine actually records', () => {
    const recorded = new Set(
      sourceFiles(path.resolve(__dirname, '..')).flatMap((file) =>
        [...readFileSync(file, 'utf8').matchAll(/record\(\s*'([a-z_]+)'/g)].map((m) => m[1])),
    );
    const named = [commonMilestones, democraticMilestones, socialistMilestones, capitalistMilestones, managerialMilestones, singleAgentMilestones]
      .flatMap((table) => Object.keys(table));
    expect(named.filter((type) => !recorded.has(type))).toEqual([]);
  });
});
