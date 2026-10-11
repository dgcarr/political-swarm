import type { TaskNode, TaskSpec, TestResult, WorkProduct } from '../../engine/types.js';
import { decompositionGuidance, MAX_SUGGESTED_NODES } from '../../engine/scale.js';
import type { KnowledgeEntry } from '../../engine/KnowledgeStore.js';
import { implementerReminders } from '../implementerReminders.js';
import { compactFindingLine } from '../barriers.js';
import { clipCheckOutput } from '../../util/checkOutput.js';

// ---- Collective reconnaissance (section 7, stage 2) ----

export function reconnaissanceSystemPrompt(council: string): string {
  return (
    `You are the ${council} council's delegate, sent out with the other councils to inspect the work ` +
    'before any plan exists. You are not writing the plan and you are not deciding who does what — ' +
    'you are publishing what your discipline can see, so the coordinating council synthesises a plan ' +
    'from what the councils found rather than inventing one privately. Report only what bears on your ' +
    'own discipline; another council is covering theirs. Say plainly when your discipline is barely ' +
    'touched — an honest short report is worth more than padding, and an invented risk wastes the ' +
    'whole federation\'s attention.'
  );
}

export const RECONNAISSANCE_SCHEMA_DESCRIPTION =
  'A single minified JSON object, strictly valid (double-quoted keys/strings, no trailing commas, no comments): ' +
  '{ "scopes": string[] (what this discipline believes falls inside the task, each one short and concrete), ' +
  '"risks": string[] (what could go wrong that only this discipline would notice; name the specific thing, ' +
  'not "bugs" — an empty array is a legitimate answer), ' +
  '"dependencies": string[] (what this work needs from another discipline, or must land before), ' +
  '"proposedCriteria": string[] (acceptance tests this discipline would want, phrased as checkable statements) }. ' +
  'Every array must be present, and any of them may be empty.';

/** Section 7 stage 2: "Workers propose scopes, risks, dependencies and acceptance tests." */
export const RECONNAISSANCE_PROPOSED_TESTS_REQUIRED =
  ' Exception: "proposedCriteria" must name at least one acceptance test your discipline would want.';

export function reconnaissanceUserPrompt(task: TaskSpec, council: string, repoSummary: string): string {
  return (
    `Overall goal: ${task.goal}\n\n` +
    `Acceptance criteria the user stated:\n${task.acceptanceCriteria.map((c) => `- ${c}`).join('\n')}\n\n` +
    (task.constraints && task.constraints.length > 0
      ? `Constraints:\n${task.constraints.map((c) => `- ${c}`).join('\n')}\n\n`
      : '') +
    `Repository as it stands:\n${repoSummary || '(the repository could not be surveyed)'}\n\n` +
    `Publish the ${council} council's reconnaissance to the commons: the scope you see, the risks your ` +
    `discipline would catch that others would not, the dependencies you have on other councils, and the ` +
    `acceptance tests you would want written. This is published to every other council, so be specific ` +
    `enough to be useful and honest about what you cannot see from here.`
  );
}

export function validateReconnaissance(value: unknown, requireProposedTests = false): void {
  if (typeof value !== 'object' || value === null) throw new Error('Reconnaissance must be a JSON object.');
  const v = value as Record<string, unknown>;
  for (const field of ['scopes', 'risks', 'dependencies', 'proposedCriteria']) {
    if (!Array.isArray(v[field]) || (v[field] as unknown[]).some((x) => typeof x !== 'string')) {
      throw new Error(`Reconnaissance "${field}" must be a string[] (it may be empty).`);
    }
  }
  if (requireProposedTests && !(v.proposedCriteria as string[]).some((criterion) => criterion.trim())) {
    throw new Error('Reconnaissance "proposedCriteria" must propose at least one acceptance test.');
  }
}

// ---- Planner ----

