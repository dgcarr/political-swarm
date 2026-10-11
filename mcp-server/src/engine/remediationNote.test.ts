import { describe, expect, it } from 'vitest';
import { REMEDIATION_PRECEDENCE, remediationNote } from './remediationNote.js';

describe('remediationNote', () => {
  it('carries the evidence, not just the summary', () => {
    const note = remediationNote([{
      summary: 'Required final check unit failed on the partial combined tree.',
      evidence: 'E   ValueError: missing nuclear data file: alloydamage/data/Fe/Fe_dpa_nrt.csv',
      affectedTaskIds: ['core-modules'],
      severity: 'high',
    }], 'core-modules');

    expect(note).toContain('Required final check unit failed');
    expect(note).toContain('E   ValueError: missing nuclear data file');
  });

  it('gives a task only the findings that name it or name no task', () => {
    const note = remediationNote([
      { summary: 'mine', evidence: '', affectedTaskIds: ['a'], severity: 'high' },
      { summary: 'theirs', evidence: '', affectedTaskIds: ['b'], severity: 'high' },
      { summary: 'everyone', evidence: '', severity: 'low' },
    ], 'a');

    expect(note).toContain('mine');
    expect(note).toContain('everyone');
    expect(note).not.toContain('theirs');
  });

  it('keeps the end of long evidence, where the error is', () => {
    const note = remediationNote([{
      summary: 's',
      evidence: `${'header\n'.repeat(1000)}E   AssertionError: boom`,
      severity: 'high',
    }]);

    expect(note).toContain('E   AssertionError: boom');
    expect(note.length).toBeLessThan(1700 + REMEDIATION_PRECEDENCE.length);
  });

  it('ends with the task statement outranking any finding, and stays empty with no findings', () => {
    expect(remediationNote([{ summary: 's', evidence: '', severity: 'low' }])).toMatch(/never overrides the task statement/);
    expect(remediationNote([{ summary: 'theirs', evidence: '', affectedTaskIds: ['b'], severity: 'high' }], 'a')).toBe('');
  });
});
