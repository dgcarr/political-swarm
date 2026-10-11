// Section 9's "Baseline inspection and applicable checks", performed before bidding closes.
//
// The doctrine is specific about what due diligence covers: "inspection of repository instructions,
// manifests, CI configuration and test layout, identification of existing tests relevant to the
// contracted behaviour, and execution or recording of the narrowest useful baseline." None of it
// was happening. Bidders priced work having seen a title and a glob, and the buyer let contracts
// without knowing whether the repository could even demonstrate the acceptance criteria.
//
// That gap did more damage than it looks. Section 9 requires the statement of work to price "all
// applicable unit, integration, regression and security tests, type-checking, linting, builds and
// documentation checks", and to exclude a category only "through an explicit, justified contract
// term". Without an inspection there is no way to say which categories are applicable, so exclusions
// happen by silence — which is exactly the disclosure failure article 7 is about.
//
// Nothing here makes a model call, and that is not a cost decision. Due diligence is the act of
// finding out what is actually there; a model asked what a repository contains would produce a
// plausible answer, and a plausible answer is precisely what due diligence exists to rule out. The
// same reasoning is why this reads the baseline the engine already ran rather than running its own:
// the engine records the narrowest useful baseline before any editing, and a second opinion about
// the same commands would add cost and subtract authority.

import type { CheckRunRecord } from '../../engine/packets.js';
import type { ChecksConfig } from '../../util/config.js';

/** Reads a repository-relative file, returning null when it does not exist. */
export type FileReader = (relPath: string) => string | null;

export interface DiligenceReport {
  /** Repository instructions a contractor is bound by. */
  instructions: string[];
  /** Manifests found, and the test command one of them declares. */
  manifests: string[];
  declaredTestCommand?: string;
  ciConfigs: string[];
  /** Where tests live in this repository, as far as inspection could establish. */
  testLayout: string[];
  /** Check categories the statement of work must price. */
  applicableChecks: string[];
  /** Categories excluded, each with the justification section 9 requires. */
  excludedChecks: Array<{ categoryId: string; reason: string }>;
  /**
   * Whether inspection established enough to let fixed-price work. False sends the listing to time
   * and materials, which is section 8's shape for uncertain investigation.
   */
  scopeUnderstood: boolean;
  /** What a bidder should know before pricing, in plain words. */
  notes: string[];
}