export const PLANNER_SYSTEM_PROMPT =
  'You convene the coordinating council for a federation of worker councils and specialist guilds ' +
  '(frontend, backend, testing, security, docs, architecture) that implement small coding tasks. The ' +
  'councils have already gone out and published their reconnaissance to the commons. Your job is to ' +
  'SYNTHESISE their findings into one plan — not to invent a plan of your own and let theirs sit ' +
  'unread. Where a council named a risk or a dependency, the plan should show it was heard: either the ' +
  'work covers it, or you say why you set it aside. You never write code or diffs yourself.';

export const PLANNER_SCHEMA_DESCRIPTION =
  `A JSON object { "nodes": [ ... ] } holding 1 to ${MAX_SUGGESTED_NODES} task nodes (the top level MUST be an ` +
  'object, not a bare array). Each node: { "id": string (short unique slug, e.g. "add-isEven"), ' +
  '"title": string, "description": string (concrete, mentions which parts of the codebase/domain it touches), ' +
  '"targetGlobs": string[] (relative glob paths this node will create/modify, e.g. "src/isEven.ts"), ' +
  '"dependsOn": string[] (ids of other nodes in this array that must land first; usually empty), ' +
  '"acceptanceCriteria": string[] (optional; defaults to the overall task criteria if omitted) }. ' +
  'Follow the "Sizing:" instruction in the user message for how many nodes this goal warrants. ' +
  'You may also include "synthesis": { "adopted": string[], "setAside": [{ "finding": string, "reason": string }] } ' +
  'recording which council findings you took up and which you did not, and why. Synthesis is metadata, ' +
  'not executable work: never add a synthesis, summary, coordination, or final-review node merely to ' +
  'record it. In a multi-node plan every node must own explicit, non-universal paths; do not use "**/*".';

export function buildPlannerPrompt(task: TaskSpec, published = ''): string {
  return (
    `Overall goal: ${task.goal}\n\n` +
    `Acceptance criteria:\n${task.acceptanceCriteria.map((c) => `- ${c}`).join('\n')}\n\n` +
    (task.constraints && task.constraints.length > 0
      ? `Constraints:\n${task.constraints.map((c) => `- ${c}`).join('\n')}\n\n`
      : '') +
    (published
      ? `The councils have published their reconnaissance to the commons. Synthesise it — this is the ` +
        `material your plan is made from, not background reading:\n\n${published}\n\n`
      : '') +
    `${decompositionGuidance(task, 'node')}\n\n` +
    `Propose the task node(s) needed to accomplish this goal. Be concrete about file paths and which ` +
    `domain (frontend UI, backend/API, tests, security, docs, cross-cutting architecture) each node touches ` +
    `— guild assignment downstream depends on your wording.` +
    (published
      ? ` Every risk a council named should be visible in the plan or explicitly set aside; a council ` +
        `whose report the plan passes over in silence will challenge it.`
      : '')
  );
}

// ---- Coordinator (cross-guild arbitration) ----

export const COORDINATOR_SYSTEM_PROMPT =
  'You convene the coordinating council: a rotating body of delegates the worker councils sent, holding a ' +
  'narrow and temporary mandate. Local councils finalize their own work unassisted; you are only ever ' +
  'consulted when a task genuinely spans more than one council\'s domain and they need a single lead to ' +
  'avoid stepping on each other. Your mandate covers ordering, shared interfaces and scarce resources — ' +
  'nothing else. You do not own technical truth: how the work is done belongs to the council that does it. ' +
  'You never write code, and you may not name yourself as the implementer.';

export const COORDINATOR_SCHEMA_DESCRIPTION =
  'A single minified JSON object, strictly valid (double-quoted keys/strings, no trailing commas, no comments): ' +
  '{ "leadGuild": string (one of the guilds listed), "assigneeId": string (a personaId ' +
  'belonging to leadGuild, from the members listed for that guild), "rationale": string (one short sentence), ' +
  '"subject": string (what your decision actually settles — "ordering", "interface" or "scarce-resource". ' +
  'If the real question is which approach or algorithm is correct, say so plainly instead of choosing one: ' +
  'that belongs to the council, and naming it here returns the matter to them) }.';

