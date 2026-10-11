import type { LedgerEntry } from '../engine/Ledger.js';
import type { RunState } from '../engine/RunStore.js';
import type { StrategyId } from '../engine/types.js';
import { formattedMoney as money, normalizedNumber as num, pluralizedCount as plural } from './prose.js';

/**
 * The closing statement a run makes about itself, in the rhetoric of its own governance model.
 *
 * Every figure in the prose comes from `RunRecord`, which is derived only from `state.json` and
 * the ledger. DoctrinalStatement.test.ts extracts every number from the rendered text and
 * asserts it appears in the record — the statement is rhetoric, but it may not invent a
 * statistic. A closing speech that overstates the run would be worse than none.
 */

export type Outcome = 'completed' | 'incomplete' | 'failed' | 'stopped';

export interface RunRecord {
  strategy: StrategyId;
  outcome: Outcome;
  goal: string;

  tasksTotal: number;
  approved: number;
  rejected: number;
  unresolved: number;

  verificationsRun: number;
  verificationsPassed: number;

  workerCalls: number;
  costUsd: number;
  budgetUsd: number;
  durationMin: number;

  approvalsOpened: number;
  errors: number;

  // Democratic
  divisions: number;
  committeeInquiries: number;
  confidenceVotes: number;
  speakerRulings: number;
  motionsStruck: number;
  minorityReports: number;
  reservePowers: number;

  // Socialist
  guilds: number;
  peerReviews: number;
  plannerRecalls: number;
  capabilityGains: number;
  councils: number;
  reconnaissanceReports: number;
  planChallenges: number;
  assignmentsReturned: number;
  aidSupplied: number;
  delegateRecalls: number;

  // Capitalist
  bidsReceived: number;
  listingsAwarded: number;
  listingsUnfilled: number;
  escrowsReleased: number;
  bankruptcies: number;
  leviesCollected: number;
  bailoutsGranted: number;
  bailoutsRefused: number;
}

export interface DoctrinalStatement {
  title: string;
  /** Body paragraphs, in order. */
  paragraphs: string[];
  /** The single line the ticker announces when the run ends. */
  closing: string;
}

/** Subject-verb agreement for a counted subject: "1 division was held", "3 divisions were held". */
const were = (n: number): string => (n === 1 ? 'was' : 'were');
const pct = (part: number, whole: number): number => (whole === 0 ? 0 : Math.round((part / whole) * 100));
const MILLISECONDS_PER_MINUTE = 60_000;

export function outcomeOf(status: RunState['status']): Outcome {
  if (status === 'completed') return 'completed';
  if (status === 'stopped') return 'stopped';
  // Kept distinct from 'failed' deliberately. A run that reached no acceptable delivery did not
  // crash — the doctrine, or the evidence, declined to certify it — and section 5 of every
  // philosophy doc forbids reporting that as either success or breakdown.
  if (status === 'terminated_incomplete') return 'incomplete';
  return 'failed';
}

/**
 * Reduces a run to the figures the statements may cite. Nothing else is available to them, which
 * is what makes the no-invented-statistics gate enforceable.
 */
