import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { KnowledgeStore } from './KnowledgeStore.js';

describe('KnowledgeStore.scopedTo', () => {
  it('shows a run only the knowledge it wrote itself, while the shared store keeps everything', () => {
    const store = new KnowledgeStore(mkdtempSync(path.join(os.tmpdir(), 'knowledge-')));
    const lesson = (sourceRunId: string) => ({ kind: 'lesson' as const, tags: ['testing'], sourceRunId, content: sourceRunId });
    store.add(lesson('earlier-run'), 'k1', '2026-09-21T00:00:00.000Z');
    const current = store.scopedTo('current-run');
    current.add(lesson('current-run'), 'k2', '2026-09-22T00:00:00.000Z');

    expect(current.queryByTags(['testing']).map((entry) => entry.id)).toEqual(['k2']);
    expect(store.queryByTags(['testing']).map((entry) => entry.id)).toEqual(['k2', 'k1']);
  });
});
