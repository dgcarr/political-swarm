// Section 12 of docs/philosophy/democratic_coder_westminster_ai_code_swarm.md — the minimal
// democratic swarm constitution — as checked data rather than prose.
//
// The point of writing the articles down here is that several of them are enforceable by
// inspection, and an article nobody can check is decoration. Each entry names the mechanism that
// actually holds it up, and the predicates below are the ones the Speaker, the Ceremonial Head and
// the constitutional gate call. Where an article is upheld somewhere else in the system (the
// engine's test-integrity floor, the human's sovereignty over the run) the entry says so plainly
// instead of pretending this module enforces it.
//
// Nothing in this file makes a model call. The doctrine's own §5 puts constitutional judgment on
// "reproducible evidence, not voting", and that rules out an LLM here as much as it rules out a
// division.


import type { AgentRight, Article, EnforcementSite } from '../../constitution/articles.js';

export type { AgentRight, Article, EnforcementSite };

export const ARTICLES: readonly Article[] = [
  {
    id: 'article-1',
    title: 'Purpose',
    text:
      'The swarm exists to produce correct, secure, maintainable and useful software in accordance ' +
      'with explicit human objectives.',
    enforcedBy: 'engine',
    mechanism: 'The user acceptance criteria are the run\'s objective; engine/delivery.ts refuses a criterion without evidence.',
  },
  {
    id: 'article-2',
    title: 'Source of authority',
    text:
      'All agent authority derives from the project charter, approved mandates and repository ' +
      'evidence. No agent possesses inherent ownership of the system.',
    enforcedBy: 'strategy',
    mechanism: 'Every office is held for a term and reselected — strategies/democratic/offices.ts.',
  },
  {
    id: 'article-3',
    title: 'Rule of law',
    text: 'All agents, including the executive, are bound by the same versioned policies, safety rules and audit requirements.',
    enforcedBy: 'engine',
    mechanism: 'config/checks.yaml commands are engine-owned and never taken from model output.',
  },
  {
    id: 'article-4',
    title: 'Responsible executive',
    text: 'The executive coordinates implementation only while it retains the confidence of the Code Commons.',
    enforcedBy: 'strategy',
    mechanism: 'The confidence motion in strategies/democratic/cabinet.ts.',
  },
  {
    id: 'article-5',
    title: 'Opposition',
    text:
      'A recognised opposition must have access to the evidence needed to challenge executive claims ' +
      'and propose an alternative programme.',
    enforcedBy: 'strategy',
    mechanism: 'The Opposition receives the actual diff and check results — strategies/democratic/opposition.ts.',
  },
  {
    id: 'article-6',
    title: 'Separation of functions',
    text:
      'No consequential change may be proposed, implemented, approved and adjudicated solely by the ' +
      'same agent or tightly coupled agent group.',
    enforcedBy: 'constitution',
    mechanism: 'separationOfFunctionsBreaches() below, plus engine/delivery.ts\'s verifier-is-not-integrator rule.',
  },
  {
    id: 'article-7',
    title: 'Evidence',
    text: 'Technical decisions must be justified by inspectable evidence appropriate to their risk.',
    enforcedBy: 'engine',
    mechanism: 'Evidence status is resolved from the checks that actually ran, never from an agent\'s report.',
  },
  {
    id: 'article-8',
    title: 'Minority reports',
    text: 'Material dissent must be preserved with the final decision.',
    enforcedBy: 'constitution',
    mechanism: 'droppedMinorityReports() below; the Speaker re-marks anything the disposition step downgraded.',
  },
  {
    id: 'article-9',
    title: 'Rotation and recall',
    text: 'Governance offices are temporary and subject to recall, review and periodic reselection.',
    enforcedBy: 'strategy',
    mechanism: 'rotateOffices() and recallRepresentative() in strategies/democratic/offices.ts.',
  },
  {
    id: 'article-10',
    title: 'Constitutional constraints',
    text:
      'Security, safety, privacy, licensing and human-control requirements cannot be overridden by an ' +
      'ordinary majority.',
    enforcedBy: 'constitution',
    mechanism: 'isNonWaivableGround() below; the gate refuses assent while such a finding is open.',
  },
  {
    id: 'article-11',
    title: 'Transparency',
    text:
      'Plans, votes, amendments, implementation records, test results and unresolved risks must be recorded.',
    enforcedBy: 'engine',
    mechanism: 'The append-only ledger (engine/Ledger.ts) and the delivery packet.',
  },
  {
    id: 'article-12',
    title: 'Human sovereignty',
    text:
      'Human project owners retain final constitutional authority and may halt, amend or dissolve the swarm.',
    enforcedBy: 'human',
    mechanism: 'swarm_stop, swarm_decide and Claude\'s independent check of the delivery packet.',
  },
];

/**
 * Section 6's protected procedural rights. Kept as data for the same reason the articles are: the
 * ones with a mechanism are checked, and the ones without say so.
 */
