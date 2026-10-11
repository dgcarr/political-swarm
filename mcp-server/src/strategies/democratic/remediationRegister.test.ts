import { describe, expect, it } from 'vitest';
import type { TaskGraph } from '../../engine/types.js';
import { compactFindingLine } from '../barriers.js';
import { compactRemediationRegister, scopedRemediationTargets } from './remediationRegister.js';

describe('compactRemediationRegister', () => {
  it('cites findings by id instead of recursively embedding prior packets', () => {
    const nested =
      'Finding 1 [high]: Finding 1 [high]: External oracle check 8 failed: CSV headers\n' +
      'Evidence: prior packet '.repeat(20);
    const line = compactRemediationRegister([
      { summary: nested, evidence: 'pkg/cli.py', affectedTaskIds: ['cli'] },
    ]);
    expect(line).toMatch(/^F1:/);
    expect(line).toContain('motions=cli');
    expect(line).not.toMatch(/Finding 1 \[high\]: Finding 1/);
    expect(line).not.toContain('prior packet prior packet');
  });

  it('summarizes a regression-rule packet by id without embedding prior prose', () => {
    const line = compactFindingLine({
      id: 'f-ab12cd34',
      source: 'engine:regression-rule',
      summary: `Remediation of "${'prior packet '.repeat(40)}" changed no test`,
      evidenceRefs: ['pkg/cli.py', 'remediation-origin:cli:f-00aa11bb'],
    });
    expect(line).toContain('f-ab12cd34');
    expect(line).toContain('changed no test');
    expect(line).not.toContain('prior packet');
    expect(line).not.toContain('remediation-origin:');
  });
});

describe('scopedRemediationTargets', () => {
  const graph = {
    order: ['cli', 'core', 'docs'],
    nodes: {
      cli: { targetGlobs: ['pkg/cli.py'] },
      core: { targetGlobs: ['pkg/core.py'] },
      docs: { targetGlobs: ['README.md'] },
    },
  } as unknown as TaskGraph;

  it('reopens only the motions named on the finding', () => {
    expect(scopedRemediationTargets(graph, [{
      summary: 'A helper is duplicated',
      evidence: 'pkg/cli.py, pkg/core.py',
      affectedTaskIds: ['cli', 'core'],
    }])).toEqual(['cli', 'core']);
  });

  it('maps a two-path finding onto the owning motions when affectedTaskIds are omitted', () => {
    expect(scopedRemediationTargets(graph, [{
      summary: 'A helper is defined in pkg/cli.py and pkg/core.py',
      evidence: 'pkg/cli.py, pkg/core.py',
    }])).toEqual(['cli', 'core']);
  });

  it('reopens the whole paper when a finding names no motion and no owned path', () => {
    expect(scopedRemediationTargets(graph, [{ summary: 'The suite fails' }])).toEqual(['cli', 'core', 'docs']);
  });
});