export function aggregate(state: RunState, ledger: LedgerEntry[]): RunRecord {
  const count = (type: string): number => ledger.filter((e) => e.type === type).length;

  const decided = ledger.filter((e) => e.type === 'task_decided');
  const approved = decided.filter((e) => e.data.outcome === 'approved').length;
  const rejected = decided.filter((e) => e.data.outcome === 'rejected').length;

  const verifications = ledger.filter((e) => e.type === 'verification_result' && e.data.ran === true);
  const verificationsPassed = verifications.filter((e) => e.data.passed === true).length;

  const tasksTotal = state.graph ? Object.keys(state.graph.nodes).length : 0;

  const guilds = new Set(
    ledger
      .filter((e) => e.type === 'guild_assigned' && typeof e.data.leadGuild === 'string')
      .map((e) => e.data.leadGuild as string),
  );

  const bidsReceived = ledger
    .filter((e) => e.type === 'bids_received')
    .reduce((sum, e) => sum + (Array.isArray(e.data.bids) ? e.data.bids.length : 0), 0);

  const capabilityGains = ledger.filter((e) => e.type === 'capability_updated' && num(e.data.delta) > 0).length;

  // The last constitution wins: a run that rotated its coordinating council re-forms the register,
  // and counting every event would report the same councils once per term.
  const councils = ledger
    .filter((e) => e.type === 'councils_constituted' && Array.isArray(e.data.councils))
    .map((e) => (e.data.councils as unknown[]).length)
    .at(-1) ?? 0;

  const started = new Date(state.createdAt).getTime();
  const ended = new Date(state.updatedAt).getTime();
  const durationMin = Number.isFinite(started) && Number.isFinite(ended) && ended >= started
    ? Math.round((ended - started) / MILLISECONDS_PER_MINUTE)
    : 0;

  return {
    strategy: state.strategy,
    outcome: outcomeOf(state.status),
    goal: state.task.goal.split('\n')[0],

    tasksTotal,
    approved,
    rejected,
    unresolved: Math.max(0, tasksTotal - approved - rejected),

    verificationsRun: verifications.length,
    verificationsPassed,

    workerCalls: num(state.workerCalls),
    costUsd: num(state.costUsd),
    budgetUsd: num(state.budgetUsd),
    durationMin,

    approvalsOpened: count('approval_opened'),
    errors: count('task_error'),

    divisions: count('vote_computed'),
    committeeInquiries: count('committee_inquiry'),
    confidenceVotes: count('confidence_vote') + count('confidence_motion'),
    speakerRulings: count('speaker_ruling'),
    motionsStruck: ledger.filter((e) => e.type === 'speaker_ruling' && e.data.admissible === false).length,
    minorityReports: (state.findings ?? []).filter((f) => f.minority).length,
    reservePowers: count('reserve_power_exercised'),

    guilds: guilds.size,
    peerReviews: count('peer_review'),
    plannerRecalls: count('planner_recall'),
    capabilityGains,
    councils,
    reconnaissanceReports: ledger.filter(
      (e) => e.type === 'reconnaissance_published' && Array.isArray(e.data.scopes),
    ).length,
    planChallenges: count('plan_challenged'),
    assignmentsReturned: count('assignment_returned'),
    aidSupplied: count('mutual_aid_supplied'),
    delegateRecalls: count('delegate_recalled'),

    bidsReceived,
    listingsAwarded: count('listing_awarded'),
    listingsUnfilled: count('listing_unfilled'),
    escrowsReleased: count('escrow_released'),
    bankruptcies: count('bankruptcy'),
    leviesCollected: count('levy_collected'),
    bailoutsGranted: ledger.filter((e) => e.type === 'bailout_considered' && e.data?.granted === true).length,
    bailoutsRefused: ledger.filter((e) => e.type === 'bailout_considered' && e.data?.granted === false).length,
  };
}

// --------------------------------------------------------------- shared prose

/** The evidence sentence, common to all three: the swarm's own claim about its work. */
function evidence(r: RunRecord): string {
  if (r.verificationsRun === 0) {
    return 'No check was executed during this sitting. Nothing here rests on evidence.';
  }
  return (
    `Of ${plural(r.verificationsRun, 'check')} actually executed, ${r.verificationsPassed} passed ` +
    `— ${pct(r.verificationsPassed, r.verificationsRun)} per cent.`
  );
}

function ledgerLine(r: RunRecord): string {
  return (
    `${plural(r.workerCalls, 'call')} ${were(r.workerCalls)} made to the models, at a cost of ` +
    `${money(r.costUsd)} against a budget of ${money(r.budgetUsd)}, over ${plural(r.durationMin, 'minute')}.`
  );
}

// ------------------------------------------------------------------ democratic

