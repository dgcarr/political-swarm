import { describe, expect, it } from 'vitest';
import {
  aggregate,
  buildStatement,
  outcomeOf,
  statementFor,
  traceableNumbers,
  untraceableFigures,
  type RunRecord,
} from './DoctrinalStatement.js';
import type { LedgerEntry } from '../engine/Ledger.js';
import type { RunState } from '../engine/RunStore.js';
import type { StrategyId } from '../engine/types.js';

const STRATEGIES: StrategyId[] = ['democratic', 'socialist', 'capitalist', 'noop'];
const OUTCOMES = ['completed', 'failed', 'stopped'] as const;

function entry(type: string, data: Record<string, unknown> = {}): LedgerEntry {
  return { ts: '2026-01-01T10:00:00.000Z', runId: 'r', strategy: 'democratic', type, data };
}

function state(overrides: Partial<RunState> = {}): RunState {
  return {
    runId: 'r',
    strategy: 'democratic',
    task: { goal: 'Repair the drainage\nsecond line ignored', acceptanceCriteria: [] },
    repoPath: '/repo',
    baseBranch: 'main',
    worktreePath: '/wt',
    branch: 'b',
    status: 'completed',
    createdAt: '2026-01-01T10:00:00.000Z',
    updatedAt: '2026-01-01T10:07:00.000Z',
    budgetUsd: 5,
    costUsd: 1.2345,
    tokensUsed: { prompt: 0, completion: 0 },
    workerCalls: 9,
    graph: {
      nodes: {
        t1: { id: 't1', title: 'One' },
        t2: { id: 't2', title: 'Two' },
        t3: { id: 't3', title: 'Three' },
      },
      order: ['t1', 't2', 't3'],
    },
    pendingApprovals: [],
    ...overrides,
  } as RunState;
}

const FULL_LEDGER: LedgerEntry[] = [
  entry('task_decided', { taskId: 't1', outcome: 'approved' }),
  entry('task_decided', { taskId: 't2', outcome: 'rejected' }),
  entry('verification_result', { taskId: 't1', ran: true, passed: true, command: 'npm test' }),
  entry('verification_result', { taskId: 't2', ran: true, passed: false, command: 'npm test' }),
  entry('verification_result', { taskId: 't3', ran: false, passed: false }),
  entry('vote_computed', { taskId: 't1' }),
  entry('committee_inquiry', { taskId: 't1' }),
  entry('confidence_vote', {}),
  entry('approval_opened', { kind: 'final_diff' }),
  entry('task_error', { taskId: 't3', error: 'boom' }),
  entry('guild_assigned', { taskId: 't1', leadGuild: 'backend' }),
  entry('guild_assigned', { taskId: 't2', leadGuild: 'backend' }),
  entry('guild_assigned', { taskId: 't3', leadGuild: 'testing' }),
  entry('peer_review', { taskId: 't1' }),
  entry('planner_recall', { from: 'a', to: 'b' }),
  entry('capability_updated', { delta: 0.05 }),
  entry('capability_updated', { delta: -0.05 }),
  entry('bids_received', { taskId: 't1', bids: [{}, {}, {}] }),
  entry('bids_received', { taskId: 't2', bids: [{}] }),
  entry('listing_awarded', { taskId: 't1' }),
  entry('listing_unfilled', { taskId: 't3', reason: 'no bid' }),
  entry('escrow_released', { taskId: 't1', personaId: 'p' }),
  entry('bankruptcy', { personaId: 'p2', capital: -1 }),
];

