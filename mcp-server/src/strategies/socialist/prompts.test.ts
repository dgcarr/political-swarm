import { describe, expect, it } from 'vitest';

import type { TaskNode } from '../../engine/types.js';
import { buildImplementerPrompt, buildReviewerPrompt, validateReconnaissance } from './prompts.js';

describe('buildImplementerPrompt', () => {
  it('makes strict external evidence actionable during remediation', () => {
    const node: TaskNode = {
      id: 'damage',
      title: 'Damage calculation',
      description: 'Implement interpolation.',
      acceptanceCriteria: ['Interpolation is correct.'],
      dependsOn: [],
      targetGlobs: ['alloydamage/damage.py', 'tests/test_damage.py'],
      riskTags: ['backend'],
      riskClass: 'medium',
      phase: 'queued',
      attempts: [],
      remediationOf:
        'Finding 1 [high]: External oracle check 6 failed: Interpolation accuracy\n' +
        'Evidence: synthetic proportional interpolation: got 159.0098, independently expected 20',
    };

    const prompt = buildImplementerPrompt({ goal: 'Build alloydamage.' }, node, ['backend'], 'backend-1', 'medium');

    expect(prompt).toContain('STRICT REMEDIATION DIRECTIVE');
    expect(prompt).toContain('got 159.0098, independently expected 20');
    expect(prompt).toContain('Passing existing local tests');
  });

  it('reminds the implementer that __main__.py is required for a CLI task', () => {
    const node: TaskNode = {
      id: 'cli',
      title: 'Command-line interface',
      description: 'Wire up python -m alloydamage.',
      acceptanceCriteria: ['CLI accepts --emin/--emax/--output.'],
      dependsOn: [],
      targetGlobs: ['alloydamage/cli.py', 'alloydamage/__main__.py'],
      riskTags: ['backend'],
      riskClass: 'medium',
      phase: 'queued',
      attempts: [],
    };

    const prompt = buildImplementerPrompt({ goal: 'Build alloydamage.' }, node, ['backend'], 'backend-1', 'medium');

    expect(prompt).toContain('__main__.py');
  });

  it('does not add the CLI reminder to an unrelated task', () => {
    const node: TaskNode = {
      id: 'damage',
      title: 'Damage calculation',
      description: 'Implement interpolation.',
      acceptanceCriteria: ['Interpolation is correct.'],
      dependsOn: [],
      targetGlobs: ['alloydamage/damage.py', 'tests/test_damage.py'],
      riskTags: ['backend'],
      riskClass: 'medium',
      phase: 'queued',
      attempts: [],
    };

    const prompt = buildImplementerPrompt({ goal: 'Build alloydamage.' }, node, ['backend'], 'backend-1', 'medium');

    expect(prompt).not.toContain('__main__.py');
  });

  it('reminds the implementer not to silently extrapolate on an interpolation/damage task', () => {
    const node: TaskNode = {
      id: 'damage',
      title: 'Damage calculation',
      description: 'Implement interpolation onto a common energy grid.',
      acceptanceCriteria: ['Interpolation is correct.'],
      dependsOn: [],
      targetGlobs: ['alloydamage/damage.py', 'tests/test_damage.py'],
      riskTags: ['backend'],
      riskClass: 'medium',
      phase: 'queued',
      attempts: [],
    };

    const prompt = buildImplementerPrompt({ goal: 'Build alloydamage.' }, node, ['backend'], 'backend-1', 'medium');

    expect(prompt).toMatch(/extrapolat/i);
  });

  it('does not add the extrapolation reminder to an unrelated task', () => {
    const node: TaskNode = {
      id: 'readme',
      title: 'Write the README',
      description: 'Document how to run the program.',
      acceptanceCriteria: ['README exists.'],
      dependsOn: [],
      targetGlobs: ['README.md'],
      riskTags: ['docs'],
      riskClass: 'low',
      phase: 'queued',
      attempts: [],
    };

    const prompt = buildImplementerPrompt({ goal: 'Build alloydamage.' }, node, ['backend'], 'backend-1', 'low');

    expect(prompt).not.toMatch(/extrapolat/i);
  });

  it('reminds the implementer to parse the real key names on a provenance task', () => {
    const node: TaskNode = {
      id: 'nuclear-data',
      title: 'Nuclear data loader',
      description: 'Load and expose nuclear-data provenance.',
      acceptanceCriteria: ['Provenance is inspectable.'],
      dependsOn: [],
      targetGlobs: ['alloydamage/nuclear_data.py', 'tests/test_nuclear_data.py'],
      riskTags: ['backend'],
      riskClass: 'medium',
      phase: 'queued',
      attempts: [],
    };

    const prompt = buildImplementerPrompt({ goal: 'Build alloydamage.' }, node, ['backend'], 'backend-1', 'medium');

    expect(prompt).toMatch(/real input files/);
  });

  it('does not add the provenance-key reminder to an unrelated task', () => {
    const node: TaskNode = {
      id: 'readme',
      title: 'Write the README',
      description: 'Document how to run the program.',
      acceptanceCriteria: ['README exists.'],
      dependsOn: [],
      targetGlobs: ['README.md'],
      riskTags: ['docs'],
      riskClass: 'low',
      phase: 'queued',
      attempts: [],
    };

    const prompt = buildImplementerPrompt({ goal: 'Build alloydamage.' }, node, ['backend'], 'backend-1', 'low');

    expect(prompt).not.toMatch(/real input files/);
  });
});

describe('buildReviewerPrompt', () => {
  // pytest prints its session header first and the assertion that failed last, so a cut from the
  // head showed the reviewer the header and nothing it could judge the work by.
  it('shows the reviewer the end of a long failing check output, where the error is', () => {
    const node: TaskNode = {
      id: 'damage',
      title: 'Damage calculation',
      description: 'Implement interpolation.',
      acceptanceCriteria: ['Interpolation is correct.'],
      dependsOn: [],
      targetGlobs: ['alloydamage/damage.py'],
      riskTags: ['backend'],
      riskClass: 'medium',
      phase: 'running',
      attempts: [],
    };
    const output = `${'platform linux -- Python 3.12, pytest-8 collected 4 items\n'.repeat(40)}` +
      'E   AssertionError: got 159.0098, expected 20\n1 failed, 3 passed';

    const prompt = buildReviewerPrompt(
      node,
      { taskId: 'damage', assignment: { taskId: 'damage', assigneeId: 'backend-1', role: 'implementer' }, fileOps: [], rationale: 'r' },
      { ran: true, passed: false, output },
      [],
      { personaId: 'backend-2', guild: 'backend' },
    );

    expect(prompt).toContain('E   AssertionError: got 159.0098, expected 20');
  });
});

describe('validateReconnaissance', () => {
  const report = (proposedCriteria: string[]) => ({ scopes: [], risks: [], dependencies: [], proposedCriteria });

  it('accepts a report that proposes no tests when tests are not required', () => {
    expect(() => validateReconnaissance(report([]))).not.toThrow();
  });

  it('rejects a report that proposes no tests when the doctrine requires them', () => {
    expect(() => validateReconnaissance(report([]), true)).toThrow(/at least one acceptance test/);
    expect(() => validateReconnaissance(report(['  ']), true)).toThrow(/at least one acceptance test/);
    expect(() => validateReconnaissance(report(['Saving a profile persists it']), true)).not.toThrow();
  });
});