function democratic(r: RunRecord): DoctrinalStatement {
  const tally =
    `${plural(r.tasksTotal, 'motion')} stood on the Order Paper. ${r.approved} ${were(r.approved)} carried, ` +
    `${r.rejected} defeated, ${r.unresolved} left unresolved at the close.`;
  const procedure =
    `${plural(r.divisions, 'division')} ${were(r.divisions)} held and ` +
    `${plural(r.committeeInquiries, 'committee inquiry', 'committee inquiries')} ` +
    `reported. ` +
    (r.approvalsOpened === 0
      ? 'The House was not asked to rule'
      : `The House was asked to rule ${plural(r.approvalsOpened, 'time')}`) +
    (r.confidenceVotes > 0 ? `, and confidence was tested ${plural(r.confidenceVotes, 'time')}.` : '.');

  // What the procedural offices did, said plainly. A statement that mentioned only the divisions it
  // won would be the executive's account of the sitting rather than the House's.
  const chair =
    `The Chair ruled ${plural(r.speakerRulings, 'time')} at first reading` +
    (r.motionsStruck === 0 ? ' and struck nothing from the paper.' : `, striking ${plural(r.motionsStruck, 'motion')}.`);
  const dissent =
    r.minorityReports === 0
      ? 'No member recorded a minority report.'
      : `${plural(r.minorityReports, 'minority report')} ${were(r.minorityReports)} recorded, and ${were(r.minorityReports)} preserved with the decision.`;
  const reserve =
    r.reservePowers === 0 ? '' : ` The constitutional guardian acted ${plural(r.reservePowers, 'time')}.`;

  if (r.outcome === 'completed') {
    return {
      title: 'Statement to the House',
      paragraphs: [
        `Mr Speaker, the business before this House is concluded.`,
        tally,
        `${procedure} ${chair}${reserve}`,
        `${dissent}`,
        evidence(r),
        ledgerLine(r),
        `The work was done in the open and is recorded in the ledger, where any member may ` +
          `examine it. No clause was carried that the House did not see. I commend this ` +
          `programme to the House.`,
      ],
      closing: 'The business of the House is concluded. The programme is commended to the House.',
    };
  }

  if (r.outcome === 'stopped') {
    return {
      title: 'Statement to the House',
      paragraphs: [
        `Mr Speaker, the sitting has been suspended on the instruction of the Chair.`,
        tally,
        `${procedure} ${chair}${reserve}`,
        `${dissent}`,
        evidence(r),
        ledgerLine(r),
        `Business not reached stands adjourned rather than defeated. The record is preserved ` +
          `intact, and the House may resume where it left off.`,
      ],
      closing: 'The sitting stands suspended. Business not reached is adjourned, not defeated.',
    };
  }

  if (r.outcome === 'incomplete') {
    return {
      title: 'Statement to the House',
      paragraphs: [
        `Mr Speaker, this programme is not concluded, and I will not pretend to the House that it is.`,
        tally,
        `${procedure} ${chair}${reserve}`,
        `${dissent}`,
        evidence(r),
        ledgerLine(r),
        `Assent was not granted. What was not carried is not law, and no member should read this ` +
          `record as though it were. The House is owed the truth of an unfinished business rather ` +
          `than the appearance of a finished one.`,
      ],
      closing: 'The programme is not concluded. What was not carried is not law.',
    };
  }

  return {
    title: 'Statement to the House',
    paragraphs: [
      `Mr Speaker, I must report to the House that this programme has failed.`,
      tally,
      `${plural(r.errors, 'motion')} collapsed in error before reaching a division. ${procedure} ${chair}${reserve}`,
      `${dissent}`,
      evidence(r),
      ledgerLine(r),
      `The failure is on the record and will not be amended after the fact. That the House can ` +
        `read the whole of it is the only thing this Government can claim as a success.`,
    ],
    closing: 'The programme has failed. The failure stands on the record, unamended.',
  };
}

// ------------------------------------------------------------------- socialist