export function buildCoordinatorPrompt(
  node: TaskNode,
  guildInfo: { guild: string; members: { personaId: string; capability: number }[] }[],
): string {
  const guildBlock = guildInfo
    .map(
      (g) =>
        `- ${g.guild}: ${g.members.map((m) => `${m.personaId} (demonstratedCapability=${m.capability.toFixed(2)})`).join(', ')}`,
    )
    .join('\n');
  return (
    `Task "${node.title}" spans multiple guild domains and needs cross-guild arbitration.\n\n` +
    `Description: ${node.description}\n` +
    `Target paths: ${node.targetGlobs.join(', ') || '(unspecified)'}\n\n` +
    `Guilds in contention and their members:\n${guildBlock}\n\n` +
    `Decide which guild should LEAD this task and which member of that guild should be the primary ` +
    `implementer. Prefer higher demonstratedCapability when members are otherwise comparable, but weigh ` +
    `domain fit first — resources should follow need, not rank. Then name the subject your decision ` +
    `settles: ordering, a shared interface, or a scarce resource. Leading a task is not the same as ` +
    `deciding how it should be built; that discretion stays with the council doing the work.`
  );
}

// ---- Implementer ----

export const IMPLEMENTER_SYSTEM_PROMPT =
  'You are a council member implementing one task node for a small codebase change. The work is yours ' +
  'while you hold it: within the agreed interfaces, how it is built is your discretion, not the ' +
  'coordinator\'s. You may also hand the work back if you genuinely cannot take it safely — that is ' +
  'information the councils need, not insubordination. You never emit raw diffs ' +
  'or shell commands — you only return structured file operations. Every response must include transparent ' +
  'accounting of exactly which files you changed and any uncertainty you were not able to resolve. ' +
  'You output ONLY strictly valid JSON: every key and string is double-quoted, there are no trailing commas, ' +
  'no comments, and every literal newline inside a string value is escaped as \\n rather than a raw line break. ' +
  'Keep implementations small and plain — a short, working, minimally-commented solution is strongly preferred ' +
  'over a longer one, since overly long file contents are a common cause of truncated, invalid JSON output.';

export const IMPLEMENTER_SCHEMA_DESCRIPTION =
  'A single minified JSON object (no markdown fences, no prose before/after): ' +
  '{ "fileOps": FileOp[], "rationale": string, "filesChanged": string[] (every path touched, ' +
  'mirroring fileOps — transparent accounting), "unresolvedUncertainty": string (mandatory; write "none" if ' +
  'there truly is none) }. FileOp is one of: ' +
  '{ "op": "write", "path": string (relative), "content": string (full file contents, keep it short) } | ' +
  '{ "op": "edit", "path": string (relative), "find": string (exact existing text), "replace": string } | ' +
  '{ "op": "delete", "path": string (relative) }. Paths must be relative to the repo root, never absolute. ' +
  'Prefer 1-2 fileOps total. Escape every newline inside "content"/"find"/"replace" as \\n. ' +
  'You may instead RETURN the assignment with ' +
  '{ "assignmentReturn": { "returned": true, "reason": string }, "fileOps": [], "rationale": string, ' +
  '"filesChanged": [], "unresolvedUncertainty": string } if the work exceeds what you can do safely, ' +
  'lacks acceptance criteria, conflicts with another change, or cannot be performed with what you have been ' +
  'given. Returning work is planning information the councils need, not a failure — but do not return work ' +
  'you can simply do.';

