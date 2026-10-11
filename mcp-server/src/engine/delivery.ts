// Assembly and validation of the delivery packet — the artefact section 10 of every doctrine calls
// the "final delivery manifest" and section 5 calls the "delivery packet".
//
// Assembly is doctrine-neutral on purpose. What each doctrine contributes (its integration report,
// its verifier's decision, its finding dispositions, its acceptance procedure) arrives as inputs;
// this module only puts them in one shape and refuses to let a manifest through with holes in it.

import { randomUUID } from 'node:crypto';
import type {
  CheckArtifact,
  CheckRunRecord,
  DeliveryPacket,
  DoctrineAcceptance,
  EvidenceItem,
  Finding,
  IntegrationResult,
  VerificationResult,
} from './packets.js';
import { findingDispositionError } from './packets.js';
import type { RunState } from './RunStore.js';
import type { ChecksConfig } from '../util/config.js';
import { blockingFailures, limitationsFrom } from './checks.js';
import { latestVerdict } from './TaskGraph.js';

/** File names that run code, or decide what code runs, outside the checks: CI on push, git hooks,
 * shell and editor automation, package-manager scripts and build entry points. */
const SENSITIVE_BASENAMES = new Set([
  '.gitlab-ci.yml',
  '.gitattributes',
  '.gitmodules',
  '.envrc',
  '.npmrc',
  '.pre-commit-config.yaml',
  'package.json',
  'pyproject.toml',
  'setup.py',
  'makefile',
  'tox.ini',
  'noxfile.py',
]);
const SENSITIVE_PATH_PATTERNS = [/(^|\/)\.github\/workflows\//, /(^|\/)\.husky\//, /(^|\/)\.vscode\/tasks\.json$/];

/**
 * Changed paths that would execute code on the user's machine or CI once applied, without anyone
 * running the checks: a workflow, a hook, an install script. A diff that touches one deserves a
 * deliberate second look, so swarm_apply refuses it without explicit confirmation. Matched
 * case-insensitively at any depth; `.gitignore` and `.gitkeep` are deliberately absent, since they
 * run nothing.
 */
export function sensitivePaths(files: readonly string[]): string[] {
  return files.filter((file) => {
    const normalized = file.replace(/\\/g, '/').toLowerCase();
    const basename = normalized.slice(normalized.lastIndexOf('/') + 1);
    return SENSITIVE_BASENAMES.has(basename) || SENSITIVE_PATH_PATTERNS.some((pattern) => pattern.test(normalized));
  });
}

export function newFinding(input: Omit<Finding, 'id'> & { id?: string }): Finding {
  return { ...input, id: input.id ?? `f-${randomUUID().slice(0, 8)}` };
}

/** Every acceptance criterion the user stated, matched against the evidence the swarm produced.
 * A criterion with no entry gets an `unavailable` row rather than being dropped — the delivery
 * packet must show the gap, not hide it. */
export function buildRequirementMatrix(state: RunState): EvidenceItem[] {
  const collected: EvidenceItem[] = [...(state.evidence ?? [])];
  const graph = state.graph;
  if (graph) {
    for (const id of graph.order) {
      for (const item of graph.nodes[id].evidence ?? []) {
        collected.push({ ...item, taskId: item.taskId ?? id });
      }
    }
  }

  const matrix: EvidenceItem[] = [];
  for (const criterion of state.task.acceptanceCriteria) {
    const match = collected.find((e) => e.criterion.trim() === criterion.trim());
    matrix.push(
      match ?? {
        criterion,
        command: '(none)',
        expectedResult: '(none recorded)',
        status: 'unavailable',
        note: 'No test, command or named manual inspection was recorded for this acceptance criterion.',
      },
    );
  }
  // Evidence the swarm produced for sub-task criteria beyond the user's list is still worth
  // carrying — it is part of the ledger — but never displaces a user criterion's own row.
  for (const item of collected) {
    if (!matrix.some((m) => m.criterion.trim() === item.criterion.trim())) matrix.push(item);
  }
  return matrix;
}

/** Criteria that reached delivery with no evidence, or with evidence that says it isn't satisfied.
 * Section 9: "A task is incomplete — not accepted — when any acceptance criterion lacks evidence." */
export function unevidencedCriteria(matrix: EvidenceItem[], acceptanceCriteria: string[]): EvidenceItem[] {
  const userCriteria = new Set(acceptanceCriteria.map((c) => c.trim()));
  return matrix.filter(
    (m) => userCriteria.has(m.criterion.trim()) && (m.status === 'unavailable' || m.status === 'unsatisfied'),
  );
}

export interface AssembleDeliveryInput {
  state: RunState;
  checks: ChecksConfig;
  baseRevision: string;
  diffText: string;
  changedFiles: string[];
  checkArtifacts?: CheckArtifact[];
  finalChecks: CheckRunRecord[];
  findings: Finding[];
  integration: IntegrationResult;
  verification: VerificationResult;
  acceptance: DoctrineAcceptance;
}

/**
 * A doctrine's own contributions to the delivery manifest.
 *
 * `limitations`, `residualRisks` and `rollback` are otherwise computed here from checks and
 * findings, which leaves no way for a doctrine to disclose something that is neither. A Westminster
 * swarm's Question Time answers about unmet criteria, a socialist council's recorded shortfall, a
 * capitalist warranty exclusion are all real disclosures with no finding attached, and section 10
 * requires the manifest to carry known limitations and residual risks — not merely the ones the
 * engine can derive.
 *
 * Deliberately doctrine-neutral, and read from strategyState in the same way `decisionRationales`
 * already is. Additive only: a doctrine can disclose more, never less. Nothing here can remove a
 * limitation the engine found.
 */
export interface DeliveryNotes {
  limitations: string[];
  residualRisks: string[];
  /** Appended to the engine's rollback instructions — a doctrine may add to them, not replace them. */
  rollbackNotes: string[];
}

function readDeliveryNotes(state: RunState): DeliveryNotes {
  const raw = state.strategyState?.deliveryNotes as Partial<DeliveryNotes> | undefined;
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0) : [];
  return {
    limitations: strings(raw?.limitations),
    residualRisks: strings(raw?.residualRisks),
    rollbackNotes: strings(raw?.rollbackNotes),
  };
}