function socialist(r: RunRecord): DoctrinalStatement {
  const tally =
    `${plural(r.tasksTotal, 'undertaking')} ${were(r.tasksTotal)} taken up. ${r.approved} passed into the ` +
    `common stock, ${r.rejected} ${were(r.rejected)} returned to the guilds, ${r.unresolved} remain open.`;
  const federation =
    `${plural(r.councils, 'worker council')} formed around the work and ${plural(r.guilds, 'guild')} ` +
    `took part, with ${plural(r.peerReviews, 'peer review')} ${were(r.peerReviews)} conducted — no ` +
    `comrade approved their own work.` +
    (r.plannerRecalls + r.delegateRecalls > 0
      ? ` ${plural(r.plannerRecalls + r.delegateRecalls, 'delegate')} ${were(r.plannerRecalls + r.delegateRecalls)} ` +
        `recalled; no coordinator is irreplaceable.`
      : ' The delegates held the confidence of their councils throughout.');

  const commons =
    (r.reconnaissanceReports > 0
      ? `${plural(r.reconnaissanceReports, 'council')} went out before the plan was written, and ` +
        `${r.planChallenges === 0 ? 'nothing they found went unanswered' : `${plural(r.planChallenges, 'warning')} of theirs ${were(r.planChallenges)} pressed against it`}.`
      : 'The plan was drawn without reconnaissance, which is a shortcut the councils should not need to take.') +
    (r.assignmentsReturned > 0
      ? ` ${plural(r.assignmentsReturned, 'assignment')} ${were(r.assignmentsReturned)} handed back rather than ` +
        `attempted badly — that is information, not insubordination.`
      : '') +
    (r.aidSupplied > 0 ? ` Mutual aid reached a blocked comrade ${plural(r.aidSupplied, 'time')}.` : '');

  const dissent =
    r.minorityReports === 0
      ? 'No comrade dissented from what was decided.'
      : `${plural(r.minorityReports, 'objection')} ${were(r.minorityReports)} overruled and ${were(r.minorityReports)} ` +
        `carried into the record anyway. A decision may go against a comrade without erasing that they made it.`;

  if (r.outcome === 'completed') {
    return {
      title: 'Report to the Council of Producers',
      paragraphs: [
        `Comrades, the work is done and belongs to all of us.`,
        tally,
        federation,
        commons,
        dissent,
        evidence(r),
        ledgerLine(r),
        `${plural(r.capabilityGains, 'record')} of increased capability ${were(r.capabilityGains)} entered against the ` +
          `guilds — skill gained here is held in common, not by the worker who happened to hold ` +
          `the task. Nothing was produced for one owner. The whole record is open to every ` +
          `member of the council.`,
      ],
      closing: 'The work is done and passes into the common stock. It belongs to all of us.',
    };
  }

  if (r.outcome === 'stopped') {
    return {
      title: 'Report to the Council of Producers',
      paragraphs: [
        `Comrades, the council has halted this work by its own decision.`,
        tally,
        federation,
        commons,
        dissent,
        evidence(r),
        ledgerLine(r),
        `What was completed remains in the common stock and is not withdrawn. The tools are laid ` +
          `down, not broken, and the work may be resumed by whichever guild takes it up.`,
      ],
      closing: 'The council has halted the work. What was finished remains held in common.',
    };
  }

  if (r.outcome === 'incomplete') {
    return {
      title: 'Report to the Council of Producers',
      paragraphs: [
        `Comrades, this work is not finished, and the council will not record it as though it were.`,
        tally,
        federation,
        commons,
        dissent,
        evidence(r),
        ledgerLine(r),
        `Correctness cannot be voted into existence, and it will not be asserted into existence ` +
          `here either. The evidence did not carry, so the undertaking returns to the commons ` +
          `unfinished — with everything learned in the attempt left where the next comrade can use it.`,
      ],
      closing: 'The work is unfinished and is recorded as unfinished. Evidence decides, not assertion.',
    };
  }

  return {
    title: 'Report to the Council of Producers',
    paragraphs: [
      `Comrades, this work has failed, and the council is owed an honest account of it.`,
      tally,
      `${plural(r.errors, 'undertaking')} broke down entirely. ${federation}`,
      commons,
      dissent,
      evidence(r),
      ledgerLine(r),
      `No individual is to be blamed for a failure the collective organised. What was learned ` +
        `is entered in the shared record so that the next council does not repeat it — that much ` +
        `is not wasted.`,
    ],
    closing: 'The work has failed. What was learned is entered in the common record.',
  };
}

