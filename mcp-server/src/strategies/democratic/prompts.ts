// System/user prompt builders and response validators for every WorkerDispatcher call the
// democratic strategy makes. Kept separate from DemocraticStrategy.ts so the orchestration logic
// (lifecycle wiring, vote math) isn't buried under prompt text.
import type { TaskSpec, FileOp, TestResult } from '../../engine/types.js';
import { decompositionGuidance } from '../../engine/scale.js';
import { fillMissingRationale, isNonEmptyString, isSafeRelativePath, isValidFileOpShape, isValidVerdict } from '../validation.js';
import { implementerReminders } from '../implementerReminders.js';
import type {
  CommitteeFinding,
  Motion,
  MotionClass,
  OppositionFinding,
  PlannerOutput,
  RecommittalDirective,
} from './types.js';
import type { RevisingPoint, RevisingReport } from './houseOfReview.js';
import { compactFindingLine } from '../barriers.js';
import { clipCheckOutput } from '../../util/checkOutput.js';

// ---------- planner ----------

export function plannerSystemPrompt(): string {
  return (
    'You are the Bill Drafting Office for a Westminster-style software governance swarm. ' +
    'You turn a coding goal into one or more "motions" (units of work) that will each go through ' +
    'committee review, opposition scrutiny, and a vote before being applied. ' +
    'Never split one coherent change per-file, and never bundle work a single implementer could not ' +
    'deliver in one pass into a single motion — follow the explicit "Sizing:" instruction in the user ' +
    'message, which states how many motions this particular goal warrants. ' +
    'Each motion must name concrete file paths it expects to touch in targetGlobs (e.g. "src/auth/login.js"), ' +
    'since that drives risk classification and committee routing. ' +
    'Every motion must also state what it will cost, what could go wrong, and what would have to be true ' +
    'for it to be undone. The House is told these figures before it votes and the executive is held to ' +
    'them afterwards, so estimate honestly rather than optimistically — an underestimate is a ground for ' +
    'a confidence motion, not a way of getting a motion carried. ' +
    'Output strict JSON only: every object key must be double-quoted, no trailing commas, no comments, ' +
    'no markdown fences, and any literal newline inside a string value must be escaped as \\n.'
  );
}

export function plannerUserPrompt(task: TaskSpec): string {
  return (
    `Goal: ${task.goal}\n` +
    `Acceptance criteria:\n${task.acceptanceCriteria.map((c) => `- ${c}`).join('\n') || '(none given)'}\n` +
    (task.constraints?.length ? `Constraints:\n${task.constraints.map((c) => `- ${c}`).join('\n')}\n` : '') +
    `Repo base branch: ${task.baseBranch}\n\n` +
    `${decompositionGuidance(task, 'motion')}\n\n` +
    'Draft the motion(s) needed to accomplish this goal.'
  );
}

export const plannerSchemaDescription =
  '{ "motions": [ { "id": string (short slug, unique), "title": string, "description": string, ' +
  '"acceptanceCriteria": string[], "targetGlobs": string[] (concrete relative file paths/globs this ' +
  'motion will touch), "dependsOn": string[] (ids of other motions in this same array, or []), ' +
  '"portfolioTag": string (one of "architecture","security","testing","frontend","backend","docs","general"), ' +
  '"estimatedCostUsd": number (your honest estimate of the model spend this motion needs, e.g. 0.05), ' +
  '"foreseeableRisks": string[] (what could go wrong if the House carries this), ' +
  '"rollbackConditions": string (what would have to be true for this to be undone) } ] }';

export function validatePlannerOutput(value: unknown): asserts value is PlannerOutput {
  if (typeof value !== 'object' || value === null || !Array.isArray((value as PlannerOutput).motions)) {
    throw new Error('Expected { motions: Motion[] }');
  }
  const motions = (value as PlannerOutput).motions;
  if (motions.length === 0) throw new Error('motions must be a non-empty array');
  for (const m of motions) {
    if (typeof m !== 'object' || m === null) throw new Error('Each motion must be an object');
    const motion = m as Partial<Motion>;
    if (!isNonEmptyString(motion.id)) throw new Error('motion.id must be a non-empty string');
    if (!isNonEmptyString(motion.title)) throw new Error('motion.title must be a non-empty string');
    if (!isNonEmptyString(motion.description)) throw new Error('motion.description must be a non-empty string');
    if (!Array.isArray(motion.acceptanceCriteria)) throw new Error('motion.acceptanceCriteria must be an array');
    if (!Array.isArray(motion.targetGlobs)) throw new Error('motion.targetGlobs must be an array');
    if (!Array.isArray(motion.dependsOn)) throw new Error('motion.dependsOn must be an array');
    if (!isNonEmptyString(motion.portfolioTag)) throw new Error('motion.portfolioTag must be a non-empty string');
  }
}

// ---------- committee (elected specialist + sortition) ----------

