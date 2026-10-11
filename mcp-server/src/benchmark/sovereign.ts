// The benchmark's sovereign: who answers an escalation the doctrine reserves above its own
// government, when no human is in the loop.
//
// In ordinary use those approvals wait for the human, through /swarm-status and /swarm-decide.
// In the headless benchmark they are put to Claude instead — the model the user has selected in
// Claude Code, invoked through the `claude` CLI — so a stronger reasoner than the swarm's own
// workers decides them, identically for every arm. Budget and wall-clock extensions are not
// sovereign decisions here: they draw on the harness's fixed shared allowance, which stays
// deterministic so every arm gets the same resources.
//
// If Claude cannot be reached or returns no usable answer, the fixed evaluator policy's decision
// stands and the fallback is recorded, so a sovereign outage never stalls a run.

import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CheckRunRecord } from '../engine/packets.js';
import type { PendingApproval, PendingApprovalKind } from '../engine/types.js';
import type { ApprovalDecision, ApprovalResolution } from './evaluatorPolicy.js';

const SOVEREIGN_TIMEOUT_MS = 300_000;
const GOAL_EXCERPT_CHARS = 4_000;
const DIFF_EXCERPT_CHARS = 16_000;

/** Approvals the harness's allowance governs; everything else goes to the sovereign. */
const ALLOWANCE_KINDS: ReadonlySet<PendingApprovalKind> = new Set(['budget_increase', 'wall_clock_extension']);

export function sovereignDecides(kind: PendingApprovalKind): boolean {
  return !ALLOWANCE_KINDS.has(kind);
}

/**
 * Groups pending approvals so the sovereign is asked once per decision. A doctrine that escalates a
 * task opens its own approval (democratic `vote_threshold`), and the engine opens the `final_diff`
 * that actually settles the task, so one escalation arrives as two approvals. Asked separately, an
 * arm whose doctrine files that extra approval would get a second consultation, and the two
 * answers could disagree. Sovereign kinds on one task form one group, `final_diff` first because it
 * is the one the engine acts on; everything else stands alone.
 */
export function sovereignDecisionGroups(approvals: readonly PendingApproval[]): PendingApproval[][] {
  const groups = new Map<string, PendingApproval[]>();
  for (const approval of approvals) {
    const key = sovereignDecides(approval.kind) && approval.taskId ? `task:${approval.taskId}` : `id:${approval.id}`;
    groups.set(key, [...(groups.get(key) ?? []), approval]);
  }
  return [...groups.values()].map((group) =>
    [...group].sort((a, b) => Number(b.kind === 'final_diff') - Number(a.kind === 'final_diff')),
  );
}

/** The single approval the sovereign is shown for a group: the primary, carrying every description. */
export function combinedApproval(group: readonly PendingApproval[]): PendingApproval {
  const [primary, ...rest] = group;
  if (!primary) throw new Error('combinedApproval needs at least one approval');
  if (rest.length === 0) return primary;
  return { ...primary, description: group.map((approval) => approval.description).join('\n\n') };
}

export interface SovereignInput {
  approval: PendingApproval;
  goal: string;
  acceptanceCriteria: readonly string[];
  independentChecks?: readonly CheckRunRecord[];
  /** The worktree diff as it stands while the approval is pending. */
  diffText?: string;
}

export interface SovereignAnswer {
  decision: ApprovalResolution;
  rationale: string;
  model: string;
  costUsd: number;
}

/** Runs one sovereign consultation. Injected in tests; the default shells out to `claude -p`. */
export type SovereignInvoker = (systemPrompt: string, userPrompt: string) => Promise<SovereignAnswer>;

export interface SovereignOutcome {
  decision: ApprovalDecision;
  /**
   * What the engine is told, and so what a rejected task's next implementer reads: the sovereign's
   * real rationale, passed through uniformly. decideAsSovereign is invoked with the same neutral
   * system prompt and the same evidence shape for every arm and every sovereign-decided kind, and
   * every arm's final_diff settlement goes through the sovereign — so this is equal-opportunity
   * feedback available identically to every arm, not asymmetric coaching of one.
   */
  engineNote: string;
  decidedBy: 'sovereign' | 'fallback-policy';
  model?: string;
  costUsd?: number;
  error?: string;
}

const KIND_MEANING: Partial<Record<PendingApprovalKind, string>> = {
  final_diff:
    'A task needs sign-off before its change counts. Approve: the change already applied to the worktree ' +
    'stands and the task is settled. Reject: the change is reverted and the task is retried with your ' +
    'reason, or abandoned if it has no attempts left.',
  test_waiver:
    'The task proposed deleting or weakening an existing test. No answer lets that change through: either ' +
    'answer sends the task back for another attempt, which is checked again. Reject unless the evidence ' +
    'shows the test itself is obsolete or wrong.',
  vote_threshold:
    "The swarm's own vote reached a category its constitution reserves for the sovereign (a security " +
    'boundary, a constitutional change, a missing test signal, or an emergency rollback). Approve: you ' +
    'authorise the motion. Reject: you refuse it.',
  spend_approval:
    'A high-risk task touches security-sensitive paths and needs sign-off before work on it is bought. ' +
    'Approve: the task proceeds. Reject: it is abandoned.',
  confidence_vote:
    "A question of confidence in the swarm's leadership reached you. Approve or reject what the " +
    'description asks.',
};

