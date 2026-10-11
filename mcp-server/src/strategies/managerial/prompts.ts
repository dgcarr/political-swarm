import { decompositionGuidance } from '../../engine/scale.js';
import type { FileOp, TaskNode, TaskSpec, TestResult, WorkProduct } from '../../engine/types.js';
import type { DeliveryPacket, Finding } from '../../engine/packets.js';
import { fillMissingRationale, isNonEmptyString, isSafeRelativePath, isValidFileOpShape, isValidVerdict } from '../validation.js';
import { implementerReminders } from '../implementerReminders.js';
import { compactFindingLine } from '../barriers.js';

export interface PlannerTask {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  dependsOn: string[];
  targetGlobs: string[];
  riskTags: string[];
}

export interface PlannerOutput {
  tasks: PlannerTask[];
}

export interface ImplementerOutput {
  fileOps: FileOp[];
  rationale: string;
  unresolvedUncertainty?: string;
}

export interface ReviewerOutput {
  verdict: 'approve' | 'reject' | 'flag';
  rationale: string;
  evidenceRefs?: string[];
}

export const PLANNER_SYSTEM_PROMPT =
  'You are a senior software planner. Break the requested change into coherent units that one engineer can implement and test. ' +
  'Keep tightly coupled code and tests together, express real dependencies, and name the concrete paths or globs each unit expects to change. ' +
  'Cover every acceptance criterion without creating process-only tasks.';

export function buildPlannerUserPrompt(task: TaskSpec): string {
  return (
    `Goal: ${task.goal}\n\n` +
    `Acceptance criteria:\n${renderList(task.acceptanceCriteria)}\n\n` +
    `${task.constraints?.length ? `Constraints:\n${renderList(task.constraints)}\n\n` : ''}` +
    `${decompositionGuidance(task, 'task')}\n\n` +
    'Return the implementation plan.'
  );
}

export const PLANNER_SCHEMA_DESCRIPTION =
  '{ "tasks": [ { "id": string (short unique id), "title": string, "description": string, ' +
  '"acceptanceCriteria": string[], "dependsOn": string[] (ids from this response), ' +
  '"targetGlobs": string[] (relative paths or globs), "riskTags": string[] } ] }';

export function validatePlannerOutput(value: unknown): asserts value is PlannerOutput {
  if (typeof value !== 'object' || value === null) throw new Error('Expected an object');
  const output = value as Partial<PlannerOutput>;
  if (!Array.isArray(output.tasks)) throw new Error('tasks must be an array');

  for (const task of output.tasks) {
    if (typeof task !== 'object' || task === null) throw new Error('Each task must be an object');
    if (!isNonEmptyString(task.id)) throw new Error('task.id must be a non-empty string');
    if (!isNonEmptyString(task.title)) throw new Error('task.title must be a non-empty string');
    if (!isNonEmptyString(task.description)) throw new Error('task.description must be a non-empty string');
    if (!isStringArray(task.acceptanceCriteria)) throw new Error('task.acceptanceCriteria must be a string array');
    if (!isStringArray(task.dependsOn)) throw new Error('task.dependsOn must be a string array');
    if (!isStringArray(task.targetGlobs)) throw new Error('task.targetGlobs must be a string array');
    if (!isStringArray(task.riskTags)) throw new Error('task.riskTags must be a string array');
  }
}

export const IMPLEMENTER_SYSTEM_PROMPT =
  'You are the engineer responsible for one assigned task. Produce only the smallest file operations needed to satisfy it. ' +
  'Use repository-relative paths and return complete write, exact edit, or delete operations. Do not return shell commands or patch syntax. ' +
  'State any unresolved technical uncertainty instead of hiding it.';

export function buildImplementerUserPrompt(goal: string, node: TaskNode, reworkChanges: string[]): string {
  const remediation = node.remediationOf ? `\n\nRemediation required by delivery review: ${node.remediationOf}` : '';
  const rework = reworkChanges.length > 0 ? `\n\nRequired corrections from the prior attempt:\n${renderList(reworkChanges)}` : '';
  return (
    `Overall goal: ${goal}\n\n` +
    `Assigned task: ${node.title}\n${node.description}\n\n` +
    implementerReminders(node) +
    `Acceptance criteria:\n${renderList(node.acceptanceCriteria)}\n\n` +
    `Expected paths: ${node.targetGlobs.join(', ') || '(not specified)'}` +
    remediation +
    rework
  );
}

export const IMPLEMENTER_SCHEMA_DESCRIPTION =
  '{ "fileOps": [ { "op": "write", "path": string, "content": string } | ' +
  '{ "op": "edit", "path": string, "find": string, "replace": string } | ' +
  '{ "op": "delete", "path": string } ], "rationale": string, "unresolvedUncertainty": string (optional) }';

