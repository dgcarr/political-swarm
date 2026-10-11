// Wire shapes and validators shared by the acceptance barriers.
//
// The institutions differ per doctrine — an Integration Committee reporting to the Commons, an
// integration council of producers, a separately procured integration assessor — and so do their
// prompts, which live in each strategy's own prompts.ts. What they return travels over the same
// doctrine-neutral interface, so the parsing and validation of it belongs here rather than being
// written three times.

import type { CheckRunRecord, DraftFinding, Finding, FindingDisposition } from '../engine/packets.js';
import type { ChecksConfig } from '../util/config.js';
import type { EngineContext } from '../engine/SwarmStrategy.js';
import { isNonEmptyString } from './validation.js';

export interface WireBarrierFinding {
  summary: string;
  severity: 'low' | 'medium' | 'high';
  evidence: string;
}

export interface WireIntegrationReport {
  integrated: boolean;
  rationale: string;
  findings: WireBarrierFinding[];
}

export interface WireVerificationReport {
  verified: boolean;
  rationale: string;
  criteriaTraced: string[];
  findings: WireBarrierFinding[];
}

export interface WireDisposition {
  id: string;
  disposition: FindingDisposition;
  rationale: string;
  owner?: string;
  returnCondition?: string;
  minority?: boolean;
}

export interface WireDispositionReport {
  dispositions: WireDisposition[];
}

export const integrationSchemaDescription =
  '{ "integrated": boolean, "rationale": string (1-2 plain sentences on the COMBINED tree; do not use ' +
  'quotation marks, newlines or code fences inside it), "findings": [ { "summary": string (one plain ' +
  'sentence), "severity": "low"|"medium"|"high", "evidence": string (an owned source path or command, ' +
  'never a runtime-generated CSV or PNG) } ] }';

export const verificationSchemaDescription =
  '{ "verified": boolean, "rationale": string (1-2 plain sentences; no quotation marks, newlines or ' +
  'code fences inside it), "criteriaTraced": string[] (the exact acceptance criteria you could trace to ' +
  'implementing code AND evidence, copied verbatim), "findings": [ { "summary": string (one plain ' +
  'sentence), "severity": "low"|"medium"|"high", "evidence": string (a file path or command, no prose) } ] }';

export const dispositionSchemaDescription =
  '{ "dispositions": [ { "id": string (the finding id, copied exactly), "disposition": "accepted"|"rejected"|' +
  '"deferred"|"unresolved", "rationale": string, "owner": string (REQUIRED when deferred), ' +
  '"returnCondition": string (REQUIRED when deferred), "minority": boolean (true if this records dissent) } ] } ' +
  '— keep every string to one plain sentence with no quotation marks, newlines or code fences inside it';

function validateWireFindings(value: unknown, field: string): void {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  for (const f of value) {
    if (typeof f !== 'object' || f === null) throw new Error(`Each ${field} entry must be an object`);
    const finding = f as Partial<WireBarrierFinding>;
    if (!isNonEmptyString(finding.summary)) throw new Error(`${field}[].summary must be a non-empty string`);
    if (finding.severity !== 'low' && finding.severity !== 'medium' && finding.severity !== 'high') {
      throw new Error(`${field}[].severity must be "low", "medium" or "high"`);
    }
    if (!isNonEmptyString(finding.evidence)) throw new Error(`${field}[].evidence must be a non-empty string`);
  }
}

export function validateIntegrationReport(value: unknown): asserts value is WireIntegrationReport {
  if (typeof value !== 'object' || value === null) throw new Error('Expected an object');
  const v = value as Partial<WireIntegrationReport>;
  if (typeof v.integrated !== 'boolean') throw new Error('integrated must be a boolean');
  if (!isNonEmptyString(v.rationale)) throw new Error('rationale must be a non-empty string');
  validateWireFindings(v.findings, 'findings');
}