export function assembleDelivery(input: AssembleDeliveryInput): DeliveryPacket {
  const { state, checks } = input;
  const requirementMatrix = buildRequirementMatrix(state);
  const graph = state.graph;

  const decisions =
    graph?.order.map((id) => {
      const node = graph.nodes[id];
      return {
        taskId: id,
        title: node.title,
        outcome: latestVerdict(node) ?? 'pending',
        rationale: (state.strategyState?.decisionRationales as Record<string, string> | undefined)?.[id] ?? '',
        evidenceRefs: (node.evidence ?? []).map((e) => e.command),
      };
    }) ?? [];

  const notes = readDeliveryNotes(state);

  const limitations = [...limitationsFrom(input.finalChecks)];
  for (const gap of unevidencedCriteria(requirementMatrix, state.task.acceptanceCriteria)) {
    limitations.push(`Acceptance criterion has no satisfying evidence: "${gap.criterion}"`);
  }
  // Work released to proceed without a dependency the doctrine abandoned is honest about it here.
  // The engine let these tasks run rather than stranding them forever behind a task that was never
  // coming, and the price of that is saying so: what they built was built around a gap, and a
  // reader of the manifest must not mistake an abandoned dependency for one that passed.
  for (const id of graph?.order ?? []) {
    const missing = graph?.nodes[id].abandonedDependencies;
    if (missing?.length) {
      limitations.push(
        `Task "${id}" was completed without ${missing.length === 1 ? 'its abandoned dependency' : 'its abandoned dependencies'} ` +
          `${missing.map((dep) => `"${dep}"`).join(', ')}, whose work is not in this delivery.`,
      );
    }
  }
  // A task the doctrine abandoned is not quietly missing. The delivery may now be submitted with
  // it outstanding, so the manifest must name it and say why it was given up, or a reader would
  // take this packet for the whole of what was asked.
  for (const id of graph?.order ?? []) {
    const node = graph?.nodes[id];
    if (node?.phase !== 'abandoned') continue;
    const reason = node.attempts.at(-1)?.rationale?.replace(/\s+/g, ' ').trim().slice(0, 240);
    limitations.push(
      `Task "${id}" (${node.title}) was abandoned after ${node.attempts.length} attempt(s) and is not in this delivery` +
        (reason ? `: ${reason}` : '.'),
    );
  }
  limitations.push(...notes.limitations);

  const residualRisks = input.findings
    .filter((f) => f.disposition === 'unresolved' || f.disposition === 'deferred')
    .map((f) => `[${f.disposition}] ${f.summary}`);

  for (const failure of blockingFailures(input.finalChecks, checks)) {
    residualRisks.push(`Required check "${failure.categoryId}" is failing on the integrated tree.`);
  }
  residualRisks.push(...notes.residualRisks);

  return {
    runId: state.runId,
    strategy: state.strategy,
    baseRevision: input.baseRevision,
    branch: state.branch,
    goal: state.task.goal,
    acceptanceCriteria: state.task.acceptanceCriteria,
    changedFiles: input.changedFiles,
    checkArtifacts: input.checkArtifacts ?? [],
    diffText: input.diffText,
    requirementMatrix,
    baseline: state.baseline ?? [],
    finalChecks: input.finalChecks,
    decisions,
    findings: input.findings,
    minorityReports: input.findings.filter((f) => f.minority),
    limitations,
    residualRisks,
    rollback: [
      `The run's work is isolated on branch "${state.branch}" and has not touched the working tree. ` +
        `To discard it, delete that branch and its worktree. If it was already applied with swarm_apply, ` +
        `revert the resulting merge commit on "${state.baseBranch}".`,
      ...notes.rollbackNotes,
    ].join(' '),
    integrationEvidence: input.integration,
    independentVerification: input.verification,
    doctrineAcceptance: input.acceptance,
    assembledAt: new Date().toISOString(),
    remediationCycles: state.remediationCycles ?? 0,
  };
}

/**
 * Structural defects that make a manifest unfit to submit at all — as distinct from substantive
 * problems (a failing check, an unresolved risk), which are Claude's to weigh during its
 * independent check. Nothing here is a judgment about the code.
 */
export function deliveryPacketErrors(packet: DeliveryPacket): string[] {
  const errors: string[] = [];
  for (const finding of packet.findings) {
    const err = findingDispositionError(finding);
    if (err) errors.push(err);
  }
  if (!packet.integrationEvidence) errors.push('Delivery packet carries no integration evidence.');
  if (!packet.independentVerification) errors.push('Delivery packet carries no independent verification.');
  if (packet.independentVerification?.verifierId && packet.integrationEvidence?.integratorId) {
    // Section 9/10, all three doctrines: final verification belongs to an agent outside the chain
    // that produced the work. An integrator certifying its own integration is exactly the
    // self-certification each doc rules out.
    if (packet.independentVerification.verifierId === packet.integrationEvidence.integratorId) {
      errors.push(
        `Independent verification was performed by "${packet.independentVerification.verifierId}", the same ` +
          `agent that performed integration — verification must sit outside the authorship chain.`,
      );
    }
  }
  if (!packet.rollback.trim()) errors.push('Delivery packet states neither rollback instructions nor why rollback is inapplicable.');
  return errors;
}