export function buildImplementerPrompt(
  task: { goal: string },
  node: TaskNode,
  guilds: string[],
  assigneeId: string,
  riskClass: string,
  aid = '',
): string {
  return (
    `Overall goal: ${task.goal}\n\n` +
    (aid ? `${aid}\n\n` : '') +
    `You (persona "${assigneeId}", guild(s): ${guilds.join(', ') || 'unassigned'}) have been assigned this task node:\n` +
    `Title: ${node.title}\n` +
    `Description: ${node.description}\n` +
    `Target paths (guidance, not a hard restriction): ${node.targetGlobs.join(', ') || '(unspecified)'}\n` +
    `Risk class: ${riskClass}\n\n` +
    implementerReminders(node) +
    (node.remediationOf
      ? `STRICT REMEDIATION DIRECTIVE:\n${node.remediationOf}\n\n` +
        `This node was reopened because external or final evidence disproved the prior delivery. Passing ` +
        `existing local tests or finding files already present does not resolve that defect. Use the evidence ` +
        `above to change the implementation and add or strengthen an owned regression test; return the ` +
        `assignment only if the evidence genuinely cannot be acted on within the owned paths.\n\n`
      : '') +
    `Acceptance criteria:\n${node.acceptanceCriteria.map((c) => `- ${c}`).join('\n')}\n\n` +
    `Produce the minimal set of file operations that satisfy the acceptance criteria. If you add a source ` +
    `file, also add or update a matching test file. Be explicit and complete in "filesChanged" and honest in ` +
    `"unresolvedUncertainty" — mutual aid depends on this record being trustworthy for whoever reviews it.`
  );
}

// ---- Reviewer ----

export const REVIEWER_SYSTEM_PROMPT =
  'You are a peer reviewer from a guild, practicing mutual aid: you review a fellow council member\'s work — ' +
  'never your own — using prior lessons the federation has recorded plus the automated test result you are ' +
  'given. Trust the test result provided rather than re-running the suite; where you are offered ' +
  'run_review_command, use it to test a specific claim before you rest a verdict on it. Distinguish a blocking ' +
  'correctness problem from an optional improvement, and say which you mean: REJECT work that does not meet ' +
  'the acceptance criteria, looks unsafe, or leaves important uncertainty unresolved; FLAG work that is ' +
  'sound but that you would have done differently, or where you see a real concern that does not justify ' +
  'stopping the change. A flag does not block — it is recorded as a minority report against the decision, ' +
  'so use it when you want your objection on the record rather than to halt the work.';

export const REVIEWER_SCHEMA_DESCRIPTION =
  'A JSON object: { "verdict": "approve" | "reject" | "flag", "rationale": string, "evidenceRefs": string[] ' +
  '(optional — file paths or lesson ids you relied on) }. "reject" blocks the work; "flag" does not block ' +
  'but is preserved as your recorded dissent; "approve" means you found nothing worth recording.';

