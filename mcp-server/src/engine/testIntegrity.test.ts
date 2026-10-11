import { describe, it, expect } from 'vitest';
import { detectTestIntegrityViolations, isTestPath } from './testIntegrity.js';
import type { FileOp } from './types.js';

const GLOBS = ['**/*.test.*', '**/*.spec.*', '**/test/**', '**/tests/**', '**/__tests__/**'];

const EXISTING_TEST = `
import { describe, it, expect } from 'vitest';

describe('adder', () => {
  it('adds', () => {
    expect(add(1, 2)).toBe(3);
    expect(add(0, 0)).toBe(0);
  });

  it('handles negatives', () => {
    expect(add(-1, 1)).toBe(0);
  });
});
`;

function reader(files: Record<string, string>) {
  return (p: string): string | null => files[p] ?? null;
}

describe('isTestPath', () => {
  it('recognizes the usual test layouts', () => {
    expect(isTestPath('src/add.test.ts', GLOBS)).toBe(true);
    expect(isTestPath('src/add.spec.js', GLOBS)).toBe(true);
    expect(isTestPath('tests/integration/api.py', GLOBS)).toBe(true);
    expect(isTestPath('src/__tests__/thing.tsx', GLOBS)).toBe(true);
  });

  it('leaves ordinary source alone', () => {
    expect(isTestPath('src/add.ts', GLOBS)).toBe(false);
    expect(isTestPath('README.md', GLOBS)).toBe(false);
  });
});

describe('detectTestIntegrityViolations', () => {
  it('flags deleting an existing test file', () => {
    const ops: FileOp[] = [{ op: 'delete', path: 'src/add.test.ts' }];
    const violations = detectTestIntegrityViolations(ops, GLOBS, reader({ 'src/add.test.ts': EXISTING_TEST }));

    expect(violations).toHaveLength(1);
    expect(violations[0].kind).toBe('test_deleted');
  });

  it('flags a rewrite that removes assertions', () => {
    const weakened = EXISTING_TEST.replace('    expect(add(0, 0)).toBe(0);\n', '').replace(
      "  it('handles negatives', () => {\n    expect(add(-1, 1)).toBe(0);\n  });\n",
      '',
    );
    const ops: FileOp[] = [{ op: 'write', path: 'src/add.test.ts', content: weakened }];
    const violations = detectTestIntegrityViolations(ops, GLOBS, reader({ 'src/add.test.ts': EXISTING_TEST }));

    expect(violations).toHaveLength(1);
    expect(violations[0].kind).toBe('assertions_removed');
  });

  it('flags an edit that empties the file of test cases', () => {
    const ops: FileOp[] = [
      { op: 'write', path: 'src/add.test.ts', content: '// tests removed pending a rewrite\n' },
    ];
    const violations = detectTestIntegrityViolations(ops, GLOBS, reader({ 'src/add.test.ts': EXISTING_TEST }));

    expect(violations).toHaveLength(1);
    expect(violations[0].kind).toBe('test_emptied');
  });

  it('allows adding assertions to an existing test', () => {
    const strengthened = EXISTING_TEST.replace(
      '    expect(add(0, 0)).toBe(0);',
      '    expect(add(0, 0)).toBe(0);\n    expect(add(5, 5)).toBe(10);',
    );
    const ops: FileOp[] = [{ op: 'write', path: 'src/add.test.ts', content: strengthened }];

    expect(detectTestIntegrityViolations(ops, GLOBS, reader({ 'src/add.test.ts': EXISTING_TEST }))).toEqual([]);
  });

  it('allows creating a brand new test file', () => {
    const ops: FileOp[] = [
      { op: 'write', path: 'src/sub.test.ts', content: "it('subtracts', () => { expect(sub(2, 1)).toBe(1); });" },
    ];

    expect(detectTestIntegrityViolations(ops, GLOBS, reader({}))).toEqual([]);
  });

  it('ignores non-test files entirely, including deletions', () => {
    const ops: FileOp[] = [
      { op: 'delete', path: 'src/legacy.ts' },
      { op: 'write', path: 'src/add.ts', content: 'export const add = (a, b) => a + b;' },
    ];

    expect(detectTestIntegrityViolations(ops, GLOBS, reader({ 'src/legacy.ts': 'export const x = 1;' }))).toEqual([]);
  });

  it('does not flag an edit whose find-text is absent — applyFileOps rejects that op on its own', () => {
    const ops: FileOp[] = [
      { op: 'edit', path: 'src/add.test.ts', find: 'text that is not there', replace: '' },
    ];

    expect(detectTestIntegrityViolations(ops, GLOBS, reader({ 'src/add.test.ts': EXISTING_TEST }))).toEqual([]);
  });

  it('flags an edit that deletes a whole test case', () => {
    const ops: FileOp[] = [
      {
        op: 'edit',
        path: 'src/add.test.ts',
        find: "  it('handles negatives', () => {\n    expect(add(-1, 1)).toBe(0);\n  });\n",
        replace: '',
      },
    ];
    const violations = detectTestIntegrityViolations(ops, GLOBS, reader({ 'src/add.test.ts': EXISTING_TEST }));

    expect(violations).toHaveLength(1);
    expect(violations[0].kind).toBe('assertions_removed');
  });
});
