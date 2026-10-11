import type { LedgerEntry } from '../engine/Ledger.js';
import type { StrategyId } from '../engine/types.js';
import { formattedMoney as money, normalizedNumber as num, pluralizedCount as plural } from './prose.js';

/**
 * Turns ledger entries into the running commentary shown in the doctrine ticker.
 *
 * Deterministic templates, not generated prose: free, instant, offline, and — the reason that
 * matters — incapable of inventing a vote count that never happened. The ticker sits beside an
 * audit log, so it must not be able to contradict it.
 *
 * Each template declares the payload fields it reads. DoctrineNarrator.test.ts cross-checks
 * those declarations against the object literals the engine actually passes to ledger.record(),
 * so a template can never quietly render `undefined` because a call site changed shape.
 */

export type Tone = 'routine' | 'contest' | 'ruling' | 'alarm';

export interface TickerLine {
  text: string;
  tone: Tone;
  taskId?: string;
  actor?: string;
}

/** Resolves a task id to its human-readable title. */
export type TitleResolver = (taskId: unknown) => string;

export interface Template {
  /** Payload keys this template reads. Enforced by test against the emitting call site. */
  fields: string[];
  tone: Tone;
  render: (d: Record<string, unknown>, title: TitleResolver) => string;
}

// ------------------------------------------------------------------ helpers

const str = (v: unknown): string => (v === undefined || v === null ? '' : String(v));
const count = (v: unknown): number => (Array.isArray(v) ? v.length : 0);