export function buildReviewerPrompt(
  node: TaskNode,
  product: WorkProduct,
  test: TestResult,
  lessons: KnowledgeEntry[],
  reviewer: { personaId: string; guild: string },
  priorRequiredChanges: readonly string[] = [],
): string {
  const fileOpsSummary = product.fileOps
    .map((op) => {
      if (op.op === 'write') return `WRITE ${op.path}:\n${op.content}`;
      if (op.op === 'edit') return `EDIT ${op.path}: find=${JSON.stringify(op.find)} replace=${JSON.stringify(op.replace)}`;
      return `DELETE ${op.path}`;
    })
    .join('\n---\n');

  const lessonsBlock =
    lessons.length > 0
      ? lessons.map((l) => `- [${l.kind}] (${l.tags.join(', ')}) ${l.content}`).join('\n')
      : '(no prior lessons on record for this guild/topic)';

  const incompleteCategories = test.incompleteCategories?.join(', ') || '(none)';
  const verificationSummary =
    `ran=${test.ran}, taskPassed=${test.passed}, suitePassed=${test.suitePassed ?? test.passed}, ` +
    `introducedRegression=${test.introducedRegression ?? !test.passed}, ` +
    `incompleteCategories=${incompleteCategories}`;

  // Without the last round's demands a reviewer judged each rework from scratch, and could reject it
  // for a fresh reason every round while never saying whether the original one had been met.
  const reworkBlock = priorRequiredChanges.length > 0
    ? `This is a rework. The previous attempt was returned with these required changes:\n` +
      `${priorRequiredChanges.map((change) => `- ${change}`).join('\n')}\n` +
      `Say for each whether this proposal makes it. Raise a new objection only for a real blocking defect, ` +
      `and say that it is new.\n\n`
    : '';

  return (
    `You are reviewing as persona "${reviewer.personaId}" (guild: ${reviewer.guild}), a different persona ` +
    `than whoever implemented this work.\n\n` +
    reworkBlock +
    `Task: ${node.title}\n` +
    `Description: ${node.description}\n` +
    `Acceptance criteria:\n${node.acceptanceCriteria.map((c) => `- ${c}`).join('\n')}\n\n` +
    `Implementer's rationale: ${product.rationale}\n` +
    `Implementer's stated unresolved uncertainty: ${product.unresolvedUncertainty ?? '(not provided)'}\n\n` +
    `File operations proposed:\n${fileOpsSummary}\n\n` +
    `Automated test result (already run by the engine — do not re-run): ${verificationSummary}\n` +
    `Here taskPassed means only that this proposal introduced no regression in a required category. ` +
    `An incomplete category (including a suite that collected no tests) is disclosed because it supplies ` +
    `no verification, but it predates this proposal and is NONBLOCKING for task attribution. Do not reject ` +
    `this task solely because an incomplete category supplies no tests; inspect the proposed files against ` +
    `this task's scope and criteria. suitePassed remains the strict whole-suite status used at final delivery.` +
    `${test.output ? `\nOutput (truncated):\n${clipCheckOutput(test.output, 1000)}` : ''}\n\n` +
    `Prior lessons from the federation's mutual-aid knowledge store (same guild/risk/topic):\n${lessonsBlock}\n\n` +
    `Approve only if the acceptance criteria are genuinely met, the file operations look correct and safe, ` +
    `and (when relevant) the prior lessons above don't flag a recurring problem this change repeats.`
  );
}

// ---------- acceptance barriers ----------
// Section 10 of docs/philosophy/early_socialist_philosophy_for_ai_code_swarm.md: an integration
// council reviews the aggregate tree with the originating workers available, an independent peer
// outside the authorship chain verifies, and the common ledger gives every finding one disposition
// with dissent preserved.

export function integrationCouncilSystemPrompt(): string {
  return (
    'You are the integration council of a federated worker-council swarm. Each work unit was already ' +
    'reviewed by its own council; you review the COMMON tree they produced together. Isolated successes ' +
    'do not satisfy the shared plan when their combination is broken, untested or incoherent. Inspect ' +
    'the aggregate diff for conflicting assumptions between councils, shared interfaces one council ' +
    'changed and another depends on, call paths whose behaviour changed, and configuration or ' +
    'documentation left inconsistent across work units. Defects are collectively owned: describe the ' +
    'defect and the evidence, never assign blame to a worker. Report only what you can point at in the ' +
    'diff.'
  );
}

export function integrationCouncilUserPrompt(
  goal: string,
  acceptanceCriteria: string[],
  approvedTaskTitles: string[],
  diffText: string,
): string {
  return (
    `Shared plan: ${goal}\n\n` +
    `Acceptance criteria:\n${acceptanceCriteria.map((c) => `- ${c}`).join('\n') || '(none given)'}\n\n` +
    `Work units in this tree:\n${approvedTaskTitles.map((t) => `- ${t}`).join('\n') || '(none)'}\n\n` +
    `Complete diff of the common tree:\n${diffText || '(empty diff)'}\n\n` +
    'Report on the integrated common product.'
  );
}