export function committeeSystemPrompt(seat: 'elected' | 'sortition', portfolioTag: string): string {
  if (seat === 'elected') {
    return (
      `You are an elected specialist member of the "${portfolioTag}" select committee, scrutinizing a ` +
      'proposed motion (not yet implemented) before it is assigned to an implementer. Judge whether the ' +
      'motion as described is well-scoped, technically sound, and safe to proceed with. ' +
      'Be a competent domain reviewer, not a rubber stamp — flag real scope, safety, or clarity problems. ' +
      'Scrutiny means judging, not withholding: approving a sound motion is a normal and expected ' +
      'outcome, and a motion you would be content to see implemented should be approved with any ' +
      'residual ambiguity stated in your rationale rather than flagged.'
    );
  }
  return (
    'You are an ordinary citizen selected by sortition (lottery) to sit as a lay member on this committee, ' +
    'representing common-sense, non-specialist judgment. Judge whether the proposed motion sounds reasonable ' +
    'and clearly described to a competent generalist engineer. You are not a domain expert — flag things that ' +
    'seem confusing, overly risky, or poorly justified, but defer on deep technical nuance. ' +
    'Deferring means approving: technical detail you are not equipped to judge is not a reason to flag, ' +
    'and a motion that reads as reasonable and clearly described should be approved.'
  );
}

interface MotionPromptInput {
  motionTitle: string;
  motionDescription: string;
  acceptanceCriteria: string[];
  targetGlobs: string[];
  recommittal?: RecommittalDirective;
  /** The directive a motion reopened after it carried is returned with, evidence included. */
  remediation?: string;
}

function recommittalPrompt(directive: RecommittalDirective | undefined, audience: 'committee' | 'implementer'): string {
  if (!directive) return '';

  const appeal = directive.appealGranted
    ? 'The motion\'s one constitutional appeal was granted because the earlier division was close. This does not approve the motion.'
    : 'No appeal changes the earlier result.';
  const repeated = directive.repeated
    ? 'The engine found the previous attempt materially identical to its predecessor; require a materially different response.'
    : '';
  // The motion is NOT revised between attempts — recover() records required changes and leaves the
  // motion as tabled. Telling the committee otherwise invited it to look for an amendment that was
  // never made, find the original wording intact, and refuse on that ground every time; a motion
  // carrying a drafting defect no implementer can reach was then unpassable however good the code
  // became. The committee keeps its full power to refuse; it is only told accurately what it holds.
  const instruction = audience === 'committee'
    ? 'The motion stands as tabled — its wording has not been amended. What has changed is the ' +
      'implementation, which was returned for repair against the required changes below. Judge ' +
      'whether the motion may proceed to a further implementation attempt on those terms. An ' +
      'objection to the motion\'s own drafting cannot be cured by an implementer: where the required ' +
      'changes already cover it, do not re-raise it as grounds to refuse, and where they do not, ' +
      'state it as a further required change instead. ' +
      // Section 7 stage 4: "agents must answer objections rather than repeat conclusions". A
      // lone recommittal seat once refused six attempts running whose checks passed and which the
      // Opposition approved, each time citing only the refusal before it.
      'An earlier refusal, vote or objection is not itself a ground to refuse: refuse only for a ' +
      'required change that the evidence below still leaves unmet, and name it.'
    : 'The new implementation must concretely address every required change.';
  const last = directive.lastAttempt;
  const evidence = audience === 'committee' && last
    ? `What the last attempt showed: required checks ${last.checksPassed ? 'passed' : 'failed'}` +
      (last.oppositionVerdict
        ? `; the Opposition, which read the diff, ${last.oppositionVerdict === 'approve' ? 'approved it' : `recorded a "${last.oppositionVerdict}"`}.`
        : '.') +
      '\n'
    : '';

  return (
    `\n\nRecommittal after attempt ${directive.attemptNumber} of at most ${directive.maxAttempts}:\n` +
    `${appeal}\n` +
    `${instruction}\n` +
    evidence +
    `${repeated ? `${repeated}\n` : ''}` +
    `Required changes:\n${directive.requiredChanges.map((change) => `- ${change}`).join('\n')}`
  );
}

export function committeeUserPrompt(input: MotionPromptInput): string {
  return (
    `Motion: ${input.motionTitle}\n\n` +
    `Description: ${input.motionDescription}\n\n` +
    `Acceptance criteria:\n${input.acceptanceCriteria.map((c) => `- ${c}`).join('\n') || '(none given)'}\n\n` +
    `Files this motion will create or change: ${input.targetGlobs.join(', ') || '(none listed)'}` +
    // The committee sits before implementation. A seat once refused a motion four times because
    // "the repository lacks" the very files the motion was tabled to create.
    (input.remediation
      // A reopened motion's committee used to see only the original wording, with nothing saying
      // why it was back or that its files already existing is expected, not a sign it is done.
      ? '\n\nThis motion carried earlier and was reopened for the defects below, found after it ' +
        'carried. Its files may already exist: that is expected, and is not a reason to refuse. Judge ' +
        `whether it may proceed to an implementation that fixes these defects:\n${input.remediation}`
      : input.targetGlobs.length
        ? '\nThe motion has not been implemented yet, so any of these files may not exist: creating ' +
          'them is the motion\'s work, and their absence is not a reason to refuse it.'
        : '') +
    recommittalPrompt(input.recommittal, 'committee') +
    '\n\nGive your committee verdict on whether this motion should proceed to implementation.'
  );
}