// ------------------------------------------------------------------ capitalist

/**
 * What the treasury did, told straight.
 *
 * This used to be the flat assertion "No one was bailed out", which was true only because the
 * doctrine's treasury did not exist yet. It does now, and it can rescue a firm whose failure would
 * stop the run — so the statement has to be able to say so. A closing statement that claimed nobody
 * was rescued on a run that rescued somebody would be the one thing a market report may never be.
 */
function bailoutLine(r: RunRecord): string {
  if (r.bailoutsGranted > 0) {
    return (
      `${plural(r.bailoutsGranted, 'firm')} ${were(r.bailoutsGranted)} rescued from the public fund, in part and ` +
      `not in full, and ${plural(r.bailoutsRefused, 'further request')} ${were(r.bailoutsRefused)} refused. ` +
      `A rescue is an event here, never a facility. `
    );
  }
  if (r.bailoutsRefused > 0) {
    return `${plural(r.bailoutsRefused, 'request')} for rescue ${were(r.bailoutsRefused)} refused. No one was bailed out. `;
  }
  return 'No one was bailed out. ';
}

function capitalist(r: RunRecord): DoctrinalStatement {
  const tally =
    `${plural(r.tasksTotal, 'contract')} ${were(r.tasksTotal)} brought to market. ` +
    `${r.approved} ${were(r.approved)} performed, ${r.rejected} failed, ${r.unresolved} remain unsettled.`;
  const market =
    `${plural(r.bidsReceived, 'bid')} ${were(r.bidsReceived)} tendered across ` +
    `${plural(r.listingsAwarded, 'award')}. ` +
    (r.listingsUnfilled > 0
      ? `${plural(r.listingsUnfilled, 'listing')} cleared no bid at any price.`
      : 'Every listing cleared.') +
    (r.escrowsReleased === 0
      ? ' No escrow was released.'
      : ` Escrow was released ${plural(r.escrowsReleased, 'time')}.`);

  if (r.outcome === 'completed') {
    return {
      title: 'Statement to Shareholders',
      paragraphs: [
        `The market has cleared and the position is closed.`,
        tally,
        market,
        evidence(r),
        ledgerLine(r),
        (r.bankruptcies > 0
          ? `${plural(r.bankruptcies, 'participant')} ${were(r.bankruptcies)} declared insolvent and left the market. `
          : 'No participant was declared insolvent. ') +
          bailoutLine(r) +
          `Payment followed delivery and nothing else. No central planner directed this outcome. Prices did.`,
      ],
      closing: 'The market has cleared. No central planner directed this outcome — prices did.',
    };
  }

  if (r.outcome === 'stopped') {
    return {
      title: 'Statement to Shareholders',
      paragraphs: [
        `Trading has been halted by the principal.`,
        tally,
        market,
        evidence(r),
        ledgerLine(r),
        `Settled contracts stand. Unsettled positions are closed out at cost rather than carried, ` +
          `and no obligation survives the halt. The book is closed where it stood.`,
      ],
      closing: 'Trading is halted. Settled contracts stand; the book is closed where it stood.',
    };
  }

  if (r.outcome === 'incomplete') {
    return {
      title: 'Statement to Shareholders',
      paragraphs: [
        `The delivery did not meet its acceptance terms, and escrow is withheld.`,
        tally,
        market,
        evidence(r),
        ledgerLine(r),
        `An unearned release would be a subsidy, and this market does not pay for outcomes it did ` +
          `not get. The obligation stands with the supplier; the account stays open and honest ` +
          `rather than closed and flattering.`,
      ],
      closing: 'Acceptance terms were not met. Escrow is withheld and the account stays open.',
    };
  }

  return {
    title: 'Statement to Shareholders',
    paragraphs: [
      `The market has failed to deliver and shareholders are entitled to know why.`,
      tally,
      `${plural(r.errors, 'contract')} collapsed outright. ${market}`,
      evidence(r),
      ledgerLine(r),
      (r.bankruptcies > 0
        ? `${plural(r.bankruptcies, 'participant')} ${were(r.bankruptcies)} wiped out. `
        : 'No participant was wiped out. ') +
        bailoutLine(r) +
        `Capital was consumed and nothing was delivered against it. The loss is disclosed in full, ` +
        `because a market that conceals its losses cannot price anything.`,
    ],
    closing: 'The market has failed. Capital was consumed and the loss is disclosed in full.',
  };
}

