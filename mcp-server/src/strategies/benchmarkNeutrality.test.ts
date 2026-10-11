// docs/Coding-Swarm-Benchmark.md §14: "Do not give one swarm additional engineering guidance."
//
// Four properties keep that true. No strategy or shared dispatcher source may carry the benchmark
// task's own vocabulary, so no arm can be coached on it; every one of the five arms' implementers
// reads the whole goal and the same generic reminders; no arm is told which language or test
// framework to use; and every implementer is sampled at the same temperature.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { TaskNode } from '../engine/types.js';
import { buildImplementerUserPrompt as capitalistImplementerPrompt } from './capitalist/prompts.js';
import { implementerUserPrompt as democraticImplementerPrompt } from './democratic/prompts.js';
import { implementerReminders } from './implementerReminders.js';
import { buildImplementerUserPrompt as managerialImplementerPrompt } from './managerial/prompts.js';
import { buildImplementerUserPrompt as singleAgentImplementerPrompt } from './singleAgent/prompts.js';
import { buildImplementerPrompt as socialistImplementerPrompt } from './socialist/prompts.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const BENCHMARK_VOCABULARY = /alloydamage|dpa-barn|\bMeV\b|DXS-2018|NRT-dpa|26Fe0|24Cr0|28Ni0|\bIAEA\b|_log_interp|304L/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith('.ts') && !full.endsWith('.test.ts') ? [full] : [];
  });
}

describe('benchmark neutrality', () => {
  it('keeps the benchmark task\'s vocabulary out of every strategy and the shared dispatcher', () => {
    const files = [...sourceFiles(here), path.join(here, '..', 'engine', 'WorkerDispatcher.ts')];
    const offending = files.filter((file) => BENCHMARK_VOCABULARY.test(readFileSync(file, 'utf8')));
    expect(offending.map((file) => path.relative(here, file))).toEqual([]);
  });

  it('gives every arm the same implementer reminders for the same task', () => {
    const node: TaskNode = {
      id: 'cli',
      title: 'Command-line interface',
      description: 'Parse the input metadata and refuse requests outside the supported range.',
      acceptanceCriteria: ['python -m pkg runs'],
      dependsOn: [],
      targetGlobs: ['pkg/cli.py', 'pkg/__main__.py'],
      riskTags: [],
      riskClass: 'low',
      phase: 'queued',
      attempts: [],
    };
    const reminders = implementerReminders(node);
    expect(reminders).not.toBe('');

    const goal = 'GOAL-SENTINEL: build pkg, a small command-line tool, and document it.';
    const prompts = {
      democratic: democraticImplementerPrompt({
        goal,
        motionTitle: node.title,
        motionDescription: node.description,
        acceptanceCriteria: node.acceptanceCriteria,
        targetGlobs: node.targetGlobs,
      }),
      socialist: socialistImplementerPrompt({ goal }, node, ['general'], 'worker-1', 'low'),
      capitalist: capitalistImplementerPrompt(goal, node, undefined),
      managerial: managerialImplementerPrompt(goal, node, []),
      single_agent: singleAgentImplementerPrompt(goal, node),
    };
    for (const [strategy, prompt] of Object.entries(prompts)) {
      expect(prompt, strategy).toContain(reminders);
      // The whole brief, not only the planner's paraphrase of it: an implementer that sees only its
      // task text never learns a requirement the planner left out.
      expect(prompt, strategy).toContain(goal);
    }
  });

  it('names no language, module system or test framework in any arm\'s prompts', () => {
    // One arm's implementer was once told to write Node.js with node:assert on a Python task.
    const promptFiles = [
      ...sourceFiles(here).filter((file) => /prompts\.ts$|implementerReminders\.ts$/.test(file)),
      path.join(here, '..', 'engine', 'WorkerDispatcher.ts'),
    ];
    const offending = promptFiles.filter((file) =>
      /Node\.js|CommonJS|module\.exports|node:assert|\bjest\b|\bmocha\b/.test(readFileSync(file, 'utf8')),
    );
    expect(offending.map((file) => path.relative(here, file))).toEqual([]);
  });

  it('samples every arm\'s implementer at the same temperature', () => {
    const strategyFiles = sourceFiles(here).filter((file) => /Strategy\.ts$/.test(file) && !/noop/.test(file));
    expect(strategyFiles).toHaveLength(5);
    for (const file of strategyFiles) {
      const source = readFileSync(file, 'utf8');
      const implementerTemperatures = [...source.matchAll(/temperature: ([^,\n]+)/g)]
        .filter((match) => {
          const roles = [...source.slice(0, match.index).matchAll(/role: '([a-z_-]+)'/g)];
          return roles.at(-1)?.[1] === 'implementer';
        })
        .map((match) => match[1]);
      const name = path.relative(here, file);
      expect(implementerTemperatures.length, name).toBeGreaterThan(0);
      expect(new Set(implementerTemperatures), name).toEqual(new Set(['IMPLEMENTER_TEMPERATURE']));
    }
  });
});