describe('aggregate', () => {
  const r = aggregate(state(), FULL_LEDGER);

  it('counts decisions from the ledger, not from the graph', () => {
    expect(r).toMatchObject({ tasksTotal: 3, approved: 1, rejected: 1, unresolved: 1 });
  });

  it('counts only verifications that actually ran', () => {
    // The third verification_result has ran:false — an unexecuted check is not evidence.
    expect(r.verificationsRun).toBe(2);
    expect(r.verificationsPassed).toBe(1);
  });

  it('counts distinct guilds rather than assignments', () => {
    expect(r.guilds).toBe(2);
  });

  it('sums bids across listings and counts only positive capability changes as gains', () => {
    expect(r.bidsReceived).toBe(4);
    expect(r.capabilityGains).toBe(1);
  });

  it('takes cost, budget and worker calls from state, and duration from its timestamps', () => {
    expect(r.costUsd).toBe(1.2345);
    expect(r.budgetUsd).toBe(5);
    expect(r.workerCalls).toBe(9);
    expect(r.durationMin).toBe(7);
  });

  it('reports zero rather than NaN for an empty run', () => {
    const empty = aggregate(state({ graph: null, workerCalls: 0, costUsd: 0 }), []);
    for (const [key, value] of Object.entries(empty)) {
      if (typeof value === 'number') expect(Number.isFinite(value), key).toBe(true);
    }
    expect(empty.tasksTotal).toBe(0);
    expect(empty.durationMin).toBe(7);
  });

  it('maps every non-terminal failure status onto "failed"', () => {
    expect(outcomeOf('completed')).toBe('completed');
    expect(outcomeOf('stopped')).toBe('stopped');
    expect(outcomeOf('failed')).toBe('failed');
    expect(outcomeOf('paused_budget')).toBe('failed');
    expect(outcomeOf('paused_human')).toBe('failed');
  });
});

// ---------------------------------------------------------------------------
// The gate: a statement may be rhetorical, but it may not invent a statistic.
// ---------------------------------------------------------------------------

// The allowed-figure set lives in DoctrinalStatement.ts because the LLM rhetorician checks its
// output against the same function at runtime. Testing it here tests both uses.
const allowedNumbers = traceableNumbers;

function statementText(r: RunRecord): string {
  const s = statementFor(r);
  return [s.title, ...s.paragraphs, s.closing].join(' ');
}

describe('gate: every number in the prose traces to a real field', () => {
  const records: RunRecord[] = [];
  for (const strategy of STRATEGIES) {
    for (const outcome of OUTCOMES) {
      const status = outcome === 'completed' ? 'completed' : outcome === 'stopped' ? 'stopped' : 'failed';
      records.push(aggregate(state({ strategy, status }), FULL_LEDGER));
      // Also the degenerate run: nothing happened at all.
      records.push(aggregate(state({ strategy, status, graph: null, workerCalls: 0, costUsd: 0 }), []));
    }
  }

  for (const r of records) {
    it(`${r.strategy}/${r.outcome} cites no figure absent from the record`, () => {
      const text = statementText(r);
      const allowed = allowedNumbers(r);
      const cited = text.match(/\d+(?:\.\d+)?/g) ?? [];

      const invented = cited.filter((n) => !allowed.has(n));
      expect(invented, `${r.strategy}/${r.outcome} invented: ${invented.join(', ')} in "${text}"`).toEqual([]);
    });
  }

  it('actually finds numbers to check, so the gate cannot pass vacuously', () => {
    const r = aggregate(state({ strategy: 'democratic' }), FULL_LEDGER);
    expect((statementText(r).match(/\d+/g) ?? []).length).toBeGreaterThan(5);
  });

  it('untraceableFigures catches a fabricated statistic', () => {
    // This is the function the LLM rhetorician uses to vet model output before it is shown.
    const r = aggregate(state({ strategy: 'democratic' }), FULL_LEDGER);
    expect(untraceableFigures('The House sat for 7 minutes.', r)).toEqual([]);
    expect(untraceableFigures('Public confidence stands at 87 per cent.', r)).toEqual(['87']);
    expect(untraceableFigures('We delivered 1000 features.', r)).toEqual(['1000']);
  });
});

