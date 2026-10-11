import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { isSafeBranchName, MAX_ITEM_CHARS, MAX_LIST_ITEMS, MAX_TASK_CHARS, runIdSchema } from './ids.js';
import { swarmApplyInputShape } from '../tools/swarmApply.js';
import { swarmDecideInputShape } from '../tools/swarmDecide.js';
import { swarmGetDiffInputShape } from '../tools/swarmGetDiff.js';
import { swarmStartInputShape } from '../tools/swarmStart.js';

describe('runIdSchema', () => {
  it('accepts the ids the engine mints', () => {
    expect(runIdSchema.safeParse('democratic-mfx2k9q1-3f9a2c').success).toBe(true);
  });

  it.each(['../../etc', 'a/b', 'a\\b', '', '.', 'x'.repeat(129)])('rejects %j', (id) => {
    expect(runIdSchema.safeParse(id).success).toBe(false);
  });

  it('guards every tool that joins a run or approval id into a path', () => {
    expect(z.object(swarmApplyInputShape).safeParse({ runId: '../x' }).success).toBe(false);
    expect(z.object(swarmGetDiffInputShape).safeParse({ runId: '../x' }).success).toBe(false);
    expect(
      z.object(swarmDecideInputShape).safeParse({ runId: 'r', approvalId: '../x', decision: 'approve' }).success,
    ).toBe(false);
  });
});

describe('isSafeBranchName', () => {
  it.each(['main', 'feature/login', 'release-1.2', 'origin/main', 'a1b2c3d'])('accepts %s', (name) => {
    expect(isSafeBranchName(name)).toBe(true);
  });

  it.each(['-x', '--upload-pack=evil', 'a..b', 'a b', 'a\tb', 'a\nb', 'a~1', 'a^', 'a:b', 'a@{1}', '.hidden', 'x.lock', 'a//b', 'a/', ''])(
    'rejects %j',
    (name) => {
      expect(isSafeBranchName(name)).toBe(false);
    },
  );
});

describe('swarm_start input caps', () => {
  const start = z.object(swarmStartInputShape);
  const base = { task: 'do it', strategy: 'democratic' as const };

  it('accepts an ordinary request', () => {
    expect(start.safeParse({ ...base, baseBranch: 'main', acceptanceCriteria: ['works'] }).success).toBe(true);
  });

  it('rejects oversized or malformed input', () => {
    expect(start.safeParse({ ...base, task: 'x'.repeat(MAX_TASK_CHARS + 1) }).success).toBe(false);
    expect(start.safeParse({ ...base, acceptanceCriteria: ['x'.repeat(MAX_ITEM_CHARS + 1)] }).success).toBe(false);
    expect(start.safeParse({ ...base, constraints: Array(MAX_LIST_ITEMS + 1).fill('c') }).success).toBe(false);
    expect(start.safeParse({ ...base, baseBranch: '--orphan' }).success).toBe(false);
  });
});
