import { fillMissingRationale, isNonEmptyString, isSafeRelativePath, isValidFileOpShape, isValidVerdict } from '../validation.js';
import type { ApprovalRecord, MandateBreach, Reassignment } from './constitution.js';
import type { WorkerCouncil } from './councils.js';
import type { NeedsAssessment } from './allocation.js';
import type { AidPacket } from './mutualAid.js';
import type { CoordinatingCouncil } from './coordinating.js';
import type { SocialistConfig } from '../../constitution/schema.js';

// The `socialist:` section of config/strategies.yaml, as constitution/schema.ts validates it and
// fills its defaults. EngineContext.config is already scoped to this slice, so the strategy casts.
export type { SocialistConfig } from '../../constitution/schema.js';

/** Strategy-private state persisted in ctx.strategyState / RunState.strategyState across the run. */
export interface SocialistState {
  /** Which persona currently plays the 'planner' role — recallable leadership (see recordOutcome). */
  currentPlannerPersonaId: string;
  plannerMandateId?: string;
  /** demonstratedCapability: guild -> personaId -> score in [0,1]. Lazily initialized. */
  capability: Record<string, Record<string, number>>;
  /** Consecutive rejection count per taskId, reset on approval. Feeds need assessment and mutual aid. */
  rejectionCounts: Record<string, number>;
  /** Consecutive planner-attributed failures across tasks in this run. Drives planner recall. */
  plannerFailureCount: number;
  /** All guild domains a node's targetGlobs/description touch, computed once at plan() time. */
  nodeGuilds: Record<string, string[]>;
  /** Who ended up assigned to each node and how the assignment was decided. */
  assignments: Record<
    string,
    {
      assigneeId: string;
      leadGuild: string;
      allGuilds: string[];
      coordinated: boolean;
      /** Why recovery prepared a handoff for the next assign/execute pass. */
      recoveryReason?: string;
    }
  >;

  // ---- section 6's federation ----

  /** taskId -> what the work needs, from the work alone (article 4). */
  needs: Record<string, NeedsAssessment>;
  /** taskId -> workers who handed this node back, in order. */
  returnedBy: Record<string, string[]>;
  /** Nodes every eligible worker returned: a defect in the plan, not in any worker. */
  planningDefects: string[];
  /** taskId -> the lead guild the coordinating council chose for a cross-council node, kept so a
   * retry under the same plan version is not arbitrated again. Dropped on remediation. */
  coordinatedLeads?: Record<string, { leadGuild: string; planDigest: string }>;
  /** taskId -> aid the mutual-aid worker published, handed to the next attempt. */
  aid: Record<string, AidPacket>;
  /** What the council required of the last rejected proposal, and under which plan version. The
   * proposal's own file operations reach the next worker through the engine's repair brief. */
  reworkDrafts?: Record<string, {
    planDigest: string;
    requiredChanges: string[];
    /** Set when remediation reopened the node after this draft was rejected. */
    superseded?: boolean;
  }>;
  /** taskId -> the globs the plan allocated to that council, declared before editing (section 8). */
  agreedScope: Record<string, string[]>;
  /** taskId -> the paths the work actually wrote to, for the comparison at convergence. */
  touchedPaths: Record<string, string[]>;
  /** Nodes an appeal panel has already sat on, so a council appeals once per cycle. */
  appealsHeard: string[];
  /** Who implemented and who reviewed each node — article 8's check reads this, not a claim. */
  approvals: ApprovalRecord[];
  /** Everything this run wrote back to the shared store, as `kind:tags` summaries (article 7). */
  contributions: string[];
  /**
   * The final check records, stashed at verifyDelivery. disposeFindings does not receive the draft
   * packet, and section 9 requires the commons report to name skipped checks with their reasons.
   */
  finalChecks?: import('../../engine/packets.js').CheckRunRecord[];
  /**
   * The doctrine-neutral channel engine/delivery.ts reads. Written at the end of disposeFindings,
   * because assembleDelivery reads it before accept() runs.
   */
  deliveryNotes?: { limitations: string[]; residualRisks: string[]; rollbackNotes: string[] };
  /** Nodes whose failure taught the swarm something, and whether it was written down. */
  failedTaskIds: string[];
  publishedTaskIds: string[];
  /** taskId -> the worker council formed around that unit of production. */
  councils: Record<string, WorkerCouncil>;
  ratifiedPlanDigest?: string;
  councilMandateIds?: Record<string, string>;
  /** The delegates currently coordinating, and who chairs them. Absent before plan(). */
  coordinating?: CoordinatingCouncil;
  /** Work units completed so far, which is what the coordinating council's term is counted in. */
  completedTasks: number;
  /** Every decision the coordinating council took outside its mandate, kept for the record. */
  mandateBreaches: MandateBreach[];
  /** delegate persona id -> allocations of its that had to be reassigned or overridden. */
  delegateMisallocations: Record<string, number>;
  /** Article 11: every move of work off a worker, with the cause that justified it. */
  reassignments: Reassignment[];
}

export function isSocialistConfig(v: unknown): v is SocialistConfig {
  return typeof v === 'object' && v !== null;
}

