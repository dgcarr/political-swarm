// System/user prompt builders for the capitalist strategy's four dispatcher roles: planner,
// bidder, implementer, reviewer. Kept out of CapitalistStrategy.ts purely for readability.
import type { TaskNode, TaskSpec, WorkProduct, TestResult } from '../../engine/types.js';
import { decompositionGuidance } from '../../engine/scale.js';
import type { Bid } from './types.js';
import { implementerReminders } from '../implementerReminders.js';
import { compactFindingLine } from '../barriers.js';
import { clipCheckOutput } from '../../util/checkOutput.js';

export const PLANNER_SYSTEM_PROMPT = `You are the listing originator for a capitalist code-swarm task exchange.
Given a coding goal, decompose it into the smallest set of independent, biddable task listings
that fully cover the goal. Each listing must be small enough for a single implementer to complete
in one pass — follow the explicit "Sizing:" instruction in the user message, which states how many
listings this particular goal warrants. Never bundle more than one pass of work into a single
listing, and never split one coherent change per-file.
Output "targetGlobs" as generous glob patterns (e.g. "**/*.js") covering every file the
listing might plausibly touch — a downstream regulator treats any file change outside these globs
as bid misrepresentation, so prefer broader patterns over ones that are too narrow.`;

export function buildPlannerUserPrompt(task: TaskSpec): string {
  const constraints = task.constraints && task.constraints.length > 0 ? task.constraints.join('; ') : 'none';
  return [
    `Goal: ${task.goal}`,
    `Acceptance criteria: ${task.acceptanceCriteria.join('; ') || 'none given'}`,
    `Constraints: ${constraints}`,
    `Base branch: ${task.baseBranch}`,
    '',
    decompositionGuidance(task, 'listing'),
  ].join('\n');
}

export const PLANNER_SCHEMA_DESCRIPTION =
  'A JSON object: { "tasks": [ { "id": string (short unique slug), "title": string, ' +
  '"description": string, "acceptanceCriteria": string[], "targetGlobs": string[] ' +
  '(glob patterns), "dependsOn": string[] (ids of other tasks in this same array; [] if none) } ] }. ' +
  'Follow the "Sizing:" instruction in the user message for how many tasks this goal warrants.';

export const BIDDER_SYSTEM_PROMPT = `You are an independent contractor bidding on a listing in a
capitalist code-swarm task exchange. You compete against other bidders on price, confidence,
warranties and fit; the exchange does not simply pick the lowest price, and it does not simply pick
the strongest bidder either — it weighs whether this listing is the best use of you. Bid honestly:
- "priceTokens" is the total contract price you are asking for in this economy's abstract token
  unit. The listing states an available budget; a bid above it is refused outright, not scored down.
- "estTime" is your estimated minutes to deliver. The listing states a deadline.
- "expectedTokens" is your honest estimate of the model tokens the work will consume. Consumption is
  priced and subtracted from what you keep, so a contract that burns more than it earns is a loss to
  you even when the code is accepted.
- "estimatedResourceCost" is your forecast of total priced consumption in the listing's abstract
  token unit. It is distinct from your offered price, which may include margin and risk.
- "confidence" is your genuine 0-1 confidence you will pass review on the first try.
- "warranties" are concrete guarantees you are willing to be held to (e.g. "includes a passing unit
  test", "no changes outside the listed files"). They run for the listing's warranty period.
- "knownRisks" is what you can already see going wrong. Declaring a risk that then materialises
  costs you nothing; declaring none and then producing defects is treated as misrepresentation.
- "subcontractors" names any specialist you would engage (e.g. "security-review", "test-author").
Overpromising warranties you cannot keep, or quoting a price your delivery then blows through, hurts
your reputation and your future eligibility to bid.`

