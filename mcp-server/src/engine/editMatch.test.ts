import { describe, expect, it } from 'vitest';
import { editsWithUnmatchedFind, locateEditTarget, unmatchedEditMessage } from './editMatch.js';

const FILE = [
  'def clamp(x):',
  '    # Clamp to the supported range.',
  '    return max(0, x)',
  '',
  '## 7. How to run',
  'python -m alloydamage',
].join('\n');

describe('locateEditTarget', () => {
  it('prefers the exact text', () => {
    expect(locateEditTarget(FILE, '    return max(0, x)')).toBe('    return max(0, x)');
  });

  it('strips line numbers copied from the repository read tool', () => {
    expect(locateEditTarget(FILE, '5: ## 7. How to run\n6: python -m alloydamage'))
      .toBe('## 7. How to run\npython -m alloydamage');
  });

  it('matches across indentation and trailing whitespace, returning the file\'s own text', () => {
    expect(locateEditTarget(FILE, "# Clamp to the supported range.\nreturn max(0, x)  "))
      .toBe('    # Clamp to the supported range.\n    return max(0, x)');
  });

  it('refuses text that is not there or a repair that matches more than one place', () => {
    expect(locateEditTarget(FILE, '    return np.interp(x):')).toBeUndefined();
    expect(locateEditTarget('a\n  b\nc\n a\n b', 'a\nb')).toBeUndefined();
  });
});

describe('editsWithUnmatchedFind', () => {
  const read = (p: string) => (p === 'm.py' ? FILE : null);

  it('reports an edit whose find-text is missing and passes one that matches', () => {
    expect(editsWithUnmatchedFind({ fileOps: [
      { op: 'edit', filePath: 'm.py', find: 'return max(0, x)', replace: 'return x' },
      { op: 'edit', filePath: 'm.py', find: 'def nope():', replace: '' },
    ] }, read)).toEqual([{ path: 'm.py', find: 'def nope():' }]);
  });

  it('applies earlier ops in the same response before checking a later edit', () => {
    expect(editsWithUnmatchedFind({ fileOps: [
      { op: 'write', path: 'new.py', content: 'A = 1\n' },
      { op: 'edit', path: 'new.py', find: 'A = 1', replace: 'A = 2' },
      { op: 'edit', path: 'new.py', find: 'A = 2', replace: 'A = 3' },
    ] }, read)).toEqual([]);
  });

  it('leaves edits to a missing file to the missing-file check', () => {
    expect(editsWithUnmatchedFind({ fileOps: [{ op: 'edit', path: 'gone.py', find: 'x', replace: 'y' }] }, read))
      .toEqual([]);
  });
});

describe('unmatchedEditMessage', () => {
  it('shows the file as it stands so the model can quote it', () => {
    const message = unmatchedEditMessage([{ path: 'm.py', find: 'def nope():' }], () => FILE);
    expect(message).toContain('m.py (find began: "def nope():")');
    expect(message).toContain('--- m.py as it stands now ---\n' + FILE);
  });
});
