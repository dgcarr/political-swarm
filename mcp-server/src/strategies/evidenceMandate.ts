// The test mandate of section 9, shared across the three doctrines.
//
// Each names a different body — the democratic Testing and Evidence Committee, the socialist
// councils co-designing tests, the capitalist task owner writing acceptance into the contract
// before bidding closes — but all three require the same artefact before or alongside
// implementation: a traceability record "linking requirement, command and expected result", with a
// named reproducible inspection where automation is impractical.
//
// One rule shapes the design here. The body chooses **which check** demonstrates a criterion; it
// never reports whether the criterion is met. Status is computed from the check that actually ran
// (see resolveEvidenceStatus), because a model asserting "satisfied" is exactly the self-report
// every doctrine refuses to accept as evidence.

import type { CheckRunRecord, EvidenceItem } from '../engine/packets.js';
import type { CheckCategory, ChecksConfig } from '../util/config.js';
import { isNonEmptyString } from './validation.js';

export interface WireEvidenceItem {
  criterion: string;
  /** Id of the check category that demonstrates this criterion, or null for a manual inspection. */
  checkCategoryId: string | null;
  expectedResult: string;
  /** Required when checkCategoryId is null: the reproducible inspection and the evidence it yields. */
  manualInspection?: string;
}

export interface WireEvidenceMandate {
  evidence: WireEvidenceItem[];
}

export function evidenceSchemaDescription(categoryIds: string[]): string {
  return (
    '{ "evidence": [ { "criterion": string (copy one acceptance criterion EXACTLY as given), ' +
    `"checkCategoryId": ${categoryIds.map((id) => `"${id}"`).join(' | ')} | null (which check demonstrates it; ` +
    'null ONLY if no available check can), "expectedResult": non-empty string (what that check or ' +
    'manual inspection must show for the ' +
    'criterion to hold), "manualInspection": string (REQUIRED when checkCategoryId is null: the exact ' +
    'reproducible inspection someone must perform, and the evidence it must produce) } ] }'
  );
}

export function validateEvidenceMandate(value: unknown): asserts value is WireEvidenceMandate {
  if (typeof value !== 'object' || value === null) throw new Error('Expected an object');
  const v = value as Partial<WireEvidenceMandate>;
  if (!Array.isArray(v.evidence)) throw new Error('evidence must be an array');
  for (const e of v.evidence) {
    if (typeof e !== 'object' || e === null) throw new Error('Each evidence entry must be an object');
    const item = e as Partial<WireEvidenceItem>;
    if (!isNonEmptyString(item.criterion)) throw new Error('evidence[].criterion must be a non-empty string');
    if (!isNonEmptyString(item.expectedResult)) throw new Error('evidence[].expectedResult must be a non-empty string');
    if (item.checkCategoryId !== null && !isNonEmptyString(item.checkCategoryId)) {
      throw new Error('evidence[].checkCategoryId must be a category id or null');
    }
    if (item.checkCategoryId === null && !isNonEmptyString(item.manualInspection)) {
      throw new Error('evidence[].manualInspection is required when checkCategoryId is null');
    }
  }
}

/**
 * validateEvidenceMandate, plus, where manual evidence is not accepted, a refusal of any criterion
 * left without a check: the mandate is fixed for the whole run, so a manual row accepted here
 * would block every delivery later with nothing the workers could do about it.
 */
export function evidenceMandateValidator(checks: Pick<ChecksConfig, 'manualEvidenceAccepted'>): (value: unknown) => asserts value is WireEvidenceMandate {
  return (value: unknown): asserts value is WireEvidenceMandate => {
    validateEvidenceMandate(value);
    if (checks.manualEvidenceAccepted) return;
    const manual = value.evidence.filter((e) => e.checkCategoryId === null).map((e) => `"${e.criterion}"`);
    if (manual.length) {
      throw new Error(
        `Manual inspection is not accepted as evidence in this run, so every criterion needs a check category. ` +
        `Name one for: ${manual.join(', ')}. A test in the unit suite can inspect the repository's files.`,
      );
    }
  };
}