/** Files that bind a contractor if they exist. Order is the order they are reported in. */
const INSTRUCTION_FILES = ['CLAUDE.md', 'AGENTS.md', 'CONTRIBUTING.md', '.cursorrules'];
const MANIFEST_FILES = ['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'pom.xml', 'Gemfile'];
const CI_FILES = [
  '.github/workflows/ci.yml',
  '.github/workflows/ci.yaml',
  '.github/workflows/test.yml',
  '.gitlab-ci.yml',
  'azure-pipelines.yml',
  'Jenkinsfile',
];
const TEST_LAYOUT_PROBES = [
  'test',
  'tests',
  '__tests__',
  'spec',
  'test.js',
  'test/index.js',
  'src/test',
  'mcp-server/vitest.config.ts',
  'vitest.config.ts',
  'jest.config.js',
];

/**
 * Pulls the declared test command out of a package manifest.
 *
 * Parsed rather than pattern-matched, and a manifest that will not parse is reported as absent
 * rather than guessed at: a malformed manifest is itself a fact a bidder needs, and inventing a
 * test command from a broken file is how a contract comes to promise evidence nobody can produce.
 */
export function declaredTestCommand(packageJson: string | null): string | undefined {
  if (!packageJson) return undefined;
  try {
    const parsed = JSON.parse(packageJson) as { scripts?: Record<string, string> };
    const test = parsed.scripts?.test;
    return typeof test === 'string' && test.trim().length > 0 ? test : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The inspection itself.
 *
 * `baseline` is what the engine already recorded before any editing. It is read, not re-run: it is
 * the same commands against the same tree, and re-running them would spend the run's budget to
 * learn what is already on the record.
 */
export function inspectRepository(
  read: FileReader,
  checks: ChecksConfig,
  baseline: readonly CheckRunRecord[] = [],
): DiligenceReport {
  const instructions = INSTRUCTION_FILES.filter((f) => read(f) !== null);
  const manifests = MANIFEST_FILES.filter((f) => read(f) !== null);
  const ciConfigs = CI_FILES.filter((f) => read(f) !== null);
  const testLayout = TEST_LAYOUT_PROBES.filter((f) => read(f) !== null);
  const testCommand = declaredTestCommand(read('package.json'));

  const applicableChecks: string[] = [];
  const excludedChecks: Array<{ categoryId: string; reason: string }> = [];

  for (const category of checks.categories ?? []) {
    const record = baseline.find((b) => b.categoryId === category.id);
    if (!record) {
      // Never silently: an unclassified category is exactly the implicit exclusion section 9
      // forbids, so it is priced into the contract and the gap is stated.
      applicableChecks.push(category.id);
      continue;
    }
    if (!record.ran) {
      excludedChecks.push({
        categoryId: category.id,
        reason: record.skippedReason ?? 'the category did not run at baseline and no reason was recorded',
      });
      continue;
    }
    if (!record.passed) {
      // A category already failing before the contract began is a disclosed limitation, not a
      // defect the contractor may be charged for — but it is still applicable, because the
      // contractor must not make it worse.
      applicableChecks.push(category.id);
      excludedChecks.push({
        categoryId: category.id,
        reason: 'failing before this contract began: the contractor is not liable for it, but may not worsen it',
      });
      continue;
    }
    applicableChecks.push(category.id);
  }

  const ranSomething = baseline.some((b) => b.ran);
  const scopeUnderstood = manifests.length > 0 && testCommand !== undefined && ranSomething;

  const notes: string[] = [];
  if (instructions.length > 0) {
    notes.push(`Repository instructions bind this contract: ${instructions.join(', ')}.`);
  }
  if (manifests.length === 0) {
    notes.push('No package manifest was found, so no dependency or script assumptions are safe.');
  }
  if (!testCommand) {
    notes.push('No manifest declares a test command, so acceptance evidence must be produced by the contract itself.');
  }
  if (!ranSomething) {
    notes.push('No check ran at baseline, so nothing is known about the tree the contract starts from.');
  }
  if (testLayout.length === 0) {
    notes.push('No existing test layout was found; a contract requiring tests is establishing one, not extending one.');
  }
  if (ciConfigs.length === 0) {
    notes.push('No CI configuration was found, so no external check will catch what this run does not.');
  }
  if (scopeUnderstood) {
    notes.push(
      `Inspection established a manifest, a declared test command (${testCommand}) and a baseline, ` +
        'so this work can be let at a fixed price.',
    );
  } else {
    notes.push(
      'Inspection could not establish what the work involves, so the listing goes to time and materials ' +
        'rather than a fixed price on a guess.',
    );
  }

  return {
    instructions,
    manifests,
    declaredTestCommand: testCommand,
    ciConfigs,
    testLayout,
    applicableChecks,
    excludedChecks,
    scopeUnderstood,
    notes,
  };
}

/** The report as the text that goes into a listing, so bidders price against facts. */
export function renderDiligence(report: DiligenceReport): string {
  return [
    'Due diligence on the repository as it stands:',
    `- Repository instructions: ${report.instructions.join(', ') || 'none found'}`,
    `- Manifests: ${report.manifests.join(', ') || 'none found'}`,
    `- Declared test command: ${report.declaredTestCommand ?? 'none declared'}`,
    `- CI configuration: ${report.ciConfigs.join(', ') || 'none found'}`,
    `- Test layout: ${report.testLayout.join(', ') || 'none found'}`,
    `- Checks this contract must satisfy: ${report.applicableChecks.join(', ') || 'none applicable'}`,
    ...report.excludedChecks.map((e) => `- Excluded, ${e.categoryId}: ${e.reason}`),
    ...report.notes.map((n) => `- ${n}`),
  ].join('\n');
}