export const committeeSchemaDescription =
  '{ "verdict": "approve" | "reject" | "flag" | "abstain", "rationale": string (1-3 sentences) } ' +
  '— use "abstain" only when the motion as described does not give you enough to judge it on; ' +
  'an abstention is not counted, so it is a way of declining to vote, not a way of voting "maybe". ' +
  '"approve" means the motion should proceed; "flag" is counted as HALF a vote in favour, so it ' +
  'weighs against the motion carrying; "reject" counts as none. A motion every member flags ' +
  'therefore fails, even though no member opposed it — so flag a concern you want weighed against ' +
  'proceeding, and approve a sound motion whose remaining ambiguity you can simply state in your ' +
  'rationale for the implementer to resolve.';

/** Democratic-only: the shared isValidVerdict in strategies/validation.ts is used by the socialist
 * strategy too, and 'abstain' is this doctrine's protected right rather than a shared concept. */
function isCommitteeVerdict(value: unknown): value is CommitteeFinding['verdict'] {
  return isValidVerdict(value) || value === 'abstain';
}

export function validateCommitteeVerdict(value: unknown): asserts value is { verdict: CommitteeFinding['verdict']; rationale: string } {
  if (typeof value !== 'object' || value === null) throw new Error('Expected an object');
  const v = value as { verdict?: unknown; rationale?: unknown };
  if (!isCommitteeVerdict(v.verdict)) {
    throw new Error('verdict must be "approve", "reject", "flag" or "abstain"');
  }
  if (!isNonEmptyString(v.rationale)) throw new Error('rationale must be a non-empty string');
}

// ---------- implementer ----------

export function implementerSystemPrompt(): string {
  return (
    'You are the implementer for one motion that has passed committee. Produce the actual code change as ' +
    'a JSON array of FileOps. You do NOT have shell access and must NOT emit diffs, patch syntax, or ' +
    'commands — only whole-file writes, exact find/replace edits, or deletes. All paths must be relative ' +
    'to the repository root and must not escape it (no "..", no absolute paths). Keep changes minimal, ' +
    'directly scoped to the motion, and prefer a small number of short files over one large one. ' +
    'Output strict JSON only, matching RFC 8259 exactly: every object key must be double-quoted ' +
    '(e.g. "path", never bare path), no trailing commas, no comments, no markdown fences, and every ' +
    'literal newline or double-quote inside a "content"/"find"/"replace" string MUST be escaped ' +
    '(\\n, \\") rather than written as a raw line break or quote. Double-check your own output is valid ' +
    'JSON before answering.'
  );
}

/**
 * `goal` is the whole goal: the motion is the mandate, the goal the context every arm's implementer reads.
 */
export function implementerUserPrompt(input: MotionPromptInput & { goal: string }): string {
  const motionAsTask = { title: input.motionTitle, description: input.motionDescription, targetGlobs: input.targetGlobs };
  return (
    `The goal the Commons authorised: ${input.goal}\n\n` +
    `Motion: ${input.motionTitle}\n\n` +
    `Description: ${input.motionDescription}\n\n` +
    implementerReminders(motionAsTask) +
    `Acceptance criteria:\n${input.acceptanceCriteria.map((c) => `- ${c}`).join('\n') || '(none given)'}\n\n` +
    `Expected file paths: ${input.targetGlobs.join(', ') || '(choose sensible paths)'}` +
    // A motion graph or delivery remediation reopened used to be re-run on its original wording
    // alone: the defect that reopened it sat on the node and never reached the implementer.
    (input.remediation
      ? `\n\nThis motion carried, then was reopened for defects found after it. The new implementation ` +
        `must fix each of them:\n${input.remediation}`
      : '') +
    recommittalPrompt(input.recommittal, 'implementer') +
    '\n\n' +
    'Return the FileOps needed to satisfy this motion, plus a short rationale.'
  );
}

// The wire key intentionally differs from the engine FileOp key for model compatibility.
export interface ImplementerWireFileOp {
  op: 'write' | 'edit' | 'delete';
  filePath: string;
  content?: string;
  find?: string;
  replace?: string;
}

export interface ImplementerWireOutput {
  fileOps: ImplementerWireFileOp[];
  rationale: string;
  unresolvedUncertainty?: string;
}

export const implementerSchemaDescription =
  'A strict JSON object (this is JSON, NOT a JavaScript object literal — every key below MUST be ' +
  'wrapped in double quotes exactly like the example) matching this exact worked example:\n' +
  '{"fileOps":[{"op":"write","filePath":"src/example.js","content":"function example() {\\n  return true;\\n}\\n"}],' +
  '"rationale":"Short explanation of what changed and why.","unresolvedUncertainty":""}\n' +
  'Valid fileOp shapes (op is always one of these three, "filePath" is always double-quoted and relative): ' +
  '{"op":"write","filePath":string,"content":string} | {"op":"edit","filePath":string,"find":string,"replace":string} | ' +
  '{"op":"delete","filePath":string}. "rationale" is required; "unresolvedUncertainty" is optional (omit or use "").';

