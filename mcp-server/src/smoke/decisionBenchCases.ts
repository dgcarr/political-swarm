// Labelled cases for the decision-model bench. Each is a small change put to a reviewer: the
// function as changed, what it was asked to do, and what its tests reported. Half are sound; half
// carry one concrete defect a careful reviewer should refuse. The defects are of the kinds the
// benchmark actually meets: an off-by-one, an inverted condition, an ignored argument, a swallowed
// error, a test weakened to pass.

export interface LabelledReview {
  id: string;
  expected: 'approve' | 'reject';
  state: { task: string; change: string; tests: string };
}

const sound = (id: string, task: string, change: string, tests: string): LabelledReview =>
  ({ id, expected: 'approve', state: { task, change, tests } });
const defective = (id: string, task: string, change: string, tests: string): LabelledReview =>
  ({ id, expected: 'reject', state: { task, change, tests } });

export const LABELLED_REVIEWS: LabelledReview[] = [
  sound('chunk', 'chunk(items, size) splits a list into consecutive chunks of `size`; the last may be shorter.',
    'def chunk(items, size):\n    if size < 1:\n        raise ValueError("size must be at least 1")\n    return [items[i:i + size] for i in range(0, len(items), size)]',
    'passed: 3 tests (even split, ragged last chunk, size < 1 raises)'),
  defective('chunk-drop-last', 'chunk(items, size) splits a list into consecutive chunks of `size`; the last may be shorter.',
    'def chunk(items, size):\n    if size < 1:\n        raise ValueError("size must be at least 1")\n    return [items[i:i + size] for i in range(0, len(items) - 1, size)]',
    'passed: 1 test (even split)'),
  sound('clamp', 'clamp(x, lo, hi) returns x limited to [lo, hi].',
    'def clamp(x, lo, hi):\n    return max(lo, min(x, hi))',
    'passed: 4 tests (below, inside, above, at bounds)'),
  defective('clamp-swapped', 'clamp(x, lo, hi) returns x limited to [lo, hi].',
    'def clamp(x, lo, hi):\n    return min(lo, max(x, hi))',
    'passed: 1 test (x inside range where lo == hi)'),
  sound('mean', 'mean(values) returns the arithmetic mean and raises ValueError on an empty list.',
    'def mean(values):\n    if not values:\n        raise ValueError("mean of empty list")\n    return sum(values) / len(values)',
    'passed: 3 tests'),
  defective('mean-empty', 'mean(values) returns the arithmetic mean and raises ValueError on an empty list.',
    'def mean(values):\n    try:\n        return sum(values) / len(values)\n    except ZeroDivisionError:\n        return 0',
    'passed: 2 tests (non-empty lists only)'),
  sound('slugify', 'slugify(title) lowercases, replaces runs of non [a-z0-9] with one hyphen, strips leading/trailing hyphens.',
    'import re\ndef slugify(title):\n    return re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")',
    'passed: 3 tests ("Hello, World!" -> "hello-world", "  --A  B--  " -> "a-b", "" -> "")'),
  defective('slugify-no-strip', 'slugify(title) lowercases, replaces runs of non [a-z0-9] with one hyphen, strips leading/trailing hyphens.',
    'import re\ndef slugify(title):\n    return re.sub(r"[^a-z0-9]+", "-", title.lower())',
    'passed: 1 test ("hello world" -> "hello-world")'),
  sound('interp', 'interp(x, xs, ys) linearly interpolates; raises ValueError when x is outside [xs[0], xs[-1]].',
    'import bisect\ndef interp(x, xs, ys):\n    if x < xs[0] or x > xs[-1]:\n        raise ValueError("x outside the data range")\n    i = max(1, bisect.bisect_left(xs, x))\n    x0, x1, y0, y1 = xs[i-1], xs[i], ys[i-1], ys[i]\n    return y0 + (y1 - y0) * (x - x0) / (x1 - x0)',
    'passed: 4 tests (interior, endpoints, below range raises, above range raises)'),
  defective('interp-clamps', 'interp(x, xs, ys) linearly interpolates; raises ValueError when x is outside [xs[0], xs[-1]].',
    'import bisect\ndef interp(x, xs, ys):\n    x = min(max(x, xs[0]), xs[-1])\n    i = max(1, bisect.bisect_left(xs, x))\n    x0, x1, y0, y1 = xs[i-1], xs[i], ys[i-1], ys[i]\n    return y0 + (y1 - y0) * (x - x0) / (x1 - x0)',
    'passed: 2 tests (interior, endpoints)'),
  sound('parse-csv', 'parse_rows(text) returns (energy, value) float pairs from a CSV with a header row.',
    'def parse_rows(text):\n    lines = text.strip().splitlines()[1:]\n    return [tuple(float(v) for v in line.split(",")) for line in lines]',
    'passed: 2 tests (two rows, header skipped)'),
  defective('parse-csv-header', 'parse_rows(text) returns (energy, value) float pairs from a CSV with a header row.',
    'def parse_rows(text):\n    rows = []\n    for line in text.strip().splitlines():\n        try:\n            rows.append(tuple(float(v) for v in line.split(",")))\n        except ValueError:\n            pass\n    return rows',
    'passed: 2 tests'),
  sound('is-even', 'is_even(n) returns True for even integers.',
    'def is_even(n):\n    return n % 2 == 0',
    'passed: 3 tests (0, 7, -4)'),
  defective('is-even-inverted', 'is_even(n) returns True for even integers.',
    'def is_even(n):\n    return n % 2 == 1',
    'passed: 0 tests (no tests were added)'),
  sound('normalise', 'normalise(fractions) scales a dict of non-negative weights so they sum to 1; raises on an all-zero dict.',
    'def normalise(fractions):\n    total = sum(fractions.values())\n    if total <= 0:\n        raise ValueError("weights sum to zero")\n    return {k: v / total for k, v in fractions.items()}',
    'passed: 3 tests'),
  defective('normalise-ignores-arg', 'normalise(fractions) scales a dict of non-negative weights so they sum to 1; raises on an all-zero dict.',
    'def normalise(fractions):\n    total = sum(fractions.values())\n    return {k: 1 / len(fractions) for k in fractions}',
    'passed: 1 test (equal weights)'),
  sound('retry', 'retry(fn, attempts) calls fn until it succeeds, at most `attempts` times, re-raising the last error.',
    'def retry(fn, attempts):\n    for i in range(attempts):\n        try:\n            return fn()\n        except Exception:\n            if i == attempts - 1:\n                raise',
    'passed: 3 tests (first try, third try, all fail re-raises)'),
  defective('retry-swallows', 'retry(fn, attempts) calls fn until it succeeds, at most `attempts` times, re-raising the last error.',
    'def retry(fn, attempts):\n    for i in range(attempts):\n        try:\n            return fn()\n        except Exception:\n            continue\n    return None',
    'passed: 2 tests (first try, third try)'),
  sound('test-kept', 'Fix total() to include tax; tests/test_total.py must keep asserting the taxed total.',
    'def total(prices, tax):\n    return round(sum(prices) * (1 + tax), 2)\n\n# tests/test_total.py\ndef test_total():\n    assert total([10, 5], 0.1) == 16.5',
    'passed: 1 test'),
  defective('test-weakened', 'Fix total() to include tax; tests/test_total.py must keep asserting the taxed total.',
    'def total(prices, tax):\n    return sum(prices)\n\n# tests/test_total.py\ndef test_total():\n    assert total([10, 5], 0.1) > 0',
    'passed: 1 test (assertion relaxed from == 16.5 to > 0)'),
];

/**
 * The verdict question the swarm's review fast path asked. That path was removed (2026-10-04): on
 * real multi-file reviews solar-decide almost never cleared its 0.85 floor (0 of 61 managerial
 * reviews) while democratic's aye question did, which unbalanced the arms. Kept so a recalibrated
 * question can be measured here before it is trusted again.
 */
export const VERDICT_QUESTION = {
  type: 'choice' as const,
  instructions:
    'You review one change against its task. Approve only if the change does what the task asks, including ' +
    'its edge cases, and its tests genuinely check that. Reject a concrete defect.',
  criteria: {
    approve: 'The change meets the task, edge cases included, and the tests genuinely verify it.',
    reject: 'The change has a concrete defect: wrong result, missed edge case, ignored input, swallowed error, or a weakened test.',
    flag: 'The change works but has a non-blocking concern worth recording.',
  },
};