export const SOVEREIGN_SYSTEM_PROMPT =
  'You are the sovereign of an AI coding swarm running a benchmark task: the authority above the ' +
  "swarm's own government, standing in for its human owner. The swarm has escalated one decision it " +
  'may not take itself. Decide it on the evidence in front of you: the task, the checks that ran, and ' +
  'the change. Approve what is sound and within the task; reject what is unsafe, unverified, outside ' +
  'the task, or weakens a test to obtain a pass. You are not writing code and cannot ask questions. ' +
  'Give a short rationale that names the evidence you relied on; it is recorded and, on a rejection, ' +
  'sent back to the swarm.';

function renderChecks(checks: readonly CheckRunRecord[] | undefined): string {
  if (!checks?.length) return '(none recorded for this task)';
  return checks
    .map((c) => `- ${c.categoryId}: ${!c.ran ? `not run${c.skippedReason ? ` (${c.skippedReason})` : ''}` : c.passed ? 'passed' : 'FAILED'}`)
    .join('\n');
}

function excerpt(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n…[truncated]`;
}

export function sovereignUserPrompt(input: SovereignInput): string {
  const { approval } = input;
  return (
    `Decision kind: ${approval.kind}\n` +
    `${KIND_MEANING[approval.kind] ?? 'Approve or reject what the description asks.'}\n\n` +
    `What the swarm escalated:\n${approval.description}\n\n` +
    `Task acceptance criteria:\n${input.acceptanceCriteria.map((c) => `- ${c}`).join('\n') || '(none given)'}\n\n` +
    `Required checks on the latest attempt:\n${renderChecks(input.independentChecks)}\n\n` +
    `Task (excerpt):\n${excerpt(input.goal, GOAL_EXCERPT_CHARS)}\n\n` +
    `Current worktree diff (excerpt):\n${input.diffText ? excerpt(input.diffText, DIFF_EXCERPT_CHARS) : '(unavailable)'}\n\n` +
    'Decide: approve or reject.'
  );
}

const DECISION_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    decision: { type: 'string', enum: ['approve', 'reject'] },
    rationale: { type: 'string' },
  },
  required: ['decision', 'rationale'],
});

/** Parses `claude -p --output-format json` output into a sovereign answer, or throws. */
export function parseClaudeOutput(stdout: string): SovereignAnswer {
  const out = JSON.parse(stdout) as {
    is_error?: boolean;
    structured_output?: { decision?: unknown; rationale?: unknown };
    modelUsage?: Record<string, unknown>;
    total_cost_usd?: number;
    result?: string;
  };
  if (out.is_error) throw new Error(`claude reported an error: ${String(out.result ?? '').slice(0, 300)}`);
  const answer = out.structured_output;
  if (answer?.decision !== 'approve' && answer?.decision !== 'reject') {
    throw new Error('claude returned no approve/reject decision');
  }
  const rationale = typeof answer.rationale === 'string' ? answer.rationale.trim() : '';
  if (!rationale) throw new Error('claude returned a decision without a rationale');
  return {
    decision: answer.decision,
    rationale,
    model: Object.keys(out.modelUsage ?? {})[0] ?? 'claude',
    costUsd: typeof out.total_cost_usd === 'number' ? out.total_cost_usd : 0,
  };
}

/**
 * Asks the user's own Claude Code model. `--safe-mode` drops plugins, hooks, CLAUDE.md and MCP
 * servers so nothing in this repository coaches the sovereign; `--tools ""` leaves it only the
 * evidence in the prompt; no `--model` flag, so the user's selected model decides.
 */
export const claudeCliInvoker: SovereignInvoker = (systemPrompt, userPrompt) =>
  new Promise((resolve, reject) => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'swarm-sovereign-'));
    const child = execFile(
      'claude',
      [
        '-p',
        '--safe-mode',
        '--tools', '',
        '--no-session-persistence',
        '--output-format', 'json',
        '--json-schema', DECISION_SCHEMA,
        '--system-prompt', systemPrompt,
      ],
      { cwd, timeout: SOVEREIGN_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }
        try {
          resolve(parseClaudeOutput(stdout));
        } catch (parseErr) {
          reject(parseErr);
        }
      },
    );
    child.stdin?.end(userPrompt);
  });

/**
 * Puts one approval to the sovereign. `fixed` is the evaluator policy's own decision for the same
 * approval: it keeps the allowance snapshot, and it stands if the sovereign cannot answer.
 */
export async function decideAsSovereign(
  input: SovereignInput,
  fixed: ApprovalDecision,
  invoke: SovereignInvoker = claudeCliInvoker,
): Promise<SovereignOutcome> {
  try {
    const answer = await invoke(SOVEREIGN_SYSTEM_PROMPT, sovereignUserPrompt(input));
    return {
      decision: { ...fixed, decision: answer.decision, note: `Sovereign (${answer.model}): ${answer.rationale}` },
      engineNote: `The sovereign ${answer.decision === 'approve' ? 'approved' : 'rejected'} this ${input.approval.kind}: ${answer.rationale}`,
      decidedBy: 'sovereign',
      model: answer.model,
      costUsd: answer.costUsd,
    };
  } catch (err) {
    const error = String((err as Error)?.message ?? err).slice(0, 500);
    return {
      decision: { ...fixed, note: `Sovereign unavailable (${error}); the fixed evaluator policy decided. ${fixed.note}` },
      engineNote: fixed.note,
      decidedBy: 'fallback-policy',
      error,
    };
  }
}
