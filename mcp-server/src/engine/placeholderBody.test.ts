import { describe, expect, it } from 'vitest';
import { editsAgainstMissingFiles, isPlaceholderBody, placeholderFileWrites } from './placeholderBody.js';

describe('isPlaceholderBody', () => {
  // The exact bytes two doctrines shipped as finished modules.
  it('flags a file that is only an ellipsis', () => {
    expect(isPlaceholderBody('...')).toBe(true);
    expect(isPlaceholderBody('...\n')).toBe(true);
  });

  it('flags a bare pass and a bare NotImplementedError', () => {
    expect(isPlaceholderBody('pass\n')).toBe(true);
    expect(isPlaceholderBody('raise NotImplementedError\n')).toBe(true);
    expect(isPlaceholderBody('raise NotImplementedError("todo")\n')).toBe(true);
  });

  it('sees through a docstring that dresses up a stub', () => {
    expect(isPlaceholderBody('"""Loads IAEA cross-sections."""\n...\n')).toBe(true);
  });

  it('ignores comments and blank lines around the placeholder', () => {
    expect(isPlaceholderBody('# TODO: write this\n\n...\n\n')).toBe(true);
  });

  // A false positive discards real work, so these must all stay false.
  it('leaves an empty file alone, because a bare __init__.py is legitimate', () => {
    expect(isPlaceholderBody('')).toBe(false);
    expect(isPlaceholderBody('\n\n')).toBe(false);
  });

  it('leaves a comment-only file alone', () => {
    expect(isPlaceholderBody('# intentionally empty\n')).toBe(false);
  });

  it('leaves a docstring-only file alone', () => {
    expect(isPlaceholderBody('"""Package marker."""\n')).toBe(false);
  });

  it('does not flag real code that merely contains a placeholder token', () => {
    expect(isPlaceholderBody('def f(x=...):\n    return x\n')).toBe(false);
    expect(isPlaceholderBody('def f():\n    pass\n')).toBe(false);
    expect(isPlaceholderBody('class A:\n    pass\n\n\nclass B:\n    pass\n')).toBe(false);
  });

  it('does not flag a real module that raises NotImplementedError in one branch', () => {
    expect(
      isPlaceholderBody('def load(kind):\n    if kind == "x":\n        return 1\n    raise NotImplementedError(kind)\n'),
    ).toBe(false);
  });
});

describe('placeholderFileWrites', () => {
  it('finds stub writes under either path key the doctrines use', () => {
    expect(
      placeholderFileWrites({
        fileOps: [
          { op: 'write', path: 'alloydamage/cli.py', content: '...' },
          { op: 'write', filePath: 'alloydamage/damage.py', content: 'pass\n' },
        ],
      }),
    ).toEqual(['alloydamage/cli.py', 'alloydamage/damage.py']);
  });

  it('passes real work through untouched', () => {
    expect(
      placeholderFileWrites({
        fileOps: [{ op: 'write', path: 'alloydamage/composition.py', content: 'def f():\n    return 1\n' }],
      }),
    ).toEqual([]);
  });

  it('ignores edits and deletes, which carry no whole-file body', () => {
    expect(
      placeholderFileWrites({
        fileOps: [
          { op: 'edit', path: 'a.py', find: 'x', replace: '...' },
          { op: 'delete', path: 'b.py' },
        ],
      }),
    ).toEqual([]);
  });

  it('survives a cyclic structure without hanging', () => {
    const cyclic: Record<string, unknown> = { fileOps: [{ op: 'write', path: 'a.py', content: '...' }] };
    cyclic.self = cyclic;

    expect(placeholderFileWrites(cyclic)).toEqual(['a.py']);
  });

  it('returns nothing for values that carry no file ops', () => {
    expect(placeholderFileWrites({ verdict: 'approve' })).toEqual([]);
    expect(placeholderFileWrites(null)).toEqual([]);
    expect(placeholderFileWrites('...')).toEqual([]);
  });
});

// applyFileOps throws on these, which reaches handleTaskError and blocks the task. A rejected
// attempt has its files reverted, so the retry repairing that work is exactly when an implementer
// edits a file that is no longer there — one run looped on a single missing path for 91 minutes.
describe('editsAgainstMissingFiles', () => {
  const present = (p: string) => p === 'there.py';

  it('names an edit aimed at a file that is not in the tree', () => {
    expect(
      editsAgainstMissingFiles({ fileOps: [{ op: 'edit', path: 'gone.py', find: 'a', replace: 'b' }] }, present),
    ).toEqual(['gone.py']);
  });

  it('allows an edit against a file that exists', () => {
    expect(
      editsAgainstMissingFiles({ fileOps: [{ op: 'edit', path: 'there.py', find: 'a', replace: 'b' }] }, present),
    ).toEqual([]);
  });

  it('never blocks a write, which is how a missing file gets created', () => {
    expect(editsAgainstMissingFiles({ fileOps: [{ op: 'write', path: 'gone.py', content: 'x = 1\n' }] }, present)).toEqual([]);
  });

  it('reads the other path key the doctrines use', () => {
    expect(
      editsAgainstMissingFiles({ fileOps: [{ op: 'edit', filePath: 'gone.py', find: 'a', replace: 'b' }] }, present),
    ).toEqual(['gone.py']);
  });

  it('ignores deletes and non-fileop values', () => {
    expect(editsAgainstMissingFiles({ fileOps: [{ op: 'delete', path: 'gone.py' }] }, present)).toEqual([]);
    expect(editsAgainstMissingFiles(null, present)).toEqual([]);
  });
});