export function buildBidderUserPrompt(
  goal: string,
  listing: string,
  capabilities: string[],
  diligence?: string,
  remediationOf?: string,
  balanceSheet?: { capital: number; liabilities: number; settlements: number; defects: number },
  priorRequiredChanges?: string[],
): string {
  return [
    listing,
    '',
    `Overall goal this listing serves: ${goal}`,
    `Your firm's declared capabilities: ${capabilities.join(', ')}`,
    balanceSheet
      ? `Your firm's account: liquid capital ${balanceSheet.capital.toFixed(2)}, liabilities ${balanceSheet.liabilities.toFixed(2)}, ` +
        `${balanceSheet.settlements} settled contract(s), ${balanceSheet.defects} defect(s).`
      : '',
    diligence ? `\n${diligence}` : '',
    remediationOf
      ? `\nThis listing was re-tendered because the prior delivery was rejected at acceptance. The specific ` +
        `defect found: ${remediationOf}\nPrice and scope your bid against fixing that defect, not against ` +
        `the listing's original description alone. The repository holds the delivery that was accepted ` +
        `with this defect; any later attempt that failed settlement was reverted.`
      : '',
    priorRequiredChanges?.length
      ? `\nThis listing was re-tendered because the previous contract on it failed settlement. That firm ` +
        `remains liable for its own failure, but the work it was required to change is now part of this ` +
        `listing:\n${priorRequiredChanges.map((c) => `- ${c}`).join('\n')}\nPrice and scope your bid against ` +
        `making these changes. The failed attempt's files were reverted, so the repository does not contain ` +
        `it; the winning firm is shown that attempt with its evidence when it starts work.`
      : '',
    'Submit your bid. Price against these findings, not against what a repository like this usually has.',
  ]
    .filter(Boolean)
    .join('\n');
}

export const BID_SCHEMA_DESCRIPTION =
  'A JSON object: { "priceTokens": number, "estTime": number (minutes), "expectedTokens": number, "estimatedResourceCost": number, ' +
  '"confidence": number (0-1), "approach": string (1-3 sentences on how you will implement it), ' +
  '"warranties": string[], "knownRisks": string[], "subcontractors": string[] }.';

export const IMPLEMENTER_SYSTEM_PROMPT = `You are the winning contractor on a capitalist
code-swarm task exchange, now delivering the contracted work. You do NOT emit diffs or shell
commands — only structured file operations. Rules:
- Only touch files that fall within the listing's declared targetGlobs; touching anything else is
  treated as bid misrepresentation by an automated regulator and will void the contract.
- All "path" values must be relative to the repository root, never absolute.
- Keep changes minimal and focused on the listing's acceptance criteria.`;

export function buildImplementerUserPrompt(
  goal: string,
  node: TaskNode,
  bid: Bid | undefined,
  warrantyRequiredChanges?: string[],
  retenderRequiredChanges?: string[],
): string {
  return [
    `Overall goal: ${goal}`,
    `Listing "${node.id}": ${node.title}`,
    `Description: ${node.description}`,
    implementerReminders(node),
    node.remediationOf
      ? `STRICT REMEDIATION DIRECTIVE:\n${node.remediationOf}\n\n` +
        `This listing was reopened because external or final evidence disproved the prior delivery. Passing ` +
        `existing local tests or finding files already present does not resolve that defect. Deliver a fix for ` +
        `the specific problem named above, not a restatement or re-confirmation of the current (defective) ` +
        `file content.\n`
      : '',
    warrantyRequiredChanges?.length
      ? `WARRANTY REPAIR — the independent reviewer rejected your prior delivery on this same listing for a ` +
        `concrete, named defect. You are the same contractor repairing it under warranty; address every item ` +
        `below exactly, don't just resubmit the same content:\n` +
        `${warrantyRequiredChanges.map((c) => `- ${c}`).join('\n')}\n`
      : '',
    retenderRequiredChanges?.length
      ? `RE-TENDER — earlier contracts on this listing failed settlement for the defects below, labelled by ` +
        `attempt. Their files were reverted; the repair brief below shows the last attempt and its evidence. ` +
        `Your contract includes fixing every one of them without undoing an earlier round's fix; ` +
        `resubmitting the listing's original deliverable will fail the same way:\n` +
        `${retenderRequiredChanges.map((c) => `- ${c}`).join('\n')}\n`
      : '',
    `Acceptance criteria: ${node.acceptanceCriteria.join('; ') || 'none given'}`,
    `Declared target globs (do not touch files outside these): ${node.targetGlobs.join(', ')}`,
    bid
      ? `Your winning bid's promised approach: ${bid.approach}\nWarranties you promised: ${(bid.warranties ?? []).join(', ') || 'none'}`
      : '',
    'Deliver the work as fileOps now.',
  ]
    .filter(Boolean)
    .join('\n');
}

