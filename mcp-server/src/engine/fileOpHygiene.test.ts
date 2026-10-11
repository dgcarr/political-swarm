import { describe, it, expect } from 'vitest';
import { pathsWithForbiddenControlCharacters, repairOverEscapedContent } from './fileOpHygiene.js';

const BS = String.fromCharCode(92);
const ESCAPED_NEWLINE = BS + 'n';

describe('repairOverEscapedContent', () => {
  it('restores realistic corrupted Python content to real lines', () => {
    const corrupted = [
      'import math',
      '',
      'def test_conversion():',
      '    result = load_alloy("a.yaml")',
      '    assert math.isclose(result["Fe"], 0.714, rel_tol=1e-2)',
    ].join(ESCAPED_NEWLINE);

    expect(repairOverEscapedContent(corrupted)).toBe(
      [
        'import math',
        '',
        'def test_conversion():',
        '    result = load_alloy("a.yaml")',
        '    assert math.isclose(result["Fe"], 0.714, rel_tol=1e-2)',
      ].join('\n'),
    );
  });

  it('returns healthy multi-line content byte-identical', () => {
    const healthy = 'def calculate():\n    return 42\n';

    expect(repairOverEscapedContent(healthy)).toBe(healthy);
  });

  it('leaves a legitimate escaped newline in multi-line source untouched', () => {
    const healthy = 'def message():\n    return "first' + ESCAPED_NEWLINE + 'second"\n';

    expect(repairOverEscapedContent(healthy)).toBe(healthy);
  });

  it('leaves a short one-line file with a legitimate escape untouched', () => {
    const oneLine = 'print("a' + ESCAPED_NEWLINE + 'b")';

    expect(repairOverEscapedContent(oneLine)).toBe(oneLine);
  });

  it('unescapes tabs and quotes when repairing', () => {
    const escapedTab = BS + 't';
    const escapedQuote = BS + '"';
    const corrupted = [
      'def value():',
      escapedTab + 'text = ' + escapedQuote + 'hello' + escapedQuote,
      escapedTab + 'return text',
    ].join(ESCAPED_NEWLINE);

    expect(repairOverEscapedContent(corrupted)).toBe('def value():\n\ttext = "hello"\n\treturn text');
  });

  it('does not reinterpret an unescaped backslash as a newline', () => {
    const escapedBackslash = BS + BS;
    const corrupted = [
      'def windows_path():',
      '    path = "C:' + escapedBackslash + 'n_dir"',
      '    return path',
    ].join(ESCAPED_NEWLINE);

    const repaired = repairOverEscapedContent(corrupted);

    expect(repaired).toContain('C:' + BS + 'n_dir');
    expect(repaired).toBe('def windows_path():\n    path = "C:' + BS + 'n_dir"\n    return path');
  });

  it('handles empty, undefined, and null inputs without throwing', () => {
    expect(repairOverEscapedContent('')).toBe('');
    expect(repairOverEscapedContent(undefined)).toBeUndefined();
    expect(repairOverEscapedContent(null)).toBeNull();
  });
});

describe('pathsWithForbiddenControlCharacters', () => {
  it('finds a JSON backspace escape before the file reaches the worktree', () => {
    const corrupted = `element: str${String.fromCharCode(8)}n    energy_eV: np.ndarray`;

    expect(pathsWithForbiddenControlCharacters({
      fileOps: [{ op: 'write', path: 'alloydamage/nuclear_data.py', content: corrupted }],
    })).toEqual(['alloydamage/nuclear_data.py']);
  });

  it('allows ordinary newlines, tabs, and carriage returns', () => {
    expect(pathsWithForbiddenControlCharacters({
      fileOps: [{ op: 'write', path: 'source.py', content: 'def f():\r\n\treturn 1\n' }],
    })).toEqual([]);
  });
});
