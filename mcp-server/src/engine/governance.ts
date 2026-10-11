import { createHash } from 'node:crypto';
import type { Ledger, LedgerEntry } from './Ledger.js';
import type { RunState } from './RunStore.js';
import type { Assignment } from './types.js';
import type { DeliveryPacket, DoctrineAcceptance } from './packets.js';
import { isRuleId, resultDisagreement, type RuleId } from '../constitution/rules.js';

export interface GovernanceDecision {
  id: string;
  body: string;
  subject: string;
  artifactDigest: string;
  /** One of constitution/rules.ts's rules; the recorded result must follow from the positions under it. */
  rule: RuleId;
  eligible: string[];
  positions: Array<{ actor: string; choice: string }>;
  evidenceRefs: string[];
  result: string;
  nextAction: string;
}

export interface GovernanceMandate {
  id: string;
  grantor: string;
  holder: string;
  scope: string[];
  artifactDigest: string;
  revoked?: boolean;
}

export class RevokedMandateError extends Error {
  constructor(id: string) {
    super(`Mandate ${id} was revoked before dispatch.`);
    this.name = 'RevokedMandateError';
  }
}

/**
 * A doctrine's own institutions refused to let the run proceed (for example, worker councils that
 * will not ratify any plan the planner can produce). The run ends terminated_incomplete with this
 * reason, like any other governed refusal, rather than failed as if the engine had crashed.
 */
export class GovernanceHaltError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GovernanceHaltError';
  }
}

