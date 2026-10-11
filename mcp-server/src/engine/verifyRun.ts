import path from 'node:path';
import { verifyLedgerFile, Ledger, type LedgerEntry, type LedgerVerification } from './Ledger.js';
import { RunStore, type RunState } from './RunStore.js';
import { restoreGovernanceFromLedger, type GovernanceDecision } from './governance.js';
import { constitutionDigest, type ConstitutionDocument } from '../constitution/articles.js';
import { isRuleId, resultDisagreement } from '../constitution/rules.js';

// An offline audit of one run from what it left on disk. It answers three questions a reader of a
// governed run should not have to take on trust: is the ledger the one that was written, does the
// governance the run acted on follow from that ledger, and does the money add up.

export interface RunVerification {
  runId: string;
  ok: boolean;
  ledger: LedgerVerification;
  governance: { decisions: number; mandates: number; problems: string[] };
  /** The constitution the run adopted, as its ledger records it; null for a run without one. */
  constitution: { digest: string; strategy: string } | null;
  spend: { ledgerUsd: number; stateUsd: number };
  /** Failures: the record is inconsistent with itself. */
  problems: string[];
  /** Worth a look, not proof of tampering. */
  warnings: string[];
}

export interface VerifyOptions {
  /**
   * Re-judges one recorded decision; returns a reason when the recorded result does not follow.
   * Defaults to the constitutional check: the rule must be one the adopted constitution declares,
   * and the result must follow from the ballots under it.
   */
  checkDecision?: (decision: GovernanceDecision) => string | null;
}

function constitutionalCheck(adopted: ConstitutionDocument | null) {
  return (decision: GovernanceDecision): string | null => {
    if (!isRuleId(decision.rule)) return `recorded under "${decision.rule}", which is not a constitutional rule`;
    if (adopted && !(decision.rule in adopted.decisionRules)) {
      return `recorded under ${decision.rule}, which the run's constitution does not declare`;
    }
    const disagreement = resultDisagreement(decision.rule, decision.eligible.length, decision.positions, decision.result);
    return disagreement ? `records "${decision.result}", but ${disagreement}` : null;
  };
}

const ACTIVE_STATUSES = new Set<RunState['status']>(['running', 'remediation', 'interrupted', 'paused_human', 'paused_budget']);

function spendFromLedger(entries: readonly LedgerEntry[]): number {
  let total = 0;
  for (const entry of entries) {
    if (entry.type !== 'worker_call' && entry.type !== 'decision_call') continue;
    const cost = entry.data.costUsd;
    if (typeof cost === 'number' && Number.isFinite(cost)) total += cost;
  }
  return total;
}