export function validateImplementerOutput(value: unknown): asserts value is ImplementerOutput {
  if (typeof value !== 'object' || value === null) throw new Error('Expected an object');
  const output = value as Partial<ImplementerOutput>;
  if (!Array.isArray(output.fileOps)) throw new Error('fileOps must be an array');
  for (const operation of output.fileOps) {
    if (!isValidFileOpShape(operation, 'path')) throw new Error('Each fileOp must be a valid write, edit, or delete');
    if (!isSafeRelativePath(operation.path)) throw new Error(`Unsafe file operation path: ${operation.path}`);
  }
  fillMissingRationale(output);
  if (output.unresolvedUncertainty !== undefined && typeof output.unresolvedUncertainty !== 'string') {
    throw new Error('unresolvedUncertainty must be a string when provided');
  }
}

export const REVIEWER_SYSTEM_PROMPT =
  'You are an independent senior engineer reviewing work you did not author. Check the proposed file operations against the assigned task, ' +
  'its acceptance criteria, and the observed test result. Approve sound work, reject concrete defects requiring another implementation attempt, ' +
  'or flag material ambiguity or risk that requires human judgment. Cite paths or checks that support the verdict.';

/** The corrections this attempt was directed to make go to the reviewer too, so it can check they were. */
export function buildReviewerUserPrompt(
  product: WorkProduct,
  node: TaskNode | undefined,
  test: TestResult,
  reworkChanges: string[] = [],
): string {
  const remediation = node?.remediationOf ? `Remediation required by delivery review: ${node.remediationOf}\n\n` : '';
  const rework = reworkChanges.length > 0
    ? `Corrections this attempt was directed to make — confirm each was made:\n${renderList(reworkChanges)}\n\n`
    : '';
  return (
    `Task: ${node?.title ?? product.taskId}\n` +
    `Description: ${node?.description ?? '(description unavailable)'}\n\n` +
    `Acceptance criteria:\n${renderList(node?.acceptanceCriteria ?? [])}\n\n` +
    remediation +
    rework +
    `Implementer rationale: ${product.rationale}\n\n` +
    `File operations:\n${JSON.stringify(product.fileOps)}\n\n` +
    `Test result: ${JSON.stringify(test)}`
  );
}

export const REVIEWER_SCHEMA_DESCRIPTION =
  '{ "verdict": "approve" | "reject" | "flag", "rationale": string, "evidenceRefs": string[] (optional paths or checks) }';

export function validateReviewerOutput(value: unknown): asserts value is ReviewerOutput {
  if (typeof value !== 'object' || value === null) throw new Error('Expected an object');
  const output = value as Partial<ReviewerOutput>;
  if (!isValidVerdict(output.verdict)) throw new Error('verdict must be approve, reject, or flag');
  if (!isNonEmptyString(output.rationale)) throw new Error('rationale must be a non-empty string');
  if (output.evidenceRefs !== undefined && !isStringArray(output.evidenceRefs)) {
    throw new Error('evidenceRefs must be a string array when provided');
  }
}

export const TEST_MANDATE_SYSTEM_PROMPT =
  'You are the test lead for a software delivery. For each user acceptance criterion, select the configured check that can demonstrate it. ' +
  'If automation cannot demonstrate a criterion, describe a reproducible manual inspection and the evidence it must produce. ' +
  'Do not claim that a criterion already passes; this step defines evidence before implementation.';

export const INTEGRATION_SYSTEM_PROMPT =
  'You are a senior engineer checking the combined result after individually reviewed tasks have been assembled. ' +
  'Inspect interactions across task boundaries, shared interfaces, regressions, and consistency with the overall goal. ' +
  'Report concrete findings supported by a path or command.';

export function buildIntegrationUserPrompt(
  goal: string,
  acceptanceCriteria: string[],
  titles: string[],
  truncatedDiff: string,
): string {
  return (
    `Goal: ${goal}\n\n` +
    `Acceptance criteria:\n${renderList(acceptanceCriteria)}\n\n` +
    `Completed tasks:\n${renderList(titles)}\n\n` +
    `Combined diff:\n${truncatedDiff}`
  );
}

export const VERIFICATION_SYSTEM_PROMPT =
  'You are the final verification engineer and did not implement or integrate this change. Trace every acceptance criterion to both implementing code ' +
  'and recorded evidence, account for required check results, and report any unsupported criterion or delivery defect. Verify only when the record supports it.';

export function buildVerificationUserPrompt(
  goal: string,
  acceptanceCriteria: string[],
  requirementMatrix: DeliveryPacket['requirementMatrix'],
  checkSummary: string,
  truncatedDiff: string,
): string {
  return (
    `Goal: ${goal}\n\n` +
    `Acceptance criteria:\n${renderList(acceptanceCriteria)}\n\n` +
    `Evidence matrix:\n${JSON.stringify(requirementMatrix)}\n\n` +
    `Checks:\n${checkSummary}\n\n` +
    `Combined diff:\n${truncatedDiff}`
  );
}

export const DISPOSITION_SYSTEM_PROMPT =
  'You are the senior reviewer closing the engineering finding log. Give every supplied finding exactly one disposition with a concrete rationale. ' +
  'A deferred item must name the responsible owner and the condition that brings it back for review. Do not omit a finding.';

export function buildDispositionUserPrompt(open: Finding[]): string {
  return (
    'Open findings:\n' +
    open.map(compactFindingLine).join('\n')
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function renderList(items: string[]): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join('\n') : '(none)';
}