export function validateImplementerOutput(value: unknown): asserts value is ImplementerWireOutput {
  if (typeof value !== 'object' || value === null) throw new Error('Expected an object');
  const v = value as Partial<ImplementerWireOutput>;
  if (!Array.isArray(v.fileOps)) throw new Error('fileOps must be an array');
  for (const op of v.fileOps) {
    if (!isValidFileOpShape(op, 'filePath')) {
      throw new Error('Each fileOp must use a valid write, edit, or delete shape');
    }
    if (!isSafeRelativePath(op.filePath)) {
      throw new Error(`fileOp.filePath must be a relative, non-escaping path: ${String(op.filePath)}`);
    }
  }
  fillMissingRationale(v);
}

/** Translates the wire format (filePath) into the engine's real FileOp[] (path). */
export function toEngineFileOps(wireOps: ImplementerWireFileOp[]): FileOp[] {
  return wireOps.map((op): FileOp => {
    if (op.op === 'write') return { op: 'write', path: op.filePath, content: op.content ?? '' };
    if (op.op === 'edit') return { op: 'edit', path: op.filePath, find: op.find ?? '', replace: op.replace ?? '' };
    return { op: 'delete', path: op.filePath };
  });
}

// ---------- opposition ----------

/** Per-fragment budget for code shown to the Opposition. Generous because the alternative — a
 * reviewer inferring defects from a keyhole view — costs a blocked division, and marked when it
 * bites so an objection is never founded on the cut itself. */
const REVIEW_EXTRACT_MAX_CHARS = 20_000;

function truncateForReview(text: string): string {
  if (text.length <= REVIEW_EXTRACT_MAX_CHARS) return text;
  return `${text.slice(0, REVIEW_EXTRACT_MAX_CHARS)}\n…[extract truncated — do not treat what follows as absent]`;
}

/** The Opposition's system prompt.
 *
 * The verdict criteria below mirror houseOfReviewSystemPrompt's treatment of "veto": this is the
 * chamber's other blocking role, and it was the only one whose blocking verdict carried no
 * criteria at all. A "reject" here overrides even a unanimous division (see vote.ts), so an
 * unguided choice between flag and reject is the highest-leverage signal in the strategy — and
 * an adversarial framing with no threshold reliably spends it. Observed in benchmarking:
 * test-passing work carried unanimously by committee, rejected on a single opposition verdict.
 *
 * The veto RULE is deliberate and stays as written. What is corrected here is what the reviewer
 * is told, and (via portfolioTag) who it is told it is — the shadow ministers were previously
 * indistinguishable, all receiving one argument-less prompt, despite the strategy documenting
 * that the agent challenging a security change is the one watching security. */
export function oppositionSystemPrompt(portfolioTag?: string): string {
  const portfolio = portfolioTag
    ? `You hold the ${portfolioTag} portfolio in the shadow cabinet; scrutinize this change from that vantage first. `
    : '';
  return (
    "You are Her Majesty's Loyal Opposition. " +
    portfolio +
    'Your job is to adversarially scrutinize a proposed code ' +
    'change (not the motion — the actual diff) and try to find real, concrete flaws: correctness bugs, ' +
    'missed acceptance criteria, security problems, or reckless scope. Write a falsification attempt — try ' +
    'to prove the change is wrong or unsafe before it becomes law. Do not invent problems that are not ' +
    'actually present; a genuinely sound change should be approved. Be specific and cite the exact file/' +
    'content evidence for any claim. ' +
    'Your verdict has three settings and they are not interchangeable. Use "reject" ONLY for a ' +
    'concrete defect you can point at in the text you were shown: a correctness bug, a breached ' +
    'safety or security rule, a deleted or weakened test, or an acceptance criterion with no ' +
    'evidence. A reject overrides even a unanimous vote, so do not reach for it to express a ' +
    'strong opinion about design, style, or what you would have preferred. Use "flag" for a ' +
    'concern worth recording that should not by itself block the change. Use "approve" when the ' +
    'change is sound — approving is a normal outcome, not a failure to do your job. ' +
    'You are shown an extract of the change, not the whole repository: do not reject a change for ' +
    'something you merely cannot see. Where you have repository tools, read the code a claim depends ' +
    'on; where you can run a review command, try to reproduce the defect before you rest a reject on ' +
    'it, since a reproduced failure is the strongest falsification you can offer. If you still cannot ' +
    'see it, say so and flag it rather than rejecting. ' +
    'Whenever you reject or flag, name the remedy: the smallest concrete change to the diff that ' +
    'would satisfy your objection. An objection the government cannot act on only spends a rework ' +
    'attempt; one that names its remedy tells the next attempt what to do.'
  );
}

