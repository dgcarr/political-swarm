import { describe, expect, it, vi } from 'vitest';
import type { PendingApproval } from '../engine/types.js';
import type { ApprovalDecision } from './evaluatorPolicy.js';
import {
  combinedApproval,
  decideAsSovereign,
  sovereignDecisionGroups,
  parseClaudeOutput,
  sovereignDecides,
  sovereignUserPrompt,
  SOVEREIGN_SYSTEM_PROMPT,
  type SovereignInput,
} from './sovereign.js';

const approval: PendingApproval = {
  id: 'ap-1',
  kind: 'final_diff',
  taskId: 'cli',
  description: 'Task "cli" needs human sign-off: the division carried but the check output is ambiguous.',
  createdAt: '2026-09-22T00:00:00.000Z',
};

const fixed: ApprovalDecision = {
  kind: 'final_diff',
  approvalId: 'ap-1',
  decision: 'reject',
  note: 'Rejected final_diff: a required check regressed.',
  allowance: { usdCeiling: 40, usdRemaining: 40, extensionCountCeiling: 6, extensionsRemaining: 6 },
};

const input: SovereignInput = {
  approval,
  goal: 'Build pkg, a small CLI.',
  acceptanceCriteria: ['python -m pkg runs'],
  independentChecks: [{ categoryId: 'unit', command: 'pytest', args: [], ran: true, passed: true }],
  diffText: 'diff --git a/pkg/cli.py b/pkg/cli.py\n+print("hi")\n',
};

describe('sovereignDecides', () => {
  it('leaves budget and wall-clock extensions to the fixed allowance', () => {
    expect(sovereignDecides('budget_increase')).toBe(false);
    expect(sovereignDecides('wall_clock_extension')).toBe(false);
  });

  it('puts every doctrine escalation to the sovereign', () => {
    for (const kind of ['final_diff', 'test_waiver', 'vote_threshold', 'spend_approval', 'confidence_vote'] as const) {
      expect(sovereignDecides(kind)).toBe(true);
    }
  });
});

describe('sovereignDecisionGroups', () => {
  const at = (id: string, kind: PendingApproval['kind'], taskId?: string): PendingApproval => ({
    id,
    kind,
    ...(taskId ? { taskId } : {}),
    description: `${kind} ${id}`,
    createdAt: '2026-09-22T00:00:00.000Z',
  });

  it('asks once per escalated task, final_diff first, and carries every description', () => {
    const groups = sovereignDecisionGroups([
      at('a', 'vote_threshold', 'cli'),
      at('b', 'final_diff', 'cli'),
      at('c', 'final_diff', 'docs'),
    ]);

    expect(groups.map((group) => group.map((approval) => approval.id))).toEqual([['b', 'a'], ['c']]);
    expect(combinedApproval(groups[0]!)).toMatchObject({ id: 'b', kind: 'final_diff', description: 'final_diff b\n\nvote_threshold a' });
  });

  it('never groups allowance approvals, which the fixed policy decides one by one', () => {
    const groups = sovereignDecisionGroups([at('a', 'budget_increase', 'cli'), at('b', 'final_diff', 'cli')]);
    expect(groups).toHaveLength(2);
  });
});

describe('sovereignUserPrompt', () => {
  it('gives the sovereign the escalation, what each answer does, the checks and the diff', () => {
    const prompt = sovereignUserPrompt(input);
    expect(prompt).toContain('Decision kind: final_diff');
    expect(prompt).toContain('the change is reverted and the task is retried');
    expect(prompt).toContain(approval.description);
    expect(prompt).toContain('- unit: passed');
    expect(prompt).toContain('+print("hi")');
  });

  it('tells the sovereign no answer lets a weakened test through', () => {
    expect(sovereignUserPrompt({ ...input, approval: { ...approval, kind: 'test_waiver' } }))
      .toMatch(/No answer lets that change through/);
  });

  it('names no doctrine, so every arm is judged by the same words', () => {
    expect(`${SOVEREIGN_SYSTEM_PROMPT}\n${sovereignUserPrompt(input)}`)
      .not.toMatch(/democratic|socialist|capitalist|managerial|single.agent/i);
  });
});

describe('parseClaudeOutput', () => {
  const ok = {
    is_error: false,
    structured_output: { decision: 'approve', rationale: 'Checks pass and the diff is in scope.' },
    modelUsage: { 'claude-opus-5': {} },
    total_cost_usd: 0.02,
  };

  it('reads the structured decision and the model the user selected', () => {
    expect(parseClaudeOutput(JSON.stringify(ok))).toEqual({
      decision: 'approve',
      rationale: 'Checks pass and the diff is in scope.',
      model: 'claude-opus-5',
      costUsd: 0.02,
    });
  });

  it('refuses an answer without a decision or a rationale', () => {
    expect(() => parseClaudeOutput(JSON.stringify({ ...ok, structured_output: { decision: 'maybe', rationale: 'x' } }))).toThrow();
    expect(() => parseClaudeOutput(JSON.stringify({ ...ok, structured_output: { decision: 'approve', rationale: ' ' } }))).toThrow();
    expect(() => parseClaudeOutput(JSON.stringify({ ...ok, is_error: true }))).toThrow(/error/);
  });
});

describe('decideAsSovereign', () => {
  it('replaces the fixed decision with the sovereign\'s, keeping the allowance snapshot', async () => {
    const invoke = vi.fn(async () => ({ decision: 'approve' as const, rationale: 'Sound.', model: 'claude-opus-5', costUsd: 0.01 }));

    const outcome = await decideAsSovereign(input, fixed, invoke);

    expect(invoke).toHaveBeenCalledWith(SOVEREIGN_SYSTEM_PROMPT, sovereignUserPrompt(input));
    expect(outcome).toMatchObject({ decidedBy: 'sovereign', model: 'claude-opus-5', costUsd: 0.01 });
    expect(outcome.decision).toMatchObject({ decision: 'approve', note: 'Sovereign (claude-opus-5): Sound.', allowance: fixed.allowance });
  });

  it("passes the sovereign's rationale through to the engine note, so the next implementer sees it too", async () => {
    const outcome = await decideAsSovereign(input, fixed, async () => ({
      decision: 'reject' as const,
      rationale: 'Use numpy.interp and clamp nothing.',
      model: 'claude-opus-5',
      costUsd: 0.01,
    }));

    expect(outcome.decision.note).toContain('numpy.interp');
    expect(outcome.engineNote).toContain('numpy.interp');
  });

  it('falls back to the fixed policy when the sovereign cannot answer', async () => {
    const outcome = await decideAsSovereign(input, fixed, async () => {
      throw new Error('claude not found');
    });

    expect(outcome.decidedBy).toBe('fallback-policy');
    expect(outcome.decision.decision).toBe('reject');
    expect(outcome.decision.note).toMatch(/^Sovereign unavailable \(claude not found\)/);
  });
});