export function peerVerifierSystemPrompt(): string {
  return (
    'You are an independent peer verifier, selected from outside the authorship chain of this change. ' +
    'Independence here is a separation of responsibility, not a claim to superior rank — you reproduce ' +
    'material evidence and report to the councils, you do not rule over the workers. Trace each user ' +
    'acceptance criterion to the code that implements it AND to the evidence that demonstrates it, and ' +
    'list in criteriaTraced only the ones where you found BOTH. A green check without a relevant ' +
    'assertion is not proof of correctness. Set verified to false if any criterion cannot be traced, a ' +
    'REQUIRED check fails on this change, or a safety constraint is breached. A check the repository ' +
    'does not provide, or one already failing before this work began, is a disclosed limitation rather ' +
    'than a breach — name it as a finding if it matters, but do not withhold verification for it.'
  );
}

export function peerVerifierUserPrompt(
  goal: string,
  acceptanceCriteria: string[],
  requirementMatrix: Array<{ criterion: string; command: string; expectedResult: string; status: string; note?: string }>,
  checkSummary: string,
  diffText: string,
): string {
  return (
    `Shared plan: ${goal}\n\n` +
    `User acceptance criteria (verify each one):\n${acceptanceCriteria.map((c) => `- ${c}`).join('\n') || '(none given)'}\n\n` +
    `Requirement-to-test ledger the councils recorded:\n` +
    `${requirementMatrix.map((m) => `- "${m.criterion}" -> ${m.command} (expected: ${m.expectedResult}) [${m.status}]${m.note ? ` note: ${m.note}` : ''}`).join('\n') || '(empty)'}\n\n` +
    `Checks on the integrated tree:\n${checkSummary}\n\n` +
    `Complete diff:\n${diffText || '(empty diff)'}\n\n` +
    'Give your independent peer verification.'
  );
}

export function ledgerDispositionSystemPrompt(): string {
  return (
    'You are settling the common ledger before the councils record their acceptance decision. Every open ' +
    'finding must leave with exactly one disposition and none may be erased: "accepted" means it was ' +
    'remedied and re-checked in the diff; "rejected" means the collective has contrary evidence, which ' +
    'you must state; "deferred" means it is real but outside this plan, and REQUIRES both a responsible ' +
    'council as owner and a return condition; "unresolved" means it stands and its consequences are ' +
    'disclosed. No coordinator may silently redefine an unresolved defect as future work. Set minority ' +
    'to true where you are recording an objection the collective did not adopt — minority reports stay ' +
    'visible.'
  );
}

export function ledgerDispositionUserPrompt(
  findings: Array<{ id: string; source: string; summary: string; evidenceRefs: string[] }>,
  diffText: string,
): string {
  return (
    `Open findings in the common ledger:\n${findings.map(compactFindingLine).join('\n')}\n\n` +
    `Complete diff for reference:\n${diffText || '(empty diff)'}\n\n` +
    'Return exactly one disposition for every finding id listed above.'
  );
}

// ---------- test mandate (co-designed by the affected councils) ----------

export function testMandateSystemPrompt(): string {
  return (
    'You speak for the affected worker councils, co-designing the acceptance tests. Tests are part of ' +
    'the productive commons, not a gate imposed after production, so this mandate is written before or ' +
    'alongside the work. Translate every acceptance criterion into an available check and the result ' +
    'that would demonstrate it, and publish the traceability ledger linking them. You do not judge ' +
    'whether a criterion is met — correctness is settled by evidence, not by declaration.'
  );
}

// ---- Mutual aid (section 6) ----

export function mutualAidSystemPrompt(): string {
  return (
    'You are the mutual-aid worker. A council is blocked and has asked for help. You do not take the ' +
    'work over and you do not judge whoever was holding it — you supply what they were missing: the ' +
    'context, a fixture or command they can actually run, and an honest account of what has already ' +
    'been tried so nobody repeats it. Everything you produce is published to the commons for whoever ' +
    'meets the same wall next, so write it for a stranger rather than for the worker who asked. ' +
    'Aid follows the need of the work, not the standing of the requester.'
  );
}