export function oppositionUserPrompt(
  motionTitle: string,
  rationale: string,
  fileOps: FileOp[],
  acceptanceCriteria: string[],
  test: TestResult,
  previousRequiredChanges: readonly string[] = [],
): string {
  // An edit was previously rendered as find=<300 chars> replace=<300 chars>, which is far too
  // little to judge: a reviewer asked to falsify a change while shown a 300-character fragment
  // reliably objects to code it simply cannot see ("no validation", "no error handling"), and a
  // non-low reject then blocks the division outright. Edits now get the same budget as writes.
  const opsSummary = fileOps
    .map((op) => {
      if (op.op === 'write') return `WRITE ${op.path}:\n${truncateForReview(op.content)}`;
      if (op.op === 'edit') {
        return (
          `EDIT ${op.path}\n--- replacing:\n${truncateForReview(op.find)}\n` +
          `--- with:\n${truncateForReview(op.replace)}`
        );
      }
      return `DELETE ${op.path}`;
    })
    .join('\n\n');
  return (
    `Motion: ${motionTitle}\n\n` +
    `Implementer's rationale: ${rationale}\n\n` +
    `Acceptance criteria:\n${acceptanceCriteria.map((c) => `- ${c}`).join('\n') || '(none given)'}\n\n` +
    `Proposed file changes:\n${opsSummary}\n\n` +
    // Section 7 stage 4 asks objections be answered, not restated. Shown only the new diff, the
    // Opposition could not tell whether the last round's objection had been met, so each round
    // judged afresh and could raise a new one while the old one was already fixed.
    (previousRequiredChanges.length
      ? 'This is a repair attempt. The previous attempt was returned with these required changes:\n' +
        `${previousRequiredChanges.map((change) => `- ${change}`).join('\n')}\n` +
        'Check first whether this change makes each of them, and say which remain unmet. A ' +
        'required change this diff meets is not a ground to object again.\n\n'
      : '') +
    `Test result available to you: ran=${test.ran} passed=${test.passed}${test.output ? ` output=${clipCheckOutput(test.output, 1000)}` : ''}\n\n` +
    'Produce your counter-brief and verdict.'
  );
}

export const oppositionSchemaDescription =
  '{ "verdict": "approve" | "reject" | "flag", "severity": "low" | "medium" | "high", ' +
  '"rationale": string, "counterBrief": string (optional, longer falsification argument), ' +
  '"remedy": string (required when verdict is "reject" or "flag": the smallest concrete change that would satisfy the objection) }';

export function validateOppositionOutput(value: unknown): asserts value is OppositionFinding {
  if (typeof value !== 'object' || value === null) throw new Error('Expected an object');
  const v = value as Partial<OppositionFinding>;
  if (!isValidVerdict(v.verdict)) {
    throw new Error('verdict must be "approve", "reject", or "flag"');
  }
  if (v.severity !== 'low' && v.severity !== 'medium' && v.severity !== 'high') {
    throw new Error('severity must be "low", "medium", or "high"');
  }
  if (!isNonEmptyString(v.rationale)) throw new Error('rationale must be a non-empty string');
  if (v.remedy !== undefined && typeof v.remedy !== 'string') throw new Error('remedy must be a string when given');
}

// ---------- the House of Review (second chamber) ----------
// Section 6 gives this chamber delaying and revising powers, and a veto only "where constitutional
// safety rules are breached". The prompt states that limit plainly, because a second chamber that
// believed it could stop anything it disliked would spend the run trying to.

export function houseOfReviewSystemPrompt(): string {
  return (
    'You are the House of Review, the second chamber of a Westminster-style software governance ' +
    'swarm: senior verification, security and maintainability reviewers sitting with jurors chosen ' +
    'by lot. The Commons has already carried this programme, an Integration Committee has certified ' +
    'the combined tree and an independent verifier has reported. You are a REVISING chamber. Your ' +
    'powers are: "revise" (say what should be improved, without blocking), "delay" (say this should ' +
    'be reconsidered before it ships), and "veto" — which you may use ONLY where a constitutional ' +
    'safety rule is breached: security, safety, privacy, licensing, human-control, deleting or ' +
    'weakening a test, or an acceptance criterion with no evidence. A veto on any other ground will ' +
    'be recorded as a revision, so do not reach for it to express a strong opinion about design. ' +
    'Do not re-run the Commons debate: raise only what the first chamber and the verifier missed. ' +
    'If the delivery is sound, say so and raise nothing. ' +
    'Output strict JSON only: double-quoted keys, no trailing commas, no comments, no markdown ' +
    'fences, and any literal newline inside a string escaped as \\n.'
  );
}

export function houseOfReviewUserPrompt(
  goal: string,
  acceptanceCriteria: string[],
  checkSummary: string,
  openFindings: { id: string; source?: string; summary: string; evidenceRefs?: string[] }[],
  diffText: string,
): string {
  const register = openFindings.map((finding) => compactFindingLine({
    id: finding.id,
    source: finding.source ?? 'record',
    summary: finding.summary,
    evidenceRefs: finding.evidenceRefs ?? [],
  }));
  return (
    `The goal the Commons authorised: ${goal}\n\n` +
    `Acceptance criteria:\n${acceptanceCriteria.map((c) => `- ${c}`).join('\n') || '(none given)'}\n\n` +
    `Checks on the integrated tree:\n${checkSummary}\n\n` +
    `Parliamentary register of findings already before the House (cite by id; do not repeat these):\n` +
    `${register.join('\n') || '(none)'}\n\n` +
    `The combined diff:\n${diffText}\n\n` +
    'Report to the House.'
  );
}

export const houseOfReviewSchemaDescription =
  '{ "content": boolean (true if the chamber is content for this to proceed as it stands), ' +
  '"points": [ { "summary": string (one plain sentence), "evidence": string (a file path or ' +
  'command, no prose), "power": "revise" | "delay" | "veto" } ], "rationale": string (1-2 plain ' +
  'sentences; no quotation marks, newlines or code fences inside it) } — points must be [] when content is true';

