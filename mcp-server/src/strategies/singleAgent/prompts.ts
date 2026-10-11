import type { DeliveryPacket, Finding } from '../../engine/packets.js';
import type { FileOp, TaskSpec, TestResult } from '../../engine/types.js';
import { fillMissingRationale, isNonEmptyString, isSafeRelativePath, isValidFileOpShape, isValidVerdict } from '../validation.js';
import { implementerReminders } from '../implementerReminders.js';

const MAX_PLANNED_TASKS = 3;

export interface PlannedTask {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  targetGlobs: string[];
  dependsOn: string[];
}

export interface PlannerOutput {
  tasks: PlannedTask[];
}

export interface ImplementerOutput {
  fileOps: Array<
    | { op: 'write'; path: string; content: string }
    | { op: 'edit'; path: string; find: string; replace: string }
    | { op: 'delete'; path: string }
  >;
  rationale: string;
  unresolvedUncertainty?: string;
}

export interface SelfReviewOutput {
  verdict: 'approve' | 'reject' | 'flag';
  rationale: string;
  evidenceRefs: string[];
  requiredChanges: string[];
  requiresHumanJudgment: boolean;
}

export const TEST_MANDATE_SYSTEM_PROMPT =
  'You are doing the planning pass for a single-agent coding baseline. Map each acceptance criterion ' +
  'to evidence that can actually demonstrate it. Do not claim that unrun checks passed.';

export const PLANNER_SYSTEM_PROMPT =
  'You are the sole agent planning a coding task. Prefer one task. Use two or three only when a real ' +
  'dependency makes that necessary. Keep the plan concrete, small, and directly tied to the request.';

export const IMPLEMENTER_SYSTEM_PROMPT =
  'You are the sole agent implementing the assigned coding task. Return only necessary file operations. ' +
  'Respect the stated paths, acceptance criteria, and constraints; disclose any unresolved uncertainty.';

export const SELF_REVIEW_SYSTEM_PROMPT =
  'This is a second pass by the same agent that produced the change, not an independent review. Re-read ' +
  'the proposed file operations against every acceptance criterion and the actual test result. Reject or ' +
  'flag concrete defects, and approve only when the available evidence supports approval.';

export const INTEGRATION_SYSTEM_PROMPT =
  'This is the single agent performing a separate integration pass over the combined diff. Check that the ' +
  'approved tasks form one coherent change and report concrete conflicts or omissions honestly.';

export const VERIFICATION_SYSTEM_PROMPT =
  'This is the single agent performing a final verification pass. Trace each acceptance criterion to the ' +
  'combined diff and recorded checks. Verify only criteria supported by both implementation and evidence.';

export const DISPOSITION_SYSTEM_PROMPT =
  'You are the same single agent closing the review record. Give every supplied finding exactly one honest ' +
  'disposition. Deferred findings must name an owner and a concrete return condition.';

export const plannerSchemaDescription =
  '{ "tasks": [ { "id": string (short unique slug), "title": string, "description": string, ' +
  '"acceptanceCriteria": string[], "targetGlobs": string[] (relative paths or globs), ' +
  '"dependsOn": string[] (ids in this plan) } ] } — return between one and three tasks';

export const implementerSchemaDescription =
  '{ "fileOps": [ { "op":"write", "path":string, "content":string } | ' +
  '{ "op":"edit", "path":string, "find":string, "replace":string } | ' +
  '{ "op":"delete", "path":string } ], "rationale": string, "unresolvedUncertainty": string (optional) }';

export const selfReviewSchemaDescription =
  '{ "verdict":"approve"|"reject"|"flag", "rationale":string, "evidenceRefs":string[], ' +
  '"requiredChanges":string[], "requiresHumanJudgment":boolean }';

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

export function validatePlannerOutput(value: unknown): asserts value is PlannerOutput {
  if (typeof value !== 'object' || value === null) throw new Error('Expected an object');
  const tasks = (value as Partial<PlannerOutput>).tasks;
  if (!Array.isArray(tasks) || tasks.length === 0 || tasks.length > MAX_PLANNED_TASKS) {
    throw new Error(`tasks must contain between 1 and ${MAX_PLANNED_TASKS} entries`);
  }
  const ids = new Set<string>();
  for (const task of tasks) {
    if (typeof task !== 'object' || task === null) throw new Error('Each task must be an object');
    if (!isNonEmptyString(task.id) || ids.has(task.id)) throw new Error('task ids must be non-empty and unique');
    if (!isNonEmptyString(task.title)) throw new Error('task.title must be a non-empty string');
    if (!isNonEmptyString(task.description)) throw new Error('task.description must be a non-empty string');
    if (!isStringArray(task.acceptanceCriteria)) throw new Error('task.acceptanceCriteria must be a string array');
    if (!isStringArray(task.targetGlobs)) throw new Error('task.targetGlobs must be a string array');
    if (!isStringArray(task.dependsOn)) throw new Error('task.dependsOn must be a string array');
    ids.add(task.id);
  }
}