// ---- Planner ----

export interface PlannerNode {
  id: string;
  title: string;
  description: string;
  targetGlobs: string[];
  dependsOn: string[];
  acceptanceCriteria?: string[];
}

/**
 * What the coordinating council did with the councils' published reconnaissance.
 *
 * Optional on purpose. `normalizePlannerResponse` accepts a bare top-level array, which cannot
 * carry a sibling field at all, and hard-requiring new keys on the planner is what made this
 * planner unsatisfiable once before (see normalizePlannerResponse below). The guarantee that
 * reconnaissance was not ignored is not this field — it is the deterministic comparison in
 * reconnaissance.unaddressedRisks(), which reads the plan itself.
 */
export interface PlannerSynthesis {
  adopted: string[];
  setAside: { finding: string; reason: string }[];
}

export interface PlannerResponse {
  nodes: PlannerNode[];
  synthesis?: PlannerSynthesis;
}

/**
 * Accepts either `{ "nodes": [...] }` or a bare top-level array.
 *
 * The object form is the documented shape and the only one that works when the model honors
 * `response_format: {type:'json_object'}` (which WorkerDispatcher sets for every model flagged
 * supportsJsonMode) — that mode requires a top-level object, so demanding a bare array made the
 * socialist planner unsatisfiable on compliant models and burned every corrective retry. The bare
 * array stays accepted because models return it anyway and rejecting it buys nothing.
 */
export function normalizePlannerResponse(value: unknown): PlannerNode[] {
  if (Array.isArray(value)) return value as PlannerNode[];
  if (typeof value === 'object' && value !== null) {
    const wrapped = (value as Record<string, unknown>).nodes;
    if (Array.isArray(wrapped)) return wrapped as PlannerNode[];
  }
  return [];
}

/** Reads the synthesis record if the planner supplied a well-formed one, and ignores it otherwise. */
export function readPlannerSynthesis(value: unknown): PlannerSynthesis | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const raw = (value as Record<string, unknown>).synthesis;
  if (typeof raw !== 'object' || raw === null) return undefined;

  const s = raw as Record<string, unknown>;
  const adopted = Array.isArray(s.adopted) ? s.adopted.filter((a): a is string => typeof a === 'string') : [];
  const setAside = Array.isArray(s.setAside)
    ? s.setAside
        .filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null)
        .filter((e) => typeof e.finding === 'string' && typeof e.reason === 'string')
        .map((e) => ({ finding: e.finding as string, reason: e.reason as string }))
    : [];
  return adopted.length === 0 && setAside.length === 0 ? undefined : { adopted, setAside };
}

export function validatePlannerResponse(value: unknown): void {
  // Deliberately widened back to unknown[]: this runs *before* anything is verified, so the
  // element type from normalize() is an unproven claim, not a fact to lean on.
  const nodes: unknown[] = normalizePlannerResponse(value);
  if (nodes.length === 0) {
    throw new Error('Planner response must be a JSON object { "nodes": [ ... ] } with a non-empty nodes array.');
  }
  const ids = new Set<string>();
  const hasMultipleNodes = nodes.length > 1;
  for (const [i, raw] of nodes.entries()) {
    if (typeof raw !== 'object' || raw === null) throw new Error(`Planner node[${i}] must be an object.`);
    const n = raw as Record<string, unknown>;
    if (typeof n.id !== 'string' || n.id.trim().length === 0) throw new Error(`Planner node[${i}].id must be a non-empty string.`);
    if (ids.has(n.id)) throw new Error(`Planner node[${i}].id "${n.id}" is not unique.`);
    ids.add(n.id);
    if (typeof n.title !== 'string' || n.title.trim().length === 0) throw new Error(`Planner node[${i}].title must be a non-empty string.`);
    if (typeof n.description !== 'string' || n.description.trim().length === 0) {
      throw new Error(`Planner node[${i}].description must be a non-empty string.`);
    }
    if (!Array.isArray(n.targetGlobs) || n.targetGlobs.some((g) => typeof g !== 'string')) {
      throw new Error(`Planner node[${i}].targetGlobs must be a string[].`);
    }
    if (hasMultipleNodes && (n.targetGlobs.length === 0 || n.targetGlobs.includes('**/*'))) {
      throw new Error(
        `Planner node[${i}] in a multi-node plan must own explicit, non-universal targetGlobs; ` +
          'synthesis and coordination records belong in metadata, not an executable "**/*" task.',
      );
    }
    if (n.dependsOn !== undefined && (!Array.isArray(n.dependsOn) || n.dependsOn.some((d) => typeof d !== 'string'))) {
      throw new Error(`Planner node[${i}].dependsOn must be a string[] if present.`);
    }
    if (
      n.acceptanceCriteria !== undefined &&
      (!Array.isArray(n.acceptanceCriteria) || n.acceptanceCriteria.some((c) => typeof c !== 'string'))
    ) {
      throw new Error(`Planner node[${i}].acceptanceCriteria must be a string[] if present.`);
    }
  }
}

// ---- Coordinator (cross-guild arbitration) ----