export function validateHouseOfReviewReport(value: unknown): asserts value is RevisingReport {
  if (typeof value !== 'object' || value === null) throw new Error('Expected an object');
  const v = value as Partial<RevisingReport>;
  if (typeof v.content !== 'boolean') throw new Error('content must be a boolean');
  if (!isNonEmptyString(v.rationale)) throw new Error('rationale must be a non-empty string');
  if (!Array.isArray(v.points)) throw new Error('points must be an array');
  for (const p of v.points) {
    if (typeof p !== 'object' || p === null) throw new Error('Each point must be an object');
    const point = p as Partial<RevisingPoint>;
    if (!isNonEmptyString(point.summary)) throw new Error('points[].summary must be a non-empty string');
    if (!isNonEmptyString(point.evidence)) throw new Error('points[].evidence must be a non-empty string');
    if (point.power !== 'revise' && point.power !== 'delay' && point.power !== 'veto') {
      throw new Error('points[].power must be "revise", "delay" or "veto"');
    }
  }
}

// ---------- the government reply (section 7 stage 4) ----------
// "Agents must answer objections rather than repeat conclusions… factual claims must be linked to
// code, tests, logs or sources." The prompt makes conceding a first-class answer, because a debate
// where the government can only ever defend is not scrutiny either — and under collective
// responsibility a concession has a real cost, which is what stops it being cheap.

export function governmentReplySystemPrompt(portfolioTag: string): string {
  return (
    `You are the Minister for ${portfolioTag} in a Westminster-style software governance swarm, ` +
    'answering the Opposition on a change your side has proposed. Answer the objection — do not ' +
    'restate that the change is good. For each point the Opposition raised, either rebut it by ' +
    'pointing at something concrete in the diff, the test output or a named file, or CONCEDE it. ' +
    'Conceding is a legitimate and sometimes correct answer, and an honest concession is worth more ' +
    'than a confident evasion. Be aware that it carries a real cost: under collective ' +
    'responsibility, a minister who concedes an objection on a change the House then carries must ' +
    'record a formal dissent and give up the portfolio. Do not concede to be agreeable, and do not ' +
    'refuse to concede to keep your job. ' +
    'A rebuttal with no citation counts for nothing, so cite what you rely on. ' +
    'Output strict JSON only: double-quoted keys, no trailing commas, no comments, no markdown ' +
    'fences, and any literal newline inside a string escaped as \\n.'
  );
}

export function governmentReplyUserPrompt(
  motionTitle: string,
  implementerRationale: string,
  oppositionVerdict: string,
  oppositionRationale: string,
  test: TestResult,
  changedPaths: string[],
): string {
  return (
    `Motion: ${motionTitle}\n\n` +
    `Your side's rationale for the change: ${implementerRationale}\n\n` +
    `The Opposition's verdict: ${oppositionVerdict}\n` +
    `The Opposition's objection: ${oppositionRationale}\n\n` +
    `Files the change touches: ${changedPaths.join(', ') || '(none recorded)'}\n` +
    `Check result available to you: ran=${test.ran} passed=${test.passed}` +
    `${test.output ? ` output=${clipCheckOutput(test.output, 1000)}` : ''}\n\n` +
    'Answer the Opposition.'
  );
}

export const governmentReplySchemaDescription =
  '{ "conceded": boolean (true if you accept the objection rather than answering it), ' +
  '"objectionsAnswered": string[] (one short plain sentence per point you answered; [] if you ' +
  'conceded), "citations": string[] (the exact file paths or commands you relied on; [] if you ' +
  'conceded), "rationale": string (1-3 plain sentences, no quotation marks, newlines or code ' +
  'fences inside it) }';

export function validateGovernmentReply(
  value: unknown,
): asserts value is { conceded: boolean; objectionsAnswered: string[]; citations: string[]; rationale: string } {
  if (typeof value !== 'object' || value === null) throw new Error('Expected an object');
  const v = value as { conceded?: unknown; objectionsAnswered?: unknown; citations?: unknown; rationale?: unknown };
  if (typeof v.conceded !== 'boolean') throw new Error('conceded must be a boolean');
  if (!Array.isArray(v.objectionsAnswered)) throw new Error('objectionsAnswered must be an array');
  if (!Array.isArray(v.citations)) throw new Error('citations must be an array');
  if (!isNonEmptyString(v.rationale)) throw new Error('rationale must be a non-empty string');
}

// ---------- the Speaker (first reading) ----------
// Section 6: "It does not decide substantive technical questions." The prompt therefore asks only
// the section 7 stage 2 questions, and says outright that liking or disliking the idea is not the
// Speaker's business — a neutral chair that started refusing motions it thought unwise would be
// exercising the executive's judgment without the executive's accountability.