/** The user message body every doctrine's mandate prompt shares — only the framing above it differs. */
export function evidenceMandateUserPrompt(
  goal: string,
  acceptanceCriteria: string[],
  checks: Pick<ChecksConfig, 'categories' | 'manualEvidenceAccepted'>,
): string {
  const categories = checks.categories;
  return (
    `Goal: ${goal}\n\n` +
    `Acceptance criteria — produce exactly one entry for each, copying its text verbatim:\n` +
    `${acceptanceCriteria.map((c) => `- ${c}`).join('\n') || '(none given)'}\n\n` +
    `Checks available in this repository (you may not invent others; commands are fixed and run by ` +
    `the engine, not by you):\n` +
    `${categories.map((c) => `- ${c.id}: \`${[c.command, ...c.args].join(' ')}\`${c.required ? ' (required)' : ''}`).join('\n')}\n\n` +
    'Assign each criterion the check that would demonstrate it, and say what that check must show. ' +
    (checks.manualEvidenceAccepted
      ? 'Use null only where no available check could demonstrate the criterion, and then name the ' +
        'reproducible manual inspection instead. Every entry must state a non-empty expectedResult, ' +
        'including manual inspections: describe the observable source or artifact condition that would pass. ' +
        'For source-organization or generated-file policies, an explicit repository inspection is appropriate.'
      : 'Manual inspection is not accepted as evidence in this run: nobody will perform it, and a ' +
        'criterion without a check can never be accepted. Never use null. A source-organization or ' +
        'generated-file policy is demonstrated by a test in the unit suite that inspects the ' +
        "repository's files, so assign it the unit check and say what that test must assert.")
  );
}

/**
 * Turns the mandate into evidence items. Status starts `unavailable` for every entry: nothing is
 * evidenced until a check has actually run, which happens later.
 *
 * A criterion the body failed to cover still gets a row, marked with the omission — section 9's
 * "an omitted category requires a recorded reason, not silence" applies to criteria too.
 */
export function toEvidenceItems(
  mandate: WireEvidenceMandate,
  acceptanceCriteria: string[],
  categories: CheckCategory[],
): EvidenceItem[] {
  const validIds = new Set(categories.map((c) => c.id));
  const commandFor = (id: string): string => {
    const c = categories.find((x) => x.id === id);
    return c ? [c.command, ...c.args].join(' ') : id;
  };

  const items: EvidenceItem[] = [];
  for (const criterion of acceptanceCriteria) {
    const match = mandate.evidence.find((e) => e.criterion.trim() === criterion.trim());

    if (!match) {
      items.push({
        criterion,
        command: '(none)',
        expectedResult: '(none recorded)',
        status: 'unavailable',
        note: 'The test mandate returned no entry for this acceptance criterion.',
      });
      continue;
    }

    // A category id the body invented is treated as no category at all, rather than silently
    // trusted — the engine can only run what config/checks.yaml declares.
    if (match.checkCategoryId && validIds.has(match.checkCategoryId)) {
      items.push({
        criterion,
        command: commandFor(match.checkCategoryId),
        checkCategoryId: match.checkCategoryId,
        expectedResult: match.expectedResult,
        status: 'unavailable',
        note: `check:${match.checkCategoryId}`,
      });
    } else if (match.checkCategoryId) {
      items.push({
        criterion,
        command: '(none)',
        expectedResult: match.expectedResult,
        status: 'unavailable',
        note: `The mandate named check category "${match.checkCategoryId}", which this repository does not define.`,
      });
    } else {
      items.push({
        criterion,
        command: match.manualInspection ?? '(manual inspection, unnamed)',
        expectedResult: match.expectedResult,
        status: 'manual',
        note: 'No available automated check demonstrates this criterion; a named manual inspection stands in its place.',
      });
    }
  }
  return items;
}

/**
 * Resolves each item's status against the checks that actually ran on the integrated tree.
 *
 * This is the step that makes the matrix evidence rather than assertion: an item is `satisfied`
 * only because its check ran and passed, and `unavailable` when the check never ran — never
 * because an agent said so.
 */
export function resolveEvidenceStatus(items: EvidenceItem[], checks: CheckRunRecord[]): EvidenceItem[] {
  const byId = new Map(checks.map((c) => [c.categoryId, c]));
  const byCommand = new Map(checks.map((c) => [[c.command, ...c.args].join(' '), c.categoryId]));

  return items.map((item) => {
    if (item.status === 'manual') return item;
    const categoryId = item.checkCategoryId ??
      (item.note?.startsWith('check:') ? item.note.slice('check:'.length) : undefined) ??
      byCommand.get(item.command);
    if (!categoryId) return item;

    const record = byId.get(categoryId);
    if (!record) {
      return {
        ...item,
        checkCategoryId: categoryId,
        status: 'unavailable',
        note: `Check "${categoryId}" was not run on the integrated tree.`,
      };
    }
    if (!record.ran) {
      return {
        ...item,
        checkCategoryId: categoryId,
        status: 'unavailable',
        note: record.skippedReason ?? `Check "${categoryId}" did not run.`,
      };
    }
    if (record.passed) {
      return {
        ...item,
        checkCategoryId: categoryId,
        status: 'satisfied',
        note: `Check "${categoryId}" passed on the integrated tree.`,
      };
    }
    // A check that was already failing before the run tells us nothing about this change either
    // way — it neither demonstrates the criterion nor disproves it. Section 9 calls that an
    // environmental limitation, so it is recorded as no evidence rather than as a failed criterion.
    // Either way the criterion is unevidenced and cannot be reported as met.
    if (record.failedAtBaseline) {
      return {
        ...item,
        checkCategoryId: categoryId,
        status: 'unavailable',
        note: `Check "${categoryId}" was already failing before this run, so it cannot demonstrate this criterion either way.`,
      };
    }
    return {
      ...item,
      checkCategoryId: categoryId,
      status: 'unsatisfied',
      note: `Check "${categoryId}" failed on the integrated tree.`,
    };
  });
}