const WRITERS: Record<StrategyId, (r: RunRecord) => DoctrinalStatement> = {
  democratic,
  socialist,
  capitalist,
  // No governance model is in force, so there is no doctrine to speak in — but the run still
  // deserves an honest accounting.
  noop: (r) => ({
    title: 'Run summary',
    paragraphs: [
      `${plural(r.tasksTotal, 'task')} were attempted. ${r.approved} approved, ${r.rejected} rejected, ${r.unresolved} unresolved.`,
      evidence(r),
      ledgerLine(r),
    ],
    closing: 'The run is finished.',
  }),
  // Scaffolding placeholder pending the managerial/single-agent strategy classes (benchmark-
  // methodology plan, phase 3) — borrows the same neutral register as noop until each gets its
  // own doctrinal voice, if one is warranted for a non-political control condition.
  managerial: (r) => ({
    title: 'Run summary',
    paragraphs: [
      `${plural(r.tasksTotal, 'task')} were attempted. ${r.approved} approved, ${r.rejected} rejected, ${r.unresolved} unresolved.`,
      evidence(r),
      ledgerLine(r),
    ],
    closing: 'The run is finished.',
  }),
  single_agent: (r) => ({
    title: 'Run summary',
    paragraphs: [
      `${plural(r.tasksTotal, 'task')} were attempted. ${r.approved} approved, ${r.rejected} rejected, ${r.unresolved} unresolved.`,
      evidence(r),
      ledgerLine(r),
    ],
    closing: 'The run is finished.',
  }),
};

/**
 * Every numeric string a statement about this run is permitted to contain.
 *
 * Used both by the test that guards the deterministic templates and, at runtime, to check
 * anything an LLM writes before it is shown. One definition, so the two cannot drift.
 *
 * Note the scope of the guarantee: this is one allowlist for the whole record, not a per-field
 * check. It catches a figure that was invented outright — the thing that would actually mislead
 * a reader of an audit log — but it cannot catch a real figure attached to the wrong claim, so
 * "3 divisions were held" passes on a run with 3 tasks and no divisions. Tightening that would
 * mean tying each number to the sentence it appears in; the templates are fixed and the model is
 * re-voicing a draft, so the looser check is the proportionate one. It should not be read as
 * more than it is.
 */
export function traceableNumbers(r: RunRecord): Set<string> {
  const allowed = new Set<string>();
  for (const value of Object.values(r)) {
    if (typeof value !== 'number') continue;
    allowed.add(String(value));
    allowed.add(value.toFixed(4));
    allowed.add(value.toFixed(2));
  }
  allowed.add(String(pct(r.verificationsPassed, r.verificationsRun)));
  return allowed;
}

/** Figures in `text` that do not appear in the run record. Empty means the prose is honest. */
export function untraceableFigures(text: string, r: RunRecord): string[] {
  const allowed = traceableNumbers(r);
  return (text.match(/\d+(?:\.\d+)?/g) ?? []).filter((n) => !allowed.has(n));
}

export function buildStatement(state: RunState, ledger: LedgerEntry[]): DoctrinalStatement {
  return statementFor(aggregate(state, ledger));
}

export function statementFor(record: RunRecord): DoctrinalStatement {
  return (WRITERS[record.strategy] ?? WRITERS.noop)(record);
}
