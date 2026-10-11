// The doctrine-neutral runtime interface between Claude (the external orchestrator) and whichever
// political swarm is running. Every philosophy doc in docs/philosophy/ carries the same section 5
// verbatim: "Claude observes only this runtime interface. Votes, council decisions, contracts,
// prices, appointments, recalls and other political acts remain internal to the selected doctrine
// and are neither translated into one another nor decided by Claude."
//
// So nothing in this file names an institution. A committee verdict, a council decision and an
// assessor's certificate all arrive here as the same shapes; the doctrine that produced them stays
// inside its own strategy module.

import type { StrategyId } from './types.js';

/**
 * Section 10, all three docs: "The review record assigns every finding one unambiguous
 * disposition." A finding may never disappear through adjournment, summary or executive
 * assertion — every one of these reaches the delivery packet.
 */
export type FindingDisposition = 'accepted' | 'rejected' | 'deferred' | 'unresolved';

export interface Finding {
  id: string;
  /** Who raised it: a reviewer/opposition/assessor persona id, an engine guard, or 'claude'. */
  source: string;
  taskId?: string;
  summary: string;
  evidenceRefs: string[];
  disposition: FindingDisposition;
  dispositionRationale: string;
  /** Required when disposition === 'deferred' — "with owner, reason, and follow-up condition". */
  owner?: string;
  /** Required when disposition === 'deferred'. */
  returnCondition?: string;
  /** Preserved dissent. Democratic minority reports, socialist minority objections, capitalist
   * disclosed liabilities all land here rather than being converted into apparent consensus. */
  minority?: boolean;
  /** Set on findings the swarm must not silently downgrade: safety floors and criteria evidence. */
  nonWaivable?: boolean;
}

/** A finding as raised, before the engine assigns it a run-unique id. */
export type DraftFinding = Omit<Finding, 'id'> & { id?: string };

/** A `deferred` finding is only well-formed with an owner and a return condition. */
export function findingDispositionError(finding: Finding): string | null {
  if (!finding.summary.trim()) return `Finding "${finding.id}" has no summary`;
  if (!finding.dispositionRationale.trim()) {
    return `Finding "${finding.id}" has disposition "${finding.disposition}" with no rationale`;
  }
  if (finding.disposition === 'deferred') {
    if (!finding.owner?.trim()) return `Deferred finding "${finding.id}" names no owner`;
    if (!finding.returnCondition?.trim()) return `Deferred finding "${finding.id}" names no return condition`;
  }
  return null;
}

/**
 * Section 9, all three docs: a traceability matrix "linking requirement, command and expected
 * result". One entry per user acceptance criterion. `manual` is the doc's escape hatch — "the
 * mandate names the reproducible manual inspection and the evidence it must produce" — not a way
 * to record nothing.
 */
export type EvidenceStatus = 'satisfied' | 'unsatisfied' | 'manual' | 'unavailable';

export interface EvidenceItem {
  criterion: string;
  /** The exact command that demonstrates the criterion, or the named manual inspection. */
  command: string;
  /** Stable check binding. Optional so schema-v1 run states remain readable. */
  checkCategoryId?: string;
  expectedResult: string;
  status: EvidenceStatus;
  /** Required for 'manual' and 'unavailable' — the doc's "recorded reason, not silence". */
  note?: string;
  taskId?: string;
}

/** One executed (or deliberately skipped) check category, with the exact command and its outcome. */
export interface CheckRunRecord {
  categoryId: string;
  command: string;
  args: string[];
  ran: boolean;
  passed: boolean;
  output?: string;
  /** Set when the category was not run — "an omitted category requires a recorded reason". */
  skippedReason?: string;
  /** True when this same category already failed at baseline, so the failure predates the swarm. */
  failedAtBaseline?: boolean;
  /** Worktree-relative paths this check generated. Recorded as evidence, never as authored FileOps. */
  generatedPaths?: string[];
}

/**
 * A file a final-only check created in the worktree. Kept as acceptance evidence and stripped from
 * authored delivery state so the next integrator does not treat runtime output as source.
 */
export interface CheckArtifact {
  path: string;
  checkCategoryId: string;
  capturedAt: string;
  /** Run-directory-relative copy retained after the worktree original is removed. */
  evidencePath?: string;
}

/**
 * Which files, interfaces, generated artefacts and tests each task claims. Published before
 * dispatch and re-published at every barrier, per section 8 of each doc (the Cabinet's
 * "dependency and ownership map", the coordinating council's "dependency and stewardship map",
 * the task exchange's "dependency and property schedule").
 */