/** "a and b" / "a, b and c" — the register is parliamentary, so no Oxford comma. */
function series(values: unknown): string {
  const list = Array.isArray(values) ? values.map(str).filter(Boolean) : [];
  if (list.length === 0) return 'none';
  if (list.length === 1) return list[0];
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

/** Subject-verb agreement for a counted subject. */
const verb = (n: number, singular: string, pluralForm: string): string => (n === 1 ? singular : pluralForm);

/** "a" / "an" — real runs produced "a approved outcome" before this existed. */
const article = (word: unknown): string => (/^[aeiou]/i.test(str(word)) ? 'an' : 'a');

/** "first", "second", … Terms are counted in the parliamentary register, not "term 2". */
function ordinal(n: number): string {
  const names = ['zeroth', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];
  if (n >= 0 && n < names.length) return names[n];
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  const suffix = { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th';
  return `${n}${suffix}`;
}

/**
 * Joins the parts of a parenthetical, dropping the empty ones.
 *
 * Several payload fields are optional in practice — capitalist runs record plan_source with no
 * model, socialist runs with no source — and naively interpolating them produced lines like
 * "planner-1 (, glm-5.2, $0.0079)". Returns '' when nothing survives, so the caller can omit the
 * clause entirely.
 */
function bracket(...parts: unknown[]): string {
  const kept = parts.map(str).map((s) => s.trim()).filter(Boolean);
  return kept.length === 0 ? '' : ` (${kept.join(', ')})`;
}

// ------------------------------------------------------- cross-strategy set

// Events every strategy emits, in a register neutral enough to sit under any of the three.
// A strategy map may still override any of these where its own idiom is stronger.
const COMMON: Record<string, Template> = {
  governance_decision: {
    fields: ['id', 'body', 'subject', 'result'],
    tone: 'ruling',
    render: (d) => `${str(d.body)} decides ${str(d.subject)}: ${str(d.result)}.`,
  },
  governance_mandate_granted: {
    fields: ['id', 'holder', 'scope'],
    tone: 'ruling',
    render: (d) => `${str(d.holder)} receives mandate ${str(d.id)} for ${series(d.scope)}.`,
  },
  governance_mandate_revoked: {
    fields: ['id'],
    tone: 'ruling',
    render: (d) => `Mandate ${str(d.id)} is revoked.`,
  },
  assignment_revoked_before_dispatch: {
    fields: ['taskId', 'assigneeId', 'mandateId'],
    tone: 'ruling',
    render: (d, title) => `${title(d.taskId)} returns for reassignment after mandate ${str(d.mandateId)} was revoked.`,
  },
  plan_amended_by_council: {
    fields: ['taskId', 'council', 'requirement'],
    tone: 'ruling',
    render: (d, title) => `${str(d.council)} amends ${title(d.taskId)}: ${str(d.requirement)}`,
  },
  resource_envelope_reserved: {
    fields: ['taskId', 'difficulty', 'requestedUsd', 'grantedUsd'],
    tone: 'ruling',
    render: (d, title) =>
      `${title(d.taskId)} receives a ${money(d.grantedUsd)} resource envelope on assessed need ` +
      `${num(d.difficulty).toFixed(2)}.`,
  },
  council_member_ballots: {
    fields: ['taskId', 'council', 'planDigest', 'ballots', 'result'],
    tone: 'ruling',
    render: (d, title) => `${str(d.council)} casts ${plural(count(d.ballots), 'worker ballot')} on ${title(d.taskId)}: ${str(d.result)}.`,
  },
  resource_envelope_topped_up: {
    fields: ['taskId', 'amountUsd'],
    tone: 'ruling',
    render: (d, title) => `${title(d.taskId)} receives ${money(d.amountUsd)} more from uncommitted resources.`,
  },
  worker_call: {
    fields: ['personaId', 'role', 'model', 'costUsd'],
    tone: 'routine',
    render: (d) => `${str(d.personaId) || str(d.role)} consults ${str(d.model)} — ${money(d.costUsd)}.`,
  },
  decision_call: {
    fields: ['personaId', 'role', 'model', 'outcome', 'costUsd'],
    tone: 'routine',
    render: (d) =>
      `${str(d.personaId) || str(d.role)} puts the question to ${str(d.model)}` +
      `${d.outcome === 'accepted' ? '' : ', which is not decisive, so it is argued in full'} — ${money(d.costUsd)}.`,
  },
  decision_call_failed: {
    fields: ['role', 'model'],
    tone: 'contest',
    render: (d) => `${str(d.model)} gives no decision for the ${str(d.role)}; the question is argued in full instead.`,
  },
  plan_without_tests: {
    fields: ['testPathGlobs'],
    tone: 'contest',
    render: () => 'The plan stands with no task owning a test file, which the planner would not change.',
  },
  plan_criteria_ahead_of_owner: {
    fields: ['criteria'],
    tone: 'contest',
    render: (d) =>
      `The plan stands with ${plural(count(d.criteria), 'criterion', 'criteria')} that wait on work ` +
      'scheduled outside their own task\'s line, which the planner could not untangle.',
  },
  plan_created: {
    fields: ['nodeCount'],
    tone: 'routine',
    render: (d) => `A programme of ${plural(num(d.nodeCount), 'item')} is set down.`,
  },
  task_error: {
    fields: ['taskId', 'error'],
    tone: 'alarm',
    render: (d, title) => `Proceedings on ${title(d.taskId)} broke down: ${str(d.error)}`,
  },
  wall_clock_exceeded: {
    fields: ['elapsedMin'],
    tone: 'alarm',
    render: (d) => `The sitting is suspended — ${plural(num(d.elapsedMin), 'minute')} elapsed.`,
  },
  rework_budget_exhausted: {
    fields: ['taskId', 'attemptNumber', 'maxAttempts'],
    tone: 'alarm',
    render: (d, title) =>
      `${title(d.taskId)} requested another attempt after ${num(d.attemptNumber)} of ` +
      `${num(d.maxAttempts)} permitted attempts; the work is abandoned without approval.`,
  },
  ownership_transferred: {
    fields: ['path', 'from', 'to', 'cycle'],
    tone: 'ruling',
    render: (d, title) =>
      `${str(d.path)} passes to ${title(d.to)}: its owner ${series(d.from)} can no longer run, and the ` +
      'file still needs repair.',
  },
  ownership_handoff: {
    fields: ['taskId', 'ownerTaskIds', 'attemptNumber'],
    tone: 'contest',
    render: (d, title) =>
      `${title(d.taskId)} cannot lawfully repair the defect found on attempt ${num(d.attemptNumber)}; ` +
      `${series(d.ownerTaskIds)} must answer for the paths they own.`,
  },
  review_reject_downgraded: {
    fields: ['taskId', 'foreignPaths'],
    tone: 'ruling',
    render: (d, title) =>
      `A reject of ${title(d.taskId)} stands only as a flag: it placed the defect in ${series(d.foreignPaths)}, ` +
      'which other tasks own.',
  },
  ownership_handoff_declined: {
    fields: ['taskId', 'ownerTaskIds'],
    tone: 'ruling',
    render: (d, title) =>
      `${title(d.taskId)} keeps its own repair: ${series(d.ownerTaskIds)} already wait on it, and a ` +
      'handoff back would leave each waiting on the other.',
  },
  approval_opened: {
    fields: ['kind', 'description', 'taskId'],
    tone: 'contest',
    render: (d) => `Referred for a human ruling — ${str(d.kind).replace(/_/g, ' ')}: ${str(d.description)}`,
  },
  verification_result: {
    fields: ['taskId', 'ran', 'passed', 'command'],
    tone: 'ruling',
    render: (d, title) => {
      if (!d.ran) return `No check was run on ${title(d.taskId)} — the work stands unexamined.`;
      return d.passed
        ? `The evidence on ${title(d.taskId)} holds: \`${str(d.command)}\` passed.`
        : `The evidence on ${title(d.taskId)} fails: \`${str(d.command)}\` did not pass.`;
    },
  },
  applied_to_real_repo: {
    fields: ['commitSha', 'filesChanged', 'taskIds'],
    tone: 'ruling',
    render: (d) =>
      `Enacted into the working repository — ${plural(count(d.filesChanged), 'file')} across ` +
      `${plural(count(d.taskIds), 'item')}, at ${str(d.commitSha).slice(0, 8)}.`,
  },
  task_decided: {
    fields: ['taskId', 'outcome'],
    tone: 'ruling',
    render: (d, title) => `${title(d.taskId)} — ${str(d.outcome).replace(/_/g, ' ')}.`,
  },
  test_mandate_recorded: {
    fields: ['criteria', 'mapped', 'manual'],
    tone: 'routine',
    render: (d) => {
      const manual = num(d.manual);
      const base = `${plural(num(d.criteria), 'criterion', 'criteria')} bound to the checks that must settle them`;
      return manual === 0
        ? `${base}.`
        : `${base}, ${plural(manual, 'of them')} resting on a named inspection no check can perform.`;
    },
  },
  evidence_resolved: {
    fields: ['satisfied', 'manual', 'unmet'],
    tone: 'ruling',
    render: (d) =>
      num(d.unmet) === 0
        ? `Every criterion is answered by a check that ran${num(d.manual) > 0 ? `, or by a named inspection standing in for one` : ''}.`
        : `${plural(num(d.unmet), 'criterion', 'criteria')} ${num(d.unmet) === 1 ? 'is' : 'are'} not answered by any check that ran.`,
  },
  baseline_recorded: {
    fields: ['categories'],
    tone: 'routine',
    render: (d) => `The ground is surveyed before any work begins — ${plural(count(d.categories), 'check')} recorded as a baseline.`,
  },
  constitution_adopted: {
    fields: ['strategy', 'digest'],
    tone: 'routine',
    render: (d) => `The run adopts its constitution — ${str(d.strategy)}, sealed as ${str(d.digest).slice(0, 12)} — and will be held to it to the end.`,
  },
  constitution_drift_on_resume: {
    fields: ['adopted', 'current'],
    tone: 'routine',
    render: () => 'The rulebook on the shelf has changed since this run began; the run resumes under the constitution it adopted.',
  },
  task_recovered_after_interrupt: {
    fields: ['taskId', 'revertedPaths'],
    tone: 'routine',
    render: (d) =>
      count(d.revertedPaths) > 0
        ? `"${str(d.taskId)}" was cut off mid-verdict; its ${plural(count(d.revertedPaths), 'unjudged file')} ${count(d.revertedPaths) === 1 ? 'is' : 'are'} put back and it waits its turn again.`
        : `"${str(d.taskId)}" was cut off mid-run and waits its turn again.`,
  },
  ownership_declared: {
    fields: ['entries', 'declaredOverlaps'],
    tone: 'routine',
    render: (d) => {
      const overlaps = count(d.declaredOverlaps);
      const base = `Ownership is published over ${plural(count(d.entries), 'work item')}`;
      return overlaps === 0
        ? `${base}, with no shared surface declared.`
        : `${base}, with ${plural(overlaps, 'shared surface')} declared in advance.`;
    },
  },
  concurrent_batch: {
    fields: ['taskIds'],
    tone: 'routine',
    render: (d) => `${plural(count(d.taskIds), 'item')} proceed side by side — their claims do not touch.`,
  },
  graph_remediation_returned: {
    fields: ['cycle', 'affectedTaskIds', 'findings'],
    tone: 'contest',
    render: (d) => `The incomplete whole returns for bounded repair, round ${num(d.cycle)} — ${plural(count(d.affectedTaskIds), 'item')} reopened.`,
  },
  worker_call_unmetered: {
    fields: ['role', 'model', 'timedOut'],
    tone: 'contest',
    render: (d) =>
      `A call to ${str(d.model)} for the ${str(d.role)} ended without an answer` +
      `${d.timedOut === true ? ' when its time ran out' : ''} — the work it did is spent and unpriced.`,
  },
  partial_delivery_submitted: {
    fields: ['approved', 'abandoned', 'of'],
    tone: 'contest',
    render: (d) =>
      `What was agreed goes forward without what was not: ${num(d.approved)} of ${num(d.of)} tasks deliver, ` +
      `and ${plural(count(d.abandoned), 'abandoned task')} stands declared in the manifest.`,
  },
  graph_remediation_failed: {
    fields: ['error'],
    tone: 'alarm',
    render: (d) => `The incomplete-integration assessment could not produce actionable repair: ${str(d.error)}.`,
  },
  graph_remediation_stalled: {
    fields: ['cycle', 'affectedTaskIds'],
    tone: 'alarm',
    render: (d) => `Round ${num(d.cycle)} names the same ${plural(count(d.affectedTaskIds), 'item')} as before — a deadlock, not progress, so repair stops here.`,
  },
  external_evaluation: {
    fields: ['passed', 'total', 'results'],
    tone: 'ruling',
    render: (d) => `The independent oracle records ${num(d.passed)} of ${num(d.total)} checks passing.`,
  },
  repository_fallback_failed: {
    fields: ['role', 'error'],
    tone: 'alarm',
    render: (d) => `Repository context could not be prepared for ${str(d.role)}: ${str(d.error)}.`,
  },
  institutional_call_ceiling: {
    fields: ['taskId', 'role', 'used', 'ceiling'],
    tone: 'alarm',
    render: (d, title) => `${title(d.taskId)} reached its institutional call ceiling of ${num(d.ceiling)} while ${str(d.role)} was sitting.`,
  },
  security_committee_constituted: {
    fields: ['members'],
    tone: 'routine',
    render: (d) => `The Security Committee is constituted with ${plural(count(d.members), 'member')}.`,
  },
  regression_floor_applied: {
    fields: ['taskId', 'doctrineOutcome', 'failedCategories'],
    tone: 'alarm',
    render: (d, title) => `${title(d.taskId)} cannot settle: ${plural(count(d.failedCategories), 'required check')} regressed from the accepted tree.`,
  },
  regression_test_delegated: {
    fields: ['sourceTaskId', 'testTaskId'],
    tone: 'routine',
    render: (d, title) => `${title(d.testTaskId)} carries regression coverage for ${title(d.sourceTaskId)}.`,
  },
  assignment_deferred: {
    fields: ['taskIds', 'reason'],
    tone: 'routine',
    render: (d) => `${plural(count(d.taskIds), 'item')} must wait: ${str(d.reason)}.`,
  },
  undeclared_overlap: {
    fields: ['taskId', 'paths'],
    tone: 'alarm',
    render: (d, title) =>
      `${title(d.taskId)} reached beyond what it claimed — ${plural(count(d.paths), 'path')} nobody had declared.`,
  },
  test_integrity_violation: {
    fields: ['taskId', 'violations'],
    tone: 'alarm',
    render: (d, title) =>
      `${title(d.taskId)} would weaken the tests that judge it. No authority here may permit that; it goes to a human.`,
  },
  finding_raised: {
    fields: ['source', 'summary', 'nonWaivable'],
    tone: 'contest',
    render: (d) => `${d.nonWaivable ? 'On ground that cannot be waived: ' : ''}${str(d.summary)}`,
  },
  integration_report: {
    fields: ['integratorId', 'integrated', 'findingCount'],
    tone: 'ruling',
    render: (d) =>
      d.integrated
        ? `The assembled whole holds together${bracket(str(d.integratorId))} — ${plural(num(d.findingCount), 'finding')} raised.`
        : `The assembled whole does not hold${bracket(str(d.integratorId))} — ${plural(num(d.findingCount), 'finding')} raised.`,
  },
  independent_verification: {
    fields: ['verifierId', 'verified', 'criteriaTraced'],
    tone: 'ruling',
    render: (d) =>
      d.verified
        ? `Verified from outside the chain that made it${bracket(str(d.verifierId))} — ${plural(num(d.criteriaTraced), 'criterion', 'criteria')} traced to evidence.`
        : `Verification is withheld${bracket(str(d.verifierId))}; only ${plural(num(d.criteriaTraced), 'criterion', 'criteria')} could be traced.`,
  },
  review_command_run: {
    fields: ['role', 'taskId', 'commandId', 'args', 'ran', 'exitedZero'],
    tone: 'routine',
    render: (d) => {
      const args = Array.isArray(d.args) && d.args.length ? ` ${d.args.map(String).join(' ')}` : '';
      const outcome = d.ran === false ? 'could not run' : d.exitedZero ? 'exits 0' : 'exits non-zero';
      return `The ${str(d.role)} on ${str(d.taskId)} runs ${str(d.commandId)}${args} before its verdict; it ${outcome}.`;
    },
  },
  attempt_resumed: {
    fields: ['taskId', 'paths'],
    tone: 'routine',
    render: (d) => `${str(d.taskId)} resumes from its last attempt's files rather than starting again.`,
  },
  verification_follow_up: {
    fields: ['verifierId', 'omitted', 'recovered'],
    tone: 'ruling',
    render: (d) =>
      `The verifier${bracket(str(d.verifierId))} is asked again about ${plural(num(d.omitted), 'criterion', 'criteria')} it left unlisted, and traces ${num(d.recovered)}.`,
  },
  findings_disposed: {
    fields: ['count', 'dispositions'],
    tone: 'ruling',
    render: (d) => `${plural(num(d.count), 'finding')} settled — none may leave the record undecided.`,
  },
  delivery_assembled: {
    fields: ['accepted', 'changedFiles', 'findings', 'unresolved'],
    tone: 'ruling',
    render: (d) =>
      `The delivery is drawn up: ${plural(count(d.changedFiles) || num(d.changedFiles), 'file')}, ` +
      `${plural(num(d.findings), 'finding')}, ${plural(num(d.unresolved), 'still unresolved')}.`,
  },
  awaiting_claude_acceptance: {
    fields: ['runId'],
    tone: 'contest',
    render: () => 'The work is submitted for an independent check. Internal approval does not settle it.',
  },
  delivery_accepted: {
    fields: ['note', 'remediationCycles'],
    tone: 'ruling',
    render: (d) =>
      num(d.remediationCycles) > 0
        ? `Accepted after ${plural(num(d.remediationCycles), 'round')} of remediation.`
        : 'Accepted on independent examination.',
  },
  remediation_returned: {
    fields: ['cycle', 'findings'],
    tone: 'alarm',
    render: (d) =>
      `Returned for remediation, round ${num(d.cycle)} — ${plural(count(d.findings), 'concrete defect')} named, ` +
      `and the evidence already gathered is preserved.`,
  },
  delivery_returned_for_repair: {
    fields: ['cycle', 'maxCycles', 'findings'],
    tone: 'alarm',
    render: (d) =>
      `The doctrine refused its own delivery and takes it back, round ${num(d.cycle)} of ${num(d.maxCycles)} — ` +
      `${plural(count(d.findings), 'defect')} of its own naming. Refusing to ship is not the same as stopping work.`,
  },
  terminated_incomplete: {
    fields: ['reason'],
    tone: 'alarm',
    render: (d) => `The run ends incomplete rather than claiming success: ${str(d.reason)}`,
  },
};

// Recorded for audit tidiness, not for the gallery. Narrating it would be noise.
const SILENT = new Set([
  'check_artifacts_cleaned', 'final_check_artifacts', 'institutional_plan_cache_hit',
  'institutional_dispatch', 'repository_tool_limit_reached', 'review_command_refused',
]);

// Acceptance gates, in each tradition's own voice. Everything else about the barriers is narrated
// from COMMON above — only the moment of acceptance really differs between an assent, a council
// decision and an escrow release.
const DOCTRINE_ACCEPTANCE: Record<string, Record<string, Template>> = {
  democratic: {
    constitutional_gate: {
      fields: ['accepted', 'breaches'],
      tone: 'ruling',
      render: (d) =>
        d.accepted
          ? 'The constitutional gate is satisfied. Assent is granted.'
          : `Assent is refused — the gate answers to no majority: ${plural(count(d.breaches), 'breach', 'breaches')}.`,
    },
    motions_recommitted: {
      fields: ['cycle', 'taskIds'],
      tone: 'contest',
      render: (d) => `${plural(count(d.taskIds), 'motion')} recommitted for renewed scrutiny.`,
    },
  },
  socialist: {
    council_acceptance: {
      fields: ['accepted', 'blockers'],
      tone: 'ruling',
      render: (d) =>
        d.accepted
          ? 'The councils accept: the evidence, not the vote, has settled it.'
          : `The councils report the work incomplete — ${plural(count(d.blockers), 'obligation')} unmet.`,
    },
    work_returned_to_councils: {
      fields: ['cycle', 'taskIds', 'reassigned'],
      tone: 'contest',
      render: (d) =>
        count(d.reassigned) > 0
          ? `${plural(count(d.taskIds), 'work unit')} returned, ${plural(count(d.reassigned), 'of them reassigned')} — repeated failure changes hands, not just effort.`
          : `${plural(count(d.taskIds), 'work unit')} returned to the responsible council with the evidence.`,
    },
  },
  capitalist: {
    regulator_safety_floor: {
      fields: ['accepted', 'breaches'],
      tone: 'ruling',
      render: (d) =>
        d.accepted
          ? 'Acceptance terms are met. Escrow may be released.'
          : `Escrow is withheld — the safety floor is not for sale: ${plural(count(d.breaches), 'breach', 'breaches')}.`,
    },
    warranty_claim_returned: {
      fields: ['cycle', 'taskIds', 'relisted'],
      tone: 'contest',
      render: (d) =>
        count(d.relisted) > 0
          ? `${plural(count(d.taskIds), 'contract')} back under warranty, ${plural(count(d.relisted), 'of them relisted')} — a firm is not paid twice to fail.`
          : `${plural(count(d.taskIds), 'contract')} returned to the liable firm for repair, escrow still held.`,
    },
  },
};

// ------------------------------------------------------------- democratic
// Westminster: motions, readings, committees, the Opposition, divisions, confidence.

const DEMOCRATIC: Record<string, Template> = {
  offices_constituted: {
    fields: ['termId', 'method', 'primeCoordinator', 'speaker', 'ceremonialHead', 'representatives', 'cabinet'],
    tone: 'routine',
    render: (d) =>
      `The ${ordinal(num(d.termId))} term is constituted by ${str(d.method)}: ${str(d.primeCoordinator)} takes ` +
      `office, ${str(d.speaker)} takes the Chair and ${str(d.ceremonialHead)} keeps the charter, with ` +
      `${plural(count(d.representatives), 'representative')} returned and ` +
      `${plural(count(d.cabinet), 'portfolio')} filled.`,
  },
  offices_rotated: {
    fields: ['termId', 'rotated', 'method'],
    tone: 'routine',
    render: (d) =>
      `The House rises on ${str(d.method)} and the ${ordinal(num(d.termId))} term begins — ` +
      `${plural(count(d.rotated), 'office')} ${verb(count(d.rotated), 'returns', 'return')} to the country.`,
  },
  conflict_declared: {
    fields: ['personaId', 'offices', 'remedy'],
    tone: 'alarm',
    render: (d) =>
      `A conflict is declared: ${str(d.personaId)} holds ${series(d.offices)} at once. ${str(d.remedy)}`,
  },
  plan_created: {
    fields: ['nodeCount'],
    tone: 'routine',
    render: (d) =>
      `The Order Paper is published: ${plural(num(d.nodeCount), 'motion')} ` +
      `${verb(num(d.nodeCount), 'stands', 'stand')} for debate.`,
  },
  motions_drafted: {
    fields: ['count', 'model', 'costUsd'],
    tone: 'routine',
    render: (d) =>
      `${plural(num(d.count), 'motion')} drafted by the Government at ${money(d.costUsd)}, and laid before the House.`,
  },
  speaker_ruling: {
    fields: ['motionId', 'admissible', 'treatment', 'duplicateOf', 'rationale'],
    tone: 'ruling',
    render: (d, title) => {
      if (d.admissible) {
        return `At first reading the Chair admits ${title(d.motionId)} for ${str(d.treatment)} treatment. ${str(d.rationale)}`;
      }
      const duplicate = str(d.duplicateOf);
      return duplicate
        ? `The Chair refuses ${title(d.motionId)}: the same question as ${title(duplicate)}, and it may not be put twice.`
        : `The Chair rules ${title(d.motionId)} out of order. ${str(d.rationale)}`;
    },
  },
  safety_floor_applied: {
    fields: ['raisedBy', 'article', 'grounds'],
    tone: 'alarm',
    render: (d) =>
      `${str(d.raisedBy)} raised ${plural(count(d.grounds), 'finding')} on non-waivable ground ` +
      `(${series([...new Set(Array.isArray(d.grounds) ? d.grounds.map(str) : [])])}). Under ${str(d.article)} ` +
      'they must be remedied or refuted, not deferred, before delivery.',
  },
  speaker_amendment: {
    fields: ['motionId', 'struck', 'keptBy', 'subsumedBy'],
    tone: 'ruling',
    render: (d, title) =>
      count(d.subsumedBy) > 0
        ? `The Chair finds every file ${title(d.motionId)} names already in a narrower motion's mandate; ` +
          `its work passes to ${series(d.subsumedBy)}.`
        : `The Chair amends ${title(d.motionId)}: ${plural(count(d.struck), 'file')} belong to a narrower ` +
          `motion's mandate and are struck from it.`,
  },
  order_paper_restored: {
    fields: ['motionId', 'speaker'],
    tone: 'alarm',
    render: (d, title) =>
      `Every motion was struck, so ${str(d.speaker)} restores ${title(d.motionId)} — the Chair may not cancel ` +
      'the whole programme on procedure alone.',
  },
  minority_report_retained: {
    fields: ['findingIds', 'retainedBy'],
    tone: 'contest',
    render: (d) =>
      `${str(d.retainedBy)} restores ${plural(count(d.findingIds), 'minority report')} the committee's ` +
      'disposition had let fall. Dissent is preserved with the decision, whichever way it went.',
  },
  risk_classified: {
    fields: ['taskId', 'riskClass', 'touchedPaths'],
    tone: 'routine',
    render: (d, title) =>
      `${title(d.taskId)} is certified ${str(d.riskClass)} risk, touching ${plural(count(d.touchedPaths), 'paper')}.`,
  },
  closure_applied: {
    fields: ['taskId', 'attemptNumber', 'carriedFindings'],
    tone: 'ruling',
    render: (d, title) =>
      `Closure on ${title(d.taskId)}: the committee authorised this routine motion at first sitting, so ` +
      `attempt ${num(d.attemptNumber) + 1} goes straight to the Opposition and the division.`,
  },
  committee_inquiry: {
    fields: ['taskId', 'portfolioTag', 'motionClass', 'findings'],
    tone: 'contest',
    render: (d, title) =>
      `The ${str(d.portfolioTag)} committee reports on ${title(d.taskId)} — ` +
      `${plural(count(d.findings), 'finding')} on a ${str(d.motionClass)} motion.`,
  },
  file_ops_proposed: {
    fields: ['taskId', 'ops'],
    tone: 'routine',
    render: (d, title) => `Amendments laid on ${title(d.taskId)}: ${plural(count(d.ops), 'clause')}.`,
  },
  opposition_brief: {
    fields: ['taskId', 'verdict', 'severity'],
    tone: 'contest',
    render: (d, title) =>
      `The Opposition rises on ${title(d.taskId)} — ${str(d.verdict)}, severity ${str(d.severity)}.`,
  },
  division_recorded: {
    fields: ['taskId', 'ayes', 'noes', 'abstentions', 'departures', 'outcome'],
    tone: 'ruling',
    render: (d, title) => {
      const departures = count(d.departures);
      const roll =
        `The House divides on ${title(d.taskId)}: ayes ${num(d.ayes)}, noes ${num(d.noes)}, ` +
        `${plural(num(d.abstentions), 'abstention')}.`;
      return departures === 0
        ? roll
        : `${roll} ${plural(departures, 'member')} broke with their constituency on the evidence.`;
    },
  },
  minority_amendment_considered: {
    fields: ['taskId', 'proposal', 'evidenceRefs', 'ayesForOriginal', 'noesForOriginal', 'adoptedForRework'],
    tone: 'contest',
    render: (d, title) => `The Opposition's amendment on ${title(d.taskId)} is considered; ` +
      (d.adoptedForRework ? 'the motion returns for repair.' : 'the original division does not authorize repair.'),
  },
  representative_recalled: {
    fields: ['constituency', 'outgoing', 'incoming', 'misrepresentations'],
    tone: 'alarm',
    render: (d) =>
      `${str(d.constituency)} recalls ${str(d.outgoing)} after carrying ` +
      `${plural(num(d.misrepresentations), 'motion')} the House then refused. ` +
      `${str(d.incoming)} is returned in their place.`,
  },
  vote_computed: {
    fields: ['taskId', 'category', 'thresholdLabel', 'committeeApproveScore', 'oppositionVerdict', 'outcome'],
    tone: 'ruling',
    render: (d, title) =>
      `Division on ${title(d.taskId)} (${str(d.category)}, ${str(d.thresholdLabel)}): ` +
      `the committee scores ${num(d.committeeApproveScore).toFixed(2)} against an Opposition ` +
      `${str(d.oppositionVerdict)} — ${str(d.outcome).replace(/_/g, ' ')}.`,
  },
  government_reply: {
    fields: ['taskId', 'personaId', 'conceded', 'objectionsAnswered', 'citesEvidence'],
    tone: 'contest',
    render: (d, title) => {
      if (d.conceded) return `${str(d.personaId)} concedes the Opposition's case on ${title(d.taskId)}.`;
      const answered = `${str(d.personaId)} answers ${plural(count(d.objectionsAnswered), 'objection')} on ${title(d.taskId)}`;
      return d.citesEvidence
        ? `${answered}, citing the record.`
        : `${answered} — but cites nothing, and an unevidenced answer is a repeated conclusion.`;
    },
  },
  cabinet_dissent: {
    fields: ['portfolioTag', 'personaId', 'resigned', 'rationale'],
    tone: 'alarm',
    render: (d) =>
      d.resigned
        ? `${str(d.personaId)} resigns the ${str(d.portfolioTag)} brief. ${str(d.rationale)}`
        : `${str(d.personaId)} records a formal dissent on the ${str(d.portfolioTag)} brief. ${str(d.rationale)}`,
  },
  confidence_motion: {
    fields: ['subject', 'ayes', 'noes', 'abstentions', 'outcome', 'rationale'],
    tone: 'alarm',
    render: (d) =>
      `The question is put on the confidence of the House in ${str(d.subject)} — ayes ${num(d.ayes)}, ` +
      `noes ${num(d.noes)}, ${plural(num(d.abstentions), 'abstention')}. Confidence is ${str(d.outcome)}. ` +
      `${str(d.rationale)}`,
  },
  government_formed: {
    fields: ['primeCoordinator', 'method', 'termId'],
    tone: 'ruling',
    render: (d) => `${str(d.primeCoordinator)} is called to form a government by ${str(d.method)}.`,
  },
  alternative_programme_prepared: {
    fields: ['author', 'motions', 'rationale'],
    tone: 'contest',
    render: (d) =>
      count(d.motions) === 0
        ? `${str(d.author)} lays no alternative programme. ${str(d.rationale)}`
        : `${str(d.author)} lays an alternative programme of ${plural(count(d.motions), 'motion')} before the House.`,
  },
  confidence_vote: {
    fields: ['outgoingPersonaId', 'incomingPersonaId', 'consecutiveFailures', 'portfolioTag', 'note'],
    tone: 'alarm',
    render: (d) =>
      `The House withdraws its confidence from ${str(d.outgoingPersonaId)} after ` +
      `${plural(num(d.consecutiveFailures), 'defeat')} on the ${str(d.portfolioTag)} brief. ` +
      `${str(d.incomingPersonaId)} takes the despatch box. ${str(d.note)}`,
  },
  question_time: {
    fields: ['asOfCompletedTasks', 'whatChanged', 'whatsUnmet', 'risksIncreased', 'irreversible'],
    tone: 'contest',
    render: (d) =>
      `Question Time after ${plural(num(d.asOfCompletedTasks), 'completed motion')}: ` +
      `${plural(count(d.whatChanged), 'change')} carried, ${plural(count(d.whatsUnmet), 'undertaking')} unmet, ` +
      `${plural(count(d.risksIncreased), 'risk')} raised, ${plural(count(d.irreversible), 'irreversible act')}.`,
  },
  house_of_review_report: {
    fields: ['convened', 'revisions', 'delayed', 'vetoes', 'rationale'],
    tone: 'ruling',
    render: (d) => {
      if (!d.convened) return `The House of Review does not sit. ${str(d.rationale)}`;
      if (num(d.vetoes) > 0) {
        return (
          `The House of Review withholds its assent on ${plural(num(d.vetoes), 'constitutional ground')} — ` +
          'the one power a revising chamber keeps. ' + str(d.rationale)
        );
      }
      const revising = `${plural(num(d.revisions), 'revision')} and ${plural(num(d.delayed), 'delay')}`;
      return num(d.revisions) + num(d.delayed) === 0
        ? `The House of Review is content. ${str(d.rationale)}`
        : `The House of Review reports ${revising}, and does not stand in the way. ${str(d.rationale)}`;
    },
  },
  accountability_report: {
    fields: ['criteriaMet', 'criteriaUnmet', 'defects', 'costUsd', 'estimatedCostUsd', 'unresolvedRisks', 'lessons'],
    tone: 'ruling',
    render: (d) => {
      const met = `The executive reports to the House: ${num(d.criteriaMet)} criteria met, ` +
        `${plural(count(d.criteriaUnmet), 'unmet')}, ${plural(count(d.defects), 'defect')}, ` +
        `${plural(count(d.unresolvedRisks), 'unresolved risk')}.`;
      const spend =
        num(d.estimatedCostUsd) > 0
          ? ` ${money(d.costUsd)} spent against an estimate of ${money(d.estimatedCostUsd)}.`
          : ` ${money(d.costUsd)} spent; the government gave the House no estimate to be held to.`;
      const lessons = count(d.lessons) === 0 ? '' : ` ${plural(count(d.lessons), 'lesson')} drawn for future policy.`;
      return `${met}${spend}${lessons}`;
    },
  },
  reserve_power_exercised: {
    fields: ['power', 'subject', 'rationale', 'guardian'],
    tone: 'alarm',
    render: (d) =>
      `${str(d.guardian)} exercises a reserve power — ${str(d.power).replace(/-/g, ' ')} on ` +
      `${str(d.subject)}. ${str(d.rationale)}`,
  },
  appeal_recorded: {
    fields: ['taskId', 'appellant', 'granted', 'rationale'],
    tone: 'contest',
    render: (d, title) =>
      d.granted
        ? `${str(d.appellant)} appeals on ${title(d.taskId)} and is heard. ${str(d.rationale)}`
        : `${str(d.appellant)} appeals on ${title(d.taskId)}; the appeal fails. ${str(d.rationale)}`,
  },
  task_decided: {
    fields: ['taskId', 'outcome'],
    tone: 'ruling',
    render: (d, title) => {
      const outcome = str(d.outcome);
      if (outcome === 'approved') return `The ayes have it. ${title(d.taskId)} is carried.`;
      if (outcome === 'rejected') return `The noes have it. ${title(d.taskId)} is defeated.`;
      return `${title(d.taskId)} is referred to the Speaker for a ruling.`;
    },
  },
  approval_opened: {
    fields: ['kind', 'description', 'taskId'],
    tone: 'contest',
    render: (d) =>
      `The Speaker's ruling is sought — ${str(d.kind).replace(/_/g, ' ')}: ${str(d.description)}`,
  },
};

// --------------------------------------------------------------- socialist
// Councils and guilds: federated producers, recallable coordinators, common stock.

const SOCIALIST: Record<string, Template> = {
  plan_created: {
    fields: ['nodeCount'],
    tone: 'routine',
    render: (d) => `The council adopts a work plan of ${plural(num(d.nodeCount), 'undertaking')}.`,
  },
  plan_source: {
    fields: ['source', 'nodeCount', 'plannerPersonaId', 'model', 'costUsd'],
    tone: 'routine',
    render: (d) =>
      `Plan of ${plural(num(d.nodeCount), 'undertaking')} laid before the council` +
      (str(d.plannerPersonaId) ? ` by ${str(d.plannerPersonaId)}` : '') +
      `${bracket(d.source, d.model, money(d.costUsd))}.`,
  },
  guilds_inferred: {
    fields: ['taskId', 'guilds', 'primaryGuilds', 'riskClass', 'targetGlobs'],
    tone: 'routine',
    render: (d, title) =>
      `${title(d.taskId)} falls to the ${series(d.primaryGuilds)} guild, with ` +
      `${series(d.guilds)} consulted — ${str(d.riskClass) || 'unclassified'} risk over ` +
      `${plural(count(d.targetGlobs), 'work area')}.`,
  },
  guild_assigned: {
    fields: ['taskId', 'leadGuild', 'assigneeId', 'coordinated', 'contendingGuilds', 'capability'],
    tone: 'routine',
    render: (d, title) =>
      `The ${str(d.leadGuild)} guild takes up ${title(d.taskId)} through ${str(d.assigneeId)}` +
      (d.coordinated
        ? `, coordinated with ${series(d.contendingGuilds)}.`
        : ', without contention.'),
  },
  coordinator_arbitration: {
    fields: ['taskId', 'leadGuild', 'contendingGuilds', 'assigneeId', 'rationale', 'model'],
    tone: 'contest',
    render: (d, title) =>
      `The coordinator arbitrates ${title(d.taskId)} between ${series(d.contendingGuilds)}: ` +
      `${str(d.leadGuild)} leads through ${str(d.assigneeId)}. ${str(d.rationale)}`,
  },
  work_executed: {
    fields: ['taskId', 'personaId', 'assigneeId', 'fileOpCount', 'guilds', 'riskClass', 'costUsd'],
    tone: 'routine',
    render: (d, title) =>
      `${str(d.personaId) || str(d.assigneeId)} contributes ${plural(num(d.fileOpCount), 'change')} ` +
      `to ${title(d.taskId)} for the common stock` +
      `${bracket(count(d.guilds) > 0 ? series(d.guilds) : '', str(d.riskClass) ? `${str(d.riskClass)} risk` : '', money(d.costUsd))}.`,
  },
  peer_review: {
    fields: ['taskId', 'reviewerId', 'reviewerGuild', 'implementerId', 'verdict', 'rationale', 'lessonsConsidered'],
    tone: 'contest',
    render: (d, title) =>
      `${str(d.reviewerId)} of the ${str(d.reviewerGuild)} guild reviews ${str(d.implementerId)} ` +
      `on ${title(d.taskId)} — ${str(d.verdict)}, weighing ${plural(count(d.lessonsConsidered), 'lesson')} ` +
      `held in common. ${str(d.rationale)}`,
  },
  capability_updated: {
    fields: ['taskId', 'assigneeId', 'guild', 'outcome', 'before', 'after', 'delta'],
    tone: 'routine',
    render: (d) => {
      const delta = num(d.delta);
      const direction = delta >= 0 ? 'grows' : 'falls';
      return (
        `The ${str(d.guild)} guild records that ${str(d.assigneeId)}'s capability ${direction} ` +
        `${num(d.before).toFixed(2)} → ${num(d.after).toFixed(2)} on ${article(d.outcome)} ${str(d.outcome)} outcome. ` +
        `Skill is held by the collective, not the worker.`
      );
    },
  },
  planner_recall: {
    fields: ['from', 'to', 'taskIds', 'reason'],
    tone: 'alarm',
    render: (d) =>
      `The council recalls ${str(d.from)} after diagnosed planning failures. ` +
      `${str(d.to)} revises ${plural(count(d.taskIds), 'unfinished task')}.`,
  },
  task_decided: {
    fields: ['taskId', 'outcome'],
    tone: 'ruling',
    render: (d, title) => {
      const outcome = str(d.outcome);
      if (outcome === 'approved') return `The council concurs. ${title(d.taskId)} passes into the common stock.`;
      if (outcome === 'rejected') return `The council withholds assent. ${title(d.taskId)} returns to the guild.`;
      return `${title(d.taskId)} is put to the wider assembly.`;
    },
  },
  approval_opened: {
    fields: ['kind', 'description', 'taskId'],
    tone: 'contest',
    render: (d) => `Referred to the assembly — ${str(d.kind).replace(/_/g, ' ')}: ${str(d.description)}`,
  },
  constitutional_gate: {
    fields: ['accepted', 'breaches', 'articles'],
    tone: 'ruling',
    render: (d) =>
      d.accepted
        ? `The assembly of producers finds the constitution kept — ${series(d.articles)} checked against the ` +
          `record, not against anyone's account of it.`
        : `The assembly of producers refuses: ${plural(count(d.breaches), 'constitutional breach')}. ` +
          `${series(d.breaches)}`,
  },
  commons_report: {
    fields: ['published', 'unresolved', 'lessons', 'skippedChecks', 'limitations'],
    tone: 'ruling',
    render: (d) =>
      `The run accounts for itself to the commons: ${plural(count(d.published), 'contribution')} returned, ` +
      `${plural(count(d.lessons), 'lesson')} left for whoever comes next, ` +
      `${plural(count(d.unresolved), 'matter')} still unresolved, ` +
      `${plural(count(d.skippedChecks), 'check')} not run, ` +
      `${plural(count(d.limitations), 'limitation')} disclosed. Nothing here is anyone's private knowledge.`,
  },
  independent_diagnosis: {
    fields: ['taskId', 'cause', 'diagnostician', 'remedy', 'model'],
    tone: 'ruling',
    render: (d, title) =>
      `The councils commission a diagnosis on ${title(d.taskId)}. ${str(d.diagnostician)} finds the cause was ` +
      `${str(d.cause)}, not the worker who held it: ${str(d.remedy)}`,
  },
  appeal_panel_convened: {
    fields: ['taskId', 'appellant', 'panel', 'granted', 'rationale'],
    tone: 'contest',
    render: (d, title) =>
      d.granted
        ? `${str(d.appellant)} appeals over ${title(d.taskId)} to a panel of ${plural(count(d.panel), 'peer')} ` +
          `drawn from outside it. Upheld: ${str(d.rationale)}`
        : `${str(d.appellant)} appeals over ${title(d.taskId)} and does not carry it. ${str(d.rationale)}`,
  },
  mutual_aid_supplied: {
    fields: ['taskId', 'requesterId', 'aiderId', 'kind', 'fixtures', 'model'],
    tone: 'routine',
    render: (d, title) =>
      `Mutual aid reaches ${str(d.requesterId)} on ${title(d.taskId)} — ${str(d.kind).replace(/-/g, ' ')}. ` +
      `${plural(count(d.fixtures), 'fixture')} published to the commons, not handed over privately.`,
  },
  commons_contribution: {
    fields: ['kind', 'tags', 'contributorId', 'taskId'],
    tone: 'routine',
    render: (d, title) =>
      `${str(d.contributorId)} returns ${article(d.kind)} ${str(d.kind)} to the commons from ${title(d.taskId)}, ` +
      `filed under ${series(d.tags)}. What was learned here belongs to everyone.`,
  },
  minority_report_preserved: {
    fields: ['findingIds', 'preservedBy', 'article'],
    tone: 'contest',
    render: (d) =>
      `${str(d.preservedBy)} had let ${plural(count(d.findingIds), 'dissent')} slip from the record. ` +
      `Restored under ${str(d.article).replace(/-/g, ' ')} — a decision may go against a comrade without ` +
      `erasing that they objected.`,
  },
  needs_assessed: {
    fields: ['taskId', 'difficulty', 'riskClass', 'lessonBudget', 'aidEligible', 'rationale'],
    tone: 'routine',
    render: (d, title) =>
      `The council measures what ${title(d.taskId)} needs — ${num(d.difficulty).toFixed(2)} difficulty at ` +
      `${str(d.riskClass) || 'unclassified'} risk, drawing ${plural(num(d.lessonBudget), 'lesson')} from the ` +
      `commons. To each according to the work, not the worker.`,
  },
  subsidiarity_applied: {
    fields: ['taskId', 'decidedBy', 'councils', 'escalated', 'rationale'],
    tone: 'routine',
    render: (d, title) =>
      d.escalated
        ? `${title(d.taskId)} spans ${series(d.councils)} and goes to the coordinating council. ${str(d.rationale)}`
        : `${title(d.taskId)} stays with ${series(d.councils) || 'its own council'}. ${str(d.rationale)}`,
  },
  assignment_returned: {
    fields: ['taskId', 'workerId', 'reason', 'reallocatedTo'],
    tone: 'contest',
    render: (d, title) =>
      `${str(d.workerId)} returns ${title(d.taskId)} to the council: ${str(d.reason)} ` +
      `It passes to ${str(d.reallocatedTo)}. A return is planning information, not insubordination.`,
  },
  reconnaissance_published: {
    fields: ['council', 'personaId', 'scopes', 'risks', 'dependencies', 'proposedCriteria', 'model'],
    tone: 'routine',
    render: (d) =>
      `The ${str(d.council)} council publishes its reconnaissance to the commons through ${str(d.personaId)} — ` +
      `${plural(count(d.scopes), 'scope')}, ${plural(count(d.risks), 'risk')}, ` +
      `${plural(count(d.dependencies), 'dependency')}, ${plural(count(d.proposedCriteria), 'proposed test')}.`,
  },
  plan_challenged: {
    fields: ['council', 'challenge', 'riskOmitted', 'carriedForward'],
    tone: 'contest',
    render: (d) =>
      d.carriedForward
        ? `The ${str(d.council)} council challenges the plan: ${str(d.challenge)}. The risk is carried into the ` +
          `delivery in its name — a challenge is not answered by silence.`
        : `The ${str(d.council)} council's warning was set aside with a reason given: ${str(d.challenge)}`,
  },
  councils_constituted: {
    fields: ['termId', 'councils', 'delegates', 'convener', 'method'],
    tone: 'routine',
    render: (d) =>
      `${plural(count(d.councils), 'worker council')} form around the work and send ` +
      `${plural(count(d.delegates), 'delegate')} to coordinate. ${str(d.convener)} takes the chair by ` +
      `${str(d.method)} for term ${num(d.termId)} — a mandate that expires.`,
  },
  plan_revision_proposed: {
    fields: ['previousDigest', 'revisedDigest', 'objectingCouncils'],
    tone: 'ruling',
    render: (d) =>
      `The planner revises the work plan after ${plural(count(d.objectingCouncils), 'council objection')}; ` +
      `the new version returns to the councils for consent.`,
  },
  mandate_breach: {
    fields: ['body', 'taskId', 'decision', 'article', 'remedy'],
    tone: 'alarm',
    render: (d, title) =>
      `${str(d.body)} reached past its mandate on ${title(d.taskId)}, deciding "${str(d.decision)}". ` +
      `${str(d.remedy)}`,
  },
  delegate_recalled: {
    fields: ['council', 'outgoing', 'incoming', 'ground'],
    tone: 'alarm',
    render: (d) =>
      `${str(d.council)} recalls ${str(d.outgoing)} — ${str(d.ground).replace(/-/g, ' ')}. ` +
      `${str(d.incoming)} carries its instructions now. The mandate was never theirs to keep.`,
  },
  delegate_recall_unavailable: {
    fields: ['council', 'reason'],
    tone: 'contest',
    render: (d) => `${str(d.council)} cannot hold a delegate recall: ${str(d.reason)}.`,
  },
  delegate_recall_unfilled: {
    fields: ['council', 'outgoing', 'ground'],
    tone: 'alarm',
    render: (d) => `${str(d.council)} carried a ${str(d.ground)} recall of ${str(d.outgoing)}, but has no replacement.`,
  },
  legacy_plan_ratified: {
    fields: ['taskIds'],
    tone: 'ruling',
    render: (d) => `${plural(count(d.taskIds), 'unfinished work unit')} receive council authorization on a resumed plan.`,
  },
  rotation_recorded: {
    fields: ['termId', 'rotated', 'into', 'method'],
    tone: 'routine',
    render: (d) =>
      `The coordinating council's term ends. ${series(d.rotated)} ${count(d.rotated) === 1 ? 'stands' : 'stand'} down ` +
      `and ${str(d.into)} takes the chair by ${str(d.method)} for term ${num(d.termId)}.`,
  },
};

// -------------------------------------------------------------- capitalist
// Markets: listings, bids, escrow, reputation, settlement, insolvency.

const CAPITALIST: Record<string, Template> = {
  plan_created: {
    fields: ['nodeCount'],
    tone: 'routine',
    render: (d) => `${plural(num(d.nodeCount), 'contract')} are opened to the market.`,
  },
  plan_source: {
    fields: ['source', 'nodeCount', 'plannerPersonaId', 'model', 'costUsd'],
    tone: 'routine',
    render: (d) =>
      `${str(d.plannerPersonaId) || 'The house'} brings ${plural(num(d.nodeCount), 'contract')} ` +
      `to market${bracket(d.source, d.model)} at a cost of ${money(d.costUsd)}.`,
  },
  plan_fallback: {
    fields: ['reason'],
    tone: 'alarm',
    render: (d) => `The prospectus failed and the market fell back: ${str(d.reason)}`,
  },
  diligence_completed: {
    fields: ['instructions', 'manifests', 'declaredTestCommand', 'applicableChecks', 'excludedChecks', 'scopeUnderstood'],
    tone: 'routine',
    render: (d) =>
      `The ground is surveyed before anything is listed: ${plural(count(d.applicableChecks), 'check')} to be priced` +
      (count(d.excludedChecks) > 0 ? `, ${plural(count(d.excludedChecks), 'exclusion')} justified` : '') +
      `. ${d.scopeUnderstood ? 'The scope will bear a fixed price.' : 'The scope will not bear a fixed price.'}`,
  },
  listing_published: {
    fields: ['taskId', 'contractType', 'retentionFraction', 'budget', 'deadlineMinutes', 'warrantyPeriodTasks', 'requiredCapabilities', 'risk'],
    tone: 'routine',
    render: (d, title) =>
      `${title(d.taskId)} goes to market on ${str(d.contractType)} terms at ${num(d.budget).toFixed(0)} tokens, ` +
      `${num(d.deadlineMinutes).toFixed(0)} minutes, ${(num(d.retentionFraction) * 100).toFixed(0)}% retained across ` +
      `${plural(num(d.warrantyPeriodTasks), 'settlement')} — wanted: ${series(d.requiredCapabilities)}.`,
  },
  listing_republished: {
    fields: ['taskId', 'budget', 'reason'],
    tone: 'ruling',
    render: (d, title) => `${title(d.taskId)} is relisted at ${num(d.budget).toFixed(0)} tokens after ${str(d.reason)}.`,
  },
  bids_refused: {
    fields: ['taskId', 'budget', 'refused'],
    tone: 'ruling',
    render: (d, title) =>
      `${plural(count(d.refused), 'bid')} on ${title(d.taskId)} came in above the published ` +
      `${num(d.budget).toFixed(0)} and are refused. A budget that can be outbid was never a term.`,
  },
  bids_received: {
    fields: ['taskId', 'bids'],
    tone: 'contest',
    render: (d, title) => `${plural(count(d.bids), 'bid')} tendered for ${title(d.taskId)}.`,
  },
  bid_failed: {
    fields: ['taskId', 'personaId', 'error'],
    tone: 'alarm',
    render: (d, title) => `${str(d.personaId)} could not tender for ${title(d.taskId)}: ${str(d.error)}`,
  },
  listing_awarded: {
    fields: ['taskId', 'personaId', 'score'],
    tone: 'ruling',
    render: (d, title) =>
      `${title(d.taskId)} is awarded to ${str(d.personaId)} on a score of ${num(d.score).toFixed(2)}. ` +
      `The bargain is struck.`,
  },
  listing_unfilled: {
    fields: ['taskId', 'reason'],
    tone: 'alarm',
    render: (d, title) => `${title(d.taskId)} clears no bid — ${str(d.reason)}. The market has no answer.`,
  },
  dependents_released: {
    fields: ['taskIds', 'abandonedDependencies'],
    tone: 'alarm',
    render: (d) =>
      `${plural(count(d.taskIds), 'task')} released to proceed without ` +
      `${plural(count(d.abandonedDependencies), 'abandoned dependency')} that will never arrive. ` +
      `Work stopped waiting for something that was not coming; the delivery says what it was built without.`,
  },
  committee_expedited: {
    fields: ['taskId', 'motionClass', 'reason', 'seated', 'fullChamber'],
    tone: 'routine',
    render: (d, title) =>
      `${title(d.taskId)} is taken by ${plural(count(d.seated), 'member')} rather than the full ` +
      `${num(d.fullChamber)} — ${str(d.reason)}. The chamber reserves its whole attention for the business that needs it.`,
  },
  market_entry: {
    fields: ['taskId', 'entrants', 'reason'],
    tone: 'routine',
    render: (d, title) =>
      `${plural(count(d.entrants), 'firm')} enter${count(d.entrants) === 1 ? 's' : ''} the market for ` +
      `${title(d.taskId)} — ${str(d.reason)}. Demand a departing supplier left unmet is an opening for someone else.`,
  },
  market_report: {
    fields: ['positions', 'unmet', 'unresolved', 'carried', 'limitations', 'skippedChecks'],
    tone: 'routine',
    render: (d) =>
      `The market files its account: ${plural(count(d.positions), 'closing position')}, ` +
      `${plural(count(d.unmet), 'thing')} it could not clear, ${plural(count(d.unresolved), 'finding')} still open ` +
      `and ${plural(count(d.carried), 'obligation')} carried forward. A market that conceals its losses cannot ` +
      `price anything.`,
  },
  arbitration_ruled: {
    fields: ['taskId', 'matter', 'ruling', 'liableParty', 'stood', 'evidenceCited', 'rationale'],
    tone: 'ruling',
    render: (d, title) =>
      d.stood
        ? `On ${title(d.taskId)}, the arbitrator finds for the ${str(d.ruling)} on ${str(d.matter)}; ` +
          `${str(d.liableParty)} bears the cost, on ${plural(count(d.evidenceCited), 'piece')} of evidence.`
        : `The ruling on ${title(d.taskId)} cited nothing and is set aside. The burden of proof does not move ` +
          `because a judgment was eloquent.`,
  },
  arbitration_declined: {
    fields: ['taskId', 'matter', 'reason'],
    tone: 'contest',
    render: (d, title) =>
      `The dispute over ${str(d.matter)} on ${title(d.taskId)} is not heard: ${str(d.reason)}`,
  },
  arbitration_failed: {
    fields: ['taskId', 'matter', 'error', 'effect'],
    tone: 'alarm',
    render: (d, title) =>
      `The court could not sit on ${title(d.taskId)} (${str(d.error)}). A court that cannot sit decides for ` +
      `nobody — the matter falls to whoever carries the burden.`,
  },
  levy_collected: {
    fields: ['taskId', 'personaId', 'profit', 'amount', 'toPublicGoods', 'toVenturePool', 'rationale'],
    tone: 'routine',
    render: (d, title) =>
      num(d.amount) > 0
        ? `${str(d.personaId)} pays ${num(d.amount).toFixed(2)} on ${title(d.taskId)} — ` +
          `${num(d.toPublicGoods).toFixed(2)} to the commons, ${num(d.toVenturePool).toFixed(2)} to what is untried.`
        : `${title(d.taskId)} returned no profit, so no levy falls on it. The obligation is discharged, not evaded.`,
  },
  bailout_considered: {
    fields: ['personaId', 'granted', 'amount', 'systemic', 'reason'],
    tone: 'ruling',
    render: (d) =>
      d.granted
        ? `${str(d.personaId)} is rescued with ${num(d.amount).toFixed(2)}, part of the shortfall and never all of ` +
          `it. This run will not rescue another.`
        : `${str(d.personaId)} is not rescued: ${str(d.reason)}`,
  },
  credit_drawn: {
    fields: ['taskId', 'personaId', 'requested', 'drawn', 'refused', 'limit', 'outstanding', 'reason'],
    tone: 'ruling',
    render: (d, title) =>
      num(d.drawn) > 0
        ? `${str(d.personaId)} borrows ${num(d.drawn).toFixed(2)} against its record to take ${title(d.taskId)}; ` +
          `${num(d.outstanding).toFixed(2)} is now owed across the market.`
        : `${str(d.personaId)} is refused credit on ${title(d.taskId)}. Unchecked leverage spends compute ` +
          `nobody is left to answer for.`,
  },
  credit_repaid: {
    fields: ['taskId', 'personaId', 'amount', 'outstanding'],
    tone: 'routine',
    render: (d, title) =>
      `${str(d.personaId)} repays ${num(d.amount).toFixed(2)} from ${title(d.taskId)}; ` +
      `${num(d.outstanding).toFixed(2)} remains owed.`,
  },
  capital_issued: {
    fields: ['personaId', 'amount', 'source'],
    tone: 'routine',
    render: (d) => `${str(d.personaId)} enters with ${num(d.amount).toFixed(2)} in run-charter claims.`,
  },
  public_good_granted: {
    fields: ['taskId', 'good', 'amount', 'originalBudget', 'amendedBudget'],
    tone: 'ruling',
    render: (d, title) =>
      `The public-goods fund commits ${num(d.amount).toFixed(2)} to ${title(d.taskId)} for ${str(d.good)}.`,
  },
  public_good_grant_reversed: {
    fields: ['taskId', 'amount', 'reason'],
    tone: 'ruling',
    render: (d, title) => `${num(d.amount).toFixed(2)} for ${title(d.taskId)} returns to the public-goods fund: ${str(d.reason)}.`,
  },
  venture_experiment_commissioned: {
    fields: ['taskId', 'good', 'amount', 'publicationObligation'],
    tone: 'ruling',
    render: (d, title) => `The venture pool commits ${num(d.amount).toFixed(2)} to ${title(d.taskId)}; findings are owed even on failure.`,
  },
  venture_experiment_reversed: {
    fields: ['taskId', 'amount', 'reason'],
    tone: 'ruling',
    render: (d, title) => `${num(d.amount).toFixed(2)} for ${title(d.taskId)} returns to the venture pool: ${str(d.reason)}.`,
  },
  venture_findings_published: {
    fields: ['taskId', 'outcome', 'rationale', 'reviewFindings'],
    tone: 'routine',
    render: (d, title) => `${title(d.taskId)} publishes its experiment findings after a ${str(d.outcome)} settlement.`,
  },
  warranty_escrow_claimed: {
    fields: ['taskId', 'contractorId', 'forfeited'],
    tone: 'ruling',
    render: (d, title) =>
      `${num(d.forfeited).toFixed(2)} in retained warranty funds is claimed against ` +
      `${str(d.contractorId)} for ${title(d.taskId)}.`,
  },
  premium_charged: {
    fields: ['taskId', 'personaId', 'premium', 'reserveBalance', 'raisedBy', 'rationale'],
    tone: 'ruling',
    render: (d, title) =>
      `${str(d.personaId)} pays ${num(d.premium).toFixed(2)} to insure ${title(d.taskId)}` +
      (count(d.raisedBy) > 0 ? `, raised by ${plural(count(d.raisedBy), 'factor')}` : '') +
      `. Hidden risk becomes an explicit price, or it stays hidden.`,
  },
  claim_paid: {
    fields: ['taskId', 'personaId', 'paid', 'deductible', 'shortfall', 'reserveBalance'],
    tone: 'alarm',
    render: (d, title) =>
      `The reserve pays ${num(d.paid).toFixed(2)} toward repair on ${title(d.taskId)}; ` +
      `${str(d.personaId)} bears ${num(d.deductible).toFixed(2)}` +
      (num(d.shortfall) > 0 ? `, and ${num(d.shortfall).toFixed(2)} is uncovered.` : '.'),
  },
  firm_formed: {
    fields: ['taskId', 'leadId', 'liableId', 'members'],
    tone: 'routine',
    render: (d, title) =>
      `${str(d.leadId)} forms a firm on ${title(d.taskId)}, engaging ` +
      `${plural(count(d.members), 'specialist')}. The lead answers for all of it.`,
  },
  listings_integrated: {
    fields: ['leadTaskId', 'taskId', 'personaId', 'coupling', 'reasons'],
    tone: 'ruling',
    render: (d, title) =>
      `${title(d.taskId)} is taken into the same firm as ${title(d.leadTaskId)} rather than sent to ` +
      `tender — coupling ${num(d.coupling).toFixed(2)}. Some work is cheaper coordinated than bought.`,
  },
  subcontract_delivered: {
    fields: ['taskId', 'personaId', 'role', 'kept', 'dropped'],
    tone: 'routine',
    render: (d, title) =>
      `The ${str(d.role)} subcontractor delivers ${plural(num(d.kept), 'change')} on ${title(d.taskId)}` +
      (num(d.dropped) > 0
        ? `, and ${plural(num(d.dropped), 'attempt')} to rewrite the lead's work refused.`
        : '.'),
  },
  subcontract_failed: {
    fields: ['taskId', 'personaId', 'role', 'error'],
    tone: 'alarm',
    render: (d, title) =>
      `The ${str(d.role)} subcontractor fails on ${title(d.taskId)}: ${str(d.error)} ` +
      `The lead is liable regardless.`,
  },
  work_executed: {
    fields: ['taskId', 'personaId', 'assigneeId', 'fileOpCount', 'subcontractors', 'riskClass', 'costUsd'],
    tone: 'routine',
    render: (d, title) =>
      `${str(d.personaId) || str(d.assigneeId)} delivers ${plural(num(d.fileOpCount), 'change')} ` +
      `against ${title(d.taskId)}` +
      `${bracket(str(d.riskClass) ? `${str(d.riskClass)} risk` : '', money(d.costUsd))}.`,
  },
  review_completed: {
    fields: ['taskId', 'findings'],
    tone: 'contest',
    render: (d, title) => `Due diligence on ${title(d.taskId)}: ${plural(count(d.findings), 'finding')} returned.`,
  },
  spend_cap_breached: {
    fields: ['taskId', 'personaId', 'consumed', 'cap'],
    tone: 'alarm',
    render: (d, title) =>
      `${str(d.personaId)} has run ${title(d.taskId)} to ${num(d.consumed).toFixed(2)} against a cap of ` +
      `${num(d.cap).toFixed(2)}. Time and materials without a ceiling is an open account.`,
  },
  contract_deadline_breached: {
    fields: ['taskId', 'personaId', 'deadlineMinutes', 'awardedAtMs', 'deliveredAtMs'],
    tone: 'alarm',
    render: (d, title) => `${str(d.personaId)} delivered ${title(d.taskId)} after its ${num(d.deadlineMinutes)} minute deadline.`,
  },
  escrow_released: {
    fields: ['taskId', 'personaId', 'amount'],
    tone: 'ruling',
    render: (d, title) =>
      `Retention of ${num(d.amount).toFixed(2)} is released to ${str(d.personaId)} on ${title(d.taskId)}, ` +
      `the warranty period having passed clean.`,
  },
  resources_priced: {
    fields: ['taskId', 'personaId', 'total', 'lines'],
    tone: 'routine',
    render: (d, title) =>
      `What ${title(d.taskId)} consumed is priced at ${num(d.total).toFixed(2)} across ` +
      `${plural(count(d.lines), 'line')}. Scarcity is visible or it is not scarcity.`,
  },
  capital_recorded: {
    fields: ['taskId', 'personaId', 'capital', 'liabilities', 'reputation', 'domainScores', 'reasons'],
    tone: 'routine',
    render: (d, title) =>
      `${str(d.personaId)}'s books close on ${title(d.taskId)} at ${num(d.capital).toFixed(2)} capital against ` +
      `${num(d.liabilities).toFixed(2)} in liabilities, standing ${num(d.reputation).toFixed(2)}.`,
  },
  contract_settled: {
    fields: ['taskId', 'personaId', 'outcome', 'price', 'resourceCost', 'profit', 'capital', 'reputationScore'],
    tone: 'ruling',
    render: (d, title) =>
      `${str(d.personaId)} settles ${title(d.taskId)} ${str(d.outcome)} — ` +
      `${num(d.profit) >= 0 ? 'a profit' : 'a loss'} of ${Math.abs(num(d.profit)).toFixed(2)} on a price of ` +
      `${num(d.price).toFixed(2)} against ${num(d.resourceCost).toFixed(2)} consumed. Capital now ` +
      `${num(d.capital).toFixed(2)}, reputation ${num(d.reputationScore).toFixed(2)}.`,
  },
  outcome_recorded: {
    fields: ['taskId', 'outcome', 'testRan', 'testPassed'],
    tone: 'routine',
    render: (d, title) =>
      `The record on ${title(d.taskId)} closes ${str(d.outcome)}` +
      (d.testRan ? ` on evidence that ${d.testPassed ? 'held' : 'failed'}.` : ', untested.'),
  },
  bankruptcy: {
    fields: ['personaId', 'capital', 'liabilities', 'grounds', 'consequences'],
    tone: 'alarm',
    render: (d) =>
      `${str(d.personaId)} is insolvent at ${num(d.capital).toFixed(2)} against ` +
      `${num(d.liabilities).toFixed(2)} owed (${series(d.grounds)}). Its contracts move on — the point is ` +
      `not to punish the firm but to free what is trapped in it.`,
  },
  collusion_watch: {
    fields: ['recentWinners', 'note'],
    tone: 'contest',
    render: (d) => `Concentration watch — recent awards to ${series(d.recentWinners)}. ${str(d.note)}`,
  },
  task_decided: {
    fields: ['taskId', 'outcome'],
    tone: 'ruling',
    render: (d, title) => {
      const outcome = str(d.outcome);
      if (outcome === 'approved') return `${title(d.taskId)} is accepted and the contract performed.`;
      if (outcome === 'rejected') return `${title(d.taskId)} is rejected. The contract fails and escrow is withheld.`;
      return `${title(d.taskId)} is escalated to the principal.`;
    },
  },
  approval_opened: {
    fields: ['kind', 'description', 'taskId'],
    tone: 'contest',
    render: (d) => `Escalated to the principal — ${str(d.kind).replace(/_/g, ' ')}: ${str(d.description)}`,
  },
};

export const TEMPLATES: Record<StrategyId, Record<string, Template>> = {
  democratic: { ...DEMOCRATIC, ...DOCTRINE_ACCEPTANCE.democratic },
  socialist: { ...SOCIALIST, ...DOCTRINE_ACCEPTANCE.socialist },
  capitalist: { ...CAPITALIST, ...DOCTRINE_ACCEPTANCE.capitalist },
  // The noop strategy exists to exercise the engine without a governance model, so it simply
  // borrows the neutral register.
  noop: {},
  // Scaffolding placeholder pending the managerial/single-agent strategy classes (benchmark-
  // methodology plan, phase 3) — replaced or intentionally kept neutral once those land.
  managerial: {},
  single_agent: {},
};

export function templateFor(strategy: StrategyId, type: string): Template | undefined {
  return TEMPLATES[strategy]?.[type] ?? COMMON[type];
}

/** Exposed for the coverage test: every type any template speaks to. */
export function knownTypes(): string[] {
  const types = new Set<string>(Object.keys(COMMON));
  for (const map of Object.values(TEMPLATES)) for (const type of Object.keys(map)) types.add(type);
  return [...types].sort();
}

export const COMMON_TEMPLATES = COMMON;
export const SILENT_TYPES = SILENT;

const defaultResolver: TitleResolver = (taskId) => str(taskId) || 'an unnamed matter';

/**
 * Renders one ledger entry as a ticker line, or null when the entry is deliberately unnarrated.
 *
 * Pure: no I/O, no clock, no state. Whatever it is handed, it returns a line or null — it must
 * never throw into the render path of a live page.
 */
export function narrate(
  strategy: StrategyId,
  entry: LedgerEntry,
  resolveTitle: TitleResolver = defaultResolver,
): TickerLine | null {
  if (SILENT.has(entry.type)) return null;

  const data = entry.data ?? {};
  const template = templateFor(strategy, entry.type);
  const taskId = typeof data.taskId === 'string' ? data.taskId : undefined;
  const actor =
    typeof data.personaId === 'string'
      ? data.personaId
      : typeof data.assigneeId === 'string'
        ? data.assigneeId
        : typeof data.role === 'string'
          ? data.role
          : undefined;

  if (!template) {
    // An unmapped event degrades to a plain statement rather than vanishing from the record.
    // Silence would be the worse failure: the ticker sits beside an audit log.
    return { text: `${entry.type.replace(/_/g, ' ')} recorded.`, tone: 'routine', taskId, actor };
  }

  try {
    return { text: template.render(data, resolveTitle), tone: template.tone, taskId, actor };
  } catch {
    return { text: `${entry.type.replace(/_/g, ' ')} recorded.`, tone: 'routine', taskId, actor };
  }
}

/** Builds a title resolver from a run's task graph, falling back to the raw id. */
export function titleResolverFor(graph: { nodes: Record<string, { title?: string }> } | null | undefined): TitleResolver {
  return (taskId) => {
    const id = str(taskId);
    if (!id) return 'an unnamed matter';
    // Events recorded before plan_created have no graph to resolve against.
    const title = graph?.nodes?.[id]?.title;
    return title ? title : id;
  };
}
