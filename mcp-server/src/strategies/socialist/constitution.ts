// Section 12 of docs/philosophy/early_socialist_philosophy_for_ai_code_swarm.md — the minimal
// socialist swarm constitution — as checked data rather than prose.
//
// Several of these articles are enforceable by inspection, and an article nobody can check is
// decoration. Each entry names the mechanism that actually holds it up, and the predicates below
// are the ones the councils, the recovery path and the assembly's acceptance gate call. Where an
// article is upheld somewhere else (the engine's test-integrity floor, the human's sovereignty over
// the run) the entry says so plainly rather than pretending this module enforces it.
//
// Nothing here makes a model call. Section 9 is explicit that "correctness is a common obligation
// and cannot be voted into existence" and that "evidence overrides rank, majority preference,
// eloquence and schedule pressure" — which rules out an LLM adjudicating the constitution as firmly
// as it rules out a show of hands.

import type { Article, EnforcementSite } from '../../constitution/articles.js';

export type { Article, EnforcementSite };

export const ARTICLES: readonly Article[] = [
  {
    id: 'article-1',
    title: 'Purpose',
    text: 'The swarm exists to satisfy the user\'s stated task by producing correct, maintainable and verifiable software.',
    enforcedBy: 'engine',
    mechanism: 'The user acceptance criteria are the run\'s objective; engine/delivery.ts refuses a criterion without evidence.',
  },
  {
    id: 'article-2',
    title: 'Common ownership',
    text:
      'The repository, tools, task records and work-produced knowledge form a commons available to ' +
      'the whole swarm subject only to necessary safety controls.',
    enforcedBy: 'constitution',
    mechanism: 'unpublishedKnowledge() — a failure that taught the swarm something and was not written back is privatised knowledge.',
  },
  {
    id: 'article-3',
    title: 'Worker self-management',
    text:
      'Workers participate in planning and governing their work and retain discretion over ' +
      'implementation within agreed interfaces and constraints.',
    enforcedBy: 'strategy',
    mechanism: 'Collective reconnaissance feeds the plan, and a worker may return an assignment — strategies/socialist/allocation.ts.',
  },
  {
    id: 'article-4',
    title: 'Allocation',
    text:
      'Work is allocated according to capability and capacity; resources and mutual aid are ' +
      'allocated according to demonstrated need, difficulty and risk.',
    enforcedBy: 'strategy',
    mechanism: 'The needs assessment sets each node\'s share of context and aid — strategies/socialist/allocation.ts.',
  },
  {
    id: 'article-5',
    title: 'Delegation',
    text:
      'Coordination authority is explicit, narrow, temporary, transparent and recallable. It conveys ' +
      'no ownership or permanent status.',
    enforcedBy: 'constitution',
    mechanism: 'mandateBreaches() bounds what the coordinating council may decide; its term and recall live in coordinating.ts.',
  },
  {
    id: 'article-6',
    title: 'Federation',
    text: 'Decisions remain with the smallest affected council unless cross-council dependencies require collective coordination.',
    enforcedBy: 'constitution',
    mechanism: 'mandateBreaches() rejects a coordinating decision on a matter one council could settle alone.',
  },
  {
    id: 'article-7',
    title: 'Knowledge',
    text: 'Findings, decisions, evidence, reusable artefacts and failure lessons must be published to the shared commons.',
    enforcedBy: 'constitution',
    mechanism: 'unpublishedKnowledge(), against the run\'s KnowledgeStore writes.',
  },
  {
    id: 'article-8',
    title: 'Verification',
    text:
      'Consequential work requires review independent of its authorship, and correctness is ' +
      'determined by relevant reproducible evidence.',
    enforcedBy: 'constitution',
    mechanism: 'selfApprovalBreaches(); the engine separately refuses a manifest whose verifier performed the integration.',
  },
  {
    id: 'article-9',
    title: 'Right to challenge',
    text: 'Councils and workers may challenge plans, evidence and coordinators without retaliation; minority reports remain visible.',
    enforcedBy: 'constitution',
    mechanism: 'droppedMinorityReports(), re-marking any dissent the disposition step converted into consensus.',
  },
  {
    id: 'article-10',
    title: 'Rotation and recall',
    text: 'Coordinating and review offices rotate, remain recallable and may not monopolise information, tools or merge authority.',
    enforcedBy: 'constitution',
    mechanism: 'monopolyBreaches(); rotation and recall cadence in coordinating.ts and councils.ts.',
  },
  {
    id: 'article-11',
    title: 'Recovery',
    text: 'Failure is disclosed, contained, analysed and converted into shared learning; blame may not substitute for diagnosis and repair.',
    enforcedBy: 'constitution',
    mechanism: 'blameWithoutDiagnosis() — a reassignment recorded with no cause is blame standing in for diagnosis.',
  },
  {
    id: 'article-12',
    title: 'Human sovereignty',
    text:
      'Claude and the swarm remain bound by the user\'s lawful instructions, declared acceptance ' +
      'criteria and required human approval boundaries.',
    enforcedBy: 'human',
    mechanism: 'ctx.openApproval() gates; no council decision can substitute for a human one.',
  },
];