export const AGENT_RIGHTS: readonly AgentRight[] = [
  { id: 'evidence-access', text: 'Access to relevant evidence.', mechanism: 'Every reviewing office receives the diff and check summary.' },
  { id: 'record-dissent', text: 'The right to record dissent.', mechanism: 'A non-approve verdict on a carried motion becomes a minority finding.' },
  { id: 'propose-amendments', text: 'The right to propose amendments.', mechanism: 'Committee and Opposition findings return to the executive.' },
  { id: 'challenge-executive', text: 'The right to challenge an executive claim.', mechanism: 'The Opposition brief, answered by the government reply.' },
  { id: 'abstain', text: 'The right to abstain when context is inadequate.', mechanism: 'An "abstain" verdict is excluded from the division denominator.' },
  { id: 'no-retaliation', text: 'Protection from retaliation for accurate criticism.', mechanism: 'Findings are addressed by disposition, never deleted.' },
  { id: 'equal-treatment', text: 'Equal procedural treatment.', mechanism: 'The Speaker applies the same admissibility screen to every motion.' },
  { id: 'appeal', text: 'Access to appeal.', mechanism: 'A defeated motion may appeal once to the House of Review.' },
  { id: 'notice', text: 'Notice before mandate termination.', mechanism: 'Recall and resignation are recorded before the office changes hands.' },
  { id: 'minority-preserved', text: 'Preservation of minority reports.', mechanism: 'Article 8; the Speaker\'s retention check.' },
  { id: 'conflict-disclosure', text: 'Disclosure of conflicts of interest.', mechanism: 'separationOfFunctionsBreaches(), recorded as conflict_declared.' },
];

/**
 * The office holders Article 6 constrains. Deliberately a plain shape rather than the full
 * OfficeRegister, so this module stays free of any dependency on how offices are filled.
 */
export interface FunctionHolders {
  /** Proposes the programme. */
  primeCoordinator: string;
  /** Controls procedure. Section 6: "The Speaker should not simultaneously be Prime Coordinator or lead implementer." */
  speaker: string;
  /** Adjudicates. */
  ceremonialHead: string;
  /** Implements. */
  implementers: string[];
  /** Certifies the combined tree. */
  integrator: string;
  /** Independently verifies. */
  verifier: string;
}

export interface SeparationBreach {
  /** The persona holding two functions Article 6 keeps apart. */
  personaId: string;
  /** The conflicting functions, in a stable order so the message is deterministic. */
  offices: string[];
  /** What Article 6 requires be done about it. */
  remedy: string;
}

/**
 * Article 6, checked. Returns every persona holding two functions that must stay apart, in a
 * deterministic order.
 *
 * The pairs are not arbitrary. §6 forbids the Speaker being Prime Coordinator or lead implementer
 * outright. The rest follow from "proposed, implemented, approved and adjudicated" being four
 * distinct hands: the agent that wrote the code cannot be the one that certifies it, and the
 * integrator cannot be its own verifier — which engine/delivery.ts also refuses structurally, so
 * this catches it a stage earlier, while the offices can still be reassigned.
 */
export function separationOfFunctionsBreaches(holders: FunctionHolders): SeparationBreach[] {
  const pairs: Array<[string, string, string, string]> = [
    ['speaker', holders.speaker, 'prime-coordinator', holders.primeCoordinator],
    ['speaker', holders.speaker, 'integrator', holders.integrator],
    ['speaker', holders.speaker, 'verifier', holders.verifier],
    ['ceremonial-head', holders.ceremonialHead, 'prime-coordinator', holders.primeCoordinator],
    ['ceremonial-head', holders.ceremonialHead, 'speaker', holders.speaker],
    ['integrator', holders.integrator, 'verifier', holders.verifier],
    ['prime-coordinator', holders.primeCoordinator, 'verifier', holders.verifier],
  ];

  const breaches: SeparationBreach[] = [];
  for (const [officeA, holderA, officeB, holderB] of pairs) {
    if (holderA && holderB && holderA === holderB) {
      breaches.push({
        personaId: holderA,
        offices: [officeA, officeB],
        remedy: `Article 6: "${officeA}" and "${officeB}" may not be held by the same agent. Reassign one.`,
      });
    }
  }

  for (const implementer of holders.implementers) {
    for (const [office, holder] of [
      ['speaker', holders.speaker],
      ['verifier', holders.verifier],
      ['integrator', holders.integrator],
    ] as const) {
      if (holder && implementer === holder) {
        breaches.push({
          personaId: implementer,
          offices: ['implementer', office],
          remedy: `Article 6: an agent may not both implement a change and hold "${office}" over it. Reassign one.`,
        });
      }
    }
  }

  return breaches;
}

/**
 * Article 10's grounds — the constraints an ordinary majority may not override — and article 8's
 * preservation of dissent.
 *
 * Both are stated in near-identical terms by the socialist constitution (articles 12 and 9) and the
 * capitalist charter's safety floor, so the ground table itself lives in strategies/floors.ts. What
 * belongs here is only which article each one answers to under this doctrine. A finding raised on
 * one of these grounds is marked non-waivable, and the engine already refuses to let a doctrine
 * dispose of such a finding as `accepted` without remedying it.
 */
export {
  NON_WAIVABLE_GROUNDS,
  droppedMinorityReports,
  nonWaivableGround,
  type NonWaivableGround,
} from '../floors.js';

/** The charter as a single inspectable string, for the Ceremonial Head's duty to preserve it. */
export function charterDigest(): string {
  return ARTICLES.map((a) => `${a.id}. ${a.title}: ${a.text}`).join('\n');
}