export function digestArtifact(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function deliveryGovernanceDigest(draft: DeliveryPacket): string {
  return digestArtifact({
    diffText: draft.diffText,
    finalChecks: draft.finalChecks,
    verification: draft.independentVerification,
    findings: draft.findings,
  });
}

export function requireGovernanceAction(
  state: RunState,
  proof: DoctrineAcceptance['authorityProof'],
  artifactDigest: string,
  action: string,
  expectedSubjects?: readonly string[],
): void {
  if (!proof || proof.artifactDigest !== artifactDigest || proof.action !== action ||
    !Array.isArray(proof.decisionIds) || proof.decisionIds.length === 0 ||
    proof.decisionIds.some((id) => typeof id !== 'string' || !id) ||
    new Set(proof.decisionIds).size !== proof.decisionIds.length) {
    throw new Error('Delivery has no valid governance action proof for this artifact.');
  }
  const subjects: string[] = [];
  for (const id of proof.decisionIds) {
    const decision = state.governanceDecisions?.find((record) => record.id === id);
    if (!decision || decision.artifactDigest !== artifactDigest ||
      decision.result !== 'approve' || decision.nextAction !== action ||
      !decision.subject || !decision.body || !decision.rule ||
      !Array.isArray(decision.eligible) || decision.eligible.length === 0 ||
      new Set(decision.eligible).size !== decision.eligible.length ||
      !Array.isArray(decision.positions) || decision.positions.length === 0 ||
      new Set(decision.positions.map((position) => position.actor)).size !== decision.positions.length ||
      decision.positions.some((position) => !decision.eligible.includes(position.actor))) {
      throw new Error(`Governance decision ${id} does not authorize ${action} on this artifact.`);
    }
    subjects.push(decision.subject);
  }
  if (expectedSubjects && (subjects.length !== expectedSubjects.length ||
    new Set(subjects).size !== subjects.length ||
    expectedSubjects.some((subject) => !subjects.includes(subject)))) {
    throw new Error(`Governance action proof omits a required subject for ${action}.`);
  }
}

/**
 * The next id in a series of decisions on one subject: `${prefix}1`, `${prefix}2`, … An id built
 * from a counter that can stand still between two decisions (attempts, completed tasks) handed a
 * second, different decision the first one's id, which the replay check below rejects as a
 * conflict: a capitalist re-tender and a democratic confidence vote held twice in one stretch.
 */
export function nextGovernanceDecisionId(state: RunState, prefix: string): string {
  const prior = (state.governanceDecisions ?? []).filter((record) => record.id.startsWith(prefix)).length;
  return `${prefix}${prior + 1}`;
}

export function recordGovernanceDecision(state: RunState, ledger: Ledger, decision: GovernanceDecision): void {
  if (!decision.id || !decision.body || !decision.subject || !decision.rule || !decision.artifactDigest) {
    throw new Error('Governance decision is missing its identity, authority, rule, or artifact version.');
  }
  const eligible = new Set(decision.eligible);
  if (eligible.size !== decision.eligible.length) throw new Error('Duplicate eligible governance actor.');
  const cast = new Set<string>();
  for (const position of decision.positions) {
    if (!eligible.has(position.actor)) throw new Error(`Ineligible governance actor: ${position.actor}.`);
    if (cast.has(position.actor)) throw new Error(`Duplicate governance ballot: ${position.actor}.`);
    cast.add(position.actor);
  }
  if (!isRuleId(decision.rule)) throw new Error(`Governance decision ${decision.id} names no constitutional rule: ${decision.rule}.`);
  const disagreement = resultDisagreement(decision.rule, decision.eligible.length, decision.positions, decision.result);
  if (disagreement) {
    throw new GovernanceHaltError(`Governance decision ${decision.id} records "${decision.result}" under ` +
      `${decision.rule}, but ${disagreement}.`);
  }
  const records = (state.governanceDecisions ??= []);
  const prior = records.find((record) => record.id === decision.id);
  if (prior) {
    if (JSON.stringify(prior) !== JSON.stringify(decision)) throw new Error(`Conflicting replay of decision ${decision.id}.`);
    return;
  }
  records.push(decision);
  ledger.record('governance_decision', { ...decision });
}

export function grantGovernanceMandate(state: RunState, ledger: Ledger, mandate: GovernanceMandate): void {
  if (!mandate.id || !mandate.grantor || !mandate.holder || !mandate.artifactDigest || mandate.scope.length === 0) {
    throw new Error('Governance mandate is missing its grantor, holder, scope, or artifact version.');
  }
  const records = (state.governanceMandates ??= []);
  const prior = records.find((record) => record.id === mandate.id);
  if (prior) {
    const { revoked: _priorRevoked, ...originalGrant } = prior;
    const { revoked: _replayedRevoked, ...replayedGrant } = mandate;
    if (JSON.stringify(originalGrant) !== JSON.stringify(replayedGrant)) {
      throw new Error(`Conflicting replay of mandate ${mandate.id}.`);
    }
    return;
  }
  records.push(mandate);
  ledger.record('governance_mandate_granted', { ...mandate });
}

export function revokeGovernanceMandate(state: RunState, ledger: Ledger, id: string): void {
  const mandate = state.governanceMandates?.find((record) => record.id === id);
  if (!mandate) throw new Error(`Cannot revoke unknown mandate ${id}.`);
  if (mandate.revoked) return;
  mandate.revoked = true;
  ledger.record('governance_mandate_revoked', { id });
}

export function requireGovernanceMandate(state: RunState, id: string, holder: string, artifactDigest: string,
  subject?: string): void {
  const mandate = state.governanceMandates?.find((record) => record.id === id);
  if (mandate?.revoked) throw new RevokedMandateError(id);
  if (!mandate || mandate.holder !== holder || mandate.artifactDigest !== artifactDigest ||
    (subject !== undefined && !mandate.scope.includes(subject))) {
    throw new Error(`Mandate ${id} does not authorize ${holder} on this artifact version.`);
  }
}

/** Strategies name their authorizing mandate; the engine checks it at dispatch. */
export function requireAssignmentAuthority(state: RunState, assignment: Assignment, required = false): void {
  const authority = assignment.meta?.authority;
  if (authority === undefined) {
    if (required) throw new Error(`Assignment ${assignment.taskId} is missing a governance mandate.`);
    return;
  }
  if (!authority || typeof authority !== 'object') throw new Error('Assignment has malformed authority.');
  const reference = authority as Record<string, unknown>;
  if (typeof reference.mandateId !== 'string' || typeof reference.holder !== 'string' ||
    typeof reference.artifactDigest !== 'string') throw new Error('Assignment has malformed authority.');
  requireGovernanceMandate(state, reference.mandateId, reference.holder, reference.artifactDigest, assignment.taskId);
}

/** Rebuilds records already durably written before an interrupted in-memory transition. */
export function restoreGovernanceFromLedger(state: RunState, entries: readonly LedgerEntry[]): void {
  const decisions = (state.governanceDecisions ??= []);
  const mandates = (state.governanceMandates ??= []);
  for (const entry of entries) {
    if (entry.type === 'governance_decision') {
      const candidate = entry.data as unknown as GovernanceDecision;
      if (typeof candidate.id !== 'string' || typeof candidate.artifactDigest !== 'string' ||
        !Array.isArray(candidate.positions) || !Array.isArray(candidate.eligible)) {
        throw new Error('Cannot replay malformed governance decision.');
      }
      const prior = decisions.find((record) => record.id === candidate.id);
      if (prior && JSON.stringify(prior) !== JSON.stringify(candidate)) {
        throw new Error(`Conflicting governance decision in ledger: ${candidate.id}.`);
      }
      if (!prior) decisions.push(candidate);
    } else if (entry.type === 'governance_mandate_granted') {
      const candidate = entry.data as unknown as GovernanceMandate;
      if (typeof candidate.id !== 'string' || typeof candidate.holder !== 'string' ||
        !Array.isArray(candidate.scope) || typeof candidate.artifactDigest !== 'string') {
        throw new Error('Cannot replay malformed governance mandate.');
      }
      const prior = mandates.find((record) => record.id === candidate.id);
      if (prior) {
        const { revoked: _priorRevoked, ...existingGrant } = prior;
        const { revoked: _candidateRevoked, ...recordedGrant } = candidate;
        if (JSON.stringify(existingGrant) !== JSON.stringify(recordedGrant)) {
          throw new Error(`Conflicting governance mandate in ledger: ${candidate.id}.`);
        }
      } else mandates.push(candidate);
    } else if (entry.type === 'governance_mandate_revoked') {
      const id = entry.data.id;
      const mandate = mandates.find((record) => record.id === id);
      if (!mandate) throw new Error(`Cannot replay revocation of unknown mandate ${String(id)}.`);
      mandate.revoked = true;
    }
  }
}