export function articleById(id: string): Article | undefined {
  return ARTICLES.find((a) => a.id === id);
}

/** The charter as a single inspectable string. Article 2: the rules are part of the commons too. */
export function charterDigest(): string {
  return ARTICLES.map((a) => `${a.id}. ${a.title}: ${a.text}`).join('\n');
}

// ------------------------------------------------------- articles 12 and 9

/**
 * Article 12's floor and article 9's preservation of dissent.
 *
 * Both are stated in near-identical terms by the Westminster charter (articles 10 and 8), so the
 * ground table itself lives in strategies/floors.ts. What belongs here is only which article each
 * one answers to under this doctrine.
 */
export {
  NON_WAIVABLE_GROUNDS,
  droppedMinorityReports,
  markNonWaivableFindings,
  nonWaivableGround,
  type NonWaivableGround,
} from '../floors.js';

// -------------------------------------------------------- articles 5 and 6

/**
 * What the coordinating council is allowed to decide at all.
 *
 * Section 8: "The coordinating council owns ordering, not technical truth." Section 6: it
 * "identifies dependencies, interfaces and integration order" and "allocates scarce resources",
 * and "returns decisions to worker councils when they do not require federation-wide action."
 * Anything outside this list belongs to the affected council, and taking it is exactly the
 * bureaucratic capture section 14 warns about.
 */
export const COORDINATING_MANDATE = ['ordering', 'interface', 'scarce-resource'] as const;
export type MandateSubject = (typeof COORDINATING_MANDATE)[number];

export interface CoordinatingDecision {
  taskId: string;
  subject: string;
  /** How many councils the matter actually touches. One council means it was never federal. */
  councilsAffected: number;
  decidedBy: string;
}

export interface MandateBreach {
  body: string;
  taskId: string;
  decision: string;
  article: string;
  remedy: string;
}

export function mandateBreaches(decisions: readonly CoordinatingDecision[]): MandateBreach[] {
  const allowed = new Set<string>(COORDINATING_MANDATE);
  const breaches: MandateBreach[] = [];

  for (const decision of decisions) {
    if (!allowed.has(decision.subject)) {
      breaches.push({
        body: decision.decidedBy,
        taskId: decision.taskId,
        decision: decision.subject,
        article: 'article-5',
        remedy:
          `Article 5: coordination authority is narrow. "${decision.subject}" is technical truth, not ordering — ` +
          'return it to the affected council.',
      });
      continue;
    }
    if (decision.councilsAffected <= 1) {
      breaches.push({
        body: decision.decidedBy,
        taskId: decision.taskId,
        decision: decision.subject,
        article: 'article-6',
        remedy:
          'Article 6: the matter touches one council, which could settle it alone. Federation-wide action was not required.',
      });
    }
  }
  return breaches;
}

// ------------------------------------------------------------------ article 8

export interface ApprovalRecord {
  taskId: string;
  implementerId: string;
  reviewerId: string;
  /** The coordinating-council persona that allocated this node, where it was escalated. */
  allocatedBy?: string;
}

export interface SelfApprovalBreach {
  personaId: string;
  taskId: string;
  roles: [string, string];
  remedy: string;
}

/**
 * Article 8, checked: "an author cannot be the sole approver of their own work" (section 9, rule 6).
 *
 * Three ways the authorship chain can close on itself. The third is the one section 6 states
 * separately about coordinators — they "cannot approve their own consequential decisions" — which
 * here means a delegate that allocated a node to itself and then reviewed it.
 */
export function selfApprovalBreaches(
  records: readonly ApprovalRecord[],
  integratorId?: string,
  verifierId?: string,
): SelfApprovalBreach[] {
  const breaches: SelfApprovalBreach[] = [];

  for (const record of records) {
    if (record.implementerId && record.implementerId === record.reviewerId) {
      breaches.push({
        personaId: record.implementerId,
        taskId: record.taskId,
        roles: ['implementer', 'reviewer'],
        remedy: 'Article 8: review must be independent of authorship. Draw the reviewer from outside the authorship chain.',
      });
    }
    if (record.allocatedBy && record.allocatedBy === record.reviewerId) {
      breaches.push({
        personaId: record.allocatedBy,
        taskId: record.taskId,
        roles: ['coordinator', 'reviewer'],
        remedy: 'Section 6: coordinators cannot approve their own consequential decisions. Draw the reviewer from the council.',
      });
    }
  }

  if (integratorId && verifierId && integratorId === verifierId) {
    breaches.push({
      personaId: integratorId,
      taskId: '(delivery)',
      roles: ['integrator', 'verifier'],
      remedy: 'Article 8: final verification belongs to a peer outside the chain that produced the integration.',
    });
  }
  return breaches;
}