export function validateVerificationReport(value: unknown): asserts value is WireVerificationReport {
  if (typeof value !== 'object' || value === null) throw new Error('Expected an object');
  const v = value as Partial<WireVerificationReport>;
  if (typeof v.verified !== 'boolean') throw new Error('verified must be a boolean');
  if (!isNonEmptyString(v.rationale)) throw new Error('rationale must be a non-empty string');
  if (!Array.isArray(v.criteriaTraced)) throw new Error('criteriaTraced must be an array');
  validateWireFindings(v.findings, 'findings');
}

export function validateDispositionReport(value: unknown): asserts value is WireDispositionReport {
  if (typeof value !== 'object' || value === null) throw new Error('Expected an object');
  const v = value as Partial<WireDispositionReport>;
  if (!Array.isArray(v.dispositions)) throw new Error('dispositions must be an array');
  for (const d of v.dispositions) {
    if (typeof d !== 'object' || d === null) throw new Error('Each disposition must be an object');
    const dd = d as Partial<WireDisposition>;
    if (!isNonEmptyString(dd.id)) throw new Error('disposition.id must be a non-empty string');
    if (!['accepted', 'rejected', 'deferred', 'unresolved'].includes(dd.disposition as string)) {
      throw new Error('disposition must be "accepted", "rejected", "deferred" or "unresolved"');
    }
    if (!isNonEmptyString(dd.rationale)) throw new Error('disposition.rationale must be a non-empty string');
    if (dd.disposition === 'deferred' && (!isNonEmptyString(dd.owner) || !isNonEmptyString(dd.returnCondition))) {
      throw new Error('A deferred disposition must name both an owner and a returnCondition');
    }
  }
}

/** Barrier findings arrive undispositioned; they enter the run as `unresolved` and must be
 * answered for at the disposition step. Nothing reaches delivery without a disposition. */
export function toEngineFindings(wire: WireBarrierFinding[], source: string): DraftFinding[] {
  return wire.map((f) => ({
    source,
    summary: `[${f.severity}] ${f.summary}`,
    evidenceRefs: [f.evidence],
    disposition: 'unresolved' as const,
    dispositionRationale: 'Raised at a barrier; awaiting disposition.',
  }));
}

/**
 * Applies a doctrine's dispositions to the open findings it was given.
 *
 * A finding the doctrine simply did not answer stays `unresolved` with that fact recorded, rather
 * than vanishing — section 10, in all three docs: "No finding may disappear through adjournment,
 * summary, or executive assertion."
 */
export function applyDispositions(open: Finding[], wire: WireDisposition[]): Finding[] {
  const byId = new Map(wire.map((d) => [d.id, d]));
  return open.map((finding) => {
    const d = byId.get(finding.id);
    if (!d) {
      return {
        ...finding,
        disposition: 'unresolved' as const,
        dispositionRationale: 'No disposition was returned for this finding; it remains unresolved and is disclosed as such.',
      };
    }
    return {
      ...finding,
      disposition: d.disposition,
      dispositionRationale: d.rationale,
      owner: d.owner,
      returnCondition: d.returnCondition,
      minority: d.minority ?? finding.minority,
    };
  });
}

/** Compact a finding for a disposition prompt. Regression-rule packets must not recursively
 * re-embed prior remediation origin text. */
export function compactFindingLine(finding: {
  id: string;
  source: string;
  summary: string;
  evidenceRefs: string[];
}): string {
  if (finding.source === 'engine:regression-rule') {
    const paths = finding.evidenceRefs.filter((ref) => !ref.startsWith('remediation-origin:'));
    return `- id=${finding.id} [from ${finding.source}] changed no test (evidence: ${paths.join(', ') || 'none'})`;
  }
  return `- id=${finding.id} [from ${finding.source}] ${finding.summary} (evidence: ${finding.evidenceRefs.join(', ') || 'none'})`;
}

/**
 * Renders the check results for a barrier prompt.
 *
 * Says explicitly which categories are required and which could not run here, because a verifier
 * that cannot tell the difference reads "typecheck: not run" as a breach. Section 9 of every
 * doctrine treats an unavailable check as a recorded limitation with a reason — not as a failure,
 * and not as a silent pass either.
 */