describe('statements', () => {
  const record = (strategy: StrategyId, outcome: (typeof OUTCOMES)[number]) =>
    aggregate(
      state({ strategy, status: outcome === 'completed' ? 'completed' : outcome === 'stopped' ? 'stopped' : 'failed' }),
      FULL_LEDGER,
    );

  it('gives each tradition its own title', () => {
    expect(statementFor(record('democratic', 'completed')).title).toBe('Statement to the House');
    expect(statementFor(record('socialist', 'completed')).title).toBe('Report to the Council of Producers');
    expect(statementFor(record('capitalist', 'completed')).title).toBe('Statement to Shareholders');
  });

  it('produces nine distinct closings across three strategies and three outcomes', () => {
    const closings = new Set<string>();
    for (const strategy of ['democratic', 'socialist', 'capitalist'] as StrategyId[]) {
      for (const outcome of OUTCOMES) closings.add(statementFor(record(strategy, outcome)).closing);
    }
    expect(closings.size).toBe(9);
  });

  it('speaks in the register of its tradition', () => {
    expect(statementText(record('democratic', 'completed'))).toContain('Mr Speaker');
    expect(statementText(record('socialist', 'completed'))).toContain('Comrades');
    expect(statementText(record('capitalist', 'completed'))).toContain('Prices did');
  });

  it('does not claim success when the run failed', () => {
    for (const strategy of ['democratic', 'socialist', 'capitalist'] as StrategyId[]) {
      const text = statementText(record(strategy, 'failed'));
      expect(text.toLowerCase()).toMatch(/fail/);
    }
  });

  it('refuses to dress up a run in which no check was executed', () => {
    const r = aggregate(state({ strategy: 'democratic' }), [entry('task_decided', { taskId: 't1', outcome: 'approved' })]);
    expect(statementText(r)).toContain('Nothing here rests on evidence');
  });

  it('never renders undefined, NaN or an empty paragraph', () => {
    for (const strategy of STRATEGIES) {
      for (const outcome of OUTCOMES) {
        const s = statementFor(record(strategy, outcome));
        expect(s.paragraphs.length).toBeGreaterThan(0);
        for (const p of s.paragraphs) {
          expect(p.trim().length).toBeGreaterThan(0);
          expect(p).not.toMatch(/undefined|NaN|\[object Object\]/);
        }
        expect(s.closing).not.toMatch(/undefined|NaN/);
      }
    }
  });

  it('agrees subject and verb on a count of one', () => {
    // The single-item run is the common case in a short sitting, and "1 were carried" is exactly
    // the kind of slip that makes generated prose look generated.
    const single: LedgerEntry[] = [
      entry('task_decided', { taskId: 't1', outcome: 'approved' }),
      entry('vote_computed', { taskId: 't1' }),
      entry('guild_assigned', { taskId: 't1', leadGuild: 'backend' }),
      entry('peer_review', { taskId: 't1' }),
      entry('bids_received', { taskId: 't1', bids: [{}] }),
      entry('listing_awarded', { taskId: 't1' }),
      entry('bankruptcy', { personaId: 'p' }),
      entry('capability_updated', { delta: 0.1 }),
    ];
    for (const strategy of ['democratic', 'socialist', 'capitalist'] as StrategyId[]) {
      const s = statementFor(aggregate(state({ strategy, workerCalls: 1 }), single));
      const text = [...s.paragraphs, s.closing].join(' ');
      expect(text, `${strategy}: ${text}`).not.toMatch(/\b1 \w+ were\b/);
      expect(text, `${strategy}: ${text}`).not.toMatch(/\b1 (call|bid|guild|division|record|participant)s\b/);
    }
  });

  it('builds straight from state and ledger', () => {
    const s = buildStatement(state({ strategy: 'capitalist' }), FULL_LEDGER);
    expect(s.title).toBe('Statement to Shareholders');
    expect(s.paragraphs.join(' ')).toContain('4 bids');
  });

  it('handles the noop strategy without pretending it has a doctrine', () => {
    const s = statementFor(record('noop', 'completed'));
    expect(s.title).toBe('Run summary');
    expect(s.paragraphs.join(' ')).not.toContain('Comrades');
  });
});
