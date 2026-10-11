import { describe, expect, it } from 'vitest';
import type { CheckRunRecord, EvidenceItem } from '../engine/packets.js';
import { evidenceMandateUserPrompt, evidenceMandateValidator, resolveEvidenceStatus } from './evidenceMandate.js';

const passedCli: CheckRunRecord = {
  categoryId: 'benchmark-cli',
  command: 'python',
  args: ['-m', 'alloydamage', 'calculate', 'examples/304L.yaml'],
  ran: true,
  passed: true,
};

describe('resolveEvidenceStatus', () => {
  it('retains its structured check binding across repeated acceptance cycles', () => {
    const item: EvidenceItem = {
      criterion: 'CLI works',
      command: 'python -m alloydamage calculate examples/304L.yaml',
      checkCategoryId: 'benchmark-cli',
      expectedResult: 'CSV and PNG are produced',
      status: 'unsatisfied',
      note: 'Exact final CLI check passed; external oracle 3/11 passed.',
    };

    expect(resolveEvidenceStatus([item], [passedCli])).toEqual([
      expect.objectContaining({
        checkCategoryId: 'benchmark-cli',
        status: 'satisfied',
        note: 'Check "benchmark-cli" passed on the integrated tree.',
      }),
    ]);
  });

  it('recovers a schema-v1 binding from the exact persisted command', () => {
    const legacy: EvidenceItem = {
      criterion: 'CLI works',
      command: 'python -m alloydamage calculate examples/304L.yaml',
      expectedResult: 'exit 0',
      status: 'unsatisfied',
      note: 'An older cycle overwrote the check marker.',
    };

    expect(resolveEvidenceStatus([legacy], [passedCli])[0]).toMatchObject({
      checkCategoryId: 'benchmark-cli',
      status: 'satisfied',
    });
  });
});

// Headless, the evaluator refuses manual evidence, and the mandate is fixed for the whole run: a
// criterion mapped to manual inspection at the start blocked every later delivery (8 of 10 arms
// on 2026-10-04, one of them after building a product that passed all 12 oracle checks).
describe('test mandate where manual evidence is not accepted', () => {
  const categories = [{ id: 'unit', command: 'pytest', args: [], timeoutMs: 1, required: true }];
  const mandate = {
    evidence: [
      { criterion: 'python -m pytest passes', checkCategoryId: 'unit', expectedResult: 'pytest exits 0' },
      { criterion: 'outputs are not authored files', checkCategoryId: null, expectedResult: 'none tracked', manualInspection: 'git ls-files' },
    ],
  };

  it('refuses a criterion without a check, naming it', () => {
    expect(() => evidenceMandateValidator({ manualEvidenceAccepted: false })(structuredClone(mandate)))
      .toThrow(/not accepted.*"outputs are not authored files"/);
    expect(() => evidenceMandateValidator({ manualEvidenceAccepted: true })(structuredClone(mandate))).not.toThrow();
  });

  it('tells the mandate body before it answers', () => {
    const headless = evidenceMandateUserPrompt('g', ['c'], { categories, manualEvidenceAccepted: false });
    const interactive = evidenceMandateUserPrompt('g', ['c'], { categories, manualEvidenceAccepted: true });
    expect(headless).toContain('Manual inspection is not accepted');
    expect(headless).not.toContain('an explicit repository inspection is appropriate');
    expect(interactive).toContain('an explicit repository inspection is appropriate');
  });
});