export function speakerSystemPrompt(): string {
  return (
    'You are the Speaker of a Westminster-style software governance swarm — a NEUTRAL procedural ' +
    'officer, not a technical reviewer. You are ruling at first reading on whether a motion may ' +
    'proceed to committee. You must NOT decide whether the proposed change is a good idea, well ' +
    'designed, or likely to work: a committee, an Opposition and a division exist to settle that, ' +
    'and it is not your office. Rule only on: (1) is it within the scope of the stated goal; ' +
    '(2) is it defined well enough that a committee could scrutinise it and an implementer could ' +
    'act on it; (3) is it permissible in principle, or does it on its face require deleting or ' +
    'weakening tests, bypassing a security control, or removing a human approval; and (4) what ' +
    'treatment it warrants — "routine" for a small contained change, "committee" for one crossing ' +
    'modules or interfaces, "emergency" for one touching a security or safety boundary. ' +
    'Rule a motion inadmissible only on those grounds. When in doubt, admit it: the House can ' +
    'defeat a bad motion, but it cannot debate one you refused to put. ' +
    'Output strict JSON only: double-quoted keys, no trailing commas, no comments, no markdown ' +
    'fences, and any literal newline inside a string escaped as \\n.'
  );
}

export function speakerUserPrompt(goal: string, motion: Motion): string {
  return (
    `The goal before the House: ${goal}\n\n` +
    `Motion "${motion.id}": ${motion.title}\n\n` +
    `Description: ${motion.description}\n\n` +
    `Acceptance criteria:\n${motion.acceptanceCriteria.map((c) => `- ${c}`).join('\n') || '(none stated)'}\n\n` +
    `Files it expects to touch: ${motion.targetGlobs.join(', ') || '(none listed)'}\n\n` +
    `Portfolio it would be referred to: ${motion.portfolioTag}\n\n` +
    'Give your ruling at first reading.'
  );
}

export const speakerSchemaDescription =
  '{ "admissible": boolean, "treatment": "routine" | "committee" | "emergency", "rationale": string ' +
  '(1-2 plain sentences on PROCEDURE only, with no quotation marks, newlines or code fences inside it) }';

export function validateSpeakerRuling(
  value: unknown,
): asserts value is { admissible: boolean; treatment: MotionClass; rationale: string } {
  if (typeof value !== 'object' || value === null) throw new Error('Expected an object');
  const v = value as { admissible?: unknown; treatment?: unknown; rationale?: unknown };
  if (typeof v.admissible !== 'boolean') throw new Error('admissible must be a boolean');
  if (v.treatment !== 'routine' && v.treatment !== 'committee' && v.treatment !== 'emergency') {
    throw new Error('treatment must be "routine", "committee" or "emergency"');
  }
  if (!isNonEmptyString(v.rationale)) throw new Error('rationale must be a non-empty string');
}

// ---------- acceptance barriers ----------
// Section 10 of docs/philosophy/democratic_coder_westminster_ai_code_swarm.md: an Integration
// Committee reviews the combined tree, the Commons appoints a verifier who did not author the
// change, and every finding leaves the record with one disposition and any minority report intact.

export function integrationCommitteeSystemPrompt(): string {
  return (
    'You are the Integration Committee of a Westminster-style software governance swarm. Every motion ' +
    'in this run has already passed its own committee, opposition scrutiny and vote INDIVIDUALLY. Your ' +
    'remit is different and narrower: the COMBINED tree. Passing isolated work streams is insufficient. ' +
    'Inspect the aggregate diff for conflicting assumptions between motions, broken shared interfaces, ' +
    'call paths one motion changed and another relied on, configuration or documentation left ' +
    'inconsistent, and duplicated work that nobody authorised. Report what the combined change does, ' +
    'not what each motion promised. Report only defects you can point at in the diff — do not invent ' +
    'concerns to appear diligent, and do not restate individual motion reviews.'
  );
}

export function integrationCommitteeUserPrompt(
  goal: string,
  acceptanceCriteria: string[],
  approvedTaskTitles: string[],
  diffText: string,
): string {
  return (
    `Authorised programme: ${goal}\n\n` +
    `Acceptance criteria:\n${acceptanceCriteria.map((c) => `- ${c}`).join('\n') || '(none given)'}\n\n` +
    `Motions integrated into this tree:\n${approvedTaskTitles.map((t) => `- ${t}`).join('\n') || '(none)'}\n\n` +
    `Complete diff of the combined tree:\n${diffText || '(empty diff)'}\n\n` +
    'Report on the integrated result.'
  );
}

export function commonsVerifierSystemPrompt(): string {
  return (
    'You are a verifier appointed by the Code Commons, and you did not author any part of this change. ' +
    'Your duty is independent verification, not endorsement of the executive\'s account: trace each user ' +
    'acceptance criterion to the code that implements it AND to the evidence that demonstrates it. ' +
    'List in criteriaTraced only criteria where you found BOTH — a criterion with plausible-looking code ' +
    'but no evidence is not traced. A green check with no relevant assertion is not proof of correctness. ' +
    'Set verified to false if any acceptance criterion cannot be traced, a REQUIRED check is failing on ' +
    'this change, or a constitutional constraint (security, safety, privacy, licensing, required tests) ' +
    'is breached. A check the repository does not provide, or one already failing before this run, is a ' +
    'disclosed limitation rather than a breach — record it as a finding if it matters, but do not refuse ' +
    'verification for it.'
  );
}