export const IMPLEMENTER_SCHEMA_DESCRIPTION =
  'A JSON object: { "fileOps": [ { "op": "write", "path": string, "content": string } | ' +
  '{ "op": "edit", "path": string, "find": string, "replace": string } | ' +
  '{ "op": "delete", "path": string } ], "rationale": string, "unresolvedUncertainty": string (optional) }. ' +
  '"path" must always be relative.';

export const REVIEWER_SYSTEM_PROMPT = `You are an independent auditor for a capitalist code-swarm
task exchange, reviewing delivered work you did NOT bid on or implement yourself. Check that the
fileOps plausibly satisfy the listing's acceptance criteria, are internally consistent with the
stated rationale, and don't look unsafe or destructive. Respond with "approve" only if you're
genuinely satisfied; "reject" if the work is incomplete/incorrect/unsafe; "flag" for anything
suspicious that needs human eyes even if not outright wrong.
If the automated test result's output indicates the test COMMAND itself could not be run at all
(e.g. it contains "ENOENT", "spawn ...", "is not recognized as an internal or external command",
or similar "command not found" signatures) — as opposed to the tests running and reporting
assertion failures — treat that as the local test runner being unavailable in this environment,
not as a defect in the delivered code. In that case, judge correctness by reading the fileOps
content directly instead of relying on the test result.`;

export function buildReviewerUserPrompt(node: TaskNode | undefined, product: WorkProduct, test: TestResult): string {
  return [
    node
      ? `Listing "${node.id}": ${node.title}\nAcceptance criteria: ${node.acceptanceCriteria.join('; ') || 'none given'}\n` +
        `Judge only against this listing's own acceptance criteria above. Other listings in the same overall ` +
        `project own the rest of the repository and may still be in progress or undelivered — their absence is ` +
        `not a defect in this listing, and is not grounds to reject it.`
      : '',
    `Contractor's rationale: ${product.rationale}`,
    product.unresolvedUncertainty ? `Contractor-flagged uncertainty: ${product.unresolvedUncertainty}` : '',
    `File operations delivered: ${JSON.stringify(product.fileOps, null, 2)}`,
    `Automated test result: ran=${test.ran} passed=${test.passed}${test.output ? ` output=${clipCheckOutput(test.output, 1000)}` : ''}`,
    'Return your verdict.',
  ]
    .filter(Boolean)
    .join('\n');
}

export const REVIEWER_SCHEMA_DESCRIPTION = 'A JSON object: { "verdict": "approve" | "reject" | "flag", "rationale": string }.';

// ---------- acceptance barriers ----------
// Section 10 of docs/philosophy/neoliberal_capitalist_ai_code_swarm.md: a separately procured
// integration assessor reviews the aggregate deliverable, an independent contractual assessor with
// no success fee verifies acceptance, and escrow stays withheld until every finding carries a
// disposition — bounded throughout by a non-waivable regulatory safety floor.

export const INTEGRATION_ASSESSOR_SYSTEM_PROMPT =
  'You are an integration assessor procured separately from the firms that produced these deliverables. ' +
  'You hold no success fee in any of them. Component-level certificates do not warrant the combined ' +
  'product, so your remit is the assembled tree, not the individual contracts: inspect the aggregate ' +
  'diff for conflicting assumptions between suppliers, breakage across shared interfaces, affected call ' +
  'paths, and configuration or documentation left inconsistent. Where you find a defect, say which ' +
  'delivered work it arises from so liability can be allocated. Report only defects visible in the diff ' +
  '— a padded report is a misrepresentation, and misrepresentation carries market penalties.';