// ----------------------------------------------------------------- article 10

export interface CoordinationRegister {
  convener: string;
  /** council id -> delegate persona id. */
  delegates: Record<string, string>;
  integratorId?: string;
  verifierId?: string;
}

export interface MonopolyBreach {
  personaId: string;
  holdings: string[];
  remedy: string;
}

/**
 * Article 10: coordinating and review offices "may not monopolise information, tools or merge
 * authority". Section 14 names the failure this prevents — bureaucratic capture — and lists
 * "separation from final verification" among its safeguards.
 *
 * Only the pairs that genuinely concentrate authority block here. A delegate holding several seats
 * is reported separately by delegateConcentration(), because on a short plan that is arithmetic
 * rather than capture and is not worth refusing a sound delivery over.
 */
export function monopolyBreaches(register: CoordinationRegister): MonopolyBreach[] {
  const breaches: MonopolyBreach[] = [];
  const pairs: Array<[string, string | undefined, string, string | undefined]> = [
    ['convener', register.convener, 'integrator', register.integratorId],
    ['convener', register.convener, 'verifier', register.verifierId],
    ['integrator', register.integratorId, 'verifier', register.verifierId],
  ];

  for (const [roleA, holderA, roleB, holderB] of pairs) {
    if (holderA && holderB && holderA === holderB) {
      breaches.push({
        personaId: holderA,
        holdings: [roleA, roleB],
        remedy: `Article 10: "${roleA}" and "${roleB}" together concentrate merge or verification authority. Rotate one.`,
      });
    }
  }

  return breaches;
}

/**
 * One persona speaking for a majority of the councils.
 *
 * Reported, never blocking, and the distinction matters. Two work units in the same discipline
 * legitimately draw their delegates from the same small membership, so on a short plan the same
 * agent holding both seats is arithmetic rather than capture — refusing the delivery over it would
 * fail a sound run for the shape of its plan. Article 10's own remedies are rotation and recall,
 * neither of which is "throw the work away", so this goes to the commons report where a reader can
 * see the concentration and the next term can redraw.
 */
export function delegateConcentration(delegates: Record<string, string>): MonopolyBreach[] {
  const councils = Object.keys(delegates);
  if (councils.length <= 1) return [];

  const seats = new Map<string, string[]>();
  for (const [council, persona] of Object.entries(delegates)) {
    seats.set(persona, [...(seats.get(persona) ?? []), council]);
  }

  const concentrated: MonopolyBreach[] = [];
  for (const [persona, held] of seats) {
    if (held.length * 2 > councils.length) {
      concentrated.push({
        personaId: persona,
        holdings: held.map((c) => `delegate:${c}`),
        remedy: `Article 10: ${persona} speaks for ${held.length} of ${councils.length} councils. Redraw the seats next term.`,
      });
    }
  }
  return concentrated;
}

// ----------------------------------------------------------------- article 11

export interface Reassignment {
  taskId: string;
  from: string;
  to: string;
  /** The diagnosed cause of the failure that prompted the move. */
  cause?: string;
}

/**
 * Article 11: "blame may not substitute for diagnosis and repair."
 *
 * Read as an inspectable rule: taking work away from a worker is the swarm asserting the worker was
 * the problem. Doing it without a recorded cause is precisely blame standing in for diagnosis, and
 * section 11 requires the swarm to "determine whether the cause was implementation, specification,
 * allocation, integration or infrastructure" before choosing a remedy.
 */
export function blameWithoutDiagnosis(reassignments: readonly Reassignment[]): string[] {
  return reassignments.filter((r) => !r.cause || r.cause.trim().length === 0).map((r) => r.taskId);
}

// ------------------------------------------------------------ articles 2 & 7

export interface CommonsAudit {
  /** Tasks whose work was not approved — every one of them taught the swarm something. */
  failedTaskIds: readonly string[];
  /** Tasks for which a lesson, fixture or finding actually reached the shared store. */
  publishedTaskIds: readonly string[];
}

/**
 * Articles 2 and 7: work-produced knowledge belongs to the commons, and failure lessons "must be
 * published to the shared commons". A failure nobody wrote down is a discovery held privately by
 * whichever agent happened to hit it, which is the one thing common ownership rules out.
 *
 * Reported, not blocking: section 11 is emphatic that failure is disclosed and converted into
 * learning rather than punished, so the remedy for an unpublished lesson is to publish it.
 */
export function unpublishedKnowledge(audit: CommonsAudit): string[] {
  const published = new Set(audit.publishedTaskIds);
  return [...new Set(audit.failedTaskIds)].filter((id) => !published.has(id));
}
