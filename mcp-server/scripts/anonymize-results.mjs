#!/usr/bin/env node

import { randomInt } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const CANDIDATE_LABELS = [
  'candidate-A',
  'candidate-B',
  'candidate-C',
  'candidate-D',
  'candidate-E',
];

const ENGINEERING_METRIC_KEYS = [
  'status',
  'costUsd',
  'tokensUsed',
  'workerCalls',
  'wallClockMs',
  'filesChanged',
  'taskErrors',
  'testRuns',
  'coverage',
  'note',
];

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function shuffled(values) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(index + 1);
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

function discoverStrategies(summary) {
  if (!Array.isArray(summary.results)) {
    throw new Error('summary.json must contain a results array');
  }

  const strategies = summary.results.map((result) => result?.strategy);
  if (strategies.some((strategy) => typeof strategy !== 'string' || strategy.length === 0)) {
    throw new Error('Every summary result must contain a non-empty strategy string');
  }
  if (new Set(strategies).size !== strategies.length) {
    throw new Error('summary.json contains duplicate strategies');
  }
  if (strategies.length === 0 || strategies.length > CANDIDATE_LABELS.length) {
    throw new Error(`Expected between 1 and ${CANDIDATE_LABELS.length} strategies`);
  }
  for (const strategy of strategies) {
    if (path.basename(strategy) !== strategy || strategy === '.' || strategy === '..') {
      throw new Error(`Invalid strategy directory name: ${strategy}`);
    }
  }
  return strategies;
}

function engineeringMetrics(metrics) {
  return Object.fromEntries(
    ENGINEERING_METRIC_KEYS
      .filter((key) => Object.hasOwn(metrics, key))
      .map((key) => [key, metrics[key]]),
  );
}

export function anonymizeResults(resultsDirectory) {
  const resultsDir = path.resolve(resultsDirectory);
  const summaryPath = path.join(resultsDir, 'summary.json');
  if (!existsSync(summaryPath)) {
    throw new Error(`summary.json not found in ${resultsDir}`);
  }

  const strategies = discoverStrategies(readJson(summaryPath));
  const shuffledStrategies = shuffled(strategies);
  const blindDir = path.join(resultsDir, 'blind');
  rmSync(blindDir, { recursive: true, force: true });
  mkdirSync(blindDir, { recursive: true });

  const mapping = {};
  for (const [index, strategy] of shuffledStrategies.entries()) {
    const candidate = CANDIDATE_LABELS[index];
    const strategyDir = path.join(resultsDir, strategy);
    const candidateDir = path.join(blindDir, candidate);
    const diffPath = path.join(strategyDir, 'diff.patch');
    const worktreePath = path.join(strategyDir, 'worktree');
    const metricsPath = path.join(strategyDir, 'metrics.json');

    for (const requiredPath of [diffPath, worktreePath, metricsPath]) {
      if (!existsSync(requiredPath)) {
        throw new Error(`Required artifact not found: ${requiredPath}`);
      }
    }

    mkdirSync(candidateDir, { recursive: true });
    cpSync(diffPath, path.join(candidateDir, 'diff.patch'));
    cpSync(worktreePath, path.join(candidateDir, 'worktree'), { recursive: true });
    writeFileSync(
      path.join(candidateDir, 'metrics.json'),
      `${JSON.stringify(engineeringMetrics(readJson(metricsPath)), null, 2)}\n`,
      'utf8',
    );
    mapping[candidate] = strategy;
  }

  const runLabel = path.basename(resultsDir);
  writeFileSync(
    path.join(blindDir, 'strategy-mapping.json'),
    `${JSON.stringify({ [runLabel]: mapping }, null, 2)}\n`,
    'utf8',
  );

  return { runLabel, mapping };
}

function main() {
  const resultsDirectory = process.argv[2];
  if (!resultsDirectory || process.argv.length !== 3) {
    throw new Error('Usage: node anonymize-results.mjs <results-dir>');
  }

  const { mapping } = anonymizeResults(resultsDirectory);
  process.stdout.write(`Created blind candidates: ${Object.keys(mapping).join(', ')}\n`);
  process.stdout.write('Do not open blind/strategy-mapping.json until technical scoring is finalized.\n');
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`[anonymize-results] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
