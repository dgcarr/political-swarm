import { describe, expect, it } from 'vitest';
import { declaredTestCommand, inspectRepository, renderDiligence, type FileReader } from './diligence.js';
import type { ChecksConfig } from '../../util/config.js';
import type { CheckRunRecord } from '../../engine/packets.js';

function reader(files: Record<string, string>): FileReader {
  return (relPath) => (relPath in files ? files[relPath] : null);
}

const checks = {
  categories: [
    { id: 'unit', command: 'npm', args: ['test'], timeoutMs: 1000, required: true },
    { id: 'lint', command: 'npm', args: ['run', 'lint'], timeoutMs: 1000, required: false },
  ],
  testPathGlobs: [],
  maxConcurrentExecutes: 1,
  command: 'npm',
  args: ['test'],
  timeoutMs: 1000,
} as unknown as ChecksConfig;

function record(over: Partial<CheckRunRecord> = {}): CheckRunRecord {
  return { categoryId: 'unit', command: 'npm', args: ['test'], ran: true, passed: true, ...over };
}

const WELL_FOUND = {
  'package.json': JSON.stringify({ scripts: { test: 'node test.js' } }),
  'CLAUDE.md': '# instructions',
  '.github/workflows/ci.yml': 'name: ci',
  test: '',
};

describe('reading a declared test command', () => {
  it('finds the test script a manifest declares', () => {
    expect(declaredTestCommand(JSON.stringify({ scripts: { test: 'vitest run' } }))).toBe('vitest run');
  });

  it('reports no command when there is no manifest', () => {
    expect(declaredTestCommand(null)).toBeUndefined();
  });

  it('reports no command when the manifest declares none', () => {
    expect(declaredTestCommand(JSON.stringify({ name: 'x' }))).toBeUndefined();
    expect(declaredTestCommand(JSON.stringify({ scripts: { test: '   ' } }))).toBeUndefined();
  });

  // A malformed manifest is itself a fact a bidder needs. Guessing a command out of a broken file
  // is how a contract comes to promise evidence nobody can produce.
  it('treats a manifest that will not parse as absent rather than guessing', () => {
    expect(declaredTestCommand('{ not json')).toBeUndefined();
  });
});

describe('inspecting the ground before bidding closes', () => {
  it('finds instructions, manifests, CI and test layout', () => {
    const report = inspectRepository(reader(WELL_FOUND), checks, [record()]);
    expect(report.instructions).toEqual(['CLAUDE.md']);
    expect(report.manifests).toEqual(['package.json']);
    expect(report.ciConfigs).toEqual(['.github/workflows/ci.yml']);
    expect(report.testLayout).toEqual(['test']);
    expect(report.declaredTestCommand).toBe('node test.js');
  });

  it('says a repository can be let at a fixed price when it actually established the ground', () => {
    expect(inspectRepository(reader(WELL_FOUND), checks, [record()]).scopeUnderstood).toBe(true);
  });

  // Section 8's shape for uncertain investigation. A fixed price on work nobody could size is a
  // fixed price on a guess.
  it('refuses to call the scope understood with no manifest', () => {
    const report = inspectRepository(reader({ 'CLAUDE.md': 'x' }), checks, [record()]);
    expect(report.scopeUnderstood).toBe(false);
    expect(report.notes.join(' ')).toContain('time and materials');
  });

  it('refuses to call the scope understood with no declared test command', () => {
    const report = inspectRepository(reader({ 'package.json': '{}' }), checks, [record()]);
    expect(report.scopeUnderstood).toBe(false);
  });

  it('refuses to call the scope understood when nothing ran at baseline', () => {
    const report = inspectRepository(reader(WELL_FOUND), checks, [record({ ran: false, skippedReason: 'no runner' })]);
    expect(report.scopeUnderstood).toBe(false);
  });

  it('reports an empty repository without falling over', () => {
    const report = inspectRepository(reader({}), checks, []);
    expect(report.scopeUnderstood).toBe(false);
    expect(report.instructions).toEqual([]);
    expect(report.notes.length).toBeGreaterThan(0);
  });
});

describe('which checks the contract must price', () => {
  it('prices a category that ran and passed at baseline', () => {
    const report = inspectRepository(reader(WELL_FOUND), checks, [record({ categoryId: 'unit' })]);
    expect(report.applicableChecks).toContain('unit');
  });

  // Section 9 allows exclusion only "through an explicit, justified contract term". An unrecorded
  // category would be an exclusion by silence, which is the disclosure failure article 7 is about.
  it('prices an unclassified category rather than excluding it silently', () => {
    const report = inspectRepository(reader(WELL_FOUND), checks, []);
    expect(report.applicableChecks).toEqual(['unit', 'lint']);
    expect(report.excludedChecks).toEqual([]);
  });

  it('excludes a category that did not run, and says why', () => {
    const report = inspectRepository(reader(WELL_FOUND), checks, [
      record({ categoryId: 'lint', ran: false, skippedReason: 'no linter configured' }),
    ]);
    expect(report.excludedChecks).toContainEqual({ categoryId: 'lint', reason: 'no linter configured' });
  });

  it('supplies a reason even when the skip recorded none — the silence is the finding', () => {
    const report = inspectRepository(reader(WELL_FOUND), checks, [record({ categoryId: 'lint', ran: false })]);
    expect(report.excludedChecks[0].reason).toContain('no reason was recorded');
  });

  // A category already failing before the contract began is a disclosed limitation the contractor
  // is not liable for — but it stays applicable, because the contractor may not worsen it.
  it('keeps a category that was already failing applicable while disclaiming liability for it', () => {
    const report = inspectRepository(reader(WELL_FOUND), checks, [record({ categoryId: 'unit', passed: false })]);
    expect(report.applicableChecks).toContain('unit');
    expect(report.excludedChecks[0].reason).toContain('not liable');
    expect(report.excludedChecks[0].reason).toContain('may not worsen');
  });
});

describe('what a bidder is told', () => {
  it('renders every heading a bidder needs to price against facts', () => {
    const text = renderDiligence(inspectRepository(reader(WELL_FOUND), checks, [record()]));
    for (const heading of ['Repository instructions', 'Manifests', 'Declared test command', 'Test layout']) {
      expect(text).toContain(heading);
    }
  });

  it('states plainly when a contract would be establishing a test suite rather than extending one', () => {
    const text = renderDiligence(inspectRepository(reader({ 'package.json': '{}' }), checks, []));
    expect(text).toContain('establishing one, not extending one');
  });
});
