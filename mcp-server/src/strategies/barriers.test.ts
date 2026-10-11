import { describe, expect, it } from 'vitest';
import { compactFindingLine, diffBudgetForContext, renderCheckSummary, truncateDiff } from './barriers.js';
import { normalizeChecksConfig } from '../util/config.js';

describe('compactFindingLine', () => {
  it('keeps ordinary findings intact', () => {
    expect(
      compactFindingLine({
        id: 'f-11111111',
        source: 'integrator',
        summary: 'CLI and damage disagree.',
        evidenceRefs: ['alloydamage/cli.py', 'alloydamage/damage.py'],
      }),
    ).toBe(
      '- id=f-11111111 [from integrator] CLI and damage disagree. (evidence: alloydamage/cli.py, alloydamage/damage.py)',
    );
  });

  it('omits nested remediation-origin text from regression-rule findings', () => {
    const line = compactFindingLine({
      id: 'f-aaaaaaaa',
      source: 'engine:regression-rule',
      summary:
        'Remediation of task "cli" changed no test — a defect fix must add or strengthen a regression test.',
      evidenceRefs: [
        'alloydamage/cli.py',
        'remediation-origin:cli:Finding 1 [high]: prior packet that would explode the prompt',
      ],
    });

    expect(line).toBe(
      '- id=f-aaaaaaaa [from engine:regression-rule] changed no test (evidence: alloydamage/cli.py)',
    );
    expect(line).not.toContain('remediation-origin:');
    expect(line).not.toContain('prior packet');
  });
});

describe('renderCheckSummary', () => {
  it('names runtime artifacts as evidence rather than authored files', () => {
    const checks = normalizeChecksConfig({ command: 'git', args: ['status', '--short'], timeoutMs: 1_000 });
    const summary = renderCheckSummary(
      [
        {
          categoryId: 'benchmark-cli',
          command: 'python',
          args: ['-m', 'alloydamage'],
          ran: true,
          passed: true,
          generatedPaths: ['generated.csv'],
        },
      ],
      checks,
    );

    expect(summary).toContain('runtime artifacts retained as evidence, not authored: generated.csv');
  });
});

describe('truncateDiff', () => {
  const fileDiff = (name: string, body: string) => `diff --git a/${name} b/${name}\n+++ b/${name}\n${body}\n`;

  it('leaves a diff under budget untouched', () => {
    const diff = fileDiff('a.py', 'x = 1');
    expect(truncateDiff(diff, 1_000)).toBe(diff);
  });

  // democratic-musgr8io: the first 20k characters were README, __main__.py and part of cli.py, so
  // the verifier never saw composition, damage, nuclear_data, plotting or the tests.
  it('gives every file a share, so a late file is never dropped', () => {
    const big = (name: string) => fileDiff(name, '+'.repeat(5_000));
    const diff = big('README.md') + big('alloydamage/cli.py') + fileDiff('alloydamage/damage.py', '+def dpa(): pass');
    const out = truncateDiff(diff, 4_000);

    expect(out).toContain('README.md');
    expect(out).toContain('alloydamage/cli.py');
    expect(out).toContain('+def dpa(): pass');
    expect(out).toContain('read the file for the rest');
    expect(out.length).toBeLessThan(4_600);
  });
});

// The roster changes between runs, so the diff budget follows the smallest window it holds.
describe('diffBudgetForContext', () => {
  it('scales with the window and stops at the ceiling', () => {
    expect(diffBudgetForContext(524_288)).toBe(80_000);
    expect(diffBudgetForContext(131_072)).toBe(80_000);
    expect(diffBudgetForContext(32_768)).toBe(24_576);
    expect(diffBudgetForContext(8_192)).toBe(6_144);
  });
});
