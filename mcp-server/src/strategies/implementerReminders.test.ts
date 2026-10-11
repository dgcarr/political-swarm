import { describe, expect, it } from 'vitest';
import {
  cliEntryPointReminder,
  implementerReminders,
  looksLikeCliTask,
  looksLikeMetadataTask,
  looksLikeRangeTask,
  looksLikeTestTask,
  metadataReminder,
  rangeReminder,
  testIndependenceReminder,
} from './implementerReminders.js';

describe('looksLikeCliTask', () => {
  it('detects a task naming cli.py in its target paths', () => {
    expect(looksLikeCliTask({ title: 'Implement command handling', description: '', targetGlobs: ['pkg/cli.py'] })).toBe(true);
  });

  it('detects a task naming __main__.py', () => {
    expect(looksLikeCliTask({ title: 'Entry point', description: '', targetGlobs: ['pkg/__main__.py'] })).toBe(true);
  });

  it('detects "command-line" mentioned in the description', () => {
    expect(looksLikeCliTask({ title: 'Wire things up', description: 'Build the command-line interface.', targetGlobs: [] })).toBe(true);
  });

  it('matches regardless of case', () => {
    expect(looksLikeCliTask({ title: 'Entry point', description: '', targetGlobs: ['pkg/CLI.py'] })).toBe(true);
  });

  it('does not overtrigger on a task that merely mentions "CLI" in passing', () => {
    expect(looksLikeCliTask({ title: 'Build the CLI', description: 'A general task, not this specific file.', targetGlobs: [] })).toBe(false);
  });

  it('does not flag an unrelated task', () => {
    expect(looksLikeCliTask({ title: 'Core maths', description: 'Compute the result.', targetGlobs: ['pkg/core.py'] })).toBe(false);
  });
});

describe('cliEntryPointReminder', () => {
  it('names __main__.py and the python -m invocation', () => {
    const text = cliEntryPointReminder();
    expect(text).toMatch(/__main__\.py/);
    expect(text).toMatch(/python -m/);
  });

  it('says the exit status must carry the CLI result', () => {
    // Socialist cycle 3b: a bare main() in __main__.py exited 0 on every reported error.
    expect(cliEntryPointReminder()).toContain('raise SystemExit(main())');
  });
});

describe('looksLikeRangeTask', () => {
  it('detects interpolation mentioned in the description', () => {
    expect(looksLikeRangeTask({ title: 'Grid', description: 'Build a common grid and interpolate onto it.', targetGlobs: [] })).toBe(true);
  });

  it('detects extrapolation mentioned in the description', () => {
    expect(looksLikeRangeTask({ title: 'Boundary handling', description: 'Must not extrapolate beyond the data.', targetGlobs: [] })).toBe(true);
  });

  it('detects a supported-range requirement', () => {
    expect(looksLikeRangeTask({ title: 'Validation', description: 'Reject requests outside the supported range.', targetGlobs: [] })).toBe(true);
  });

  it('does not flag an unrelated task', () => {
    expect(looksLikeRangeTask({ title: 'Command-line interface', description: 'Wire up python -m pkg.', targetGlobs: ['pkg/cli.py'] })).toBe(false);
  });
});

describe('rangeReminder', () => {
  it('forbids silent extrapolation and clamping, and derives bounds from the data', () => {
    const text = rangeReminder();
    expect(text).toMatch(/extrapolated or clamped/);
    expect(text).toMatch(/from the data itself/);
  });

  it('uses the intersection of several sources\' ranges, not the union', () => {
    const text = rangeReminder();
    expect(text).toMatch(/INTERSECTION/);
    expect(text).toMatch(/union/);
  });
});

describe('looksLikeMetadataTask', () => {
  it('detects provenance mentioned in the description', () => {
    expect(looksLikeMetadataTask({ title: 'Data provenance', description: 'Expose provenance to the user.', targetGlobs: [] })).toBe(true);
  });

  it('detects a parser task', () => {
    expect(looksLikeMetadataTask({ title: 'Config loader', description: 'Parse the header block.', targetGlobs: [] })).toBe(true);
  });

  it('does not flag an unrelated task', () => {
    expect(looksLikeMetadataTask({ title: 'Command-line interface', description: 'Wire up python -m pkg.', targetGlobs: ['pkg/cli.py'] })).toBe(false);
  });
});

describe('metadataReminder', () => {
  it('tells the implementer to read the real key names and print every requested field', () => {
    const text = metadataReminder();
    expect(text).toMatch(/real input files/);
    expect(text).toMatch(/every field the spec asks for/);
  });
});

describe('looksLikeTestTask', () => {
  it('detects a task whose target paths are test files', () => {
    expect(looksLikeTestTask({ title: 'Cover the package', description: '', targetGlobs: ['tests/test_core.py'] })).toBe(true);
  });

  it('detects a task asked for a unit test suite', () => {
    expect(looksLikeTestTask({ title: 'Verification', description: 'Write unit tests for the core routine.', targetGlobs: [] })).toBe(true);
  });

  it('detects the known-answer phrasing a spec uses to ask for a reference test', () => {
    expect(looksLikeTestTask({ title: 'Check the maths', description: 'Verify it against a known-answer dataset.', targetGlobs: [] })).toBe(true);
  });

  it('does not overtrigger on a task that merely mentions testing in passing', () => {
    expect(looksLikeTestTask({ title: 'Core maths', description: 'Tested by the suite the next task writes.', targetGlobs: ['pkg/core.py'] })).toBe(false);
  });

  it('does not flag an unrelated task', () => {
    expect(looksLikeTestTask({ title: 'Command-line interface', description: 'Wire up python -m pkg.', targetGlobs: ['pkg/cli.py'] })).toBe(false);
  });
});

describe('testIndependenceReminder', () => {
  it('forbids deriving the expectation from the code under test', () => {
    const text = testIndependenceReminder();
    expect(text).toMatch(/independent of/);
    expect(text).toMatch(/same transform the implementation applies/);
    expect(text).toMatch(/calling the function under test/);
  });

  it('asks for a case that every reasonable convention agrees on, and one that separates them', () => {
    const text = testIndependenceReminder();
    expect(text).toMatch(/same under every reasonable choice/);
    expect(text).toMatch(/separates them/);
  });
});

describe('implementerReminders', () => {
  it('attaches every applicable reminder in a fixed order', () => {
    const text = implementerReminders({
      title: 'CLI',
      description: 'Parse provenance and refuse requests outside the supported range. Write unit tests.',
      targetGlobs: ['pkg/cli.py'],
    });
    expect(text).toBe(cliEntryPointReminder() + rangeReminder() + metadataReminder() + testIndependenceReminder());
  });

  it('attaches nothing to a task none of them governs', () => {
    expect(implementerReminders({ title: 'README', description: 'Document usage.', targetGlobs: ['README.md'] })).toBe('');
  });
});