export function validateImplementerOutput(value: unknown): asserts value is ImplementerOutput {
  if (typeof value !== 'object' || value === null) throw new Error('Expected an object');
  const output = value as Partial<ImplementerOutput>;
  if (!Array.isArray(output.fileOps)) throw new Error('fileOps must be an array');
  for (const op of output.fileOps) {
    if (!isValidFileOpShape(op, 'path')) throw new Error('Each fileOp must have a valid operation shape');
    if (!isSafeRelativePath(op.path)) throw new Error(`fileOp.path is unsafe: ${String(op.path)}`);
  }
  fillMissingRationale(output);
}

export function validateSelfReviewOutput(value: unknown): asserts value is SelfReviewOutput {
  if (typeof value !== 'object' || value === null) throw new Error('Expected an object');
  const output = value as Partial<SelfReviewOutput>;
  if (!isValidVerdict(output.verdict)) throw new Error('verdict must be approve, reject, or flag');
  if (!isNonEmptyString(output.rationale)) throw new Error('rationale must be a non-empty string');
  if (!isStringArray(output.evidenceRefs)) throw new Error('evidenceRefs must be a string array');
  if (!isStringArray(output.requiredChanges)) throw new Error('requiredChanges must be a string array');
  if (typeof output.requiresHumanJudgment !== 'boolean') throw new Error('requiresHumanJudgment must be boolean');
}

export function buildPlannerUserPrompt(task: TaskSpec): string {
  return (
    `Goal: ${task.goal}\n\nAcceptance criteria:\n` +
    `${task.acceptanceCriteria.map((criterion) => `- ${criterion}`).join('\n') || '(none given)'}\n\n` +
    `Constraints:\n${task.constraints?.map((constraint) => `- ${constraint}`).join('\n') || '(none)'}\n\n` +
    'Produce the smallest workable task graph.'
  );
}

export function buildImplementerUserPrompt(
  goal: string,
  task: { title: string; description: string; acceptanceCriteria: string[]; targetGlobs: string[] },
  remediation?: string,
  reworkChanges: string[] = [],
): string {
  const rework = reworkChanges.length
    ? `\nRequired corrections from the prior attempt:\n${reworkChanges.map((change) => `- ${change}`).join('\n')}\n`
    : '';
  return (
    `Overall goal: ${goal}\n\n` +
    `Task: ${task.title}\n\nDescription: ${task.description}\n\n` +
    implementerReminders(task) +
    `Acceptance criteria:\n` +
    `${task.acceptanceCriteria.map((criterion) => `- ${criterion}`).join('\n') || '(none given)'}\n\n` +
    `Expected paths: ${task.targetGlobs.join(', ') || '(not specified)'}\n` +
    `${remediation ? `\nRemediation required: ${remediation}\n` : ''}${rework}\nReturn the necessary file operations.`
  );
}

function renderFileOps(fileOps: FileOp[]): string {
  return fileOps
    .map((op) => {
      if (op.op === 'write') return `WRITE ${op.path}\n${op.content}`;
      if (op.op === 'edit') return `EDIT ${op.path}\nFIND:\n${op.find}\nREPLACE:\n${op.replace}`;
      return `DELETE ${op.path}`;
    })
    .join('\n\n');
}

export function buildSelfReviewUserPrompt(
  task: { title: string; acceptanceCriteria: string[] },
  product: { rationale: string; fileOps: FileOp[] },
  test: TestResult,
): string {
  return (
    `Task: ${task.title}\n\nAcceptance criteria:\n` +
    `${task.acceptanceCriteria.map((criterion) => `- ${criterion}`).join('\n') || '(none given)'}\n\n` +
    `Implementation rationale: ${product.rationale}\n\nProposed changes:\n${renderFileOps(product.fileOps)}\n\n` +
    `Test result: ${JSON.stringify(test)}\n\nPerform an honest self-review. Set requiresHumanJudgment only ` +
    'when a flagged question truly cannot be settled from the code, criteria, or test evidence.'
  );
}

export function buildIntegrationUserPrompt(
  goal: string,
  acceptanceCriteria: string[],
  titles: string[],
  diffText: string,
): string {
  return `Goal: ${goal}\nCriteria: ${acceptanceCriteria.join('; ')}\nTasks: ${titles.join('; ')}\n\nCombined diff:\n${diffText}`;
}

export function buildVerificationUserPrompt(
  goal: string,
  acceptanceCriteria: string[],
  requirementMatrix: DeliveryPacket['requirementMatrix'],
  checkSummary: string,
  diffText: string,
): string {
  return (
    `Goal: ${goal}\n\nAcceptance criteria:\n${acceptanceCriteria.map((criterion) => `- ${criterion}`).join('\n')}\n\n` +
    `Requirement matrix: ${JSON.stringify(requirementMatrix)}\n\nChecks:\n${checkSummary}\n\nCombined diff:\n${diffText}`
  );
}

export function buildDispositionUserPrompt(open: Finding[]): string {
  return (
    'Findings to disposition:\n' +
    open
      .map((finding) => `- ${finding.id}: ${finding.summary} (evidence: ${finding.evidenceRefs.join(', ') || 'none'})`)
      .join('\n')
  );
}