export interface CoordinatorResponse {
  leadGuild: string;
  assigneeId: string;
  rationale: string;
  /**
   * What kind of question this arbitration actually settled.
   *
   * Article 6 confines the coordinating council to ordering, interfaces and scarce resources, and
   * section 8 states the limit directly: "the coordinating council owns ordering, not technical
   * truth." Requiring it to name its own subject is what makes that limit checkable — the field is
   * deliberately not constrained to the permitted list, because the whole point is to catch a
   * coordinator that reached past it.
   */
  subject: string;
}

export function makeValidateCoordinatorResponse(allowedGuilds: string[]): (value: unknown) => void {
  return (value: unknown): void => {
    if (typeof value !== 'object' || value === null) throw new Error('Coordinator response must be a JSON object.');
    const v = value as Record<string, unknown>;
    if (typeof v.leadGuild !== 'string' || !allowedGuilds.includes(v.leadGuild)) {
      throw new Error(`Coordinator response "leadGuild" must be one of: ${allowedGuilds.join(', ')}.`);
    }
    if (typeof v.assigneeId !== 'string' || v.assigneeId.trim().length === 0) {
      throw new Error('Coordinator response must include a non-empty "assigneeId" string.');
    }
    if (typeof v.rationale !== 'string' || v.rationale.trim().length === 0) {
      throw new Error('Coordinator response must include a non-empty "rationale" string.');
    }
    if (typeof v.subject !== 'string' || v.subject.trim().length === 0) {
      throw new Error('Coordinator response must include a non-empty "subject" string naming what the arbitration settled.');
    }
  };
}

// ---- Implementer ----

export interface FileOpLike {
  op: 'write' | 'edit' | 'delete';
  path: string;
  content?: string;
  find?: string;
  replace?: string;
}

export interface ImplementerResponse {
  fileOps: FileOpLike[];
  rationale: string;
  /** Mandatory transparent-accounting: every path touched, alongside fileOps, for easy auditing. */
  filesChanged: string[];
  /** Mandatory — "none" is an acceptable value, but the field itself must always be present. */
  unresolvedUncertainty: string;
  /**
   * Section 6's right to hand work back. Read through allocation.readAssignmentReturn(), which
   * guards every field, because this is model output on the task loop.
   */
  assignmentReturn?: { returned: boolean; reason: string };
}

export function validateImplementerResponse(value: unknown): void {
  if (typeof value !== 'object' || value === null) throw new Error('Implementer response must be a JSON object.');
  const v = value as Record<string, unknown>;
  // Section 6: a worker may return an assignment it cannot safely take, declared as a return so
  // silence is never mistaken for refusal. An empty fileOps without a return is the other answer
  // every doctrine accepts: this task's files already need no change, which its peers then judge.
  const returned =
    typeof v.assignmentReturn === 'object' &&
    v.assignmentReturn !== null &&
    (v.assignmentReturn as Record<string, unknown>).returned === true;

  if (!Array.isArray(v.fileOps)) {
    throw new Error(
      'Implementer response must include a "fileOps" array (empty only when your files need no change, ' +
        'or when returning the assignment with "assignmentReturn": { "returned": true, "reason": "..." }).',
    );
  }
  if (returned && typeof (v.assignmentReturn as Record<string, unknown>).reason !== 'string') {
    throw new Error('A returned assignment must include a "reason" string — the return is planning information.');
  }
  for (const [i, op] of v.fileOps.entries()) {
    if (!isValidFileOpShape(op, 'path')) {
      throw new Error(`fileOps[${i}] is not a valid FileOp: "op" must be "write"|"edit"|"delete" with the matching required fields.`);
    }
    if (!isSafeRelativePath(op.path)) {
      throw new Error(`fileOps[${i}].path must be a relative, non-escaping path: ${String(op.path)}`);
    }
  }
  fillMissingRationale(v);
  if (!Array.isArray(v.filesChanged) || v.filesChanged.some((f) => typeof f !== 'string')) {
    throw new Error('Implementer response must include "filesChanged": string[] (transparent accounting of every touched path).');
  }
  if (!isNonEmptyString(v.unresolvedUncertainty)) {
    throw new Error('Implementer response must include a non-empty "unresolvedUncertainty" string — write "none" if there truly is none.');
  }
}

// ---- Reviewer ----

export interface ReviewerResponse {
  verdict: 'approve' | 'reject' | 'flag';
  rationale: string;
  evidenceRefs?: string[];
}

export function validateReviewerResponse(value: unknown): void {
  if (typeof value !== 'object' || value === null) throw new Error('Reviewer response must be a JSON object.');
  const v = value as Record<string, unknown>;
  if (!isValidVerdict(v.verdict)) {
    throw new Error('Reviewer response "verdict" must be one of "approve" | "reject" | "flag".');
  }
  if (!isNonEmptyString(v.rationale)) {
    throw new Error('Reviewer response must include a non-empty "rationale" string.');
  }
  if (v.evidenceRefs !== undefined && (!Array.isArray(v.evidenceRefs) || v.evidenceRefs.some((e) => typeof e !== 'string'))) {
    throw new Error('"evidenceRefs" must be a string[] if present.');
  }
}