export interface OwnershipEntry {
  taskId: string;
  paths: string[];
  interfaces: string[];
  generated: string[];
  tests: string[];
}

export interface OwnershipMap {
  entries: Record<string, OwnershipEntry>;
  /** Overlaps the coordinating body declared up front. Anything else found later is a defect. */
  declaredOverlaps: Array<{ taskIds: string[]; path: string; rationale: string }>;
  publishedAt: string;
}

export function emptyOwnershipMap(): OwnershipMap {
  return { entries: {}, declaredOverlaps: [], publishedAt: new Date().toISOString() };
}

/**
 * The bounded state handed to each newly started or resumed agent instance. Section 5: "every
 * instance receives only the role, repository context, decisions and dependencies needed for its
 * stage, rather than inheriting an assumed shared memory."
 */
export interface SynchronizationPacket {
  runId: string;
  baseRevision: string;
  decisions: Array<{ taskId: string; outcome: string; rationale: string }>;
  ownershipMap: OwnershipMap;
  changedFileManifest: string[];
  evidence: EvidenceItem[];
  openFindings: Finding[];
  capturedAt: string;
}

export interface IntegrationResult {
  /** The persona that performed integration — never one of the implementers. */
  integratorId: string;
  integrated: boolean;
  /** Post-integration checks run against the combined tree, not per-task. */
  postIntegrationChecks: CheckRunRecord[];
  findings: DraftFinding[];
  rationale: string;
}

export interface VerificationResult {
  /** Independent of the authorship chain, per section 9/10 of every doc. */
  verifierId: string;
  verified: boolean;
  /** Criteria the verifier could actually trace to code and evidence. */
  criteriaTraced: string[];
  findings: DraftFinding[];
  rationale: string;
}

/** The doctrine's own acceptance decision, reached under its own rules. Claude records it; Claude
 * does not make it, and is not bound by it. */
export interface DoctrineAcceptance {
  accepted: boolean;
  /** How the doctrine reached it, in its own vocabulary (assent, council decision, escrow release). */
  procedure: string;
  rationale: string;
  decidedAt: string;
  /** The exact recorded institutional decisions authorizing this acceptance, when required. */
  authorityProof?: { artifactDigest: string; decisionIds: string[]; action: string };
}

/**
 * Section 10's final delivery manifest, plus section 9's evidence ledger. Submitted to Claude,
 * which independently checks it and may reject: "Internal approval never binds Claude."
 */
export interface DeliveryPacket {
  /** Immutable Git tree submitted for independent review; absent on legacy deliveries. */
  treeId?: string;
  runId: string;
  strategy: StrategyId;
  baseRevision: string;
  branch: string;
  goal: string;
  acceptanceCriteria: string[];
  changedFiles: string[];
  /** Runtime outputs produced by final-only checks. Evidence, not authored source. */
  checkArtifacts?: CheckArtifact[];
  diffText: string;
  requirementMatrix: EvidenceItem[];
  baseline: CheckRunRecord[];
  finalChecks: CheckRunRecord[];
  decisions: Array<{ taskId: string; title: string; outcome: string; rationale: string; evidenceRefs: string[] }>;
  findings: Finding[];
  minorityReports: Finding[];
  limitations: string[];
  residualRisks: string[];
  /** Rollback instructions, or an explicit statement of why rollback is inapplicable. */
  rollback: string;
  integrationEvidence: IntegrationResult;
  independentVerification: VerificationResult;
  doctrineAcceptance: DoctrineAcceptance;
  assembledAt: string;
  remediationCycles: number;
  externalEvaluations?: ExternalEvaluationRecord[];
}

export interface ExternalEvaluationRecord {
  id: string | number;
  description: string;
  passed: boolean;
  detail: string;
}

/** A concrete defect Claude found during its independent check. A rejection carries these or it
 * is not a rejection — section 5 requires "concrete rejection findings". */
export interface RemediationFinding {
  summary: string;
  evidence: string;
  affectedTaskIds?: string[];
  severity: 'low' | 'medium' | 'high';
}

/**
 * Returned to the SAME swarm, which resumes under its own rules. The delivery it rejects travels
 * with it: section 5 requires "the preserved delivery evidence", so a remediation cycle can never
 * quietly discard what the previous cycle proved.
 */
export interface RemediationPacket {
  runId: string;
  submittedAt: string;
  findings: RemediationFinding[];
  origin?: 'graph' | 'delivery' | 'oracle';
  preservedDelivery?: DeliveryPacket;
  /** Required on newly emitted packets; optional only while loading legacy delivery packets. */
  preservedSynchronization?: SynchronizationPacket;
  cycle: number;
}