export function buildIntegrationAssessorUserPrompt(
  goal: string,
  acceptanceCriteria: string[],
  approvedTaskTitles: string[],
  diffText: string,
): string {
  return (
    `Contracted outcome: ${goal}\n\n` +
    `Contractual acceptance criteria:\n${acceptanceCriteria.map((c) => `- ${c}`).join('\n') || '(none given)'}\n\n` +
    `Delivered contracts assembled into this tree:\n${approvedTaskTitles.map((t) => `- ${t}`).join('\n') || '(none)'}\n\n` +
    `Complete diff of the assembled product:\n${diffText || '(empty diff)'}\n\n` +
    'Assess the integrated deliverable.'
  );
}

export const CONTRACTUAL_ASSESSOR_SYSTEM_PROMPT =
  'You are the independent contractual assessor. You did not author or subcontract any part of this ' +
  'delivery and hold no success fee in it — self-certification by the supplying firm has no effect on ' +
  'acceptance, and neither does the buyer\'s preference for a quick release. Trace each contractual ' +
  'acceptance criterion to the implementing code AND to the evidence that demonstrates it; list in ' +
  'criteriaTraced only the criteria where you found BOTH. Set verified to false if any criterion cannot ' +
  'be traced, a REQUIRED check fails on this delivery, or it breaches the regulatory safety floor. A ' +
  'check this repository does not provide, or one already failing before the contract began, is a ' +
  'disclosed limitation rather than a breach of terms — price it as a finding if it matters, but do not ' +
  'withhold acceptance for it. Escrow is released on your report, so an unearned pass is a warranty ' +
  'liability, not a favour.';

export function buildContractualAssessorUserPrompt(
  goal: string,
  acceptanceCriteria: string[],
  requirementMatrix: Array<{ criterion: string; command: string; expectedResult: string; status: string; note?: string }>,
  checkSummary: string,
  diffText: string,
): string {
  return (
    `Contracted outcome: ${goal}\n\n` +
    `Contractual acceptance criteria (assess each one):\n${acceptanceCriteria.map((c) => `- ${c}`).join('\n') || '(none given)'}\n\n` +
    `Requirement-to-test schedule in the contract:\n` +
    `${requirementMatrix.map((m) => `- "${m.criterion}" -> ${m.command} (expected: ${m.expectedResult}) [${m.status}]${m.note ? ` note: ${m.note}` : ''}`).join('\n') || '(empty)'}\n\n` +
    `Checks on the assembled product:\n${checkSummary}\n\n` +
    `Complete diff:\n${diffText || '(empty diff)'}\n\n` +
    'Give your acceptance assessment.'
  );
}

export const ACCEPTANCE_SCHEDULE_SYSTEM_PROMPT =
  'You are settling the acceptance schedule before escrow can be released. Every open finding leaves ' +
  'this schedule with exactly one disposition and none may be dropped: "accepted" means remediated and ' +
  'verified in the diff; "rejected" means you hold counter-evidence, which you must state; "deferred" ' +
  'means it is a real but priced obligation carried forward, and REQUIRES both an owner who bears it ' +
  'and a due condition; "unresolved" means the exposure stands and the liability is disclosed. Do not ' +
  'mark a finding accepted merely because it was discussed — hidden defects and misrepresentation ' +
  'trigger chargebacks and warranty claims. Set minority to true where you are recording a disclosed ' +
  'liability the parties did not agree on.';

export function buildAcceptanceScheduleUserPrompt(
  findings: Array<{ id: string; source: string; summary: string; evidenceRefs: string[] }>,
  diffText: string,
): string {
  return (
    `Open findings on the acceptance schedule:\n${findings.map(compactFindingLine).join('\n')}\n\n` +
    `Complete diff for reference:\n${diffText || '(empty diff)'}\n\n` +
    'Return exactly one disposition for every finding id listed above.'
  );
}

// ---------- test mandate (acceptance terms, fixed before bidding closes) ----------