export function renderCheckSummary(records: CheckRunRecord[], checks: ChecksConfig): string {
  if (records.length === 0) return '(no checks recorded)';
  const required = new Set(checks.categories.filter((c) => c.required).map((c) => c.id));

  const lines = records.map((r) => {
    const tag = required.has(r.categoryId) ? 'REQUIRED' : 'optional';
    if (!r.ran) {
      return `- ${r.categoryId} (${tag}): NOT AVAILABLE in this repository — ${r.skippedReason ?? 'command could not be executed'}. This is a recorded limitation, not a failure.`;
    }
    if (r.passed) {
      const artifacts = r.generatedPaths?.length
        ? `; runtime artifacts retained as evidence, not authored: ${r.generatedPaths.join(', ')}`
        : '';
      return `- ${r.categoryId} (${tag}): passed${artifacts}`;
    }
    return `- ${r.categoryId} (${tag}): FAILED${r.failedAtBaseline ? ' — but was already failing before this run, so it is pre-existing' : ''}`;
  });

  return (
    `${lines.join('\n')}\n\n` +
    'A check that is not available in this repository, or that was already failing at baseline, is a ' +
    'disclosed limitation. Do not treat either as a breach caused by this change.'
  );
}

/** Diffs are truncated before they go into a prompt — a whole-run diff can outrun a context window,
 * and the barrier needs the change, not the entire file set. Every strategy uses the same budget so
 * no arm reviews a more complete diff than another. At a flat 20k a democratic verifier saw README,
 * __main__.py and part of cli.py out of a 60k-character delivery, and refused for not having read
 * the rest; the budget now scales with the roster (diffBudget) up to this ceiling. */
export const DIFF_PROMPT_MAX_CHARS = 80_000;

/** Share of the smallest context window the diff may take; the rest of the prompt and the answer
 * need the remainder. Characters per token is set low on purpose: code tokenizes densely. */
const DIFF_SHARE_OF_CONTEXT = 0.25;
const CHARS_PER_TOKEN = 3;

/** The diff budget for a model whose window is `contextTokens`. */
export function diffBudgetForContext(contextTokens: number): number {
  return Math.min(DIFF_PROMPT_MAX_CHARS, Math.floor(contextTokens * DIFF_SHARE_OF_CONTEXT * CHARS_PER_TOKEN));
}

/**
 * The diff budget for this run's roster: sized to the smallest window any role's primary or
 * fallback has, since either may answer, and identical for every doctrine because they share the
 * roster. The models can change between runs, so this is never a constant.
 */
export function diffBudget(ctx: Pick<EngineContext, 'dispatcher'>): number {
  const dispatcher = ctx.dispatcher as { smallestContextTokens?: () => number };
  return typeof dispatcher.smallestContextTokens === 'function'
    ? diffBudgetForContext(dispatcher.smallestContextTokens())
    : DIFF_PROMPT_MAX_CHARS;
}

/**
 * Over budget, every file keeps a share instead of the first files keeping everything: a file the
 * barrier never sees is one it can only refuse on. Files smaller than an even share keep all of it,
 * and what they leave over goes to the larger ones.
 */
export function truncateDiff(diffText: string, maxChars = DIFF_PROMPT_MAX_CHARS): string {
  if (diffText.length <= maxChars) return diffText;
  const files = diffText.split(/(?=^diff --git )/m);
  const shares = new Map<number, number>();
  let budget = maxChars;
  let open = files.map((file, index) => ({ index, length: file.length }));
  while (open.length > 0) {
    const even = Math.floor(budget / open.length);
    const small = open.filter((file) => file.length <= even);
    if (small.length === 0) {
      for (const file of open) shares.set(file.index, even);
      break;
    }
    for (const file of small) {
      shares.set(file.index, file.length);
      budget -= file.length;
    }
    open = open.filter((file) => file.length > even);
  }
  const shown = files.map((file, index) => {
    const share = shares.get(index) ?? 0;
    return file.length <= share
      ? file
      : `${file.slice(0, share)}\n…[this file's diff truncated at ${share} of ${file.length} chars; read the file for the rest]\n`;
  });
  return `${shown.join('')}\n…[diff truncated to ${maxChars} of ${diffText.length} chars, shared across ${files.length} file(s)]`;
}
