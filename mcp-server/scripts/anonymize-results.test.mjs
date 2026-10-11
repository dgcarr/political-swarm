import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { anonymizeResults } from './anonymize-results.mjs';

const STRATEGIES = ['democratic', 'socialist', 'capitalist'];
const EXPECTED_METRIC_KEYS = [
  'costUsd',
  'coverage',
  'filesChanged',
  'note',
  'status',
  'taskErrors',
  'testRuns',
  'tokensUsed',
  'wallClockMs',
  'workerCalls',
];

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function createFixture(rootDir) {
  const resultsDir = path.join(rootDir, 'fake-run');
  mkdirSync(resultsDir, { recursive: true });
  writeJson(path.join(resultsDir, 'summary.json'), {
    label: 'fake-run',
    results: STRATEGIES.map((strategy) => ({ strategy })),
  });

  for (const strategy of STRATEGIES) {
    const strategyDir = path.join(resultsDir, strategy);
    const worktreeDir = path.join(strategyDir, 'worktree');
    mkdirSync(worktreeDir, { recursive: true });
    writeFileSync(path.join(strategyDir, 'diff.patch'), `diff for ${strategy}\n`, 'utf8');
    writeFileSync(path.join(strategyDir, 'ledger.jsonl'), '{"type":"worker_call"}\n', 'utf8');
    writeJson(path.join(strategyDir, 'state.json'), { strategy });
    writeFileSync(path.join(worktreeDir, 'solution.txt'), `solution from fixture ${strategy}\n`, 'utf8');
    writeJson(path.join(strategyDir, 'metrics.json'), {
      runId: `${strategy}-run-id`,
      strategy,
      status: 'completed',
      costUsd: 1.25,
      budgetUsd: 8,
      tokensUsed: { prompt: 100, completion: 50 },
      workerCalls: 4,
      wallClockMs: 1200,
      filesChanged: 2,
      autoApprovals: [{ kind: 'merge', description: 'governance-only detail' }],
      taskErrors: 0,
      testRuns: [{ ran: true, passed: true }],
      coverage: { percent: 95, detail: 'fixture' },
      note: 'engineering-safe note',
    });
  }
  return resultsDir;
}

function allDescendantFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory() ? allDescendantFiles(entryPath) : [entryPath];
  });
}

test('creates randomized, engineering-only blind candidates', () => {
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'anonymize-results-'));
  try {
    const resultsDir = createFixture(temporaryRoot);
    const assignments = new Set();

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const { mapping } = anonymizeResults(resultsDir);
      assignments.add(JSON.stringify(mapping));
    }

    assert.ok(assignments.size > 1, 'candidate assignment stayed fixed across 10 anonymizations');

    const blindDir = path.join(resultsDir, 'blind');
    const candidateNames = readdirSync(blindDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    assert.deepEqual(candidateNames, ['candidate-A', 'candidate-B', 'candidate-C']);

    const mappingPath = path.join(blindDir, 'strategy-mapping.json');
    const mappingDocument = JSON.parse(readFileSync(mappingPath, 'utf8'));
    const mapping = mappingDocument['fake-run'];
    assert.deepEqual(Object.keys(mapping).sort(), candidateNames);
    assert.deepEqual(Object.values(mapping).sort(), [...STRATEGIES].sort());

    for (const candidateName of candidateNames) {
      const candidateDir = path.join(blindDir, candidateName);
      const relativeFiles = allDescendantFiles(candidateDir).map((filePath) => path.relative(candidateDir, filePath));
      assert.ok(!relativeFiles.some((filePath) => path.basename(filePath) === 'ledger.jsonl'));
      assert.ok(!relativeFiles.some((filePath) => path.basename(filePath) === 'state.json'));
      assert.ok(!relativeFiles.includes('strategy-mapping.json'));

      const metrics = JSON.parse(readFileSync(path.join(candidateDir, 'metrics.json'), 'utf8'));
      assert.ok(!Object.hasOwn(metrics, 'autoApprovals'));
      assert.ok(!Object.hasOwn(metrics, 'strategy'));
      assert.deepEqual(Object.keys(metrics).sort(), EXPECTED_METRIC_KEYS);
    }

    process.stdout.write('PASS: blind candidates are randomized and contain only engineering-safe artifacts.\n');
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