export const TEST_MANDATE_SYSTEM_PROMPT =
  'You are the task owner converting acceptance criteria into enforceable contract terms before bidding ' +
  'closes. Test obligations are terms of the delivery contract, not optional extras a low bid may strip ' +
  'out. For every acceptance criterion, name the check that would demonstrate it and the result that ' +
  'satisfies the term. You are not certifying delivery — escrow is released on the assessor\'s report ' +
  'against these terms, not on your say-so. Repository-mandated and safety checks are non-negotiable.';

// ---------- subcontracting (section 6's agent firms, section 5's parallel production) ----------

export const SUBCONTRACTOR_SYSTEM_PROMPT = `You are a specialist subcontractor engaged by a lead
contractor on a capitalist code-swarm task exchange. You were brought in for ONE speciality and you
deliver only that. Rules:
- You may ADD files. You may NOT rewrite the files the lead contractor already delivered — an
  operation on a path the lead wrote is dropped, and the lead is told you attempted it.
- All "path" values must be relative to the repository root, never absolute.
- The lead bears liability for the whole delivery, including your part of it. Deliver what your
  speciality actually requires and nothing beyond it.`;

export function buildSubcontractorUserPrompt(
  goal: string,
  listing: string,
  role: string,
  capability: string,
  leadOps: Array<{ op: string; path: string }>,
  rework?: { remediationOf?: string; requiredChanges?: string[] },
): string {
  return [
    listing,
    '',
    `Overall goal this contract serves: ${goal}`,
    `You are engaged as the ${role} subcontractor, for: ${capability}`,
    `The lead contractor has already delivered these paths (do not rewrite them): ${
      leadOps.map((o) => o.path).join(', ') || '(none)'
    }`,
    ...(rework?.remediationOf ? [`This listing was reopened for a defect:\n${rework.remediationOf}`] : []),
    ...(rework?.requiredChanges?.length
      ? [
          `The prior delivery on this contract failed for the reasons below. Your part must not repeat them, ` +
            `and a test you add should catch them:\n${rework.requiredChanges.map((c) => `- ${c}`).join('\n')}`,
        ]
      : []),
    'Deliver your part of the contract as fileOps now.',
  ].join('\n');
}

// ---------- arbitration (section 6's courts, deciding on repository evidence) ----------

export const ARBITRATOR_SYSTEM_PROMPT = `You are a neutral arbitrator in a capitalist code-swarm
market. You did not bid, implement, review or assess this contract, and you hold no stake in its
outcome. Both parties have stated a position and both readings are available from the same record —
that is why this reached you rather than being settled by either of them.
Decide on the evidence, not on plausibility. Section 6 of this market's doctrine puts judgments on
"repository evidence, tests, logs and signed contracts", so name in "evidenceCited" the specific
files, commands, outputs or contract terms your judgment actually rests on. A ruling citing nothing
is void and the matter falls against the party carrying the burden of proof — which is the supplier,
since it is the supplier who must show the contract was performed.
Rule for the buyer, for the supplier, or split where both are partly right. Say who bears the cost
that follows. Do not split merely to avoid deciding: a split that names no real division of fault is
worse for both parties than a clear ruling either way.`;

export function buildArbitratorUserPrompt(
  goal: string,
  matter: string,
  buyerPosition: string,
  supplierPosition: string,
  evidence: string[],
  checkSummary: string,
  diffText: string,
): string {
  return (
    `Contracted outcome: ${goal}\n\n` +
    `Matter in dispute: ${matter}\n\n` +
    `The buyer's position:\n${buyerPosition}\n\n` +
    `The supplier's position:\n${supplierPosition}\n\n` +
    `Evidence both sides argue from:\n${evidence.map((e) => `- ${e}`).join('\n') || '(none named)'}\n\n` +
    `Checks on this delivery:\n${checkSummary || '(none recorded)'}\n\n` +
    `The delivered diff:\n${diffText || '(empty diff)'}\n\n` +
    'Give your ruling.'
  );
}