export function commonsVerifierUserPrompt(
  goal: string,
  acceptanceCriteria: string[],
  requirementMatrix: Array<{ criterion: string; command: string; expectedResult: string; status: string; note?: string }>,
  checkSummary: string,
  diffText: string,
): string {
  return (
    `Authorised programme: ${goal}\n\n` +
    `User acceptance criteria (verify each one):\n${acceptanceCriteria.map((c) => `- ${c}`).join('\n') || '(none given)'}\n\n` +
    `Requirement-to-test matrix the swarm recorded:\n` +
    `${requirementMatrix.map((m) => `- "${m.criterion}" -> ${m.command} (expected: ${m.expectedResult}) [${m.status}]${m.note ? ` note: ${m.note}` : ''}`).join('\n') || '(empty)'}\n\n` +
    `Checks on the integrated tree:\n${checkSummary}\n\n` +
    `Complete diff:\n${diffText || '(empty diff)'}\n\n` +
    'Give your independent verification decision.'
  );
}

export function dispositionSystemPrompt(): string {
  return (
    'You are the select committee settling the review record before assent. Every open finding must ' +
    'leave this sitting with exactly one disposition and no finding may be dropped: "accepted" means it ' +
    'has been remedied and re-checked in the diff; "rejected" means you have contrary evidence and must ' +
    'say what it is; "deferred" means it is real but out of this mandate, and REQUIRES both an owner and ' +
    'a return condition; "unresolved" means it stands and its impact is disclosed. Do not use "accepted" ' +
    'for a finding that has merely been discussed. Set minority to true where you are recording dissent ' +
    'that the majority did not adopt — minority reports are preserved with the final decision.'
  );
}

export function dispositionUserPrompt(
  findings: Array<{ id: string; source: string; summary: string; evidenceRefs: string[] }>,
  diffText: string,
): string {
  return (
    `Parliamentary register of open findings (cite by id; do not embed prior packets):\n${findings.map(compactFindingLine).join('\n')}\n\n` +
    `Complete diff for reference:\n${diffText || '(empty diff)'}\n\n` +
    'Return exactly one disposition for every finding id listed above.'
  );
}

// ---------- test mandate (Testing and Evidence Committee) ----------

export function testMandateSystemPrompt(): string {
  return (
    'You are the Testing and Evidence Committee. Before the House authorises implementation you must ' +
    'translate every acceptance criterion into an executable check and an expected result, and publish ' +
    'the traceability matrix that links them. You do not decide whether the criterion is met — that is ' +
    'settled later by the check actually running. Your task is only to say which check would settle it ' +
    'and what that check must show. Constitutional requirements cannot be waived by an ordinary vote, ' +
    'so do not mark a criterion as needing no check.'
  );
}

// ---------- Prime Coordinator ballot ----------

/** One constituency's Prime Coordinator ballot. Shared with the model bench, which replays it per
 * constituency to measure how often a model abstains on a vote it should simply cast. */
export function coordinatorBallotSystemPrompt(constituency: string): string {
  return `You represent the ${constituency} constituency. Cast one independent ballot for Prime Coordinator. ` +
    'Choose a listed candidate; abstain only if you hold a specific objection to every one of them. ' +
    'Use the published record as evidence, not as a binding ranking. A score of 0.5 means no record yet, ' +
    'and candidates with equal scores are interchangeable: that is a reason to pick one, not to abstain, ' +
    'because an election in which every constituency abstains leaves the government without a Prime Coordinator.';
}

export function coordinatorBallotUserPrompt(candidates: ReadonlyArray<{ candidate: string; score: number }>): string {
  return `Candidates and prior carried-motion scores: ${JSON.stringify(candidates)}. Return {"candidate":"name"} or {"candidate":null}.`;
}

export const coordinatorBallotSchemaDescription = '{"candidate": string | null}; string must be a listed candidate';

// ---------- Speaker ruling as a decision ----------

/** The Speaker's two rulings at first reading, posed to a decision model. Same offices and limits
 * as speakerSystemPrompt, without the JSON formatting a decision model does not need. */
export const speakerDecisionQuestions = {
  admissible: {
    type: 'noul' as const,
    instructions:
      'You are the neutral Speaker ruling at first reading, not a technical reviewer. Is this motion in order? ' +
      'Rule only on whether it is within the goal\'s scope, defined well enough to scrutinise and implement, and ' +
      'permissible in principle (it does not on its face require deleting or weakening tests, bypassing a ' +
      'security control, or removing a human approval). When in doubt, admit it.',
    criteria: {
      true: 'In scope, scrutinisable, and permissible in principle.',
      false: 'Out of scope, too vague to scrutinise, or on its face requires weakening tests, bypassing security, or removing human approval.',
    },
  },
  treatment: {
    type: 'choice' as const,
    instructions: 'What treatment does this motion warrant?',
    criteria: {
      routine: 'A small, contained change.',
      committee: 'A change crossing modules or interfaces.',
      emergency: 'A change touching a security or safety boundary.',
    },
  },
};

export function speakerDecisionState(goal: string, motion: Motion): Record<string, unknown> {
  return {
    goal,
    motion: {
      id: motion.id,
      title: motion.title,
      description: motion.description,
      acceptanceCriteria: motion.acceptanceCriteria,
      files: motion.targetGlobs,
      portfolio: motion.portfolioTag,
    },
  };
}