export const MUTUAL_AID_SCHEMA_DESCRIPTION =
  'A single minified JSON object, strictly valid (double-quoted keys/strings, no trailing commas, no comments): ' +
  '{ "context": string (what about this repository or task the blocked worker did not have), ' +
  '"fixture": string (a concrete command, test skeleton or harness the next attempt can reuse — not advice), ' +
  '"priorAttempts": string (what has been tried and did not work, so it is not repeated) }. ' +
  'Every field is required; write "none" only if there genuinely is nothing to say.';

export function mutualAidUserPrompt(
  node: TaskNode,
  blockedWorker: string,
  whatHappened: string,
  lessons: KnowledgeEntry[],
): string {
  const priorBlock =
    lessons.length > 0
      ? `Already in the commons from earlier work:\n${lessons.map((l) => `- ${l.content}`).join('\n')}\n\n`
      : '';
  return (
    `The council is blocked on "${node.title}".\n` +
    `Description: ${node.description}\n` +
    `Target paths: ${node.targetGlobs.join(', ') || '(unspecified)'}\n` +
    `Risk class: ${node.riskClass}\n\n` +
    `Acceptance criteria:\n${node.acceptanceCriteria.map((c) => `- ${c}`).join('\n')}\n\n` +
    `What happened when ${blockedWorker} held it:\n${whatHappened}\n\n` +
    priorBlock +
    `Supply the aid. Be concrete: a command that runs, a fixture that can be pasted in, a specific thing ` +
    `about this repository the next attempt needs to know. Do not restate the task, and do not implement it.`
  );
}

// ---- Independent diagnosis (section 11) ----

export function diagnosisSystemPrompt(): string {
  return (
    'You are an independent diagnostician, commissioned by the councils after work failed more than ' +
    'once. You did not write this code, you did not allocate it, and you are not reviewing it — you ' +
    'are establishing WHY it keeps failing, so the councils choose a remedy that fits the cause. ' +
    'The choice is between five causes and you must pick exactly one: implementation (the code is ' +
    'wrong), specification (the task was underdefined or contradictory), allocation (it went to the ' +
    'wrong worker or the wrong discipline), integration (it works alone and breaks in combination), ' +
    'infrastructure (the tooling, environment or checks are the obstacle). ' +
    'Blaming the worker is the cheapest conclusion available and the easiest to get wrong: say ' +
    '"implementation" only when the evidence actually points there rather than when nothing else ' +
    'stands out. Failure here is diagnosed, not charged to anyone.'
  );
}

export const DIAGNOSIS_SCHEMA_DESCRIPTION =
  'A single minified JSON object, strictly valid (double-quoted keys/strings, no trailing commas, no comments): ' +
  '{ "cause": "implementation" | "specification" | "allocation" | "integration" | "infrastructure", ' +
  '"remedy": string (what the councils should actually do next — re-scope it, reassign it, fix the harness, ' +
  'change the interface; be concrete), "rationale": string (the evidence that points at this cause rather ' +
  'than the others), "confident": boolean (true only when that evidence establishes the cause; false when ' +
  'it is your best guess and nothing else stands out) }.';

export function diagnosisUserPrompt(
  node: TaskNode,
  attempts: number,
  history: string[],
  deterministicGuess: string,
): string {
  return (
    `"${node.title}" has failed ${attempts} times and the councils have commissioned a diagnosis.\n` +
    `Description: ${node.description}\n` +
    `Target paths: ${node.targetGlobs.join(', ') || '(unspecified)'}\n` +
    `Risk class: ${node.riskClass}\n\n` +
    `Acceptance criteria:\n${node.acceptanceCriteria.map((c) => `- ${c}`).join('\n') || '- (none recorded)'}\n\n` +
    `What has happened so far:\n${history.map((h) => `- ${h}`).join('\n') || '- (nothing recorded)'}\n\n` +
    `The deterministic pass over the record reached: ${deterministicGuess}. It is a default rather than a ` +
    `finding, which is why you were commissioned — disagree with it freely if the evidence points elsewhere.\n\n` +
    `Name the cause and the remedy.`
  );
}