export function verifyRun(runsRootDir: string, runId: string, options: VerifyOptions = {}): RunVerification {
  const problems: string[] = [];
  const warnings: string[] = [];
  const runDir = path.join(runsRootDir, runId);
  const state = new RunStore(runsRootDir).load(runId);
  if (!state) throw new Error(`No run "${runId}" under ${runsRootDir}.`);

  const ledger = verifyLedgerFile(path.join(runDir, 'ledger.jsonl'));
  problems.push(...ledger.problems.map((problem) => `ledger: ${problem}`));
  if (ledger.unchainedPrefix > 0) {
    warnings.push(`ledger: the first ${ledger.unchainedPrefix} entries predate the hash chain and cannot be checked for edits`);
  }

  let entries: LedgerEntry[] = [];
  try {
    entries = new Ledger(runDir, runId, state.strategy).readAll();
  } catch (error) {
    problems.push(`ledger: ${String(error)}`);
  }

  // The constitution must be the one adopted at start, unedited since.
  const governanceProblems: string[] = [];
  const adoptions = entries.filter((entry) => entry.type === 'constitution_adopted');
  const adopted = (adoptions[0]?.data.document as ConstitutionDocument | undefined) ?? null;
  if (adoptions.length > 1) governanceProblems.push(`the ledger records ${adoptions.length} constitution adoptions`);
  if (adopted) {
    if (constitutionDigest(adopted) !== adopted.digest || adoptions[0].data.digest !== adopted.digest) {
      governanceProblems.push('the adopted constitution does not match its own digest');
    }
    if (state.constitution && state.constitution.digest !== adopted.digest) {
      governanceProblems.push('state.json names a different constitution from the one the ledger records');
    }
  } else if (state.constitution?.digest) {
    governanceProblems.push('state.json names a constitution the ledger never recorded adopting');
  }

  // Rebuild governance from the ledger alone and hold the run's own state to it.
  const replayed = { governanceDecisions: [], governanceMandates: [] } as unknown as RunState;
  try {
    restoreGovernanceFromLedger(replayed, entries);
  } catch (error) {
    governanceProblems.push(String(error instanceof Error ? error.message : error));
  }
  const fromLedger = new Map((replayed.governanceDecisions ?? []).map((decision) => [decision.id, decision]));
  for (const decision of state.governanceDecisions ?? []) {
    const recorded = fromLedger.get(decision.id);
    if (!recorded) governanceProblems.push(`decision ${decision.id} is in state.json but not in the ledger`);
    else if (JSON.stringify(recorded) !== JSON.stringify(decision)) {
      governanceProblems.push(`decision ${decision.id} differs between state.json and the ledger`);
    }
  }
  const inState = new Set((state.governanceDecisions ?? []).map((decision) => decision.id));
  const missingFromState = [...fromLedger.keys()].filter((id) => !inState.has(id));
  if (missingFromState.length > 0) {
    // A live or interrupted run's state can lag its ledger by one save; a finished one cannot.
    const message = `${missingFromState.length} ledger decision(s) not in state.json: ${missingFromState.slice(0, 5).join(', ')}`;
    if (ACTIVE_STATUSES.has(state.status)) warnings.push(`governance: ${message}`);
    else governanceProblems.push(message);
  }
  const ledgerMandates = new Map((replayed.governanceMandates ?? []).map((mandate) => [mandate.id, mandate]));
  for (const mandate of state.governanceMandates ?? []) {
    const recorded = ledgerMandates.get(mandate.id);
    if (!recorded) governanceProblems.push(`mandate ${mandate.id} is in state.json but not in the ledger`);
    else if (JSON.stringify(recorded) !== JSON.stringify(mandate)) {
      governanceProblems.push(`mandate ${mandate.id} differs between state.json and the ledger`);
    }
  }
  {
    const checkDecision = options.checkDecision ?? constitutionalCheck(adopted);
    for (const decision of fromLedger.values()) {
      const reason = checkDecision(decision);
      if (reason) governanceProblems.push(`decision ${decision.id}: ${reason}`);
    }
  }
  problems.push(...governanceProblems.map((problem) => `governance: ${problem}`));

  const ledgerUsd = spendFromLedger(entries);
  // Calls that never returned usage are recorded unmetered, so the ledger can only fall short of
  // the state's total, never exceed it.
  if (ledgerUsd > state.costUsd + 1e-6) {
    problems.push(`spend: ledger calls total $${ledgerUsd.toFixed(6)}, more than the run's recorded $${state.costUsd.toFixed(6)}`);
  } else if (state.costUsd - ledgerUsd > 1e-6) {
    warnings.push(`spend: $${(state.costUsd - ledgerUsd).toFixed(6)} of recorded spend has no metered call in the ledger`);
  }

  return {
    runId,
    ok: problems.length === 0,
    ledger,
    governance: { decisions: fromLedger.size, mandates: ledgerMandates.size, problems: governanceProblems },
    constitution: adopted ? { digest: adopted.digest, strategy: adopted.strategy } : null,
    spend: { ledgerUsd, stateUsd: state.costUsd },
    problems,
    warnings,
  };
}
