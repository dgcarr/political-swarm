import { describe, expect, it } from 'vitest';
import { clipCheckOutput, stripAnsi } from './checkOutput.js';

describe('clipCheckOutput', () => {
  it('removes colour escapes', () => {
    expect(stripAnsi('\u001b[31mFAILED\u001b[0m x')).toBe('FAILED x');
  });

  it('returns short output unchanged apart from colour', () => {
    expect(clipCheckOutput('\u001b[1mok\u001b[0m', 100)).toBe('ok');
  });

  it('keeps the error at the end of a long pytest log', () => {
    const log = `${'header line\n'.repeat(500)}E   ValueError: missing nuclear data file: data/Fe/Fe_dpa_nrt.csv\n` +
      'FAILED tests/test_core.py::test_pure - ValueError: missing nuclear data file';
    const clipped = clipCheckOutput(log, 600);

    expect(clipped.length).toBeLessThanOrEqual(600);
    expect(clipped).toContain('E   ValueError: missing nuclear data file');
    expect(clipped).toContain('header line');
    expect(clipped).toContain('chars omitted');
  });
});
